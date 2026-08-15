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

**CORS.** Browser clients (Kestrel) need this; Node clients do not. The engine echoes
`Access-Control-Allow-Origin` only for origins listed in `CORVVS_ALLOWED_ORIGINS`
(comma-separated) and answers `OPTIONS` preflights. Unset means no CORS headers at all,
which is the correct default for a machine that isn't running the extension.

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
| `voice` | no | `CORVVS_VOICE`, itself defaulting to `af_heart` |
| `speed` | no | `1.0` (range `0.5`–`2.0`) |

Responds `200` with `Content-Type: audio/wav` and the raw bytes: 24 kHz, 16-bit PCM, mono.

Synthesis is **not** streamed — the full clip is buffered and returned in one response.
Fine for a sentence or a paragraph; for reading a long article the caller should split
into sentences and pipeline the requests itself. Native streaming is a planned protocol
addition (see below).

## Errors

Non-2xx responses carry `Content-Type: application/json`:

```json
{ "error": "text is required", "code": "ERR_BAD_REQUEST" }
```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `ERR_BAD_REQUEST` | missing/empty `text`, `speed` out of range, malformed JSON |
| 401 | `ERR_UNAUTHORIZED` | `CORVVS_TOKEN` set, token missing or wrong |
| 404 | `ERR_NOT_FOUND` | unknown path |
| 413 | `ERR_TOO_LARGE` | `text` over `CORVVS_MAX_CHARS` (default 5000) |
| 500 | `ERR_SYNTHESIS` | the model raised during generation |

The client maps a connection failure (engine not running) to its `kokoro-js` fallback
rather than an error. Every other failure propagates — a running-but-broken engine is a
real problem and shouldn't be masked by silently getting 170x slower.

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

- **`POST /synthesize/stream`** — chunked response, one WAV frame per sentence, so long
  text starts playing before it finishes generating. The single biggest quality-of-life
  gap for Kestrel's read-an-article case.
- **`GET /models`** — once the engine hosts more than Kokoro (Whisper for STT is the
  obvious second occupant of the same PyTorch runtime).
