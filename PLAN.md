# ReelEnder Studio — The Plan

*An AI joke factory. Jacob — always the same guy, same clothes, same voice — tells a daily joke, posted all over social media. You're the editor-in-chief who decides what's funny. This document is the map — checkboxes get ticked as we go.*

*(Revised 2026-11-13: started life as "make any film with an AI crew." Simplified to one character, one format, thousands of jokes — a pipeline instead of a studio.)*

---

## The big idea in one paragraph

We've built a **joke factory** at **reelender.com**. An AI scout hunts the internet for short, funny jokes — one-liners and setup-punchlines — and brings them to you. You hear them, then accept or reject; both lists are kept forever so jokes never repeat. Accepted jokes get read aloud in Jacob's voice, placed in a setting, and turned into a short video of Jacob telling the joke. Same guy every time. The videos get posted to social media. Simple loop, thousands of jokes.

## How it works, no jargon

The app is two halves:

- **The front room** — a web page you see in your browser (and on your phone). Where you hear jokes and decide what makes the cut.
- **The back office** — a small program on our server that does the work: talks to the AI services, waits for renders, files every joke into the right pile, keeps the books.

Your browser talks to the back office, the back office talks to the AI models. The room is behind an email-code login — the public pages are open to everyone.

## The site map

| Door | Who it's for | What it is |
|---|---|---|
| `reelender.com` | everybody | Landing page: Jacob's name ("Traveling Joker"), the two newest clips as samples, "see more jokes" button, quiet footer with sign-in |
| `reelender.com/clips` | everybody | The gallery — thumbnail wall of every finished clip, tap to play, joke text + social links under each |
| `reelender.com/room` | you | The joke room — scout, vault, voice. Behind the login |
| `reelender.com/login` | you | Email-code sign-in |

## Where things live

| Thing | Where |
|---|---|
| The app | Live on our DigitalOcean droplet at `reelender.com` |
| The code | This Mac, `/Users/private/studio` — deployed to the server when we change it |
| The joke vault | `accepted.jsonl` + `rejected.jsonl` + `pending.json` on the server — the permanent record |
| The clips | `projects/joke-factory/clips/` — finished videos + a `clips.json` manifest (joke text, social links) feeding the public gallery |
| Voice + joke audio | Saved next to the vault, replayable any time |
| The books | Every API call logs its cost; nano-gpt balance shows in the header |

## What's already done

