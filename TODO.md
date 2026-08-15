# TODO

P1, P2, and P3 from the original review are implemented, tested against a real engine
run (RTX 5060 Ti, CUDA), and committed. What's below is what's left.

---

## Done (2026-08-15)

**P1 — correctness**
- Model access is now serialized with a `threading.Lock` (`engine/server.py`) — concurrent
  requests no longer race on the shared `KPipeline`/torch state.
- Version checking no longer disarms itself, and now runs on *every* response (not just
  `/health`) via a new `X-Corvvs-Version` header the engine sends on every reply — better
  than the originally planned fix, and covers `speak()`/`speakStream()` too, not just
  `health()`.
- A request timeout now raises `ERR_TIMEOUT`, distinct from `ERR_UNREACHABLE` — only the
  latter triggers the CPU fallback, so a slow engine no longer gets "fixed" by becoming
  170x slower.
- The CPU fallback's model load is now a cached promise, not a cached value — concurrent
  first calls share one load instead of racing two.
- An unknown `voice` now returns `400 ERR_BAD_REQUEST` (validated against
  `voices.VOICE_IDS` before synthesis) instead of a `500` from deep inside Kokoro.
  Verified live: `curl -d '{"text":"hello","voice":"not_a_real_voice"}'` → 400.
- `engine/README.md`'s GPU-recovery snippets now use `uv pip install --python …` instead
  of `python -m pip`, which fails on a `uv`-created venv (no pip seeded).

**P2 — robustness/security**
- Token comparison uses `hmac.compare_digest` (constant-time).
- Startup now binds the socket *before* loading the model — a port conflict fails in
  under a second instead of after paying the ~15s load. Verified: model loading was
  moved out of module scope into `if __name__ == '__main__':`, after `ThreadingHTTPServer(...)`
  construction (which binds), before `serve_forever()`.
- `speed` now explicitly rejects booleans (`isinstance(speed, bool)` checked before the
  `int`/`float` check — Python's `bool` is an `int` subclass, so `True` used to pass as `1.0`).
- `client/test/corvvs.test.js` added: 13 tests against mock HTTP servers (no GPU/torch
  needed) — `available()`, error-code mapping, version-mismatch throwing, a `speak()`
  round trip, `speakStream()` frame parsing, and `splitSentences()`. All passing.

**P3 — features**
- `POST /synthesize/stream`: chunked HTTP response, length-prefixed frames (JSON meta +
  WAV per frame). Client exposes it as `tts.speakStream()`, an async generator.
  **Correction made after live testing, not assumed from the design:** a frame is *not*
  one sentence. Kokoro's own pipeline batches by an internal length budget — measured,
  3 short sentences came back as 1 frame; ~1700 characters came back as 4 frames of
  roughly 4 sentences each. All docs (`docs/protocol.md`, both READMEs, the JSDoc) were
  corrected to say this explicitly rather than the originally-planned "one per sentence."
  If you need true per-sentence granularity, `tts.split()` + one `speak()` call each.
- `tts.split(text)` / `splitSentences()` (`client/src/split.js`) — abbreviation- and
  decimal-aware sentence splitter. Documented limitation: over-splits runs of initials
  ("J. K. Rowling").
- `Access-Control-Max-Age: 86400` added to CORS preflight responses.
- TypeScript declarations generated from the existing JSDoc via `tsc` (`client/tsconfig.json`,
  `npm run build:types`, wired into `prepublishOnly`). Needed `skipLibCheck: true` —
  without it, `kokoro-js`'s own (pre-existing, third-party) `.d.ts` errors blocked
  emission of ours entirely. Verified: `dist/*.d.ts` generated clean.

**Not done — still an open decision, per the original item's own text:**
- #16, `Buffer` blocking a browser build. Left alone deliberately — there's no browser
  consumer yet (Kestrel doesn't exist), so there's nothing to validate a fix against.
  Revisit when Kestrel needs to call this code directly instead of via `fetch()`.

**Verification performed**, not just written:
- `npm run setup` run for real: fetched a private Python 3.12, PyTorch 2.11.0+cu128,
  Kokoro 0.9.4 — landed on `cuda` against the RTX 5060 Ti, confirmed via the setup
  script's own probe.
- Engine started for real (`npm start`), then hit with `curl` and the real client:
  `/health`, `/voices` (28 voices), `/synthesize` (valid + invalid voice), and
  `/synthesize/stream` (valid, oversized text, invalid voice — all three validated
  *before* headers were sent, confirmed no partial/broken stream on the error paths).
- `npm run build:types` run for real, output inspected.
- `node --test` run for real: 13/13 passing.

---

## P4 — later, unchanged from the original review

- **Rook** (`app/`) — the tray app and installers. Plan and open questions in
  `app/README.md`. Blocked on nothing; it's just the largest remaining piece of work.
- **Non-English voices.** The engine hardcodes `lang_code='a'` (American English). Kokoro
  ships others; exposing them means a pipeline per language and a larger resident
  footprint, so it needs a caching decision, not just a parameter.
- **Speech-to-text in the same runtime.** Whisper has the same Windows-GPU problem Kokoro
  did and would reuse this exact PyTorch venv. `docs/protocol.md` reserves `GET /models`
  for when the engine hosts more than one thing. Don't build until something needs it.
- **Auto-update for Rook.** Needs a signing key and a release feed. Worth it before any
  non-technical user installs this; not before.

## Decisions still worth revisiting later

- **`kokoro-js` as an `optionalDependency`.** Makes `npm install corvvs` work standalone,
  but pulls in `@huggingface/transformers` — not a small install. If the thin client
  matters more than the zero-setup story, move it to a `peerDependency` instead.
- **`CORVVS_MAX_CHARS` at 5000.** Arbitrary — exists so one request can't monopolize the
  GPU for minutes. Now that both chunked streaming and `split()` exist, this could
  reasonably rise; nothing forces it to stay at 5000.
- **The streaming frame format has no version negotiation of its own** — it rides on the
  same `X-Corvvs-Version` header as everything else, but a client parsing raw frame bytes
  against a future incompatible framing change would fail confusingly (bad `metaLen`,
  garbage JSON) rather than with a clear error. Worth a magic-byte prefix if the framing
  ever needs to change.
