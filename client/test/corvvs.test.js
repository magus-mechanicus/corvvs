import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { corvvs, CorvvsError } from '../src/index.js';
import { splitSentences } from '../src/split.js';

/**
 * Spins up a throwaway HTTP server on an ephemeral port implementing just enough of the
 * protocol for a given test. No real engine (no torch, no GPU) is involved — these
 * tests cover the client's own logic: error mapping, version checking, fallback
 * behaviour, and stream framing.
 */
function mockEngine(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

describe('available()', () => {
  test('is false when nothing is listening', async () => {
    const tts = corvvs({ url: 'http://127.0.0.1:1' }); // reserved port, always refused
    assert.equal(await tts.available(), false);
  });

  test('is true when the engine answers /health', async () => {
    const engine = await mockEngine((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', device: 'cpu', model: 'kokoro-82m', version: '0.1.0' }));
    });
    try {
      const tts = corvvs({ url: engine.url });
      assert.equal(await tts.available(), true);
    } finally {
      await engine.close();
    }
  });
});

describe('error mapping', () => {
  test('an engine error body becomes a CorvvsError with the engine\'s code', async () => {
    const engine = await mockEngine((req, res) => {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'text is 9001 chars, limit is 5000', code: 'ERR_TOO_LARGE' }));
    });
    try {
      const tts = corvvs({ url: engine.url, fallback: false });
      await assert.rejects(
        () => tts.speak('hello'),
        (err) => err instanceof CorvvsError && err.code === 'ERR_TOO_LARGE',
      );
    } finally {
      await engine.close();
    }
  });

  test('an unreachable engine with fallback disabled throws ERR_UNREACHABLE', async () => {
    const tts = corvvs({ url: 'http://127.0.0.1:1', fallback: false });
    await assert.rejects(
      () => tts.speak('hello'),
      (err) => err instanceof CorvvsError && err.code === 'ERR_UNREACHABLE',
    );
  });

  test('empty text is rejected before any request is made', async () => {
    const tts = corvvs({ url: 'http://127.0.0.1:1', fallback: false });
    await assert.rejects(
      () => tts.speak('   '),
      (err) => err instanceof CorvvsError && err.code === 'ERR_BAD_REQUEST',
    );
  });
});

describe('version checking', () => {
  test('a major-version mismatch throws ERR_VERSION_MISMATCH', async () => {
    const engine = await mockEngine((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Corvvs-Version': '9.0.0' });
      res.end(JSON.stringify({ status: 'ok', device: 'cpu', model: 'kokoro-82m', version: '9.0.0' }));
    });
    try {
      const tts = corvvs({ url: engine.url });
      await assert.rejects(
        () => tts.health(),
        (err) => err instanceof CorvvsError && err.code === 'ERR_VERSION_MISMATCH',
      );
    } finally {
      await engine.close();
    }
  });

  test('a matching major version does not throw', async () => {
    const engine = await mockEngine((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Corvvs-Version': '0.1.0' });
      res.end(JSON.stringify({ status: 'ok', device: 'cpu', model: 'kokoro-82m', version: '0.1.0' }));
    });
    try {
      const tts = corvvs({ url: engine.url });
      const health = await tts.health();
      assert.equal(health.status, 'ok');
    } finally {
      await engine.close();
    }
  });
});

describe('speak() round trip', () => {
  test('returns the engine\'s bytes unchanged, as a Buffer', async () => {
    const fakeWav = Buffer.from('RIFF....WAVEfmt fake-audio-bytes', 'utf8');
    const engine = await mockEngine((req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Corvvs-Version': '0.1.0' });
      res.end(fakeWav);
    });
    try {
      const tts = corvvs({ url: engine.url, fallback: false });
      const audio = await tts.speak('hello there');
      assert.ok(Buffer.isBuffer(audio));
      assert.ok(audio.equals(fakeWav));
    } finally {
      await engine.close();
    }
  });
});

describe('speakStream() framing', () => {
  test('parses multiple length-prefixed frames into separate chunks', async () => {
    function frame(text, wav) {
      const meta = Buffer.from(JSON.stringify({ text }), 'utf8');
      const metaLen = Buffer.alloc(4);
      metaLen.writeUInt32BE(meta.length);
      const wavLen = Buffer.alloc(4);
      wavLen.writeUInt32BE(wav.length);
      return Buffer.concat([metaLen, meta, wavLen, wav]);
    }

    const frames = [
      frame('Hello there.', Buffer.from('wav-bytes-one')),
      frame('How are you?', Buffer.from('wav-bytes-two')),
    ];

    const engine = await mockEngine((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/x-corvvs-stream',
        'Transfer-Encoding': 'chunked',
        'X-Corvvs-Version': '0.1.0',
      });
      for (const f of frames) res.write(f);
      res.end();
    });

    try {
      const tts = corvvs({ url: engine.url, fallback: false });
      const received = [];
      for await (const chunk of tts.speakStream('Hello there. How are you?')) {
        received.push(chunk);
      }
      assert.equal(received.length, 2);
      assert.equal(received[0].text, 'Hello there.');
      assert.ok(received[0].audio.equals(Buffer.from('wav-bytes-one')));
      assert.equal(received[1].text, 'How are you?');
      assert.ok(received[1].audio.equals(Buffer.from('wav-bytes-two')));
    } finally {
      await engine.close();
    }
  });
});

describe('splitSentences()', () => {
  test('splits on sentence boundaries', () => {
    const result = splitSentences('Hello there. How are you? I am fine!');
    assert.deepEqual(result, ['Hello there.', 'How are you?', 'I am fine!']);
  });

  test('does not split on a known abbreviation', () => {
    const result = splitSentences('Dr. Smith arrived. He was late.');
    assert.deepEqual(result, ['Dr. Smith arrived.', 'He was late.']);
  });

  test('does not split a decimal number', () => {
    const result = splitSentences('Pi is about 3.14 in most textbooks.');
    assert.deepEqual(result, ['Pi is about 3.14 in most textbooks.']);
  });

  test('empty input yields no sentences', () => {
    assert.deepEqual(splitSentences(''), []);
    assert.deepEqual(splitSentences('   '), []);
  });
});