- [x] **The server** — $4/month DigitalOcean droplet, Ubuntu, named `reelender`
- [x] **The domain** — `reelender.com` + `www` live, HTTPS padlock via Caddy
- [x] **The joke room** — voice-first page: you talk, Whisper hears you, the scout answers in your chosen ElevenLabs voice. Works on the phone.
- [x] **Sign-in** — email → 6-digit code via Resend → logged in for 7 days. Passphrase as backup. Only your email gets in.
- [x] **The scout** — searches the real web (`:online`), brings back joke candidates as cards: **hear it / keep / toss**. Shaped by whatever direction you give it in conversation.
- [x] **The vault** — a browsable catalog with three tabs: kept, produced, tossed. Every joke can be heard, edited (including `[pause]`/`[laughing]` voice tags), moved between piles, or deleted. Manual "＋ add" for jokes you find yourself. A "✓ produced" flag tracks which kept jokes became clips.
- [x] **Dupe radar** — every scout candidate is scored against the whole vault; near-matches get a warning flag on the card showing the vault joke it resembles, so nothing repeats silently.
- [x] **Keys and secrets** — all staged locally, gitignored, mirrored on the server. Nothing sensitive in the public repo.
- [x] **The gallery** — public thumbnail wall at `/clips`; tap to play, joke text + social links under each video.
- [x] **Jacob locked** — three turnaround photos + written character sheet staged; voice is your ElevenLabs voice (same as the scout's).
- [x] **Phone-ready** — room, login, and gallery all responsive; voice input works on iOS.
- [x] **Public face** — landing page (samples + sign-in footer) separate from the full gallery; `www` redirects to the apex so one login works everywhere. Logout button in the room. Clips marked open source on both public pages.
- [x] **The joke machine** — kept joke → Jacob's voice → scene still of Jacob in a setting → lip-synced video → public gallery, one "🎬 clip" button in the vault. ~$0.80 and ~4 minutes per clip.

## The build phases

### Phase 1 — The joke room ✅ *(live)*
Voice conversation, OTP login, scout button, joke cards, the vault catalog, fuzzy dupe flagging, manual adds, produced tracking. Done and on your phone.

### Phase 2 — Lock Jacob ✅
The whole product depends on Jacob being the same Jacob every day: one face, one outfit, one voice. Done: three turnaround references staged in `projects/joke-factory/jacob/` (front, left, right) plus a written character sheet — same grey hoodie/orange top/vest/cargo shorts/blue leggings/neon runners. Voice locked too: Jacob speaks with your ElevenLabs voice — the same one the scout uses. These become the references every video is built from.

### Phase 3 — The joke machine ✅ *(live)*
The repeatable loop for every accepted joke: joke text → Jacob's voice reads it → a video model puts Jacob in a setting, lip-synced to the audio → a short clip ready for social. Same pipeline every time; only the joke and the backdrop change.

The room itself is the pipeline: three stage buttons across the top — **1 · voice → 2 · image → 3 · video** — and the body below adapts to whichever stage you're working. It runs strictly in order (video stays locked until a still is approved), and the room remembers which joke is in production, even across a restart. The image stage shows the exact prompt (editable) and 4 stills to pick or reroll; the video stage is the final review. You can walk backwards — scrap the take and return to stills, scrap the stills and return to direction — until you publish. Once published, a clip is locked behind a 🔒 so it can't be lost by accident; unlock it to unpublish or move it. About $1 and ~5 minutes a clip including stills.

### Phase 4 — Post it
Vertical format for TikTok/Reels/Shorts (our target is 716×1284, ~7–9s — Jacob's real clip size), captions burned in (jokes land better muted), a consistent intro/outro beat. Manual posting at first; social APIs later if it earns its keep.

**The gallery** ✅ — live at `reelender.com/clips`, no login: a thumbnail wall of every finished clip. Tap a tile and the video plays with the joke text and social links underneath (TikTok/IG/YouTube/X buttons appear as clips get posted). The vault becomes a back catalog fans can binge.

### Phase 5 — The accountant *(mostly done)*
Every call already logs its cost and the nano-gpt balance shows in the room. Remaining: per-run and monthly caps so a runaway pipeline can't surprise you.

## What your job looks like once it's live

Open the joke room on your phone → say "scout me some lawyer jokes" or just hit the button → hear each candidate read aloud → keep or toss → repeat when you feel like it. When a batch is kept, the factory makes the videos; you approve the day's Jacob clip and post it.

## The honest fine print

- Joke curation is nearly free: scout + voice runs about **$0.03 a turn**, a fraction of a cent per kept joke.
- The expensive part is the **video**: figure roughly **$0.50–3 per daily clip** depending on the model — so a month of Jacob is more like $15–60 than the $50–150-per-film we originally penciled. Still check the receipt.
- The quality ceiling is real: "very convincing daily character," not Pixar.
- The scout is a very fast intern with a company card. **Your taste at keep/toss is the product.**

## Glossary

- **Droplet** — DigitalOcean's name for a rented virtual server. Ours is the $4/month size.
- **OTP** — the sign-in code emailed to you; proves it's your inbox, no password to forget.
- **The vault** — the permanent joke store: kept, tossed, undecided, plus a "produced" flag on kept jokes. What keeps duplicates out forever.
- **Lip-sync** — the step where a video model moves Jacob's mouth to match the recorded joke audio.
- **Caddy** — the web server software that puts the app on the internet and handles the padlock (HTTPS) automatically.
- **nano-gpt** — the rental service for AI models. One API key, pay per use.
