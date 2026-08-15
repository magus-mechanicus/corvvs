"""
The CORVVS engine — Kokoro-82M behind a small HTTP server.

Runs the official PyTorch build of Kokoro rather than the ONNX one, because PyTorch's
CUDA and MPS backends reach the GPU on Windows and Apple Silicon respectively, while
onnxruntime's Windows DirectML execution provider has a confirmed kernel bug for this
model. Same weights, same voices — this exists purely for the ~170x speedup.

Speaks the contract in docs/protocol.md. Deliberately dependency-light: the stdlib HTTP
server is more than adequate for a single-user localhost service, and avoiding a web
framework keeps the venv (already several GB of PyTorch) from growing further.

Run:  uv run --project engine engine/server.py
      or via `npm start` from the repo root.
"""

import hmac
import io
import json
import os
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Must be set before torch is imported. Lets MPS fall back to CPU for the handful of ops
# Apple Silicon doesn't implement natively; harmless on CUDA and CPU.
os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')

import numpy as np
import soundfile as sf
import torch
from kokoro import KPipeline

from voices import VOICES, VOICE_IDS

VERSION = '0.1.0'
SAMPLE_RATE = 24000

HOST = os.environ.get('CORVVS_HOST', '127.0.0.1')
PORT = int(os.environ.get('CORVVS_PORT', '8765'))
DEFAULT_VOICE = os.environ.get('CORVVS_VOICE', 'af_heart')
TOKEN = os.environ.get('CORVVS_TOKEN')
MAX_CHARS = int(os.environ.get('CORVVS_MAX_CHARS', '5000'))
ALLOWED_ORIGINS = {
    o.strip() for o in os.environ.get('CORVVS_ALLOWED_ORIGINS', '').split(',') if o.strip()
}

# KPipeline (and the torch module underneath it) is not safe for concurrent forward
# passes — it also mutates its own state the first time it sees a given voice. Every
# route that touches `pipeline` takes this first. It costs nothing real: the GPU only
# does one clip at a time regardless, so serializing makes latency predictable instead
# of letting concurrent requests corrupt each other's audio.
MODEL_LOCK = threading.Lock()


def log(msg):
    print(f'[corvvs] {msg}', file=sys.stderr, flush=True)


def detect_device():
    if torch.cuda.is_available():
        return 'cuda'
    if torch.backends.mps.is_available():
        return 'mps'
    return 'cpu'


DEVICE = detect_device()

log(f'torch {torch.__version__}')
if DEVICE == 'cuda':
    log(f'device: cuda ({torch.cuda.get_device_name(0)})')
elif DEVICE == 'mps':
    log('device: mps (Apple Silicon)')
else:
    log('device: cpu — no GPU backend found. This is ~170x slower than GPU and')
    log('        defeats the point of the engine. See engine/README.md.')

if DEFAULT_VOICE not in VOICE_IDS:
    log(f'CORVVS_VOICE={DEFAULT_VOICE!r} is not a known voice id — requests that omit')
    log('        "voice" will be rejected. See voices.py for valid ids.')

if HOST != '127.0.0.1' and not TOKEN:
    log(f'REFUSING TO START: bound to {HOST} (not loopback) without CORVVS_TOKEN set.')
    log('        Anything on the network could drive this. Set a token or bind to 127.0.0.1.')
    sys.exit(1)


