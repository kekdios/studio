// ReelEnder Studio — writers' room prototype server.
// Express serves the page and proxies nano-gpt for STT / chat / TTS.
const express = require('express');
const fs = require('fs');
const path = require('path');
const ng = require('./nanogpt');

const ROOT = path.join(__dirname, '..');
const MODELS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'models.json'), 'utf8'));
const PERSONA = fs.readFileSync(path.join(ROOT, 'config', 'producer_prompt.md'), 'utf8');

const SESSION_DIR = path.join(ROOT, 'projects', 'writers-room');
const AUDIO_DIR = path.join(SESSION_DIR, 'audio');
const TRANSCRIPT = path.join(SESSION_DIR, 'transcript.jsonl');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/audio', express.static(AUDIO_DIR));

const PORT = process.env.PORT || 3100;

function appendTurn(role, text, extra = {}) {
  const entry = { ts: new Date().toISOString(), role, text, ...extra };
  fs.appendFileSync(TRANSCRIPT, JSON.stringify(entry) + '\n');
  return entry;
}

function loadTranscript() {
  if (!fs.existsSync(TRANSCRIPT)) return [];
  return fs.readFileSync(TRANSCRIPT, 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function historyForModel() {
  return [
    { role: 'system', content: PERSONA },
    ...loadTranscript()
      .filter(e => e.role === 'user' || e.role === 'assistant')
      .map(e => ({ role: e.role, content: e.text })),
  ];
}

// One full conversational turn: audio OR text in → { userText, replyText, audioUrl } out.
app.post('/api/turn', async (req, res) => {
  try {
    let userText;
    let userAudio = null;

    if (Buffer.isBuffer(req.body) && req.body.length) {
      // voice input: raw audio body
      const mime = req.headers['content-type'] || 'audio/webm';
      const ext = { 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
                    'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav' }[mime.split(';')[0]] || 'webm';
      const filename = `user-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(AUDIO_DIR, filename), req.body);
      userAudio = `/audio/${filename}`;
      const t = await ng.transcribe(req.body, filename, MODELS.stt, mime);
      userText = t.text.trim();
      if (!userText) return res.json({ userText: '', replyText: '', note: 'empty transcript' });
    } else if (req.body && typeof req.body.text === 'string' && req.body.text.trim()) {
      userText = req.body.text.trim();
    } else {
      return res.status(400).json({ error: 'no audio or text provided' });
    }

    appendTurn('user', userText, userAudio ? { audio: userAudio } : {});

    const reply = await ng.chat(historyForModel(), MODELS.producer_brain);
    const replyText = reply.text.trim();

    const audioFile = `reply-${Date.now()}.mp3`;
    fs.writeFileSync(path.join(AUDIO_DIR, audioFile), await ng.speak(replyText, MODELS.tts, MODELS.tts_voice));
    const audioUrl = `/audio/${audioFile}`;

    appendTurn('assistant', replyText, { audio: audioUrl, cost: reply.cost });

    res.json({ userText, replyText, audioUrl, cost: reply.cost });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/transcript', (req, res) => res.json(loadTranscript()));

app.post('/api/session/new', (req, res) => {
  if (fs.existsSync(TRANSCRIPT)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(TRANSCRIPT, path.join(SESSION_DIR, `transcript-${stamp}.jsonl`));
  }
  res.json({ ok: true });
});

app.get('/api/balance', async (req, res) => {
  try { res.json(await ng.balance()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`writers' room: http://localhost:${PORT}`));
