# corvvs

Fast, local, private text-to-speech. [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)
on your own GPU — no API keys, no per-character billing, nothing leaves the machine.

Published as `@adeptvs_mechanicvs/corvvs` — npm blocks a plain `corvvs` as too similar to
the widely-used `cors` package. The function you actually call is still named `corvvs`;
only the install/import specifier carries the scope.

```bash
npm install @adeptvs_mechanicvs/corvvs
```

```js
import { corvvs } from '@adeptvs_mechanicvs/corvvs';

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

### `tts.speakStream(text, { voice?, speed? })` → `AsyncGenerator<{ text, audio }>`

Yields clips as soon as they're ready instead of waiting for the whole text:

```js
for await (const { text, audio } of tts.speakStream(longArticle)) {
  console.log('now playing:', text);
  await play(audio); // however your app plays a WAV Buffer
}
```

**A yielded chunk is not one sentence.** Kokoro's own pipeline decides chunk boundaries
by an internal length budget, not punctuation — measured in this repo, anywhere from one
to several sentences came back per chunk. If you need one chunk per sentence
specifically, use `tts.split()` and call `speak()` per sentence instead.

Only the engine actually streams. If there's no engine and the CPU fallback kicks in,
`speakStream` still works — it just synthesizes the whole text up front and yields it as
one chunk, since `kokoro-js` has no equivalent streaming mode wired up here. Check
`tts.available()` first if your app needs to know which behavior it's getting.

### `tts.split(text)` → `string[]`

A sentence splitter, good enough for chunking text before `speak()`/`speakStream()` —
not a linguistic tokenizer. Handles common abbreviations (`Dr.`, `etc.`) and decimals
(`3.14`) without splitting on them; doesn't special-case runs of initials (`J. K.
Rowling` will over-split).

```js
for (const sentence of tts.split(article)) {
  await tts.speak(sentence);
}
```

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
import { CorvvsError } from '@adeptvs_mechanicvs/corvvs';

try {
  await tts.speak(text);
} catch (err) {
  if (err.code === 'ERR_TOO_LARGE') { /* split into sentences */ }
}
```

`ERR_UNREACHABLE` · `ERR_TIMEOUT` · `ERR_VERSION_MISMATCH` · `ERR_NO_FALLBACK` ·
`ERR_BAD_REQUEST` · `ERR_UNAUTHORIZED` · `ERR_TOO_LARGE` · `ERR_SYNTHESIS`

Only `ERR_UNREACHABLE` triggers the fallback. `ERR_TIMEOUT` deliberately does **not** —
a slow-but-working engine isn't the same as no engine, and falling back would make a slow
response look like an even slower one. Every other failure — including a
running-but-broken engine — surfaces as-is rather than being papered over.

## Notes

- Text over 5000 characters is rejected (`ERR_TOO_LARGE`). Use `tts.split()` to chunk a
  long document, or `speakStream()` to stream it sentence-by-sentence instead.
- `kokoro-js` is an `optionalDependency` (it powers the CPU fallback). Skip it with
  `npm install @adeptvs_mechanicvs/corvvs --omit=optional` for an HTTP-only client.
- Ships TypeScript declarations (`dist/index.d.ts`), generated from the JSDoc above via
  `npm run build:types`.

MIT.
