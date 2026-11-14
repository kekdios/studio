# ReelEnder Studio — The Plan

*An AI joke factory. Jacob — always the same guy, same clothes, same voice — tells a daily joke, posted all over social media. You're the editor-in-chief who decides what's funny. This document is the map — checkboxes get ticked as we go.*

*(Revised 2026-11-13: started life as "make any film with an AI crew." Simplified to one character, one format, thousands of jokes — a pipeline instead of a studio.)*

---

## The big idea in one paragraph

We're building a **joke factory** at **reelender.com**. An AI scout hunts the internet for short, funny jokes — one-liners and setup-punchlines — and brings them to you. You hear them, then accept or reject; both lists are kept forever so jokes never repeat. Accepted jokes get read aloud in Jacob's voice, placed in a setting, and turned into a short video of Jacob telling the joke. Same guy every time. The videos get posted to social media. Simple loop, thousands of jokes.

## How it works, no jargon

The app is two halves:

- **The front room** — a web page you see in your browser. This is where you approve things: pick a script take, choose a character design, watch dailies, cast voices.
- **The back office** — a small program running on the same server that does the actual work: talks to the AI services, waits for renders to finish, organizes files, keeps the books.

Your browser talks to the back office, the back office talks to the AI models. Nobody else can reach the back office — it'll live behind a login.

## Where things live

| Thing | Where |
|---|---|
| The app (while we build it) | This Mac, `/Users/private/studio` |
| The app (when it ships) | A rented server ("droplet") at DigitalOcean |
| The address | `reelender.com` — already pointing at the server |
| Each film's files | A folder per project — script, images, video takes, audio, final cut |
| The records | A state file per project + a spending ledger |

## What's already done

- [x] **Rented the server** — smallest DigitalOcean droplet ($4/month), Ubuntu Linux, named `reelender`, answering at `reelender.com`
- [x] **Pointed the domain** — `reelender.com` and `www.reelender.com` resolve to it
- [x] **Keys and secrets** — DigitalOcean access token staged and hidden (gitignored), SSH access to the server confirmed
- [x] **Brand assets** — ReelEnder logos copied into the project

## The build phases

### Phase 1 — The joke room ✅ *(live)*
The room where you and the AI curate jokes. Built as the "writers' room" — voice conversation, OTP login, live at reelender.com. The scout searches the web for jokes and brings candidates; you hear each one read aloud and tap **keep** or **toss**. Both lists are kept forever — a joke once seen is never offered again.

### Phase 2 — Lock Jacob
The whole product depends on Jacob being the same Jacob every day: one face, one outfit, one voice. Generate a character sheet (front + profile, the outfit, the look) and cast his voice — you approve both. These become the reference every video is built from. This is the single most important step for a believable daily character.

### Phase 3 — The joke machine
The repeatable loop for every accepted joke: joke text → Jacob's voice reads it → a video model puts Jacob in a setting, lip-synced to the audio → a short clip ready for social. Same pipeline every time; only the joke and the backdrop change.

### Phase 4 — Post it
Vertical format for TikTok/Reels/Shorts, captions burned in (jokes land better muted), a consistent intro/outro beat. Manual posting at first; social APIs later if it earns its keep.

### Phase 5 — The accountant
Already half-built: every call logs its cost. Per-run and monthly caps so a runaway pipeline can't surprise you.

## What your job looks like once it's live

Open the joke room → say "scout me some lawyer jokes" or just hit the button → hear each candidate read aloud → keep or toss → repeat when you feel like it. When a batch is kept, the factory makes the videos overnight; you approve the day's Jacob clip and post it. Because it runs on a server, everything happens from your phone.

## The honest fine print (kept from the original document)

- A good-looking short will cost roughly **$50–150 and most of a day**, because you'll re-render shots that come out wrong. Absurdly cheap vs. a film crew — not free.
- The quality ceiling is real: expect "very impressive short," not Hollywood.
- The software is a very fast, very organized intern with a company card. **Your taste at each approval is the product.**

## Glossary

- **Droplet** — DigitalOcean's name for a rented virtual server. Ours is the $4/month size.
- **Animatic / previz** — a rough draft of the film made cheaply to check timing before spending on pretty renders.
- **Dailies** — the day's raw takes, reviewed each evening on a real film set. Here: the 2–3 versions of each shot you pick between.
- **Contact sheet** — takes shown side-by-side so you can compare and pick.
- **Caddy** — the web server software that puts the app on the internet and handles the padlock (HTTPS) automatically.
- **nano-gpt** — the rental service for AI models. One API key, pay per use.
