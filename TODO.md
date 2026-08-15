# TODO

Findings from a full review of the initial scaffold. Nothing here has been applied — the
code is exactly as first committed.

Ordered by priority. Everything in **P1** is a real defect that will bite a real user;
start there.

---

## P1 — Correctness

### 1. The engine has no lock around the model, but serves requests on threads

`engine/server.py` — `synthesize()`

`ThreadingHTTPServer` runs a thread per connection, and every one of them calls the
single module-level `pipeline` object. Neither `KPipeline` nor a PyTorch module is safe
for concurrent forward passes — `KPipeline` also mutates its own state when it loads a
voice it hasn't seen.

Two overlapping requests can produce garbled audio or crash the process. Anything that
splits a document into sentences and pipelines them hits this on the first try, which is
the main intended use.

**Fix:** a module-level `threading.Lock()` held for the body of `synthesize()`.
Serialising costs nothing real — the GPU does one clip at a time regardless, and
concurrent inference only adds VRAM pressure. It also makes latency predictable instead
of erratic under load.

### 2. `checkVersion` disables itself before it can throw

`client/src/index.js` — `checkVersion()`

`versionChecked = true` is set at the top of the function, before the major-version
mismatch check throws. A caller who catches that error and retries gets a silent pass
forever after, on a protocol that is genuinely incompatible.

**Fix:** set the flag only after the checks pass, so the throw path stays armed.

### 3. The version check never runs for most callers

`client/src/index.js`

`checkVersion()` is only reachable through `health()`. A project that just calls
`speak()` — the common case — never gets it, so `README.md` and `docs/protocol.md` both
promise a guarantee that in practice almost never applies.

**Fix:** run it once lazily on the first `speak()` as well. Either await a `/health` on
first use, or read the version off a response header the engine can add cheaply. Don't
just soften the docs — a stale engine after `npm update` is exactly the case this is for.

### 4. A timeout is misreported as "unreachable", and falls back to something slower

`client/src/index.js` — `request()`

The `catch` around `fetch` labels *everything* `ERR_UNREACHABLE`, including
`AbortSignal.timeout` firing. `speak()` treats `ERR_UNREACHABLE` as "no engine, use the
CPU fallback".

So a working-but-slow engine causes a fallback to a path ~170x slower still. Precisely
backwards, and it will look like a hang.

**Fix:** inspect the cause — `cause.name === 'TimeoutError'` — and raise a distinct
`ERR_TIMEOUT` that does *not* trigger the fallback. Add it to `errors.js` and the
protocol doc's client-raised list.

### 5. Racing first calls load the fallback model twice

`client/src/index.js` — `speak()`

```js
if (!fallbackEngine) { fallbackEngine = await createFallback(); }
```

Two `speak()` calls issued before either resolves both see `null` and both load ~90 MB of
weights, doubling a cost that is already the slowest thing in the package.

**Fix:** cache the promise rather than the resolved value — assign `createFallback()`
unawaited, then await the stored promise. Reset it to `null` on failure so a later call
can retry.

### 6. An unknown voice returns 500 when it should return 400

`engine/server.py` — `do_POST`

`voices.py` exports `VOICE_IDS` for exactly this, but `server.py` imports only `VOICES`
and never validates. A typo'd voice id reaches `pipeline()`, raises, and comes back as
`ERR_SYNTHESIS` — reporting an engine fault for what is a client mistake, and sending the
caller to debug the wrong side.

**Fix:** import `VOICE_IDS`, check before synthesising, return 400 `ERR_BAD_REQUEST`
naming the bad id. Cheap, and it makes `/voices` meaningful rather than decorative.

### 7. `engine/README.md` recommends a pip command that cannot work

The "if you get `cpu` on Windows" recovery steps say:

```bash
.venv/Scripts/python -m pip install --force-reinstall torch --index-url …
```

`uv venv` does not seed pip into the environment, so this fails with *No module named
pip* — for exactly the people already dealing with a failed install.

**Fix:** use uv for the reinstall too:

```bash
uv pip install --python engine/.venv/Scripts/python --force-reinstall torch --index-url …
```

Check the Mac block for the same mistake.

---

## P2 — Robustness and security

### 8. Token comparison is not constant-time

`engine/server.py` — `_authorized()`

`header[7:] == TOKEN` short-circuits on the first differing byte. Irrelevant across
loopback; it stops being irrelevant the moment an engine is exposed, which the whole
`url` + `key` design exists to allow.

