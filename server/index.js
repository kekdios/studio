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
app.set('trust proxy', 'loopback');
app.use((req, res, next) => { if (req.method === 'POST') console.log(`POST ${req.path} @${new Date().toISOString().slice(11, 19)}`); next(); });
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
    || req.path.startsWith('/clips-media/') || req.path.startsWith('/share/');
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
    const wantsCards = /\[CARDS\]/i.test(reply.text);
    const replyText = reply.text.replace(/\[CARDS\]/gi, '').trim();

    // voice-triggered card fetch runs alongside TTS — no extra wait
    const [spoken, scouted] = await Promise.all([
      ng.speak(replyText, MODELS.tts, TTS_VOICE),
      wantsCards ? scoutCards(3).catch(e => { console.error('voice card fetch failed:', e.message); return null; }) : null,
    ]);

    const audioFile = `reply-${Date.now()}.mp3`;
    fs.writeFileSync(path.join(AUDIO_DIR, audioFile), spoken);
    const audioUrl = `/audio/${audioFile}`;

    appendTurn('assistant', replyText, { audio: audioUrl, cost: reply.cost });

    res.json({ userText, replyText, audioUrl, cost: reply.cost, jokes: scouted?.jokes });
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

async function scoutCards(count) {
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
  return { jokes: out, dropped: jokes.length - out.length, cost: reply.cost };
}

