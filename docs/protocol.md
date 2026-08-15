# The CORVVS protocol

The contract between `client/` (JavaScript) and `engine/` (Python). Both sides live in
this repo specifically so this document can't drift out of sync with either of them.

Plain HTTP + JSON. Deliberately small — a third-party engine implementing these three
endpoints is a drop-in replacement, and that is the property that makes a hosted CORVVS
possible later without a client rewrite.

## Transport

Default `http://127.0.0.1:8765`. The client takes a full base URL, so the engine may
equally live on another machine on the LAN or behind TLS on the public internet. Nothing
in this protocol assumes localhost.

**Auth.** If the engine is started with `CORVVS_TOKEN` set, every request must carry
`Authorization: Bearer <token>` or it is rejected with `401`. When the variable is unset
the engine is open — acceptable bound to `127.0.0.1` on a single-user machine, and the
reason the default bind address is loopback rather than `0.0.0.0`. Any deployment
reachable by another machine must set a token.

**CORS.** Browser clients need this; Node clients do not. The engine echoes
`Access-Control-Allow-Origin` only for origins listed in `CORVVS_ALLOWED_ORIGINS`
(comma-separated) and answers `OPTIONS` preflights with `Access-Control-Max-Age: 86400`,
so a browser only preflights once a day rather than once per request. Unset means no CORS
headers at all, which is the correct default for a machine that isn't running a browser
client.

**Versioning.** Every response — success or error — carries `X-Corvvs-Version`. The
client checks it on every request (not only `/health`): a major-version mismatch throws
immediately, since the engine and client are developed together in this repo and a
mismatch means the protocol itself may have changed underneath one of them.

## `GET /health`

Liveness plus — importantly — which device inference actually landed on. A silent CPU
fallback is ~170x slower than GPU, so this is the endpoint that tells you the install
worked, not merely that the process is up.

```json
{ "status": "ok", "device": "cuda", "model": "kokoro-82m", "version": "0.1.0" }
```

`device` is `cuda` | `mps` | `cpu`. Never requires auth — supervisors and health checks
shouldn't need a credential to ask whether the process is alive.

## `GET /voices`

```json
{ "voices": [ { "id": "af_heart", "name": "Heart", "gender": "female", "language": "en-US" } ] }
```

Served from the engine rather than hardcoded in the client, so adding a voice doesn't
require an npm release.

## `POST /synthesize`

```json
{ "text": "Hello there", "voice": "af_heart", "speed": 1.0 }
```

| Field | Required | Default |
|---|---|---|
| `text` | yes | — |
| `voice` | no | `CORVVS_VOICE`, itself defaulting to `af_heart` — must be a known id from `GET /voices`, or the request is rejected |
| `speed` | no | `1.0` (range `0.5`–`2.0`) |

Responds `200` with `Content-Type: audio/wav` and the raw bytes: 24 kHz, 16-bit PCM, mono.

The full clip is buffered and returned in one response — no partial results. Fine for a
sentence or a paragraph; for a long document either split it yourself and pipeline the
requests (see `corvvs.split()` in the client), or use `/synthesize/stream` below.

## `POST /synthesize/stream`

Same request body as `/synthesize`. Responds `200` with
`Content-Type: application/x-corvvs-stream` and `Transfer-Encoding: chunked` — one frame
per segment Kokoro's own pipeline yields, so playback can start before the rest of the
text has synthesized.

**A frame is not one sentence.** Kokoro's pipeline decides chunk boundaries with its own
internal splitter, governed by a length budget rather than punctuation — measured in
this repo, three short sentences came back as a single frame, while ~1700 characters of
short sentences came back as four frames of roughly four sentences each. Treat a frame as
"however much text Kokoro decided to batch," not as a sentence, a paragraph, or anything
else semantically meaningful. If you need per-sentence chunks specifically, split the
input yourself first (`corvvs.split()`) and call `/synthesize` once per sentence instead.

Each frame is two length-prefixed parts back to back:

```
u32 metaLen (big-endian)
metaLen bytes of JSON: { "text": "<the text this clip covers>" }
u32 wavLen (big-endian)
wavLen bytes of WAV audio (24 kHz, 16-bit PCM, mono)
```

Frames repeat until the chunked body ends. There is no separate terminator frame —
end-of-stream is the end of the HTTP chunked encoding itself (a zero-length final chunk),
same as any other chunked response.

**Errors after the response has started can't be reported in-band.** By the time
synthesis begins, the `200` and headers are already on the wire, so a mid-stream failure
can only end the connection early — the engine logs it, but the client just sees a
truncated stream. Validation (bad text, bad voice, bad speed, auth) happens *before*
headers are sent and still returns a normal JSON error with the correct status code, same
as `/synthesize`.

The connection is closed after one stream (`Connection: close`) rather than kept alive —
simpler and safer than reasoning about keep-alive framing around a hand-rolled chunked
body.

## Errors

Non-2xx responses carry `Content-Type: application/json`:

```json
{ "error": "text is required", "code": "ERR_BAD_REQUEST" }
```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `ERR_BAD_REQUEST` | missing/empty `text`, unknown `voice`, `speed` out of range or not a number, malformed JSON |
| 401 | `ERR_UNAUTHORIZED` | `CORVVS_TOKEN` set, token missing or wrong |
| 404 | `ERR_NOT_FOUND` | unknown path |
| 413 | `ERR_TOO_LARGE` | `text` over `CORVVS_MAX_CHARS` (default 5000) |
| 500 | `ERR_SYNTHESIS` | the model raised during generation |

These are the engine's codes, sent as the JSON body's `code` field. The client also
raises purely client-side codes that never come from the engine: `ERR_UNREACHABLE` (no
connection could be made at all), `ERR_TIMEOUT` (a connection was made but nothing came
back within the configured timeout), `ERR_VERSION_MISMATCH`, and `ERR_NO_FALLBACK`. See
`client/src/errors.js` for the authoritative list.

The client maps **only** `ERR_UNREACHABLE` to its `kokoro-js` fallback. Everything else —
including `ERR_TIMEOUT` — propagates as an error. This is deliberate: a slow-but-working
engine is not the same condition as no engine at all, and silently downgrading a timeout
to the ~170x-slower CPU path would make a slow response look like an even slower one
instead of surfacing the real problem.

## Configuration

Engine-side environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `CORVVS_HOST` | `127.0.0.1` | bind address — change only alongside `CORVVS_TOKEN` |
| `CORVVS_PORT` | `8765` | |
| `CORVVS_VOICE` | `af_heart` | default when a request omits `voice` |
| `CORVVS_TOKEN` | *(unset)* | when set, bearer auth is required |
| `CORVVS_ALLOWED_ORIGINS` | *(unset)* | comma-separated CORS allowlist |
| `CORVVS_MAX_CHARS` | `5000` | per-request cap |

## Versioning

`version` in `/health` is the engine's, and it tracks this repo's version — so the client
and engine that shipped together always report the same number. The client warns on a
minor-version mismatch and refuses on a major one.

## Planned

Not implemented; recorded here so the shape is agreed before either side builds it.

- **`GET /models`** — once the engine hosts more than Kokoro (Whisper for STT is the
  obvious second occupant of the same PyTorch runtime).
