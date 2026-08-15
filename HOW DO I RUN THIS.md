# How do I run this

Written 2026-08-15, after actually doing every step below on this machine (Windows,
RTX 5060 Ti) and confirming it works. Not a hypothetical walkthrough.

## What "running this" means right now

**Rook doesn't exist yet** — there's no tray app, no menu bar icon. What exists is the
**engine**: a Python process you start yourself in a terminal, which stays running and
serves HTTP on `127.0.0.1:8765`. "Running CORVVS" today means "the engine is running in
a terminal somewhere." Rook, when it exists, will replace the terminal with a tray icon
that does the same thing automatically at login — nothing about how you *use* the engine
from a project changes when that happens.

## One-time setup (already done on this machine)

```bash
cd z:/AI-PROJECTS/Corvvs
npm install
npm run setup
```

`npm run setup` fetches a private Python 3.12 into `engine/.venv`, installs PyTorch and
Kokoro into it, and verifies the GPU is actually reachable. On this machine it landed
here:

```
[setup] NVIDIA GPU detected (NVIDIA GeForce RTX 5060 Ti) — CUDA 12.8 wheel
[setup] ✓ ready — inference will run on cuda
```

Took about two minutes, ~2.6 GB downloaded (mostly the PyTorch CUDA wheel). If you're
setting this up on a **different** machine, this is the step to run there — it's
per-machine, not something that travels with the repo.

If it reports `cpu` instead of `cuda`/`mps`, see the "If you get `cpu`" sections in
[`engine/README.md`](../engine/README.md) before doing anything else — running on CPU
works but is ~170x slower and defeats the entire point.

## Starting it

```bash
npm start
```

You'll see the model load (~15s on this machine, first run also downloads ~350MB of
weights from Hugging Face — subsequent starts skip that):

```
[corvvs] torch 2.11.0+cu128
[corvvs] device: cuda (NVIDIA GeForce RTX 5060 Ti)
[corvvs] bound 127.0.0.1:8765, loading model...
[corvvs] model loaded in 14.87s
[corvvs] listening on http://127.0.0.1:8765
```

Leave this running in its own terminal — same idea as `ollama serve`. `Ctrl+C` stops it
cleanly. There's no daemon/background mode yet; that's what Rook is for.

## Testing it

**1. Health check** — confirms it's up and which device it landed on:

```bash
npm run health
```
```json
{ "status": "ok", "device": "cuda", "model": "kokoro-82m", "version": "0.1.0" }
```
If `device` ever comes back `cpu` on a run after setup reported `cuda`, something
changed (driver update, etc.) — worth investigating before relying on it.

**2. List voices** — confirmed 28 voices on this build:

```bash
curl http://127.0.0.1:8765/voices
```

**3. Synthesize something and listen to it:**

```bash
curl -X POST http://127.0.0.1:8765/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello there, this is a test.","voice":"af_heart"}' \
  -o test.wav
```

Open `test.wav` in anything. On this machine that request took ~250ms — that's the
number that matters; if it takes multiple seconds, the engine likely fell back to CPU
somewhere despite `/health` saying otherwise, worth re-checking.

**4. From Node, using the real client** (not curl) — save this as `try.mjs` anywhere and
run `node try.mjs`:

```js
import { corvvs } from 'z:/AI-PROJECTS/Corvvs/client/src/index.js';
// once published: import { corvvs } from 'corvvs';

const tts = corvvs();
const wav = await tts.speak('Testing from Node directly.');
console.log(wav.length, 'bytes');

// streaming — yields chunks as Kokoro's pipeline produces them (see note below)
for await (const { text, audio } of tts.speakStream('First part. Second part. Third part.')) {
  console.log('chunk:', text.length, 'chars,', audio.length, 'bytes');
}
```

**One thing that surprised me testing this:** `speakStream()` does not yield one chunk
per sentence. Kokoro's own pipeline batches several sentences into a chunk based on its
own internal length budget — three short sentences came back as a single chunk in
testing, while a longer paragraph came back as four chunks of roughly four sentences
each. If you need exactly one chunk per sentence, use `tts.split(text)` to split it
yourself first, then call `tts.speak()` once per sentence.

**5. Run the client's own test suite** (no GPU needed — it uses mock HTTP servers):

```bash
cd client && npm test
```
13 tests, all passing as of this writing.

## Stopping it

`Ctrl+C` in the terminal it's running in. If you lost that terminal (e.g. it was
backgrounded), find and kill the Python process:

- **Windows:** `tasklist | findstr python` → `taskkill /F /PID <pid>`
- **Mac:** `pkill -f server.py`

## Using it from another project, right now (before it's published to npm)

The `corvvs` name isn't published to the npm registry yet — see the note at the bottom.
Until then, point a project at this folder directly with a local `file:` dependency:

```bash
# from the other project's directory
npm install file:../Corvvs/client
```

```js
import { corvvs } from 'corvvs';
const tts = corvvs(); // talks to the engine you started with `npm start` above
```

This is exactly how VESTA's migration should work for now — see
`VESTA IMPLEMENTATION GUIDE.md` in this same folder.

## Publishing to npm (a manual step, not something I can do for you)

`npm publish` requires an interactive login (`npm login`, possibly an OTP), which can't
be driven by an automated session. When you're ready:

```bash
cd client
npm login                # once, if you haven't already
npm run build:types      # regenerates dist/*.d.ts — also runs automatically via prepublishOnly
npm publish
```

`client/package.json`'s `"files"` field already restricts what gets published to
`src/`, `dist/`, `README.md`, and `LICENSE` — so publishing from this monorepo does
**not** drag in `engine/` (the multi-GB Python side) or `app/` (Rook, whenever it
exists). `npm install corvvs` will only ever download the small client package, no
matter how large the rest of the repo grows. That was the actual goal behind "only
download the appropriate files," and it's already satisfied by this setup — nothing
further needs to change for it.

## Pushing this repo to GitHub

Not done yet — creating a public repo and pushing code is an action the harness itself
blocks without your direct hand on it, even when you've asked for it in chat. Run these
yourself:

```bash
cd z:/AI-PROJECTS/Corvvs
gh repo create magus-mechanicus/corvvs --public --source=. --remote=origin --push

cd z:/AI-PROJECTS/Kestrel
gh repo create magus-mechanicus/kestrel --private --source=. --remote=origin --push
```

Both are already git repos with commits ready to go (`corvvs`: 3 commits; `kestrel`: 1).
Nothing else needs to happen first.
