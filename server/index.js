// ReelEnder Studio — writers' room prototype server.
// Express serves the page and proxies nano-gpt for STT / chat / TTS.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
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
    || req.path === '/clips' || req.path === '/api/clips' || req.path === '/api/clips/vote'
    || req.path === '/reelenderlogo.png' || req.path === '/reelenderlogosq.png'
    || req.path.startsWith('/clips-media/');
  if (open) return next();
  const token = cookieToken(req);
  if (token && sessions.has(token)) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/audio/')) return res.status(401).json({ error: 'sign in required' });
  res.redirect('/login');
});

// public landing = splash (logo + sample clips); full gallery at /clips; room behind auth at /room
app.get('/', (req, res) => { trackVisit(req); res.sendFile(path.join(ROOT, 'public', 'landing.html')); });
app.get('/room', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.get('/stats', (req, res) => res.sendFile(path.join(ROOT, 'public', 'stats.html')));
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
  const html = `
  <div style="background:#f2f2f7; padding:40px 16px; font-family:-apple-system,Helvetica,Arial,sans-serif;">
    <div style="max-width:420px; margin:0 auto; background:#ffffff; border-radius:12px; padding:32px 28px; box-shadow:0 1px 4px rgba(0,0,0,.08);">
      <h1 style="margin:0 0 20px; text-align:center; font-size:22px; font-weight:700; color:#ff7a18;">ReelEnder</h1>
      <hr style="border:none; border-top:1px solid #e5e5ea; margin:0 0 20px;">
      <p style="margin:0 0 12px; font-size:15px; color:#333;">Dear Joke Curator,</p>
      <p style="margin:0 0 18px; font-size:15px; color:#333;">Your one-time sign-in code is:</p>
      <div style="text-align:center; font-size:34px; font-weight:700; letter-spacing:6px; color:#2d7a4f; margin:0 0 18px;">${code}</div>
      <p style="margin:0 0 16px; font-size:13px; color:#555; line-height:1.5;">Use this code to complete your sign-in. It expires in <strong>10 minutes</strong> — please don't share it with anyone.</p>
      <p style="margin:0 0 24px; font-size:13px; color:#555;">Thank you for keeping Jacob's material safe.</p>
      <p style="margin:0; text-align:center; font-size:11px; color:#999;">© 2026 ReelEnder · <a href="https://reelender.com" style="color:#999;">reelender.com</a></p>
    </div>
  </div>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `${code} — your ReelEnder sign-in code`,
      text: `Your ReelEnder sign-in code is ${code}. It expires in 10 minutes — don't share it with anyone.`,
      html,
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

app.get('/api/stats', (req, res) => {
  res.json({ visits: loadJson(VISITS_F), votes: loadJson(VOTES_F) });
});

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

// --- public stats: votes + visits, keyed by hashed IP (raw IPs never stored) ---
const VOTES_F = path.join(JF_DIR, 'votes.json');
const VISITS_F = path.join(JF_DIR, 'visits.json');
const loadJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const saveJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
const ipHash = ip => crypto.createHash('sha256').update('reelender-salt:' + (ip || '?')).digest('hex').slice(0, 16);
const trackVisit = req => {
  const v = loadJson(VISITS_F);
  const h = ipHash(req.ip);
  const e = v[h] || { count: 0, first: new Date().toISOString() };
  e.count++; e.last = new Date().toISOString();
  v[h] = e;
  saveJson(VISITS_F, v);
  // one-time geo lookup per new visitor — raw IP used in memory only, never stored
  if (!e.geoTried) {
    e.geoTried = true;
    saveJson(VISITS_F, v);
    fetch(`http://ip-api.com/json/${encodeURIComponent(req.ip)}?fields=status,country,countryCode,city`)
      .then(r => r.json())
      .then(g => {
        const vv = loadJson(VISITS_F);
        if (vv[h] && g.status === 'success') {
          vv[h].country = g.country; vv[h].countryCode = g.countryCode; vv[h].city = g.city;
          saveJson(VISITS_F, vv);
        }
      }).catch(() => {});
  }
};
const clipVotes = id => {
  const mine = loadJson(VOTES_F)[id] || {};
  return { up: Object.values(mine).filter(v => v === 'up').length,
           down: Object.values(mine).filter(v => v === 'down').length };
};

app.get('/clips', (req, res) => { trackVisit(req); res.sendFile(path.join(ROOT, 'public', 'gallery.html')); });
app.get('/api/clips', (req, res) => {
  try {
    const h = ipHash(req.ip);
    const allVotes = loadJson(VOTES_F);
    const clips = JSON.parse(fs.readFileSync(CLIPS_JSON, 'utf8'));
    for (const c of clips) { c.votes = clipVotes(c.id); c.myVote = allVotes[c.id]?.[h] || null; }
    res.json(clips);
  } catch { res.json([]); }
});
app.post('/api/clips/vote', (req, res) => {
  const { id, vote } = req.body || {};
  if (!id || !['up', 'down'].includes(vote)) return res.status(400).json({ error: 'id + vote(up|down) required' });
  try {
    const clips = JSON.parse(fs.readFileSync(CLIPS_JSON, 'utf8'));
    if (!clips.some(c => c.id === id)) return res.status(404).json({ error: 'unknown clip' });
  } catch { return res.status(500).json({ error: 'clips unavailable' }); }
  const h = ipHash(req.ip);
  const all = loadJson(VOTES_F);
  const mine = all[id] || {};
  const prev = mine[h];
  let result;
  if (prev === vote) { delete mine[h]; result = 'removed'; }
  else { mine[h] = vote; result = prev ? 'changed' : 'voted'; }
  all[id] = mine;
  saveJson(VOTES_F, all);
  res.json({ ok: true, result, votes: clipVotes(id), myVote: mine[h] || null });
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
const wordSet = s => new Set(norm(s).split(' ').filter(Boolean));
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
};
// fuzzy dupe check: best vault match (kept + tossed + pending) for a candidate
const bestMatch = text => {
  const cand = wordSet(text);
  let best = null;
  for (const [where, list] of [['kept', readJsonl(ACCEPTED_F)], ['tossed', readJsonl(REJECTED_F)], ['pending', loadPending()]]) {
    for (const j of list) {
      const score = jaccard(cand, wordSet(j.text));
      if (score > (best?.score || 0)) best = { score, text: j.text, where };
    }
  }
  return best && best.score >= 0.55 ? best : null;
};
const seenSet = () => new Set([...readJsonl(ACCEPTED_F), ...readJsonl(REJECTED_F)].map(j => norm(j.text)));
const findJoke = id => { const hit = findInStores(id); return hit ? hit.list[hit.i] : null; };

app.get('/api/jokes', (req, res) => {
  const mark = l => l.map(j => renderJobs.has(j.id) ? { ...j, render: renderJobs.get(j.id) } : j);
  res.json({
    accepted: mark(readJsonl(ACCEPTED_F)),
    rejected: readJsonl(REJECTED_F),
    rejected_count: readJsonl(REJECTED_F).length,
    pending: loadPending(),
  });
});

app.post('/api/jokes/fetch', async (req, res) => {
  try {
    const count = Math.min(Math.max(parseInt(req.body?.count) || 3, 1), 10);
    const direction = loadTranscript().filter(e => e.role === 'user').slice(-4).map(e => e.text).join(' | ');
    const rejectedSample = readJsonl(REJECTED_F).slice(-25).map(j => j.text);
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
    // no silent dropping: keep every candidate, but flag near-dupes so the director can compare
    const batchSets = [];
    const out = [];
    for (const t of jokes.map(t => String(t).trim()).filter(Boolean)) {
      const cand = wordSet(t);
      if (batchSets.some(s => jaccard(cand, s) >= 0.8)) continue; // same joke twice in one batch
      batchSets.push(cand);
      const j = { id: crypto.randomBytes(8).toString('hex'), text: t, ts: new Date().toISOString() };
      const sim = bestMatch(t);
      if (sim) j.similar = sim;
      pending.push(j); out.push(j);
    }
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

app.post('/api/jokes/add', (req, res) => {
  const { text, to } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text required' });
  if (to !== 'accepted' && to !== 'rejected') return res.status(400).json({ error: 'to must be accepted|rejected' });
  if (seenSet().has(norm(text))) return res.status(409).json({ error: 'already in the vault' });
  const joke = { id: crypto.randomBytes(8).toString('hex'), text: text.trim(), ts: new Date().toISOString(), manual: true };
  const list = stores[to].load();
  list.push(joke);
  stores[to].save(list);
  res.json({ ok: true, joke });
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
    const hit = findInStores(joke.id);
    if (hit) { hit.list[hit.i].audio = joke.audio; stores[hit.name].save(hit.list); }
    res.json({ audioUrl: joke.audio });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// --- phase 3: joke -> clip pipeline (gated) ---
// voice -> prompt -> 4 scene stills (gate: pick or edit prompt) -> OmniHuman render
// (gate: publish or bin) -> clips/ + poster + clips.json + produced flag.
const RENDERS_DIR = path.join(JF_DIR, 'renders');
const RENDER_JOBS_F = path.join(RENDERS_DIR, 'jobs.json');
const JACOB_FRONT = path.join(JF_DIR, 'jacob', 'jacob-front.png');
const JACOB_LOOK = 'the man in the photo — keep his face, black beanie, grey zip-up hoodie over bright orange top, blue/black hydration vest, black cargo shorts, bright blue leggings, neon trail runners exactly identical';
const FRAMINGS = {
  full: 'full-body head-to-toe shot — his neon trail runners clearly visible in frame',
  waist: 'mid-shot from the thighs up',
};
const DEFAULT_SETTING = 'a dim concrete multi-storey car park at night, lit by cold fluorescent strips';
const DEFAULT_MOTION = 'The man tells the joke straight to camera, deadpan. Small natural head movements and one small hand gesture, static camera.';
const scenePrompt = (setting, framing) =>
  `Put ${JACOB_LOOK} standing in ${setting || DEFAULT_SETTING}. He faces the camera straight on, deadpan, ${FRAMINGS[framing] || FRAMINGS.full}, cinematic realism, vertical 9:16 framing.`;
fs.mkdirSync(RENDERS_DIR, { recursive: true });
app.use('/renders-media', express.static(RENDERS_DIR)); // authed: owner-only render artifacts

const renderJobs = new Map(); // jokeId -> job
const saveRenderJobs = () => {
  const flat = {};
  for (const [k, j] of renderJobs) flat[k] = j;
  fs.writeFileSync(RENDER_JOBS_F, JSON.stringify(flat, null, 1));
};
try {
  for (const [k, j] of Object.entries(JSON.parse(fs.readFileSync(RENDER_JOBS_F, 'utf8')))) {
    if (j.status === 'running') j.status = 'interrupted'; // server restarted mid-render
    renderJobs.set(k, j);
  }
} catch {}

function makePoster(mp4, jpg) {
  let r = spawnSync('ffmpeg', ['-y', '-i', mp4, '-frames:v', '1', '-q:v', '3', jpg], { timeout: 30000 });
  if (r.status === 0 && fs.existsSync(jpg)) return;
  spawnSync('qlmanage', ['-t', '-s', '1024', '-o', path.dirname(jpg), mp4], { timeout: 30000 });
  const gen = mp4 + '.png'; // qlmanage names it <file>.png
  if (fs.existsSync(gen)) fs.renameSync(gen, jpg);
}

const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const ACTIVE_STATUSES = new Set(['running', 'awaiting_scene', 'awaiting_publish']);
const jobDir = job => { const d = path.join(RENDERS_DIR, job.id); fs.mkdirSync(d, { recursive: true }); return d; };
const jobAudioPath = joke => path.join(JF_AUDIO, `joke-${joke.id}.mp3`);

async function jobVoice(job, joke) {
  job.step = 'voice'; saveRenderJobs();
  const audioPath = jobAudioPath(joke);
  if (!fs.existsSync(audioPath)) {
    fs.writeFileSync(audioPath, await ng.speak(joke.text, MODELS.tts, TTS_VOICE));
    const hit = findInStores(joke.id);
    if (hit) { hit.list[hit.i].audio = `/joke-audio/joke-${joke.id}.mp3`; stores[hit.name].save(hit.list); }
  }
  if (fs.statSync(audioPath).size * 8 / 128000 < 4)
    throw new Error('joke reads under 4 seconds — too short for the avatar model; add a beat with [pause]');
}

// 4 candidate stills from the same prompt — pick one at the gate
async function jobScenes(job) {
  job.step = 'stills'; saveRenderJobs();
  const dir = jobDir(job);
  for (const f of fs.readdirSync(dir)) if (f.startsWith('scene-')) fs.rmSync(path.join(dir, f), { force: true });
  const results = await Promise.allSettled([1, 2, 3, 4].map(i =>
    ng.imageGen(MODELS.scene_image, job.prompt,
      { input_references: [ng.dataUrl(JACOB_FRONT)], aspect_ratio: '9:16', resolution: '1k' })
      .then(bufs => fs.writeFileSync(path.join(dir, `scene-${i}.png`), bufs[0]))));
  const ok = results.filter(r => r.status === 'fulfilled').length;
  if (!ok) throw new Error('all 4 stills failed: ' + (results[0].reason?.message || 'unknown'));
  job.scenes = [1, 2, 3, 4]
    .map(i => fs.existsSync(path.join(dir, `scene-${i}.png`)) ? `/renders-media/${job.id}/scene-${i}.png` : null)
    .filter(Boolean);
}

async function jobRender(job, joke) {
  job.step = 'render'; saveRenderJobs();
  const v = await ng.video({
    model: MODELS.avatar_video,
    prompt: job.motion,
    imageDataUrl: ng.dataUrl(path.join(jobDir(job), path.basename(job.sceneUrl))),
    audioDataUrl: ng.dataUrl(jobAudioPath(joke)),
  });
  fs.writeFileSync(path.join(jobDir(job), 'final.mp4'), v.buffer);
  job.runId = v.runId;
  if (v.meta?.data?.cost != null) job.cost = v.meta.data.cost;
  job.clipPreview = `/renders-media/${job.id}/final.mp4`;
}

async function jobPublish(job, joke) {
  job.step = 'publish'; saveRenderJobs();
  const clips = JSON.parse(fs.readFileSync(CLIPS_JSON, 'utf8'));
  let clipId = 'jacob-' + slugify(joke.text.split(/\s+/).slice(0, 4).join(' ')).slice(0, 40);
  if (clips.some(c => c.id === clipId)) clipId += '-' + crypto.randomBytes(3).toString('hex');
  const mp4 = clipId + '.mp4', poster = clipId + '.jpg';
  fs.copyFileSync(path.join(jobDir(job), 'final.mp4'), path.join(CLIPS_DIR, mp4));
  makePoster(path.join(CLIPS_DIR, mp4), path.join(CLIPS_DIR, poster));
  clips.push({
    id: clipId,
    title: joke.text.split(/\s+/).slice(0, 5).join(' ').replace(/[[\]"']/g, '') + '…',
    file: mp4, joke: joke.text, poster,
    socials: { tiktok: '', instagram: '', youtube: '', x: '' },
    ts: new Date().toISOString().slice(0, 10),
  });
  fs.writeFileSync(CLIPS_JSON, JSON.stringify(clips, null, 2));
  const hit = findInStores(joke.id);
  if (hit && hit.name === 'accepted') {
    hit.list[hit.i].produced = true;
    hit.list[hit.i].clip = clipId;
    stores.accepted.save(hit.list);
  }
  job.clipId = clipId; job.clipUrl = '/clips';
}

const failJob = (job, e) => { console.error('render failed:', e); job.status = 'error'; job.error = e.message; saveRenderJobs(); };
const cancelled = job => job.status === 'cancelled';

// voice + 4 stills, then stop and wait for the director
async function toSceneGate(job, joke) {
  try {
    await jobVoice(job, joke);
    if (cancelled(job)) return;
    await jobScenes(job);
    if (cancelled(job)) return;
    job.status = 'awaiting_scene';
  } catch (e) { return failJob(job, e); }
  saveRenderJobs();
}

// avatar render, then stop and wait for publish/bin
async function toPublishGate(job, joke) {
  try {
    await jobRender(job, joke);
    if (cancelled(job)) return;
    job.status = 'awaiting_publish';
  } catch (e) { return failJob(job, e); }
  saveRenderJobs();
}

// free: compose the scene prompt so the director can edit before any spend
app.post('/api/jokes/render-preview', (req, res) => {
  const { setting, framing } = req.body || {};
  res.json({ prompt: scenePrompt((setting || '').trim() || DEFAULT_SETTING, framing), defaultMotion: DEFAULT_MOTION });
});

app.post('/api/jokes/render', async (req, res) => {
  const { id, prompt, setting, framing, motion } = req.body || {};
  const joke = findJoke(id);
  if (!joke) return res.status(404).json({ error: 'joke not found' });
  const existing = renderJobs.get(id);
  if (existing && ACTIVE_STATUSES.has(existing.status)) return res.status(409).json({ error: 'already in progress', job: existing });
  try {
    const bal = await ng.balance();
    if (Number(bal.usd_spendable_balance) < (MODELS.max_clip_cost || 3))
      return res.status(402).json({ error: `balance below per-clip cap ($${MODELS.max_clip_cost}) — top up nano-gpt` });
  } catch {}
  const job = {
    id: crypto.randomBytes(6).toString('hex'), jokeId: id, status: 'running', step: 'queued',
    prompt: (prompt || '').trim() || scenePrompt((setting || '').trim(), framing),
    motion: (motion || '').trim() || DEFAULT_MOTION,
    ts: new Date().toISOString(),
  };
  renderJobs.set(id, job);
  jobDir(job);
  saveRenderJobs();
  toSceneGate(job, joke);
  res.json({ ok: true, jobId: job.id });
});

app.post('/api/jokes/render-action', (req, res) => {
  const { jokeId, action, prompt, motion, pick } = req.body || {};
  const job = renderJobs.get(jokeId);
  if (!job) return res.status(404).json({ error: 'no render job for that joke' });
  const joke = findJoke(jokeId);
  if (!joke) return res.status(404).json({ error: 'joke not found' });
  if (motion != null && String(motion).trim()) job.motion = String(motion).trim();

  if (action === 'cancel') {
    if (!ACTIVE_STATUSES.has(job.status)) return res.status(409).json({ error: 'nothing running' });
    job.status = 'cancelled';
    saveRenderJobs();
    return res.json({ ok: true });
  }
  if (action === 'new-stills') {
    if (job.status !== 'awaiting_scene') return res.status(409).json({ error: 'not at the stills step' });
    if (prompt != null && String(prompt).trim()) job.prompt = String(prompt).trim();
    job.status = 'running'; saveRenderJobs();
    jobScenes(job)
      .then(() => { if (!cancelled(job)) job.status = 'awaiting_scene'; })
      .catch(e => failJob(job, e))
      .finally(saveRenderJobs);
    return res.json({ ok: true });
  }
  if (action === 'approve-scene') {
    if (job.status !== 'awaiting_scene') return res.status(409).json({ error: 'not at the stills step' });
    const scenes = job.scenes || [];
    const i = parseInt(pick);
    if (!scenes.length || !(i >= 0 && i < scenes.length)) return res.status(400).json({ error: 'pick a still first' });
    job.pick = i;
    job.sceneUrl = scenes[i];
    job.status = 'running'; saveRenderJobs();
    toPublishGate(job, joke);
    return res.json({ ok: true });
  }
  if (action === 'publish') {
    if (job.status !== 'awaiting_publish') return res.status(409).json({ error: 'nothing to publish' });
    job.status = 'running'; saveRenderJobs();
    jobPublish(job, joke)
      .then(() => { if (!cancelled(job)) job.status = 'done'; })
      .catch(e => failJob(job, e))
      .finally(saveRenderJobs);
    return res.json({ ok: true });
  }
  if (action === 'reject') {
    if (job.status !== 'awaiting_publish') return res.status(409).json({ error: 'nothing awaiting review' });
    job.status = 'rejected';
    saveRenderJobs();
    return res.json({ ok: true });
  }
  // walk backwards: scrap the take, keep the stills
  if (action === 'back') {
    const ok = job.status === 'awaiting_publish' || (['error', 'interrupted'].includes(job.status) && job.step === 'render');
    if (!ok) return res.status(409).json({ error: 'can only step back from the video step' });
    delete job.pick; delete job.sceneUrl; delete job.clipPreview; delete job.error;
    job.status = 'awaiting_scene';
    saveRenderJobs();
    return res.json({ ok: true });
  }
  // rerun whichever step died
  if (action === 'retry') {
    if (job.status !== 'error' && job.status !== 'interrupted') return res.status(409).json({ error: 'nothing to retry' });
    delete job.error;
    job.status = 'running'; saveRenderJobs();
    const again = job.step === 'render' ? toPublishGate(job, joke)
      : jobScenes(job).then(() => { if (!cancelled(job)) job.status = 'awaiting_scene'; saveRenderJobs(); });
    again.catch(e => failJob(job, e));
    return res.json({ ok: true });
  }
  // unpublish a live clip — pulls it off the wall, lands back at review
  if (action === 'unpublish') {
    if (job.status !== 'done' || !job.clipId) return res.status(409).json({ error: 'nothing published to unpublish' });
    const clips = JSON.parse(fs.readFileSync(CLIPS_JSON, 'utf8'));
    fs.writeFileSync(CLIPS_JSON, JSON.stringify(clips.filter(c => c.id !== job.clipId), null, 2));
    const hit = findInStores(jokeId);
    if (hit) { delete hit.list[hit.i].produced; delete hit.list[hit.i].clip; stores[hit.name].save(hit.list); }
    job.status = 'awaiting_publish';
    saveRenderJobs();
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'unknown action' });
});

app.get('/api/jokes/render-status', (req, res) => {
  const job = renderJobs.get(req.query.jokeId);
  if (!job) return res.json({ status: 'none' });
  res.json(job);
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
