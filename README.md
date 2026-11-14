# ReelEnder Studio

**An AI joke factory. One character, one joke a day, posted everywhere.**

Jacob tells a daily joke on social media — always the same guy, same clothes, same voice. An AI scout hunts the internet for the funniest short jokes; you hear each one and keep or toss it; accepted jokes get voiced, turned into a short vertical video of Jacob, and posted. Simple loop, thousands of jokes.

Live at [reelender.com](https://reelender.com) — and the public clip gallery at [reelender.com/clips](https://reelender.com/clips).

## How it works

- **The joke room** (sign-in required) — voice-first curation: talk to the scout, or tap to get a batch of joke cards. Every card: **hear it / keep / toss**. Kept and tossed jokes are filed forever so nothing repeats.
- **The factory** — an accepted joke is read aloud in Jacob's voice, placed in a setting, and rendered as a short lip-synced vertical clip.
- **The gallery** — a public page with every finished clip, the joke text, and links out to the TikTok/IG/YouTube posts.

## Status

🚧 Joke room and gallery are live; the joke→video pipeline is being built. See [PLAN.md](PLAN.md) for the full roadmap.

## Stack

- Express + vanilla-JS pages (no framework yet — the prototype became the product)
- [nano-gpt](https://nano-gpt.com) API for everything: chat with web search, speech-to-text, text-to-speech (ElevenLabs voices routed through it), image/video models next
- Self-hosted on a DigitalOcean droplet behind Caddy (HTTPS), email-code sign-in via Resend
