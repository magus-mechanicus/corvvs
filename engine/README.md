# engine/

Kokoro-82M behind a small HTTP server. See [`../docs/protocol.md`](../docs/protocol.md)
for the wire contract.

## Why Python at all

The npm package `kokoro-js` runs the identical model and produces the identical audio —
but on Windows it can't reach the GPU. `onnxruntime-node`'s DirectML execution provider
has a confirmed kernel bug for this model, so it silently falls back to CPU: **~29 seconds
per sentence**. PyTorch's CUDA (Windows/NVIDIA) and MPS (Apple Silicon) backends have no
such problem: **~0.17 seconds**.

So this directory exists for exactly one reason — reaching the GPU. Everything else about
it is incidental.

## Setup

Run `npm run setup` from the repo root. It uses [`uv`](https://docs.astral.sh/uv/) to
fetch a private Python into `engine/.venv`, then installs PyTorch from the index matching
your hardware, then the rest of `requirements.txt`.

Nothing lands outside this folder — no system Python, no global pip, no PATH edits.
Uninstalling is `rm -rf engine/.venv`.

## Verifying the GPU

The single most important check after a fresh install:

```bash
curl http://127.0.0.1:8765/health
```

```json
{ "status": "ok", "device": "cuda", "model": "kokoro-82m", "version": "0.1.0" }
```

| `device` | Meaning |
|---|---|
| `cuda` | NVIDIA GPU — correct on Windows |
| `mps` | Apple Silicon GPU — correct on Mac |
| `cpu` | **fell back** — working but ~170x slower |

The startup log prints the same thing. It will never pretend to be fast.

### If you get `cpu` on Windows

The PyTorch CUDA wheel didn't match your driver. Check what torch thinks:

```bash
.venv/Scripts/python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

If `False`, reinstall torch against a different CUDA version — `cu128`, `cu126` and
`cu121` are the usual candidates. See https://pytorch.org/get-started/locally/ for the
build matching your driver:

```bash
.venv/Scripts/python -m pip install --force-reinstall torch --index-url https://download.pytorch.org/whl/cu126
```

### If you get `cpu` on Mac

Apple Silicon MPS support ships in the default PyPI wheel — there's no special index to
pick, so a `cpu` result usually means an Intel Mac (no MPS at all, nothing to fix) or a
broken install. Check:

```bash
.venv/bin/python -c "import torch; print(torch.backends.mps.is_available())"
```

**This path has not yet been run on real Apple Silicon hardware** — it's derived from the
`kokoro` package's documented device selection. Expect to shake out a bug or two the
first time.

## Running it directly

`npm start` from the repo root is the normal way. Directly:

```bash
uv run --project engine engine/server.py
```

The model loads once at startup (~15 s) and stays resident. Keep the process running
rather than starting it per request — startup dominates everything else.

## Security

Binds `127.0.0.1` by default, with no auth. That's reasonable for a single-user machine
where only local processes can reach it.

Bind anywhere else and the server **refuses to start** unless `CORVVS_TOKEN` is set —
an unauthenticated TTS engine reachable from the network is an open invitation to burn
someone else's GPU. That check is at the top of `server.py` and is deliberate.
