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
app.set('trust proxy', true);
app.use(express.json({ limit: '5mb' }));

// --- auth: passphrase login + session cookie (single-user studio) ---
const crypto = require('crypto');
const APP_PASSWORD = fs.readFileSync(path.join(ROOT, '.secrets', 'app-password'), 'utf8').trim();
const SESSIONS_FILE = path.join(ROOT, '.secrets', 'sessions.json');
const OTP_FILE = path.join(ROOT, '.secrets', 'otp.json');
const RESEND_FILE = path.join(ROOT, '.secrets', 'resend');
const ALLOWED_FILE = path.join(ROOT, '.secrets', 'allowed-emails');
const readSecretFile = p => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };
const allowedEmails = () => readSecretFile(ALLOWED_FILE).split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days
const TTS_VOICE = readSecretFile(path.join(ROOT, '.secrets', MODELS.tts_voice_secret || '')) || MODELS.tts_voice;
let sessions = new Set();
try { sessions = new Set(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))); } catch {}
const saveSessions = () => fs.writeFileSync(SESSIONS_FILE, JSON.stringify([...sessions]));
const loginFails = new Map(); // ip -> {count, until}

function cookieToken(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)session=([a-f0-9]+)/);
  return m ? m[1] : null;
}

app.use((req, res, next) => {
  const open = req.path === '/' || req.path === '/login' || req.path === '/api/login'
    || req.path === '/api/otp/request' || req.path === '/api/otp/verify'
    || req.path === '/clips' || req.path === '/api/clips'
    || req.path === '/reelenderlogo.png' || req.path === '/reelenderlogosq.png'
    || req.path.startsWith('/clips-media/');
  if (open) return next();
  const token = cookieToken(req);
  if (token && sessions.has(token)) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/audio/')) return res.status(401).json({ error: 'sign in required' });
  res.redirect('/login');
});

// public landing = splash (logo + sample clips); full gallery at /clips; room behind auth at /room
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public', 'landing.html')));
app.get('/room', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(ROOT, 'public', 'login.html')));

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const f = loginFails.get(ip) || { count: 0, until: 0 };
  if (Date.now() < f.until) return res.status(429).json({ error: 'too many attempts' });
  if (req.body?.password !== APP_PASSWORD) {
    f.count++; f.until = f.count >= 5 ? Date.now() + 15 * 60 * 1000 : 0;
    loginFails.set(ip, f);
    return res.status(401).json({ error: 'wrong passphrase' });
  }
  loginFails.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.add(token);
  saveSessions();
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}; Path=/${secure}`);
  res.json({ ok: true });
});

// --- OTP login via Resend ---
function loadOtps() { try { return JSON.parse(fs.readFileSync(OTP_FILE, 'utf8')); } catch { return {}; } }
function saveOtps(o) { fs.writeFileSync(OTP_FILE, JSON.stringify(o)); }

function resendConfig() {
  const raw = readSecretFile(RESEND_FILE);
  const get = k => { const m = raw.match(new RegExp(`^${k}=(.*)$`, 'm')); return m ? m[1].trim() : ''; };
  return { key: get('RESEND_API_KEY'), domain: get('DOMAIN') };
}

async function sendOtpEmail(to, code) {
  const { key, domain } = resendConfig();
  if (!key) throw new Error('resend not configured');
  const from = `ReelEnder Studio <login@${domain || 'resend.dev'}>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `${code} — your ReelEnder sign-in code`,
      text: `Your ReelEnder Studio sign-in code is ${code}. It expires in 10 minutes.`,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`resend ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
}

const otpRequests = new Map(); // rate limit: email -> timestamps
app.post('/api/otp/request', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email required' });
    if (!allowedEmails().includes(email)) return res.status(403).json({ error: 'not on the guest list' });
    const now = Date.now();
    const recent = (otpRequests.get(email) || []).filter(t => now - t < 60 * 60 * 1000);
    if (recent.length >= 5) return res.status(429).json({ error: 'too many codes requested — wait a bit' });
    recent.push(now); otpRequests.set(email, recent);
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const otps = loadOtps();
    otps[email] = { code, expires: now + 10 * 60 * 1000, attempts: 0 };
    saveOtps(otps);
    await sendOtpEmail(email, code);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'could not send code' });
  }
});

app.post('/api/otp/verify', (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  const code = (req.body?.code || '').trim();
  const otps = loadOtps();
  const entry = otps[email];
  if (!entry || Date.now() > entry.expires) return res.status(401).json({ error: 'code expired — request a new one' });
  if (entry.attempts >= 5) { delete otps[email]; saveOtps(otps); return res.status(429).json({ error: 'too many tries — request a new code' }); }
  if (entry.code !== code) { entry.attempts++; saveOtps(otps); return res.status(401).json({ error: 'wrong code' }); }
  delete otps[email]; saveOtps(otps);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.add(token); saveSessions();
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}; Path=/${secure}`);
  res.json({ ok: true });
});
// --- end OTP ---

