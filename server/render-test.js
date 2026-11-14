// Scratch: Phase 3 pipeline test — joke -> TTS -> scene still -> animate -> lipsync.
// Each step caches its output to projects/joke-factory/renders/test/ so a failed
// step can be retried without re-spending on the ones that already worked.
// Usage: node server/render-test.js [--fresh]
const fs = require('fs');
const path = require('path');
const ng = require('./nanogpt');

const ROOT = path.join(__dirname, '..');
const MODELS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'models.json'), 'utf8'));
const TTS_VOICE = fs.readFileSync(path.join(ROOT, '.secrets', 'elevenlabs-voice-id'), 'utf8').trim();
const OUT = path.join(ROOT, 'projects', 'joke-factory', 'renders', 'test');

const JOKE = "I bought some shoes off a drug dealer. [pause] I don't know what he laced them with… [laughs] but I've been trippin all day.";
const SETTING = 'a dim concrete multi-storey car park at night, lit by cold fluorescent strips, painted pillars';
const JACOB_LOOK = 'the man in the photo — keep his face, black beanie, grey zip-up hoodie over bright orange top, blue/black hydration vest, black cargo shorts, bright blue leggings, neon trail runners exactly identical';

const F = {
  audio: path.join(OUT, 'joke.mp3'),
  scene: path.join(OUT, 'scene.png'),
  final: path.join(OUT, 'final.mp4'),
};

if (process.argv.includes('--fresh')) for (const f of Object.values(F)) fs.rmSync(f, { force: true });
fs.mkdirSync(OUT, { recursive: true });

const have = f => fs.existsSync(f);
const est = b => `~$${b}`;

async function main() {
  // 1. joke audio in Jacob's voice
  if (!have(F.audio)) {
    console.log('[1/3] TTS…');
    fs.writeFileSync(F.audio, await ng.speak(JOKE, MODELS.tts, TTS_VOICE));
  }
  const audioBytes = fs.statSync(F.audio).size;
  const audioSecs = Math.max(3, Math.ceil(audioBytes * 8 / 128000)); // ~128kbps mp3 estimate
  if (audioSecs < 4) console.warn('WARN: audio under OmniHuman 4s minimum');
  console.log(`[1/3] audio ${(audioBytes/1024).toFixed(0)}KB, est ${audioSecs}s`);

  // 2. scene still: Jacob placed in the setting
  if (!have(F.scene)) {
    console.log('[2/4] scene still (seedream edit)…');
    const buf = await ng.imageGen(MODELS.scene_image,
      `Put ${JACOB_LOOK} standing in ${SETTING}. He faces the camera straight on, deadpan, mid-shot from thighs up, cinematic realism, vertical 9:16 framing.`,
      { input_references: [ng.dataUrl(path.join(ROOT, 'projects', 'joke-factory', 'jacob', 'jacob-front.png'))],
        aspect_ratio: '9:16', resolution: '1k' });
    fs.writeFileSync(F.scene, buf);
  }
  console.log(`[2/3] scene ${(fs.statSync(F.scene).size/1024).toFixed(0)}KB`);

  // 3. OmniHuman: scene still + joke audio -> lip-synced clip (length follows audio)
  if (!have(F.final)) {
    console.log(`[3/3] avatar render (${MODELS.avatar_video}, est ${est(0.75)})…`);
    const v = await ng.video({
      model: MODELS.avatar_video,
      prompt: 'The man tells the joke straight to camera, deadpan. He points off to the side with one hand at the setup, then drops his hand. Small natural head movements, static camera.',
      imageDataUrl: ng.dataUrl(F.scene),
      audioDataUrl: ng.dataUrl(F.audio),
    }, { onTick: s => console.log('  avatar:', s.status) });
    fs.writeFileSync(F.final, v.buffer);
  }
  console.log(`[3/3] final ${(fs.statSync(F.final).size/1024/1024).toFixed(1)}MB -> ${F.final}`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