app.post('/api/jokes/fetch', async (req, res) => {
  try {
    const count = Math.min(Math.max(parseInt(req.body?.count) || 3, 1), 10);
    res.json(await scoutCards(count));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// --- experimental lab lane ---
// pure retrieval, two modes:
//   current — Grok mines recent "funniest tweets"/joke roundups (X-adjacent)
//   deadpan — mines quote archives for Steven Wright + Mitch Hedberg one-liners
// no rewriting: the card IS the found joke, verbatim, with attribution.
const LAB_MODES = {
  current: count =>
    `Search the web and X/Twitter-adjacent sources for short jokes getting high engagement RIGHT NOW: recent "funniest tweets" roundups, viral joke threads, humor accounts — within the last ~4 weeks, the more recent the better.\n\n` +
    `Pick ${count} that (a) work read ALOUD in 5–15 seconds — one or two sentences, no setup needing context, (b) are standalone (no thread, no image needed), (c) are clean enough for a general audience.\n\n` +
    `Always return what you find — if you cannot verify engagement or exact wording, still return the closest recent jokes and say so in a "note" field. Never return an empty list.\n\n` +
    `Return each joke VERBATIM — do not rewrite, improve, or clean up the wording. JSON only: {"note":"<any caveat, or null>","lines":[{"source":"<@handle or publication>","text":"<the joke exactly as published>"}]}`,
  deadpan: count =>
    `Search quote archives — Wikiquote, quote sites, fan transcripts, album/stand-up transcripts — for one-liners by STEVEN WRIGHT and MITCH HEDBERG. Both have large documented bodies of work online.\n\n` +
    `Pick ${count} jokes, roughly half from each comedian, favoring their less-quoted lines (skip "I used to do drugs. I still do, but I used to, too." — it's everywhere). Each must work read ALOUD in 5–15 seconds, standalone, clean enough for a general audience.\n\n` +
    `Always return what you find — if sourcing is thin, still return the best-attributed lines and say so in a "note" field. Never return an empty list.\n\n` +
    `Return each joke VERBATIM. JSON only: {"note":"<any caveat, or null>","lines":[{"comedian":"steven wright|mitch hedberg","source":"<site or special>","text":"<the joke exactly as performed>"}]}`,
};
async function labCards(count, mode = 'current') {
  const prompt = (LAB_MODES[mode] || LAB_MODES.current)(count);
  let reply;
  for (let attempt = 0; attempt < 3; attempt++) { // grok :online occasionally returns blank
    reply = await ng.chat([
    { role: 'system', content:
      `You are a joke researcher with web access. You retrieve REAL jokes, verbatim — you never write or improve them. ` +
      `You always say plainly when sources are thin instead of inventing quotes.` },
    { role: 'user', content: prompt },
    ], MODELS.joke_lab || 'x-ai/grok-4.7:online');
    if (/\{[\s\S]*\}/.test(reply.text || '')) break;
  }
  const m = reply.text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`lab returned no JSON${reply.text ? ': ' + reply.text.slice(0, 140) : ''}`);
  const parsed = JSON.parse(m[0]);
  const lines = (parsed.lines || []).filter(l => l?.text);
  if (!lines.length) throw new Error(`lab found no jokes${parsed.note ? ': ' + parsed.note.slice(0, 140) : ''}`);
  const pending = loadPending();
  const batchSets = [];
  const out = [];
  for (const l of lines) {
    const t = String(l.text).trim();
    const cand = wordSet(t);
    if (batchSets.some(s => jaccard(cand, s) >= 0.8)) continue;
    batchSets.push(cand);
    const j = { id: crypto.randomBytes(8).toString('hex'), text: t, ts: new Date().toISOString(),
      lab: true, mechanism: l.comedian || mode, premise: l.premise || null,
      source: [l.source, l.comedian].filter(Boolean).join(' · ') || null };
    const sim = bestMatch(t);
    if (sim) j.similar = sim;
    pending.push(j); out.push(j);
  }
  savePending(pending);
  return { jokes: out, dropped: lines.length - out.length, cost: reply.cost, note: parsed.note || null };
}

app.post('/api/jokes/lab', async (req, res) => {
  try {
    const count = Math.min(Math.max(parseInt(req.body?.count) || 4, 1), 8);
    res.json(await labCards(count, req.body?.mode === 'deadpan' ? 'deadpan' : 'current'));
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
  // kill every artifact built from the old text — audio takes + any live render downstream
  const invalidated = { audio: 0, render: false, unpublished: false };
  for (const f of fs.readdirSync(JF_AUDIO)) {
    if (f.startsWith(`joke-${id}`)) { fs.rmSync(path.join(JF_AUDIO, f), { force: true }); invalidated.audio++; }
  }
  const job = renderJobs.get(id);
  if (job) {
    invalidated.render = true;
    for (const f of ['final.mp4', 'final-captioned.mp4', 'final-edited.mp4', 'final-edited-captioned.mp4'])
      fs.rmSync(path.join(RENDERS_DIR, job.id, f), { force: true });
    delete job.captionTemplate; delete job.captionOpts; delete job.editPrompt; delete job.workFile; delete job.ccFile;
    delete job.clipPreview; delete job.runId; delete job.renderDone; delete job.error;
    if (job.status === 'done' && job.clipId) { // pull the live clip(s) — they play the old text
      const clips = JSON.parse(fs.readFileSync(CLIPS_JSON, 'utf8'));
      const dead = clips.filter(c => c.id === job.clipId || c.id === job.clipId + '-cc');
      fs.writeFileSync(CLIPS_JSON, JSON.stringify(clips.filter(c => c.id !== job.clipId && c.id !== job.clipId + '-cc'), null, 2));
      for (const d of dead) {
        fs.rmSync(path.join(CLIPS_DIR, d.file), { force: true });
        fs.rmSync(path.join(CLIPS_DIR, d.poster), { force: true });
      }
      delete hit.list[hit.i].produced; delete hit.list[hit.i].clip;
      delete job.clipId; delete job.clipUrl;
      invalidated.unpublished = true;
    }
    job.status = 'cancelled';
    job.note = 'joke edited — downstream audio and video invalidated';
    saveRenderJobs();
  }
  stores[hit.name].save(hit.list);
  res.json({ ok: true, joke: hit.list[hit.i], invalidated });
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
    if (joke.audio && fs.existsSync(path.join(JF_AUDIO, path.basename(joke.audio)))) return res.json({ audioUrl: joke.audio });
    const audioFile = path.basename(jobAudioPath(joke));
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
const JACOB_DIR = path.join(JF_DIR, 'jacob');
const JACOB_FRONT = path.join(JACOB_DIR, 'jacob-front.png');
const JACOB_FACE = 'the man in the photo — keep his face exactly identical';
// wardrobe is compiled from the framing — a waist-up crop must never mention shoes
const FRAMINGS = {
  'full-body': {
    must: 'black beanie, grey zip-up hoodie over bright orange top, blue/black hydration vest, black cargo shorts, bright blue leggings, neon trail runners',
    shot: 'full-body head-to-toe shot — his neon trail runners clearly visible in frame',
    never: '',
  },
  'waist-up': {
    must: 'black beanie, grey zip-up hoodie over bright orange top, blue/black hydration vest',
    shot: 'waist-up shot, his face about a third of the frame height, beanie fully on his head',
    never: 'Do not show or mention anything below the waist — no shorts, leggings, or shoes.',
  },
};
const ORIENTS = { vertical: '9:16', horizontal: '16:9' };
const ORIENT_WORDS = { '9:16': 'vertical 9:16', '16:9': 'horizontal 16:9' };
const DEFAULT_SETTING = 'a dim concrete multi-storey car park at night, lit by cold fluorescent strips';
const DEFAULT_MOTION = 'The man tells the joke straight to camera, deadpan. Small natural head movements and one small hand gesture, static camera.';
const scenePrompt = (setting, orient, framing = 'full-body') => {
  const f = FRAMINGS[framing] || FRAMINGS['full-body'];
  return `Put ${JACOB_FACE}, wearing ${f.must} exactly identical, standing in ${setting || DEFAULT_SETTING}. He faces the camera straight on, deadpan, ${f.shot}, cinematic realism, ${ORIENT_WORDS[orient] || ORIENT_WORDS['9:16']} framing.${f.never ? ' ' + f.never : ''}`;
};

// uncensored model drafts scene + motion from the joke itself; director edits before any spend
// joke lab is the fallback if the first model returns nothing usable
async function aiPrompt(joke, settingHint, orient, framing) {
  const words = ORIENT_WORDS[orient] || ORIENT_WORDS['9:16'];
  const f = FRAMINGS[framing] || FRAMINGS['full-body'];
  const messages = [
    { role: 'system', content: `You write prompts for a recurring video character's daily joke clips.

The character is LOCKED. Every "scene" prompt must begin with this exact identity clause:
"Put the man in the photo — keep his face exactly identical, wearing ${f.must} exactly identical"

Output JSON only, no other text: {"scene": "...", "motion": "..."}

scene: continue the identity clause with " standing in <SETTING THAT VISUALIZES THE JOKE>" — the place and objects the joke is ABOUT should appear around him (library shelves for a librarian joke, a shoe shop for a shoes joke). He faces the camera straight on, mid-delivery, deadpan. Frame: ${f.shot}.${f.never ? ' ' + f.never : ''} End with ", cinematic realism, ${words} framing." One paragraph, plain text, no quotes inside.

motion: ONE short animation direction for an audio-driven talking-avatar model. He tells the joke deadpan to camera, plus ONE concrete gesture timed to a word or object in THIS joke (point at it, look down at it, hold it up, glance behind him). Small and natural, static camera. One or two sentences, plain text.` },
    { role: 'user', content: `Joke: ${joke.text}${settingHint ? `\nSetting the director suggested: ${settingHint} — use or adapt it.` : '\nPick whichever setting suits the joke best.'}` },
  ];
  const models = [...new Set([MODELS.prompt_draft_fallback, MODELS.joke_lab].map(m => (m || '').replace(/:online.*$/, '')))].filter(Boolean);
  for (const model of models) {
    try {
      const r = await ng.chat(messages, model);
      const d = JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] || '{}');
      if (d.scene && d.motion) return d;
    } catch {}
  }
  throw new Error('no model drafted a prompt');
}
fs.mkdirSync(RENDERS_DIR, { recursive: true });
app.use('/renders-media', express.static(RENDERS_DIR)); // authed: owner-only render artifacts

// --- still bank: director-approved scenes, reused instead of regenerating Jacob daily ---
const BANK_DIR = path.join(JACOB_DIR, 'still-bank');
const BANK_JSON = path.join(BANK_DIR, 'bank.json');
fs.mkdirSync(BANK_DIR, { recursive: true });
app.use('/jacob-media', express.static(JACOB_DIR)); // authed: character refs + bank stills
const loadBank = () => { try { return JSON.parse(fs.readFileSync(BANK_JSON, 'utf8')); } catch { return []; } };
const saveBank = b => fs.writeFileSync(BANK_JSON, JSON.stringify(b, null, 1));
const bankEntry = id => loadBank().find(b => b.id === id);

const renderJobs = new Map(); // jokeId -> job
const saveRenderJobs = () => {
  const flat = {};
  for (const [k, j] of renderJobs) flat[k] = j;
  fs.writeFileSync(RENDER_JOBS_F, JSON.stringify(flat, null, 1));
};
try {
  for (const [k, j] of Object.entries(JSON.parse(fs.readFileSync(RENDER_JOBS_F, 'utf8')))) {
    if (j.status === 'running') j.status = 'interrupted'; // server restarted mid-render
    if (j.error) j.error = friendlyError({ message: j.error }, j); // re-translate stored raw dumps
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
const ACTIVE_STATUSES = new Set(['running', 'awaiting_scene', 'awaiting_publish', 'awaiting_fallback']);
const jobDir = job => { const d = path.join(RENDERS_DIR, job.id); fs.mkdirSync(d, { recursive: true }); return d; };
// audio files are keyed by content hash — an edited joke can never collide with its stale take
const audioHash = joke => crypto.createHash('sha256').update(`${joke.text}|${TTS_VOICE}|${MODELS.tts}`).digest('hex').slice(0, 10);
const jobAudioPath = joke => path.join(JF_AUDIO, `joke-${joke.id}-${audioHash(joke)}.mp3`);

// real duration: ffprobe on the droplet, afinfo on macOS, size estimate as last resort
function probeDuration(file) {
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 15000 });
    const d = parseFloat(String(r.stdout).trim());
    if (d > 0) return d;
  } catch {}
  try {
    const r = spawnSync('afinfo', [file], { timeout: 15000 });
    const m = String(r.stdout).match(/estimated duration:\s*([\d.]+)/);
    if (m) return parseFloat(m[1]);
  } catch {}
  try { return fs.statSync(file).size * 8 / 128000; } catch { return 0; }
}
const audioSecs = joke => probeDuration(jobAudioPath(joke));
// OmniHuman wants 4–300s — shorter reads need the LongCat backup, and that's the director's call
const OMNI_MIN_SECS = 4;
const OMNI_MAX_SECS = 300;

async function jobVoice(job, joke) {
  job.step = 'voice'; job.stepStarted = new Date().toISOString(); saveRenderJobs();
  const audioPath = jobAudioPath(joke);
  if (!fs.existsSync(audioPath)) {
    fs.writeFileSync(audioPath, await ng.speak(joke.text, MODELS.tts, TTS_VOICE));
    const hit = findInStores(joke.id);
    if (hit) { hit.list[hit.i].audio = `/joke-audio/${path.basename(audioPath)}`; stores[hit.name].save(hit.list); }
  }
  const secs = probeDuration(audioPath);
  if (secs < 2)
    throw new Error(`joke reads ~${secs.toFixed(1)}s — too short even for the backup avatar; add a beat with [pause]`);
}

// stills step: generate 4 fresh stills from the direction prompt (director's default).
// the bank stays available as an opt-in via the 'use-bank' render action.
async function jobStills(job) {
  await jobScenes(job);
}

// swap the gate to bank stills — free, director-triggered
function offerBank(job) {
  const bank = loadBank()
    .filter(b => b.approved !== false && fs.existsSync(path.join(BANK_DIR, b.file)))
    .sort((a, b) => String(a.lastUsed || '').localeCompare(String(b.lastUsed || ''))); // least-used first
  if (!bank.length) throw new Error('still bank is empty');
  job.scenes = bank.map(b => `/jacob-media/still-bank/${b.file}`);
  job.sceneBankIds = bank.map(b => b.id);
  job.sceneSource = 'bank';
  delete job.pick; delete job.sceneUrl; delete job.sceneFile; delete job.bankId;
  rlog(`${job.id} stills: ${bank.length} bank stills offered ($0)`);
}

// 4 candidate stills from the same prompt — pick one at the gate
async function jobScenes(job) {
  job.step = 'stills'; job.stepStarted = new Date().toISOString();
  job.sceneSource = 'generated'; delete job.sceneBankIds; delete job.sceneFile; delete job.bankId;
  saveRenderJobs();
  const dir = jobDir(job);
  for (const f of fs.readdirSync(dir)) if (f.startsWith('scene-')) fs.rmSync(path.join(dir, f), { force: true });
  const gen = (job.sceneGen || 0) + 1; job.sceneGen = gen; // versioned filenames — same URLs would serve stale browser-cached stills
  const results = await Promise.allSettled([1, 2, 3, 4].map(i =>
    ng.imageGen(MODELS.scene_image, job.prompt,
      { input_references: [ng.dataUrl(JACOB_FRONT)], aspect_ratio: job.orientation || '9:16', resolution: '1k' })
      .then(bufs => fs.writeFileSync(path.join(dir, `scene-${gen}-${i}.png`), bufs[0]))));
  const ok = results.filter(r => r.status === 'fulfilled').length;
  rlog(`${job.id} stills ${ok}/4 generated`);
  results.forEach((r, i) => { if (r.status === 'rejected') rlog(`${job.id} still ${i + 1} failed: ${r.reason?.message}`); });
  if (!ok) throw new Error('all 4 stills failed: ' + (results[0].reason?.message || 'unknown'));
  job.scenes = [1, 2, 3, 4]
    .map(i => fs.existsSync(path.join(dir, `scene-${gen}-${i}.png`)) ? `/renders-media/${job.id}/scene-${gen}-${i}.png` : null)
    .filter(Boolean);
}

async function jobRender(job, joke) {
  job.step = 'render'; job.stepStarted = job.renderStarted = new Date().toISOString();
  const audioPath = jobAudioPath(joke);
  const secs = audioSecs(joke);
  const useFallback = secs < OMNI_MIN_SECS && !!MODELS.avatar_video_fallback;
  job.avatarModel = useFallback ? MODELS.avatar_video_fallback : MODELS.avatar_video;
  job.viaBackup = useFallback || undefined;
  if (useFallback) rlog(`${job.id} backup render: ${job.avatarModel} (read ~${secs.toFixed(1)}s)`);
  saveRenderJobs();
  const doVideo = model => ng.video({
    model,
    prompt: job.motion,
    imageDataUrl: ng.dataUrl(job.sceneFile || path.join(jobDir(job), path.basename(job.sceneUrl))),
    audioDataUrl: ng.dataUrl(audioPath),
    // LongCat takes a resolution select; OmniHuman ignores extras — only send when set for the fallback
    ...(model === MODELS.avatar_video_fallback && MODELS.avatar_fallback_resolution
      ? { resolution: MODELS.avatar_fallback_resolution } : {}),
  }, {
    onTick: s => { // surface whatever the provider reports (queue/progress/eta)
      const d = s.data || s;
      if (!job.runId && (s.requestId || d.requestId)) { job.runId = s.requestId || d.requestId; rlog(`${job.id} video submitted runId=${job.runId}`); }
      if (job._prov !== d.status) { rlog(`${job.id} provider: ${d.status} [${job.avatarModel}]`); job._prov = d.status; }
      job.provider = { status: d.status, progress: d.progress ?? null, eta: d.estimatedTimeRemaining ?? null };
      saveRenderJobs();
    },
  });
  const v = await doVideo(job.avatarModel);
  // a new take voids every downstream artifact — edits and captions alike
  for (const f of ['final-captioned.mp4', 'final-edited.mp4', 'final-edited-captioned.mp4'])
    fs.rmSync(path.join(jobDir(job), f), { force: true });
  delete job.captionTemplate; delete job.captionOpts; delete job.editPrompt; delete job.workFile; delete job.ccFile; delete job.gateError;
  fs.writeFileSync(path.join(jobDir(job), 'final.mp4'), v.buffer);
  job.renderDone = new Date().toISOString();
  job.runId = v.runId;
  if (v.meta?.data?.cost != null) job.cost = v.meta.data.cost;
  job.workFile = 'final.mp4';
  job.videoSecs = Math.round(probeDuration(path.join(jobDir(job), 'final.mp4')) * 10) / 10; // real take length — drives editor routing + display
  job.clipPreview = `/renders-media/${job.id}/final.mp4`;
}

// editor routing: grok is cheaper but hard-caps input at 8s; seedance takes longer clips
const editModelFor = secs => secs > 8 ? (MODELS.video_edit_long || 'bytedance-seedance-2-0-fast-video-edit')
                                    : (MODELS.video_edit || 'grok-imagine-video-edit');

// optional director step: Grok Imagine video-to-video edit of the take.
// always re-edits from the RAW final.mp4 — edits never stack.
async function jobEdit(job, prompt, aspect) {
  job.step = 'edit'; job.stepStarted = new Date().toISOString(); saveRenderJobs();
  const src = path.join(jobDir(job), 'final.mp4');
  const secs = probeDuration(src);
  const model = editModelFor(secs);
  job.editModel = /seedance/i.test(model) ? 'seedance' : 'grok';
  const v = await ng.video({
    model,
    videoDataUrl: ng.dataUrl(src), // editors need a data URL or trusted storage — share links won't do
    prompt,
    resolution: MODELS.video_edit_resolution || '720p',
    // seedance defaults to 16:9 + 5s — pin it to the take's real orientation and length (duration is a 4–15s select)
    ...(job.editModel === 'seedance' ? { aspect_ratio: aspect || job.orientation || '9:16', duration: Math.min(15, Math.max(4, Math.round(secs))) } : {}),
  }, {
    onTick: s => {
      const d = s.data || s;
      if (job._prov !== d.status) { rlog(`${job.id} editor: ${d.status}`); job._prov = d.status; }
      job.provider = { status: d.status, progress: d.progress ?? null, eta: d.estimatedTimeRemaining ?? null };
      saveRenderJobs();
    },
  });
  fs.writeFileSync(path.join(jobDir(job), 'final-edited.mp4'), v.buffer);
  // any caption file was burned onto a different source — it's stale now
  for (const f of ['final-captioned.mp4', 'final-edited-captioned.mp4'])
    fs.rmSync(path.join(jobDir(job), f), { force: true });
  delete job.captionTemplate; delete job.captionOpts; delete job.ccFile;
  job.editPrompt = prompt;
  job.workFile = 'final-edited.mp4';
  job.clipPreview = `/renders-media/${job.id}/final-edited.mp4`;
  rlog(`${job.id} ${job.editModel} edit applied (${Math.round(secs)}s take): "${prompt.slice(0, 80)}"`);
}

// captioner requires a public URL — mint a short-lived unguessable link per take
const tmpShares = new Map(); // token -> { file, exp }
setInterval(() => { const now = Date.now(); for (const [t, s] of tmpShares) if (s.exp < now) tmpShares.delete(t); }, 10 * 60 * 1000).unref();
app.get('/share/:token', (req, res) => {
  const s = tmpShares.get(req.params.token.replace(/\.mp4$/, ''));
  if (!s || s.exp < Date.now() || !fs.existsSync(s.file)) return res.status(404).end();
  res.setHeader('Content-Type', 'video/mp4');
  fs.createReadStream(s.file).pipe(res);
});

// optional director step at the publish gate: burn captions into the take.
// always re-runs on the RAW final.mp4 (never stacks captions on captions).
async function jobCaption(job, opts, videoUrl) {
  job.step = 'caption'; job.stepStarted = new Date().toISOString(); saveRenderJobs();
  const work = job.workFile || 'final.mp4'; // captions apply to the CURRENT take (raw or edited)
  const cc = work.replace('.mp4', '-captioned.mp4');
  const v = await ng.video({
    model: MODELS.video_captioner || 'ai-video-editor/video-captioner',
    videoUrl,
    template: opts.template || 'bold-pop',
    emoji: opts.emoji === true, // director default is off; only an explicit on adds emoji captions
    ...(opts.transcript ? { transcript: opts.transcript } : {}), // exact script beats auto-transcription ("in tents" ≠ "intense")
    ...(opts.translate_to && opts.translate_to !== 'none' ? { translate_to: opts.translate_to } : {}),
  }, {
    onTick: s => {
      const d = s.data || s;
      if (job._prov !== d.status) { rlog(`${job.id} captioner: ${d.status}`); job._prov = d.status; }
      job.provider = { status: d.status, progress: d.progress ?? null, eta: d.estimatedTimeRemaining ?? null };
      saveRenderJobs();
    },
  });
  fs.writeFileSync(path.join(jobDir(job), cc), v.buffer);
  job.ccFile = cc;
  job.captionTemplate = opts.template || 'bold-pop';
  job.captionOpts = opts;
  job.clipPreview = `/renders-media/${job.id}/${cc}`;
  rlog(`${job.id} captions applied to ${work} (${job.captionTemplate}${opts.translate_to && opts.translate_to !== 'none' ? ' → ' + opts.translate_to : ''})`);
}

async function jobPublish(job, joke, variant) {
  job.step = 'publish'; job.stepStarted = new Date().toISOString(); saveRenderJobs();
  const clips = JSON.parse(fs.readFileSync(CLIPS_JSON, 'utf8'));
  let clipId = 'jacob-' + slugify(joke.text.split(/\s+/).slice(0, 4).join(' ')).slice(0, 40);
  if (clips.some(c => c.id === clipId)) clipId += '-' + crypto.randomBytes(3).toString('hex');
  const title = joke.text.split(/\s+/).slice(0, 5).join(' ').replace(/[[\]"']/g, '') + '…';
  // director picks ONE version at the gate by filename: original / edited / captioned
  const work = job.workFile || 'final.mp4';
  const cc = job.ccFile || 'final-captioned.mp4';
  const allowed = new Set(['final.mp4', 'final-edited.mp4', cc]);
  const ver = allowed.has(variant) && fs.existsSync(path.join(jobDir(job), variant)) ? variant : work;
  job.publishedFile = ver;
  const captioned = ver === cc;
  const mp4 = clipId + '.mp4', poster = clipId + '.jpg';
  fs.copyFileSync(path.join(jobDir(job), ver), path.join(CLIPS_DIR, mp4));
  makePoster(path.join(CLIPS_DIR, mp4), path.join(CLIPS_DIR, poster));
  clips.push({
    id: clipId,
    title: captioned ? title + ' 💬' : ver === 'final-edited.mp4' ? title + ' ✂' : title,
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
  rlog(`${job.id} published → ${clipId}`);
}

const RENDER_LOG = [];
const rlog = msg => {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  RENDER_LOG.push(line);
  if (RENDER_LOG.length > 120) RENDER_LOG.shift();
  console.log('render:', line);
};
app.get('/api/jokes/render-log', (req, res) => res.json(RENDER_LOG.slice(-60)));

// turn provider JSON dumps + raw throws into something the director can act on.
// raw message stays in the log; job.error (what the UI shows) gets the readable version.
function friendlyError(e, job) {
  let m = e?.message || String(e);
  const brace = m.match(/\{[\s\S]*\}/)?.[0]; // unwrap provider payloads like video 400: {"error":"..."}
  if (brace) {
    try {
      const o = JSON.parse(brace);
      const inner = o.error?.message || o.error || o.message;
      if (typeof inner === 'string' && inner) m = inner;
    } catch {}
  }
  if (/audio must be between|under \d+ seconds|too short for the avatar|too long for the avatar/i.test(m)) {
    let secs = null;
    try { const jk = findJoke(job.jokeId); if (jk) secs = Math.round(probeDuration(jobAudioPath(jk)) * 10) / 10; } catch {}
    if (secs != null && secs > 300)
      return `the voice read is too long for the avatar model (max 300s, this one is ~${secs}s). Shorten the joke text, then retry.`;
    return `the voice read is too short for the avatar model (needs 4s+, this one is ~${secs ?? '?'}s). Edit the joke to add a beat — a [pause] or another line — then retry; your stills are kept.`;
  }
  if (/balance|insufficient|payment|402/i.test(m))
    return 'nano-gpt balance is too low for this step — top up, then retry.';
  if (/polling timed out/i.test(m))
    return "the provider didn't finish in time — it's probably busy. Retry in a minute; nothing was published.";
  if (/^tts |tts job|speak \d/i.test(m)) return `voice read failed: ${m}`;
  if (/imageGen|stills failed/i.test(m)) return `scene stills failed: ${m}`;
  const lim = m.match(/requires a 1-(\d+) second input video \(provided: ([\d.]+)s\)/i);
  if (lim) return `the take is ~${Math.round(parseFloat(lim[2]))}s — grok edit only accepts clips up to ${lim[1]}s. The take is fine; you can still caption or publish it.`;
  return m;
}

const failJob = (job, e) => { console.error('render failed:', e); rlog(`${job.id} ERROR ${e.message}`); job.status = 'error'; job.error = friendlyError(e, job); saveRenderJobs(); };
const cancelled = job => job.status === 'cancelled';

// voice + 4 stills, then stop and wait for the director
async function toSceneGate(job, joke) {
  try {
    rlog(`${job.id} job start: voice → stills`);
    await jobVoice(job, joke);
    if (cancelled(job)) return;
    await jobStills(job);
    if (cancelled(job)) return;
    job.status = 'awaiting_scene';
    rlog(`${job.id} gate: awaiting scene pick`);
  } catch (e) { return failJob(job, e); }
  saveRenderJobs();
}

// avatar render, then stop and wait for publish/bin
async function toPublishGate(job, joke) {
  try {
    job.audioSecs = Math.round(audioSecs(joke) * 10) / 10;
    if (job.audioSecs > OMNI_MAX_SECS)
      throw new Error(`voice read is ${Math.round(job.audioSecs)}s — over the ${OMNI_MAX_SECS}s avatar limit; shorten the joke`);
    if (job.audioSecs < OMNI_MIN_SECS && MODELS.avatar_video_fallback && !job.allowBackup) {
      job.status = 'awaiting_fallback'; // director's call before spending on the backup
      job.avatarModel = MODELS.avatar_video_fallback;
      rlog(`${job.id} gate: read ~${job.audioSecs}s is under OmniHuman's ${OMNI_MIN_SECS}s floor — fallback decision`);
      saveRenderJobs();
      return;
    }
    rlog(`${job.id} render start (scene ${job.pick != null ? job.pick + 1 : '?'})`);
    await jobRender(job, joke);
    if (cancelled(job)) return;
    job.status = 'awaiting_publish';
    rlog(`${job.id} gate: awaiting publish${job.renderDone && job.renderStarted ? ` (rendered in ${Math.round((Date.parse(job.renderDone) - Date.parse(job.renderStarted)) / 1000)}s)` : ''}`);
  } catch (e) {
    // our size-estimate said ≥4s but OmniHuman disagreed — same decision, ask the director
    if (MODELS.avatar_video_fallback && /audio must be between/i.test(e.message) && !job.allowBackup) {
      job.status = 'awaiting_fallback';
      job.avatarModel = MODELS.avatar_video_fallback;
      rlog(`${job.id} OmniHuman rejected the audio length — fallback decision`);
      saveRenderJobs();
      return;
    }
    return failJob(job, e);
  }
  saveRenderJobs();
}

// free: AI drafts the scene + motion prompts so the director can edit before any spend
app.post('/api/jokes/render-preview', async (req, res) => {
  const { id, setting, orientation, framing } = req.body || {};
  const joke = id ? findJoke(id) : null;
  const orient = ORIENTS[orientation] || '9:16';
  const fram = FRAMINGS[framing] ? framing : 'full-body';
  try {
    if (!joke) throw new Error('joke not found');
    const d = await aiPrompt(joke, (setting || '').trim(), orient, fram);
    const hit = findInStores(id);
    if (hit) {
      hit.list[hit.i].draft = { prompt: d.scene, motion: d.motion, orientation: orient, framing: fram, ts: new Date().toISOString() };
      stores[hit.name].save(hit.list);
    }
    return res.json({ prompt: d.scene, defaultMotion: d.motion, framing: fram });
  } catch (e) {
    console.error('ai prompt draft failed, using template:', e.message);
    res.json({ prompt: scenePrompt((setting || '').trim(), orient, fram), defaultMotion: DEFAULT_MOTION, framing: fram, fallback: true });
  }
});

// persist an edited draft without drafting again
app.post('/api/jokes/draft', (req, res) => {
  const { id, prompt, motion, orientation, framing } = req.body || {};
  const hit = findInStores(id);
  if (!hit) return res.status(404).json({ error: 'joke not found' });
  const d = hit.list[hit.i].draft || {};
  if (prompt != null) d.prompt = String(prompt);
  if (motion != null) d.motion = String(motion);
  if (orientation != null) d.orientation = ORIENTS[orientation] || d.orientation || '9:16';
  if (framing != null) d.framing = FRAMINGS[framing] ? framing : d.framing;
  d.ts = new Date().toISOString();
  hit.list[hit.i].draft = d;
  stores[hit.name].save(hit.list);
  res.json({ ok: true });
});

app.post('/api/jokes/render', async (req, res) => {
  const { id, prompt, setting, orientation, motion, framing } = req.body || {};
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
    prompt: (prompt || '').trim() || scenePrompt((setting || '').trim(), ORIENTS[orientation], framing),
    motion: (motion || '').trim() || DEFAULT_MOTION,
    orientation: ORIENTS[orientation] || '9:16',
    framing: FRAMINGS[framing] ? framing : 'full-body',
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
  rlog(`action: ${action} joke=${jokeId}${pick != null ? ` pick=${pick}` : ''}`);
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
  if (action === 'use-bank') {
    if (job.status !== 'awaiting_scene') return res.status(409).json({ error: 'not at the stills step' });
    try { offerBank(job); } catch (e) { return res.status(400).json({ error: e.message }); }
    saveRenderJobs();
    return res.json({ ok: true });
  }
  if (action === 'new-stills') {
    if (job.status !== 'awaiting_scene') return res.status(409).json({ error: 'not at the stills step' });
    if (prompt != null && String(prompt).trim()) job.prompt = String(prompt).trim();
    delete job.pick; delete job.sceneUrl;
    const hit = findInStores(jokeId);
    if (hit) { // gate edits stay tied to the workflow
      hit.list[hit.i].draft = { prompt: job.prompt, motion: job.motion, orientation: job.orientation, ts: new Date().toISOString() };
      stores[hit.name].save(hit.list);
    }
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
    job.bankId = job.sceneBankIds?.[i] || null;
    job.sceneFile = job.bankId
      ? path.join(BANK_DIR, bankEntry(job.bankId)?.file || '')
      : path.join(jobDir(job), path.basename(job.sceneUrl));
    if (job.bankId) { // track rotation — bank sorts least-used first
      const bank = loadBank();
      const e = bank.find(b => b.id === job.bankId);
      if (e) { e.uses = (e.uses || 0) + 1; e.lastUsed = new Date().toISOString(); saveBank(bank); }
    }
    job.status = 'running'; saveRenderJobs();
    toPublishGate(job, joke);
    return res.json({ ok: true });
  }
  if (action === 'edit') {
    if (job.status !== 'awaiting_publish') return res.status(409).json({ error: 'nothing to edit' });
    const src = path.join(jobDir(job), 'final.mp4');
    if (!fs.existsSync(src)) return res.status(400).json({ error: 'no take to edit' });
    const prompt = String(req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'describe the edit first' });
    delete job.gateError;
    job.editPrompt = prompt; // save now — survives a failed edit so re-edit keeps your wording
    job.status = 'running'; saveRenderJobs();
    jobEdit(job, prompt, req.body.aspect_ratio)
      .then(() => { if (!cancelled(job)) job.status = 'awaiting_publish'; })
      .catch(e => { // post-step failure: the take is intact — return to the gate with the error surfaced
        console.error('edit failed:', e); rlog(`${job.id} EDIT ERROR ${e.message}`);
        job.status = 'awaiting_publish'; job.gateError = friendlyError(e, job);
      })
      .finally(saveRenderJobs);
    return res.json({ ok: true });
  }
  if (action === 'caption') {
    if (job.status !== 'awaiting_publish') return res.status(409).json({ error: 'nothing to caption' });
    const src = path.join(jobDir(job), job.workFile || 'final.mp4');
    if (!fs.existsSync(src)) return res.status(400).json({ error: 'no take to caption' });
    const opts = {
      template: String(req.body.template || 'bold-pop'),
      transcript: String(req.body.transcript || '').trim() || null,
      translate_to: String(req.body.translate_to || 'none'),
      emoji: req.body.emoji === true,
    };
    const token = crypto.randomBytes(12).toString('hex');
    tmpShares.set(token, { file: src, exp: Date.now() + 30 * 60 * 1000 });
    const videoUrl = `https://${req.get('host')}/share/${token}.mp4`;
    delete job.gateError;
    job.status = 'running'; saveRenderJobs();
    jobCaption(job, opts, videoUrl)
      .then(() => { if (!cancelled(job)) job.status = 'awaiting_publish'; })
      .catch(e => { // post-step failure: the take is intact — return to the gate with the error surfaced
        console.error('caption failed:', e); rlog(`${job.id} CAPTION ERROR ${e.message}`);
        job.status = 'awaiting_publish'; job.gateError = friendlyError(e, job);
      })
      .finally(saveRenderJobs);
    return res.json({ ok: true });
  }
  if (action === 'publish') {
    if (job.status !== 'awaiting_publish') return res.status(409).json({ error: 'nothing to publish' });
    job.status = 'running'; saveRenderJobs();
    jobPublish(job, joke, req.body.variant)
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
  // director consents to the backup avatar for a short read
  if (action === 'use-fallback') {
    if (job.status !== 'awaiting_fallback') return res.status(409).json({ error: 'no fallback decision pending' });
    job.allowBackup = true;
    job.status = 'running'; saveRenderJobs();
    toPublishGate(job, joke);
    return res.json({ ok: true });
  }
  // walk backwards: scrap the take, keep the stills
  if (action === 'back') {
    const ok = job.status === 'awaiting_publish' || job.status === 'awaiting_fallback'
      || (['error', 'interrupted'].includes(job.status) && ['render', 'caption', 'edit'].includes(job.step));
    if (!ok) return res.status(409).json({ error: 'can only step back from the video step' });
    delete job.pick; delete job.sceneUrl; delete job.sceneFile; delete job.bankId; delete job.clipPreview; delete job.error;
    job.status = 'awaiting_scene';
    saveRenderJobs();
    return res.json({ ok: true });
  }
  // rerun whichever step died
  if (action === 'retry') {
    if (job.status !== 'error' && job.status !== 'interrupted') return res.status(409).json({ error: 'nothing to retry' });
    delete job.error;
    job.status = 'running'; saveRenderJobs();
    if (job.step === 'caption' || job.step === 'edit') { // post-step died — rerun it on the surviving take
      let rerun;
      if (job.step === 'caption') {
        const src = path.join(jobDir(job), job.workFile || 'final.mp4');
        const token = crypto.randomBytes(12).toString('hex');
        tmpShares.set(token, { file: src, exp: Date.now() + 30 * 60 * 1000 });
        rerun = jobCaption(job, job.captionOpts || {}, `https://${req.get('host')}/share/${token}.mp4`);
      } else {
        rerun = jobEdit(job, job.editPrompt || '');
      }
      rerun
        .then(() => { if (!cancelled(job)) job.status = 'awaiting_publish'; })
        .catch(e => {
          console.error('post-step retry failed:', e); rlog(`${job.id} RETRY ERROR ${e.message}`);
          job.status = 'awaiting_publish'; job.gateError = friendlyError(e, job);
        })
        .finally(saveRenderJobs);
    } else {
      const again = job.step === 'render' ? toPublishGate(job, joke) : toSceneGate(job, joke);
      again.catch(e => failJob(job, e));
    }
    return res.json({ ok: true });
  }
  // unpublish a live clip — pulls it off the wall, lands back at review
  if (action === 'unpublish') {
    if (job.status !== 'done' || !job.clipId) return res.status(409).json({ error: 'nothing published to unpublish' });
    const clips = JSON.parse(fs.readFileSync(CLIPS_JSON, 'utf8'));
    fs.writeFileSync(CLIPS_JSON, JSON.stringify(clips.filter(c => c.id !== job.clipId && c.id !== job.clipId + '-cc'), null, 2));
    const hit = findInStores(jokeId);
    if (hit) { delete hit.list[hit.i].produced; delete hit.list[hit.i].clip; stores[hit.name].save(hit.list); }
    job.status = 'awaiting_publish';
    saveRenderJobs();
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'unknown action' });
});

// bank maintenance — grow it from director-approved generated stills, prune bad ones
app.post('/api/jokes/bank/add', (req, res) => {
  const { jokeId, pick } = req.body || {};
  const job = renderJobs.get(jokeId);
  if (!job) return res.status(404).json({ error: 'no render job for that joke' });
  const scenes = job.scenes || [];
  const i = parseInt(pick);
  if (!(i >= 0 && i < scenes.length)) return res.status(400).json({ error: 'pick a still first' });
  if (job.sceneBankIds?.[i]) return res.status(409).json({ error: 'already in the bank' });
  const src = path.join(jobDir(job), path.basename(scenes[i]));
  if (!fs.existsSync(src)) return res.status(404).json({ error: 'still file missing' });
  const bank = loadBank();
  const id = 'bank-' + crypto.randomBytes(4).toString('hex');
  fs.copyFileSync(src, path.join(BANK_DIR, `${id}.png`));
  bank.push({ id, file: `${id}.png`, framing: job.framing || 'full-body', approved: true, uses: 0, ts: new Date().toISOString() });
  saveBank(bank);
  rlog(`${job.id} still ${i + 1} added to bank → ${id}`);
  res.json({ ok: true, id });
});

app.post('/api/jokes/bank/remove', (req, res) => {
  const bank = loadBank();
  const e = bank.find(b => b.id === req.body?.id);
  if (!e) return res.status(404).json({ error: 'not in the bank' });
  e.approved = false;
  saveBank(bank);
  res.json({ ok: true });
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