**Fix:** `hmac.compare_digest`. One line, no downside.

### 9. The model loads before the socket binds

`engine/server.py` — module level

`KPipeline(...)` runs at import, ~15 s, and only then does `__main__` try to bind. If the
port is already held, you wait the full load to find out.

**Fix:** bind (or probe the port) first, then load the model. Also makes Rook's supervision
job easier — see `app/README.md`.

### 10. `speed` accepts booleans

`engine/server.py` — `do_POST`

`isinstance(True, int)` is `True` in Python, so `{"speed": true}` passes validation and
becomes `1.0`. Harmless in effect, but it means the validator doesn't do what it says.

**Fix:** exclude `bool` explicitly.

### 11. `npm test` passes without running anything

`client/package.json` sets `"test": "node --test"` and there are no test files, so it
exits 0 and reads as green. Worse than having no test script.

**Fix:** add real tests, at minimum:
- `available()` returns `false` with nothing listening (no throw)
- HTTP error bodies map onto the right `CorvvsError.code`
- a round-trip against a running engine producing a valid WAV header
- `ERR_TOO_LARGE` at the 5000-char boundary

---

## P3 — Efficiency and missing pieces

### 12. Streaming synthesis

The single largest perceived-latency win, and the one limitation most likely to be felt.
Today a 40-sentence document is one request, and nothing plays until all of it is done.

Sketch: `POST /synthesize/stream` returning `Transfer-Encoding: chunked` with a length-
prefixed WAV per sentence; client exposes an async iterator. Shape is already sketched in
`docs/protocol.md` under *Planned*. Needs the P1 lock (#1) in place first, since it makes
concurrency real rather than theoretical.

### 13. Ship a sentence splitter in the client

With a 5000-char cap and no streaming, every single consumer has to write one. Writing it
badly (splitting on `.`) breaks on abbreviations, decimals and quotes. Ship it once,
correctly, as `corvvs/split` or an option on `speak()`.

### 14. CORS preflight repeats on every request

`engine/server.py` — `_cors()` sends no `Access-Control-Max-Age`, so a browser client
re-preflights constantly. `Access-Control-Max-Age: 86400` removes a full round trip per
call.

### 15. No TypeScript types

The JSDoc is already thorough enough to generate from. Run
`tsc --declaration --emitDeclarationOnly` in a build step and add `types` to
`client/package.json`. Costs one devDependency and makes the package pleasant for the
substantial share of consumers on TypeScript.

### 16. `Buffer` blocks any browser build

`client/src/index.js` and `fallback.js` both return `Buffer`, a Node global. Any browser
consumer needs `ArrayBuffer` / `Uint8Array`.

**Fix when a browser build is wanted:** return `Uint8Array` from the core and let Node
callers wrap it — `Buffer` is a `Uint8Array` subclass, so most Node code keeps working.
Worth deciding before 1.0, because it's a breaking change afterwards.

---

## P4 — Later

- **Rook** (`app/`) — the tray app and installers. Plan and open questions are in
  `app/README.md`. Blocked on nothing; it's just the largest single piece of work.
- **Non-English voices.** The engine hardcodes `lang_code='a'` (American English). Kokoro
  ships others; exposing them means a pipeline per language and a larger resident
  footprint, so it needs a caching decision, not just a parameter.
- **Speech-to-text in the same runtime.** Whisper has the same Windows-GPU problem Kokoro
  did and would reuse this exact PyTorch venv. `docs/protocol.md` already reserves
  `GET /models` for when the engine hosts more than one thing. Do not build this until
  something actually needs it.
- **Auto-update for Rook.** Needs a signing key and a release feed. Worth it before any
  non-technical user installs this; not before.

---

## Decisions worth revisiting

- **`kokoro-js` as an `optionalDependency`.** It makes `npm install corvvs` work
  standalone, which was the point — but it pulls in `@huggingface/transformers`, so the
  install is far from small. If the thin client matters more than the zero-setup story,
  move it to an optional `peerDependency` and have `createFallback()` tell people to
  install it. One-line change either way; the current default favours "it just works".

- **The `LICENSE` copyright line and the `repository` URLs** carry a GitHub handle. Fine
  if that's the account this ships from; change both together if not.

- **`CORVVS_MAX_CHARS` at 5000.** Arbitrary. It exists so one request can't monopolise the
  GPU for minutes. Once streaming lands (#12), the natural limit is per-sentence and this
  can probably rise a lot.
