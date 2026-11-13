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
  if (ct.includes('application/json')) {
    // some providers return { audioUrl } instead of raw audio
    const data = await res.json();
    const audio = await fetch(data.audioUrl);
    return Buffer.from(await audio.arrayBuffer());
  }
  return Buffer.from(await res.arrayBuffer());
}

async function balance() {
  const res = await fetch(`${BASE}/api/check-balance`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey() },
  });
  return res.json();
}

module.exports = { chat, transcribe, speak, balance };
