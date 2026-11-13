# ReelEnder Studio — The Plan

*A film studio that lives on the internet. You're the director. The software is the entire crew. This document is the map — checkboxes get ticked as we go.*

---

## The big idea in one paragraph

We're building a web app at **reelender.com**. You open it, pitch a movie idea in one sentence, and it walks you through making a real short film — script, characters, shots, voices, music, final cut. Behind the scenes it calls an AI service (nano-gpt) that rents access to ~600 AI models: script writers, image generators, video generators, voice actors, sound machines. You never touch any of that. You just make creative decisions at a handful of checkpoints, and the app does all the work in between. Every render is logged with its cost, so you always know what you've spent.

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

### Phase 1 — The workshop
Get the skeleton running *on this Mac first* (faster to build and test than on the server): the web page, the back office, an empty pipeline that can walk through the stages with placeholder work.

### Phase 2 — The producer's brain
Connect the AI service. Give a strong chat model a permanent "job description" that turns it into a competent line producer — it speaks film (shot sizes, camera moves, coverage, pacing), knows it spends real money, and never advances past a checkpoint you haven't approved. The brain works in two modes: **collaborator** in the writers' room (a creative writing partner who develops the idea with you, asks questions, pushes back) and **executor** in the pipeline (writes shot lists, picks which AI model does each job, translates "redo shot 5, tighter" into new instructions for the video models).

### Phase 3 — The checkpoints
Build the actual workflow — the app can only move forward when you approve each gate:

0. **The writers' room** — before anything is generated, you and the AI develop the idea together in conversation. Bat the concept around, try tones, shape characters, argue about dialogue — a real collaboration, not a one-shot generation. Nothing is rendered and nothing is spent during this phase. When the script feels right, you say "lock it."
1. **Script lock & shot list** — the app formalizes your agreed script into a structured shot list (every shot: location, cast, camera move, dialogue, sound). You approve it — this is the cheapest moment to change your mind.
2. **The look** — character sheets and style frames; once locked, every shot uses them as reference so faces stay consistent
3. **Rough cut** — a cheap animatic to check pacing before real money gets spent
4. **Dailies** — each shot rendered 2–3 takes; you pick or say "redo" in plain words
5. **Voices** — audition voices per character, you cast; dialogue recorded and lip-synced
6. **The mix** — sound effects, score, ambience, all mixed against picture
7. **Final cut** — assembled film with grade, grain, captions; ship it or send back notes

Then **delivery**: the film, a vertical version for Shorts/TikTok, a thumbnail, subtitle files, and an itemized receipt.

### Phase 4 — The accountant
Per-shot and per-film spending caps. The app taps the brakes and asks you before blowing a budget. Every API call logged → the receipt writes itself.

### Phase 5 — Lock the doors
Login protection (it's just you, but the app spends your money — an open door would be a free film studio for strangers). Firewall on the server. HTTPS via Caddy (free, automatic certificate).

### Phase 6 — Move to the server
Deploy script: build on this Mac (the $4 droplet is too small to build on), copy the files up, restart the app. Live at `https://reelender.com`.

### Phase 7 — First film
A real, cheap test run end-to-end — something like a 15-second scene with 3 shots — to shake out the bugs before making something you care about.

## What your job looks like once it's live

Develop the idea with the AI in the writers' room, at your own pace → lock the script → approve the shot list → get pinged → approve character designs → get pinged → approve the rough cut → get pinged per scene for dailies → cast the voices → approve the mix → approve the final. Between pings, you do nothing — the app is rendering, retrying failures, and organizing files. Because it runs on a server, it keeps working when your laptop is closed — you can approve dailies from your phone.

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