app.post('/api/logout', (req, res) => {
  const token = cookieToken(req);
  if (token) { sessions.delete(token); saveSessions(); }
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Max-Age=0; Path=/');
  res.json({ ok: true });
});
// --- end auth ---

app.use(express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }));
// cache policy: HTML revalidates every visit, media can cache hard
app.use((req, res, next) => {
  res.setHeader('Cache-Control', /^\/(clips-media|joke-audio|audio)\//.test(req.path) ? 'public, max-age=86400' : 'no-cache');
  next();
});
app.use(express.static(path.join(ROOT, 'public')));
app.use('/audio', express.static(AUDIO_DIR));

const PORT = process.env.PORT || 3100;
const HOST = process.env.HOST || '127.0.0.1';

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
      const ext = { 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
                    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
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
    fs.writeFileSync(path.join(AUDIO_DIR, audioFile), await ng.speak(replyText, MODELS.tts, TTS_VOICE));
    const audioUrl = `/audio/${audioFile}`;

    appendTurn('assistant', replyText, { audio: audioUrl, cost: reply.cost });

    res.json({ userText, replyText, audioUrl, cost: reply.cost });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// --- joke factory ---
const JF_DIR = path.join(ROOT, 'projects', 'joke-factory');
const JF_AUDIO = path.join(JF_DIR, 'audio');
const ACCEPTED_F = path.join(JF_DIR, 'accepted.jsonl');
const REJECTED_F = path.join(JF_DIR, 'rejected.jsonl');
const PENDING_F = path.join(JF_DIR, 'pending.json');
fs.mkdirSync(JF_AUDIO, { recursive: true });
const SCOUT = fs.readFileSync(path.join(ROOT, 'config', 'joke_scout_prompt.md'), 'utf8');
app.use('/joke-audio', express.static(JF_AUDIO));

// --- public gallery: finished clips + joke text + social links ---
const CLIPS_DIR = path.join(JF_DIR, 'clips');
const CLIPS_JSON = path.join(CLIPS_DIR, 'clips.json');
fs.mkdirSync(CLIPS_DIR, { recursive: true });
app.use('/clips-media', express.static(CLIPS_DIR));
app.get('/clips', (req, res) => res.sendFile(path.join(ROOT, 'public', 'gallery.html')));
app.get('/api/clips', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(CLIPS_JSON, 'utf8'))); } catch { res.json([]); }
});

const readJsonl = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const appendJsonl = (f, o) => fs.appendFileSync(f, JSON.stringify(o) + '\n');
const loadPending = () => { try { return JSON.parse(fs.readFileSync(PENDING_F, 'utf8')); } catch { return []; } };
const savePending = p => fs.writeFileSync(PENDING_F, JSON.stringify(p));
const writeJsonl = (f, l) => fs.writeFileSync(f, l.map(j => JSON.stringify(j)).join('\n') + (l.length ? '\n' : ''));
const stores = {
  pending:  { load: loadPending,              save: savePending },
  accepted: { load: () => readJsonl(ACCEPTED_F), save: l => writeJsonl(ACCEPTED_F, l) },
  rejected: { load: () => readJsonl(REJECTED_F), save: l => writeJsonl(REJECTED_F, l) },
};
const findInStores = id => {
  for (const [name, s] of Object.entries(stores)) {
    const list = s.load();
    const i = list.findIndex(j => j.id === id);
    if (i !== -1) return { name, list, i };
  }
  return null;
};
const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const seenSet = () => new Set([...readJsonl(ACCEPTED_F), ...readJsonl(REJECTED_F)].map(j => norm(j.text)));
const findJoke = id => [...loadPending(), ...readJsonl(ACCEPTED_F)].find(j => j.id === id);

app.get('/api/jokes', (req, res) => res.json({
  accepted: readJsonl(ACCEPTED_F),
  rejected: readJsonl(REJECTED_F),
  rejected_count: readJsonl(REJECTED_F).length,
  pending: loadPending(),
}));

