# corvvs

Fast, local, private text-to-speech. [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)
on your own GPU — no API keys, no per-character billing, nothing leaves the machine.

```bash
npm install corvvs
```

```js
import { corvvs } from 'corvvs';

const tts = corvvs();
const wav = await tts.speak('Hello there', { voice: 'af_heart' });
```

`wav` is a Buffer: 24 kHz, 16-bit PCM, mono.

## This package is the client

The synthesis happens in the **CORVVS engine**, a small service you install once per
machine and every project on it shares. Install it from
[the repo](https://github.com/magus-mechanicus/corvvs):

```bash
git clone https://github.com/magus-mechanicus/corvvs
cd corvvs && npm install && npm run setup && npm start
```

Without the engine this package still works — it falls back to running the same model on
the CPU, which is correct but roughly **170x slower** (~29 s/sentence vs ~0.17 s). It logs
a warning when that happens rather than being quietly slow.

## API

### `corvvs(options?)`

| Option | Default | |
|---|---|---|
| `url` | `http://127.0.0.1:8765` | Engine base URL. Also read from `CORVVS_URL` |
| `key` | — | Bearer token, if the engine requires one. Also `CORVVS_TOKEN` |
| `voice` | `af_heart` | Default voice |
| `speed` | `1.0` | Default speed, 0.5–2.0 |
| `fallback` | `true` | CPU fallback when no engine is reachable |
| `timeout` | `120000` | Per-request timeout, ms |

The engine's location is always a parameter — local, LAN, and hosted engines speak the
same protocol:

```js
corvvs();                                         // local
corvvs({ url: 'http://192.168.1.50:8765' });      // another machine
corvvs({ url: 'https://…', key: '…' });           // hosted
```

### `tts.speak(text, { voice?, speed? })` → `Promise<Buffer>`

### `tts.voices()` → `Promise<Voice[]>`

Each voice carries the model author's own quality `grade`. The roster is long but only a
handful are genuinely good — sort by grade before showing users a dropdown.

```js
[{ id: 'af_heart', name: 'Heart', gender: 'female', language: 'en-US', grade: 'A' }, …]
```

### `tts.health()` → `Promise<{ status, device, model, version }>`

`device` is `cuda`, `mps`, or `cpu`. **A `cpu` result on a machine with a GPU means the
engine install fell back** and everything will be far slower than it should be.

### `tts.available()` → `Promise<boolean>`

Never throws. For deciding a code path up front — disabling a "read aloud" button, say —
rather than discovering the answer mid-synthesis.

## Errors

Every failure is a `CorvvsError` with a stable `code`:

```js
import { CorvvsError } from 'corvvs';

try {
  await tts.speak(text);
} catch (err) {
  if (err.code === 'ERR_TOO_LARGE') { /* split into sentences */ }
}
```

`ERR_UNREACHABLE` · `ERR_VERSION_MISMATCH` · `ERR_NO_FALLBACK` · `ERR_BAD_REQUEST` ·
`ERR_UNAUTHORIZED` · `ERR_TOO_LARGE` · `ERR_SYNTHESIS`

Only `ERR_UNREACHABLE` triggers the fallback. A running-but-broken engine surfaces its
error — silently becoming 170x slower is worse than failing.

## Notes

- Text over 5000 characters is rejected (`ERR_TOO_LARGE`). Split long documents into
  sentences and pipeline them; the engine holds the model resident, so per-request
  overhead is small.
- Synthesis is not streamed yet — you get one complete WAV per call.
- `kokoro-js` is an `optionalDependency` (it powers the CPU fallback). Skip it with
  `npm install corvvs --omit=optional` for an HTTP-only client.

MIT.
