# ReelEnder Studio

**A film studio where the entire crew is software — you're the director with final cut.**

Describe a movie in one sentence. ReelEnder Studio writes the script, designs the characters, shoots every scene, casts the voices, mixes the sound, and edits the final cut — then hands you an itemized receipt for what every shot cost. You never touch a tool; you make creative decisions at a handful of checkpoints, and the app does everything in between.

Live (eventually) at [reelender.com](https://reelender.com).

## How it works

- **You pitch.** One sentence — *"a travel vlogger interviews King Leonidas at Thermopylae, shot handheld like a war documentary, 48 seconds."*
- **You approve at 7 checkpoints.** Script → character designs → rough cut → dailies → voices → the mix → final cut. The app cannot spend money past a checkpoint you haven't approved.
- **The app produces.** It casts the right AI model for each job via the [nano-gpt](https://nano-gpt.com) API — one model for landscapes, one for crowds, one for keeping faces consistent, one for voices, one for sound — submits the work, waits for renders, retries failures, and keeps the books.
- **You get the film.** Plus a vertical cut for Shorts/TikTok, a thumbnail, subtitles, and a receipt showing what every shot cost.

## Status

🚧 Early development — infrastructure provisioned, app being scaffolded. See [PLAN.md](PLAN.md) for the full roadmap and progress.

## Stack

- Next.js + Express backend
- nano-gpt API (chat, image, video, TTS, audio models)
- ffmpeg for assembly, mix, and delivery formats
- Self-hosted on a DigitalOcean droplet behind Caddy (HTTPS)