app.post('/api/jokes/fetch', async (req, res) => {
  try {
    const count = Math.min(Math.max(parseInt(req.body?.count) || 3, 1), 10);
    const direction = loadTranscript().filter(e => e.role === 'user').slice(-4).map(e => e.text).join(' | ');
    const rejectedSample = readJsonl(REJECTED_F).slice(-25).map(j => j.text);
    const seen = seenSet();
    const prompt = `Director's recent notes: ${direction || 'none yet — bring a variety'}.\n`
      + `Already-seen jokes to avoid (rejected sample): ${JSON.stringify(rejectedSample)}.\n`
      + `Bring me ${count} new jokes.`;
    const reply = await ng.chat([
      { role: 'system', content: SCOUT },
      { role: 'user', content: prompt },
    ], MODELS.producer_brain);
    const m = reply.text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('scout returned no JSON');
    const jokes = JSON.parse(m[0]).jokes || [];
    const pending = loadPending();
    const fresh = jokes.map(t => String(t).trim()).filter(t => t && !seen.has(norm(t)));
    const out = fresh.map(text => {
      const j = { id: crypto.randomBytes(8).toString('hex'), text, ts: new Date().toISOString() };
      pending.push(j); return j;
    });
    savePending(pending);
    res.json({ jokes: out, dropped: jokes.length - out.length, cost: reply.cost });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/jokes/edit', (req, res) => {
  const { id, text } = req.body || {};
  if (!id || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'id and text required' });
  const hit = findInStores(id);
  if (!hit) return res.status(404).json({ error: 'joke not found' });
  hit.list[hit.i].text = text.trim();
  delete hit.list[hit.i].audio; // cached audio no longer matches the edited text
  stores[hit.name].save(hit.list);
  res.json({ ok: true, joke: hit.list[hit.i] });
});

app.post('/api/jokes/delete', (req, res) => {
  const hit = findInStores(req.body?.id);
  if (!hit) return res.status(404).json({ error: 'joke not found' });
  hit.list.splice(hit.i, 1);
  stores[hit.name].save(hit.list);
  res.json({ ok: true });
});

app.post('/api/jokes/move', (req, res) => {
  const { id, to } = req.body || {};
  if (!stores[to]) return res.status(400).json({ error: 'to must be pending|accepted|rejected' });
  const hit = findInStores(id);
  if (!hit) return res.status(404).json({ error: 'joke not found' });
  const [joke] = hit.list.splice(hit.i, 1);
  stores[hit.name].save(hit.list);
  const target = stores[to].load();
  target.push(joke);
  stores[to].save(target);
  res.json({ ok: true, from: hit.name, to });
});

app.post('/api/jokes/produce', (req, res) => {
  const { id, produced } = req.body || {};
  const list = readJsonl(ACCEPTED_F);
  const i = list.findIndex(j => j.id === id);
  if (i === -1) return res.status(404).json({ error: 'joke not in kept list' });
  list[i].produced = !!produced;
  writeJsonl(ACCEPTED_F, list);
  res.json({ ok: true, produced: list[i].produced });
});

app.post('/api/jokes/decide', (req, res) => {
  const { id, decision } = req.body || {};
  const pending = loadPending();
  const i = pending.findIndex(j => j.id === id);
  if (i === -1) return res.status(404).json({ error: 'joke not pending' });
  const [joke] = pending.splice(i, 1);
  savePending(pending);
  appendJsonl(decision === 'accepted' ? ACCEPTED_F : REJECTED_F, joke);
  res.json({ ok: true, decision });
});

app.post('/api/jokes/speak', async (req, res) => {
  try {
    const joke = findJoke(req.body?.id);
    if (!joke) return res.status(404).json({ error: 'joke not found' });
    if (joke.audio) return res.json({ audioUrl: joke.audio });
    const audioFile = `joke-${joke.id}.mp3`;
    fs.writeFileSync(path.join(JF_AUDIO, audioFile), await ng.speak(joke.text, MODELS.tts, TTS_VOICE));
    joke.audio = `/joke-audio/${audioFile}`;
    const pending = loadPending();
    const i = pending.findIndex(j => j.id === joke.id);
    if (i !== -1) { pending[i] = joke; savePending(pending); }
    res.json({ audioUrl: joke.audio });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});
// --- end joke factory ---

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

app.listen(PORT, HOST, () => console.log(`writers' room: http://${HOST}:${PORT}`));
