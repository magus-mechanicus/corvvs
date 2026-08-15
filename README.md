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

## The three pieces

| Piece | What it is | Where it lives |
|---|---|---|
| **engine** | Python + PyTorch + Kokoro, serving HTTP on `127.0.0.1:8765` | `engine/` |
| **client** | The `corvvs` npm package your projects import | `client/` |
| **Rook** | Tray/menu-bar app that supervises the engine, plus the installers | `app/` |

They live in one repo because the client and the engine are the two ends of the same
HTTP call — see [`docs/protocol.md`](docs/protocol.md). Changing one always means
changing the other, so they version and release together.

```
   Your project (VESTA, Kestrel, anything)
   │   import { corvvs } from 'corvvs'
   ▼
   client/   (npm)  ────────  HTTP ──▶  engine/  (Python + GPU)
                                          ▲
                                          └── supervised by Rook (app/)
```

## Speed

Measured on an RTX 5060 Ti, one sentence, warm:

| Path | Device | Time |
|---|---|---|
| `kokoro-js` fallback (bundled, no setup) | CPU | ~29 s |
| CORVVS engine | CUDA / MPS | ~0.17 s |

Same model, same voices, same audio. The engine exists purely to reach the GPU —
`onnxruntime-node`'s Windows DirectML path has a confirmed kernel bug for this model,
while PyTorch's CUDA and MPS backends don't.

The client falls back to `kokoro-js` automatically when the engine isn't running, so
`npm install corvvs` works on its own — just slowly. Installing the engine makes it fast.

## Setup

Requires [Node](https://nodejs.org) 20+ and [`uv`](https://docs.astral.sh/uv/).
Python itself is *not* required — `uv` fetches a private, self-contained one into
`engine/.venv`. Nothing is installed system-wide; deleting this folder removes everything.

```bash
git clone https://github.com/magus-mechanicus/corvvs
cd corvvs
npm install
npm run setup     # ~5 min, one time — downloads Python, PyTorch and the model
npm start         # engine comes up on http://127.0.0.1:8765
```

Confirm it found your GPU:

```bash
curl http://127.0.0.1:8765/health
# {"status":"ok","device":"cuda","model":"kokoro-82m","version":"0.1.0"}
```

If `device` comes back `cpu`, the setup fell back — see [`engine/README.md`](engine/README.md).
It will always tell you which device it actually landed on rather than being silently slow.

## Using it from a project

```bash
npm install corvvs
```

```js
import { corvvs } from 'corvvs';

const tts = corvvs();                                   // local engine (default)
const tts = corvvs({ url: 'http://192.168.1.50:8765' }); // engine on another machine
const tts = corvvs({ url: 'https://…', key: '…' });      // a hosted engine

const wav     = await tts.speak('Hello there');
const voices  = await tts.voices();
const health  = await tts.health();
```

The client never assumes the engine is local — it takes a URL and an optional key. Local,
LAN, and hosted deployments all speak the identical protocol.

## Status

| | |
|---|---|
| `engine/` | working — HTTP synthesis, health, voices |
| `client/` | working — speak, voices, health, CPU fallback |
| `app/` (Rook) | not started — see [`app/README.md`](app/README.md) |
| streaming | not started — synthesis returns one complete WAV |

## License

MIT — see [LICENSE](LICENSE). Kokoro-82M is Apache 2.0 and free for commercial use.
