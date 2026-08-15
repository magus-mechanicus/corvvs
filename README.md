# CORVVS

Fast, local, private text-to-speech that any of your projects can use with one
`npm install` — no API keys, no per-character billing, nothing leaves the machine.

CORVVS runs [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) on your GPU and
exposes it over plain HTTP on localhost. Install it once per machine; every project on
that machine shares the one running model.

```js
import { corvvs } from 'corvvs';

const tts = corvvs();
const wav = await tts.speak('Hello there', { voice: 'af_heart' });
```

## Why

Kokoro is small, good, and permissively licensed — but getting it onto a GPU is fiddly,
and every project that wants speech ends up solving the same setup problem separately,
then holding its own copy of the model in VRAM.

CORVVS solves it once. One install per machine, one model resident, every project on the
box shares it over HTTP.

## The three pieces

| Piece | What it is | Where |
|---|---|---|
| **engine** | Python + PyTorch + Kokoro, serving HTTP on `127.0.0.1:8765` | `engine/` |
| **client** | The `corvvs` npm package your projects import | `client/` |
| **Rook** | Tray/menu-bar app supervising the engine, plus installers | `app/` — *not started* |

They share a repo because the client and the engine are the two ends of the same HTTP
call — see [`docs/protocol.md`](docs/protocol.md). Changing one always means changing the
other, so they version and release together.

```
   Your project
   │   import { corvvs } from 'corvvs'
   ▼
   client/  (npm)  ──── HTTP ────▶  engine/  (Python + GPU)
                                      ▲
                                      └── supervised by Rook (app/)
```

## Speed

Measured on an RTX 5060 Ti, one sentence, warm:

| Path | Device | Time |
|---|---|---|
| `kokoro-js` fallback (bundled, no setup) | CPU | ~29 s |
| CORVVS engine | CUDA / MPS | ~0.17 s |

Same model, same voices, same audio. The engine exists purely to reach the GPU:
`onnxruntime-node`'s Windows DirectML path has a confirmed kernel bug for this model,
while PyTorch's CUDA and MPS backends don't.

The client falls back to `kokoro-js` automatically when no engine is reachable, so
`npm install corvvs` works on its own — just slowly, and it says so. Installing the
engine makes it fast.

## Setup

Requires [Node](https://nodejs.org) 20+ and [`uv`](https://docs.astral.sh/uv/).
Python itself is **not** required — `uv` fetches a private, self-contained one into
`engine/.venv`. Nothing installs system-wide, nothing touches your PATH, and uninstalling
is deleting the folder.

```bash
git clone https://github.com/magus-mechanicus/corvvs
cd corvvs
npm install
npm run setup     # ~5 min, one time — fetches Python, PyTorch and the model
npm start         # engine on http://127.0.0.1:8765
```

Then confirm it actually found your GPU:

```bash
npm run health
# { status: 'ok', device: 'cuda', model: 'kokoro-82m', version: '0.1.0' }
```

`device` must be `cuda` (NVIDIA) or `mps` (Apple Silicon). If it says `cpu`, the install
fell back and everything will be ~170x slower than it should be — see
[`engine/README.md`](engine/README.md). `npm run setup` also exits non-zero in that case
rather than reporting a cheerful success.

## Using it

```bash
npm install corvvs
```

```js
import { corvvs } from 'corvvs';

const tts = corvvs();
const wav    = await tts.speak('Hello there', { voice: 'af_heart', speed: 1.0 });
const voices = await tts.voices();
const health = await tts.health();
const up     = await tts.available();   // never throws

for await (const { text, audio } of tts.speakStream(longArticle)) {
  await play(audio); // plays as each chunk finishes, not after the whole document
}
```

The engine's location is always a parameter, never an assumption:

```js
corvvs();                                     // local (default)
corvvs({ url: 'http://192.168.1.50:8765' });  // another machine on the LAN
corvvs({ url: 'https://…', key: '…' });       // a hosted engine
```

Local, LAN and hosted engines all speak the identical protocol, so moving between them
is a config change rather than a rewrite.

Full client docs: [`client/README.md`](client/README.md).

## Configuration

Engine-side, all via environment variables:

| Variable | Default | |
|---|---|---|
| `CORVVS_HOST` | `127.0.0.1` | Bind address |
| `CORVVS_PORT` | `8765` | |
| `CORVVS_VOICE` | `af_heart` | Default when a request omits `voice` |
| `CORVVS_TOKEN` | *(unset)* | When set, bearer auth is required |
| `CORVVS_ALLOWED_ORIGINS` | *(unset)* | Comma-separated CORS allowlist for browser clients |
| `CORVVS_MAX_CHARS` | `5000` | Per-request cap |

Binding to anything other than loopback **without** `CORVVS_TOKEN` set makes the engine
refuse to start. An unauthenticated TTS engine reachable from the network is someone
else's free GPU.

## Limitations

Worth knowing before you build on it:

- **`speak()` is not streamed** — one request, one complete WAV, so long text means
  waiting for all of it before any of it plays. `speakStream()` covers this when the
  engine is running (clips playable as they arrive — though a "clip" is however much
  text Kokoro's pipeline batched, not one sentence); the CPU fallback can't stream and
  just yields the whole thing as a single chunk.
- **Text is capped at 5000 characters** per request (`ERR_TOO_LARGE`). Use `tts.split()`
  to chunk a longer document.
- **English only.** The engine loads Kokoro's `a` (American English) pipeline. Other
  languages exist in the model but aren't wired up.
- **Requests are serialised in practice.** The GPU processes one clip at a time;
  concurrency buys nothing.
- **Rook doesn't exist yet.** The engine is a process you start yourself.
- **Apple Silicon is untested on real hardware.** The MPS path is written and should
  work, but nobody has run it on a Mac yet.

See [`TODO.md`](TODO.md) for the full list of known issues and planned work.

## Repo layout

```
engine/     Python — the Kokoro HTTP server
  server.py       routes, auth, validation
  voices.py       the voice roster served by /voices
client/     The `corvvs` npm package
  src/index.js    the client factory
  src/fallback.js in-process CPU synthesis
  src/split.js    the sentence splitter
  src/errors.js   CorvvsError + code list
  test/           node:test suite — runs against mock HTTP servers, no GPU needed
app/        Rook, the tray app (not started)
docs/       protocol.md — the wire contract
scripts/    setup.mjs, start.mjs
```

## License

MIT — see [LICENSE](LICENSE).

Kokoro-82M is Apache 2.0 and free for commercial use. Its model card states it was
trained on permissively licensed and public-domain audio, plus synthetic audio from
closed TTS providers; if you are building something commercial on it, that last part is
worth reading yourself rather than taking on trust.
