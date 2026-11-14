// Thin client over the nano-gpt API. Key is read from .secrets/ at call time.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = 'https://api.nano-gpt.com';

function apiKey() {
  return fs.readFileSync(path.join(ROOT, '.secrets', 'nanogpt-api-key'), 'utf8').trim();
}

async function chat(messages, model) {
  const res = await fetch(`${BASE}/api/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, max_tokens: 4096 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`chat ${res.status}: ${JSON.stringify(data)}`);
  return {
    text: data.choices[0].message.content,
    cost: data.usage?.cost ?? null,
    usage: data.usage ?? null,
  };
}

async function transcribe(audioBuffer, filename, model, mime = 'audio/webm') {
  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: mime });
  form.append('file', blob, filename);
  form.append('model', model);

  const res = await fetch(`${BASE}/api/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`transcribe ${res.status}: ${JSON.stringify(data)}`);
  return { text: data.text ?? '', raw: data };
}

async function speak(text, model, voice) {
  const res = await fetch(`${BASE}/api/tts`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, text, voice }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`speak ${res.status}: ${err.slice(0, 300)}`);
  }
  const ct = res.headers.get('content-type') || '';

  let audioUrl = null;
  if (res.status === 202 || (ct.includes('application/json') && !audioUrl)) {
    // async model: poll status until completed
    const ticket = await res.json();
    if (ticket.audioUrl) {
      audioUrl = ticket.audioUrl;
    } else {
      const qs = new URLSearchParams({ runId: ticket.runId, model: ticket.model });
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const st = await fetch(`${BASE}/api/tts/status?${qs}`, { headers: { 'x-api-key': apiKey() } });
        const s = await st.json();
        if (s.status === 'completed' && s.audioUrl) { audioUrl = s.audioUrl; break; }
        if (s.status === 'error') throw new Error(`tts job failed: ${s.error || 'unknown'}`);
      }
    }
    if (!audioUrl) throw new Error('tts polling timed out');
    const audio = await fetch(audioUrl);
    return Buffer.from(await audio.arrayBuffer());
  }
  return Buffer.from(await res.arrayBuffer());
}

// File -> data URL for media inputs (imageDataUrl / audioDataUrl / videoDataUrl).
function dataUrl(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
                 mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
                 mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }[ext] || 'application/octet-stream';
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

// Normalized Image API: text-to-image and image-to-image/edit. Returns image bytes.
// opts: { input_references: [dataUrl|url], aspect_ratio, resolution, n, ... }
async function imageGen(model, prompt, opts = {}) {
  const res = await fetch(`${BASE}/api/v1/images`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, ...opts }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`imageGen ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const item = (data.data || data.images || [])[0] || {};
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  const url = item.url || item.image_url || data.url;
  if (!url) throw new Error(`imageGen: no image in response: ${JSON.stringify(data).slice(0, 300)}`);
  const img = await fetch(url);
  return Buffer.from(await img.arrayBuffer());
}

// Async video jobs: POST /api/generate-video -> poll /api/video/status -> bytes.
// payload: { model, prompt, imageDataUrl|imageUrl, videoDataUrl|videoUrl, audioDataUrl|audioUrl, duration, aspect_ratio, ... }
// onTick(statusObj) is called after each poll so callers can report progress.
async function video(payload, { pollMs = 8000, timeoutMs = 20 * 60 * 1000, onTick } = {}) {
  const res = await fetch(`${BASE}/api/generate-video`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`video ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);
  const runId = data.runId || data.id;
  if (!runId) throw new Error(`video: no runId in response: ${JSON.stringify(data).slice(0, 300)}`);

  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    const st = await fetch(`${BASE}/api/video/status?requestId=${encodeURIComponent(runId)}`,
      { headers: { 'x-api-key': apiKey() } });
    const s = await st.json();
    last = s;
    if (onTick) onTick(s);
    // unified shape: { data: { status: IN_QUEUE|IN_PROGRESS|COMPLETED|FAILED|CANCELED, output: { video: { url } } } }
    const d = s.data || s;
    const status = String(d.status || '').toLowerCase();
    if (status === 'completed' || status === 'complete' || status === 'succeeded' || status === 'success') {
      const url = d.output?.video?.url || d.output?.video_url || d.output?.url
        || d.videoUrl || d.video_url || d.url
        || d.video?.url || (d.videos && d.videos[0]?.url) || d.output;
      if (!url || typeof url !== 'string') throw new Error(`video completed but no URL found: ${JSON.stringify(s).slice(0, 400)}`);
      const vid = await fetch(url);
      return { buffer: Buffer.from(await vid.arrayBuffer()), runId, meta: s };
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
      throw new Error(`video job failed: ${d.error || d.message || JSON.stringify(s).slice(0, 400)}`);
    }
  }
  throw new Error(`video polling timed out; last status: ${JSON.stringify(last).slice(0, 300)}`);
}

async function balance() {
  const res = await fetch(`${BASE}/api/check-balance`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey() },
  });
  return res.json();
}

module.exports = { chat, transcribe, speak, imageGen, video, dataUrl, balance };
