# ReelEnder Studio

**An AI joke factory. One character, one joke a day, posted everywhere.**

Jacob — the Traveling Joker — tells a daily joke on social media, always the same guy, same clothes, same voice. An AI scout hunts the internet for the funniest short jokes; you hear each one and keep or toss it; accepted jokes get voiced, turned into a short vertical video of Jacob, and posted. Simple loop, thousands of jokes.

## The site

- **[reelender.com](https://reelender.com)** — landing page: Jacob's name, the two newest clips as samples, and a "see more jokes" door into the gallery
- **[reelender.com/clips](https://reelender.com/clips)** — the public gallery: a thumbnail wall of every finished clip with the joke text and links out to TikTok/IG/YouTube posts. All clips are open source — use them for whatever you want
- **reelender.com/room** — the joke room (sign-in required): voice-first curation where the scouting and deciding happens

## The joke room

- **Scout button** → the AI searches the web and returns joke cards: hear it / keep / toss
- **Dupe radar** → every candidate is scored against the vault; near-matches get flagged with the joke they resemble before you decide
- **The vault** → kept / produced / tossed catalog. Every joke can be heard, edited (ElevenLabs `[pause]`/`[laughing]` tags supported), moved between piles, or deleted — and you can add your own jokes manually
- **Produced flag** → mark a kept joke when its clip is made, so the backlog and the done pile stay separate
- Everything is spoken in the same ElevenLabs voice — which is also Jacob's voice

## Status

🚧 Curation is fully live; the joke→video pipeline is next. See [PLAN.md](PLAN.md) for the full roadmap.

## Stack

- Express + vanilla-JS pages (no framework — the prototype became the product)
- [nano-gpt](https://nano-gpt.com) API for everything: chat with web search, speech-to-text, text-to-speech (ElevenLabs voices routed through it), image/video models next
- Self-hosted on a DigitalOcean droplet behind Caddy (HTTPS), email-code sign-in via Resend
