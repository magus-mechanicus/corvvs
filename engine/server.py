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

import io
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Must be set before torch is imported. Lets MPS fall back to CPU for the handful of ops
# Apple Silicon doesn't implement natively; harmless on CUDA and CPU.
os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')

import numpy as np
import soundfile as sf
import torch
from kokoro import KPipeline

from voices import VOICES

VERSION = '0.1.0'

HOST = os.environ.get('CORVVS_HOST', '127.0.0.1')
PORT = int(os.environ.get('CORVVS_PORT', '8765'))
DEFAULT_VOICE = os.environ.get('CORVVS_VOICE', 'af_heart')
TOKEN = os.environ.get('CORVVS_TOKEN')
MAX_CHARS = int(os.environ.get('CORVVS_MAX_CHARS', '5000'))
ALLOWED_ORIGINS = {
    o.strip() for o in os.environ.get('CORVVS_ALLOWED_ORIGINS', '').split(',') if o.strip()
}

SAMPLE_RATE = 24000


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

if HOST != '127.0.0.1' and not TOKEN:
    log(f'REFUSING TO START: bound to {HOST} (not loopback) without CORVVS_TOKEN set.')
    log('        Anything on the network could drive this. Set a token or bind to 127.0.0.1.')
    sys.exit(1)

# device=None lets KPipeline auto-select cuda -> mps -> cpu, matching detect_device().
_t0 = time.time()
pipeline = KPipeline(lang_code='a', device=None)
log(f'model loaded in {time.time() - _t0:.2f}s')


def synthesize(text, voice, speed):
    """Runs the pipeline and joins whatever segments it yields into one WAV clip."""
    chunks = [
        audio for _graphemes, _phonemes, audio
        in pipeline(text, voice=voice or DEFAULT_VOICE, speed=speed)
    ]
    audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format='WAV', subtype='PCM_16')
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'  # keep-alive; the client reuses the connection per sentence

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
        return header.startswith('Bearer ') and header[7:] == TOKEN

    # -- routes -----------------------------------------------------------------

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
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
        if self.path != '/synthesize':
            return self._error(404, 'ERR_NOT_FOUND', f'no such path: {self.path}')

        if not self._authorized():
            return self._error(401, 'ERR_UNAUTHORIZED', 'invalid or missing bearer token')

        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length) or b'{}')
        except (ValueError, json.JSONDecodeError):
            return self._error(400, 'ERR_BAD_REQUEST', 'body must be valid JSON')

        text = (body.get('text') or '').strip()
        if not text:
            return self._error(400, 'ERR_BAD_REQUEST', 'text is required')
        if len(text) > MAX_CHARS:
            return self._error(
                413, 'ERR_TOO_LARGE',
                f'text is {len(text)} chars, limit is {MAX_CHARS} — split it into sentences',
            )

        speed = body.get('speed', 1.0)
        if not isinstance(speed, (int, float)) or not 0.5 <= speed <= 2.0:
            return self._error(400, 'ERR_BAD_REQUEST', 'speed must be a number between 0.5 and 2.0')

        try:
            t0 = time.time()
            wav = synthesize(text, body.get('voice'), float(speed))
            log(f'synthesized {len(text)} chars in {time.time() - t0:.3f}s on {DEVICE}')
        except Exception as e:
            log(f'synthesis failed: {e}')
            return self._error(500, 'ERR_SYNTHESIS', str(e))

        self._send(200, wav, 'audio/wav')


if __name__ == '__main__':
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log(f'listening on http://{HOST}:{PORT}' + ('  (token required)' if TOKEN else ''))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log('shutting down')
        server.shutdown()