def synthesize(text, voice, speed):
    """Runs the pipeline and joins whatever segments it yields into one WAV clip.
    `voice` is assumed already validated against VOICE_IDS by the caller."""
    chunks = [audio for _graphemes, _phonemes, audio in pipeline(text, voice=voice, speed=speed)]
    audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format='WAV', subtype='PCM_16')
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'  # keep-alive; the client reuses the connection across requests

    def log_message(self, fmt, *args):
        log(f'{self.address_string()} {fmt % args}')

    # -- helpers ----------------------------------------------------------------

    def _cors(self):
        origin = self.headers.get('Origin')
        if origin and origin in ALLOWED_ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    def _send(self, status, body, content_type):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        # Sent on every response (including errors) so the client can check protocol
        # compatibility on its very first request, not just when it happens to call
        # /health.
        self.send_header('X-Corvvs-Version', VERSION)
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, payload):
        self._send(status, json.dumps(payload).encode(), 'application/json')

    def _error(self, status, code, message):
        self._json(status, {'error': message, 'code': code})

    def _authorized(self):
        if not TOKEN:
            return True
        header = self.headers.get('Authorization', '')
        if not header.startswith('Bearer '):
            return False
        # Constant-time: this only matters once the engine is reachable from more than
        # the local machine, but that's exactly the case a token exists to protect.
        return hmac.compare_digest(header[7:], TOKEN)

    def _validate_body(self):
        """Parses and validates a /synthesize(-ish) request body.
        Returns (text, voice, speed) on success. On failure, sends the error response
        itself and returns None — callers just need to check for that and stop."""
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length) or b'{}')
        except (ValueError, json.JSONDecodeError):
            self._error(400, 'ERR_BAD_REQUEST', 'body must be valid JSON')
            return None

        text = (body.get('text') or '').strip()
        if not text:
            self._error(400, 'ERR_BAD_REQUEST', 'text is required')
            return None
        if len(text) > MAX_CHARS:
            self._error(
                413, 'ERR_TOO_LARGE',
                f'text is {len(text)} chars, limit is {MAX_CHARS} — split it into sentences',
            )
            return None

        voice = body.get('voice') or DEFAULT_VOICE
        if voice not in VOICE_IDS:
            self._error(400, 'ERR_BAD_REQUEST', f'unknown voice "{voice}" — see GET /voices')
            return None

        speed = body.get('speed', 1.0)
        if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not 0.5 <= speed <= 2.0:
            self._error(400, 'ERR_BAD_REQUEST', 'speed must be a number between 0.5 and 2.0')
            return None

        return text, voice, float(speed)

    def _write_chunk(self, data):
        """One HTTP/1.1 chunked-encoding frame. An empty `data` writes the terminating
        zero-length chunk."""
        self.wfile.write(f'{len(data):x}\r\n'.encode('ascii'))
        self.wfile.write(data)
        self.wfile.write(b'\r\n')

    # -- routes -----------------------------------------------------------------

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        # Preflight-only header — tells the browser it can skip re-preflighting this
        # origin/method/header combination for a day instead of on every request.
        self.send_header('Access-Control-Max-Age', '86400')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        # /health is intentionally unauthenticated — a supervisor shouldn't need a
        # credential just to ask whether the process is alive.
        if self.path == '/health':
            return self._json(200, {
                'status': 'ok',
                'device': DEVICE,
                'model': 'kokoro-82m',
                'version': VERSION,
            })

        if self.path == '/voices':
            if not self._authorized():
                return self._error(401, 'ERR_UNAUTHORIZED', 'invalid or missing bearer token')
            return self._json(200, {'voices': VOICES})

        self._error(404, 'ERR_NOT_FOUND', f'no such path: {self.path}')

    def do_POST(self):
        if self.path not in ('/synthesize', '/synthesize/stream'):
            return self._error(404, 'ERR_NOT_FOUND', f'no such path: {self.path}')

        if not self._authorized():
            return self._error(401, 'ERR_UNAUTHORIZED', 'invalid or missing bearer token')

        parsed = self._validate_body()
        if parsed is None:
            return  # _validate_body already sent the error response
        text, voice, speed = parsed

        if self.path == '/synthesize/stream':
            self._stream_synthesize(text, voice, speed)
        else:
            self._synthesize_once(text, voice, speed)

    def _synthesize_once(self, text, voice, speed):
        try:
            t0 = time.time()
            with MODEL_LOCK:
                wav = synthesize(text, voice, speed)
            log(f'synthesized {len(text)} chars in {time.time() - t0:.3f}s on {DEVICE}')
        except Exception as e:
            log(f'synthesis failed: {e}')
            return self._error(500, 'ERR_SYNTHESIS', str(e))

        self._send(200, wav, 'audio/wav')

    def _stream_synthesize(self, text, voice, speed):
        """Chunked response, one frame per segment Kokoro's own pipeline yields — in
        practice several sentences per chunk, governed by the pipeline's internal
        splitter rather than anything CORVVS controls — so a long document starts
        playing before the rest has synthesized. Each frame is length-prefixed twice
        (JSON metadata, then WAV audio) — see docs/protocol.md.

        Framed manually rather than via BaseHTTPRequestHandler's higher-level helpers,
        since chunked transfer with no known total length isn't something the stdlib
        server does for you. Closes the connection after: simpler and safer than
        reasoning about keep-alive state across a hand-rolled chunked body.
        """
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-corvvs-stream')
        self.send_header('Transfer-Encoding', 'chunked')
        self.send_header('X-Corvvs-Version', VERSION)
        self._cors()
        self.end_headers()
        self.close_connection = True

        t0 = time.time()
        frames = 0
        try:
            with MODEL_LOCK:
                for graphemes, _phonemes, audio in pipeline(text, voice=voice, speed=speed):
                    frames += 1
                    buf = io.BytesIO()
                    sf.write(buf, audio, SAMPLE_RATE, format='WAV', subtype='PCM_16')
                    wav_bytes = buf.getvalue()
                    meta = json.dumps({'text': graphemes}).encode('utf-8')
                    frame = (
                        struct.pack('>I', len(meta)) + meta
                        + struct.pack('>I', len(wav_bytes)) + wav_bytes
                    )
                    self._write_chunk(frame)
            self._write_chunk(b'')  # terminating chunk
            log(f'streamed {frames} chunk(s), {len(text)} chars, '
                f'{time.time() - t0:.3f}s on {DEVICE}')
        except Exception as e:
            # The 200 and headers are already on the wire — there's no way to report a
            # JSON error at this point. Log it and stop; the client sees an unterminated
            # chunked body, which at least isn't silent about something going wrong.
            log(f'streaming synthesis failed mid-stream: {e}')


if __name__ == '__main__':
    # Bind before loading the model, not after — a port already in use should fail in
    # under a second, not after paying the ~15s model-load cost first.
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as e:
        log(f'could not bind {HOST}:{PORT} — {e}')
        log('        Something else is already listening there — another corvvs engine, '
            'or this one started twice.')
        sys.exit(1)

    log(f'bound {HOST}:{PORT}, loading model...')
    _t0 = time.time()
    # device=None lets KPipeline auto-select cuda -> mps -> cpu, matching detect_device().
    pipeline = KPipeline(lang_code='a', device=None)
    log(f'model loaded in {time.time() - _t0:.2f}s')

    log(f'listening on http://{HOST}:{PORT}' + ('  (token required)' if TOKEN else ''))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log('shutting down')
        server.shutdown()
