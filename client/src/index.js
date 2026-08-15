/**
 * The CORVVS client — talks to a CORVVS engine over HTTP (see ../../docs/protocol.md),
 * falling back to in-process CPU synthesis when no engine is reachable.
 *
 * The engine's location is always a parameter, never an assumption. Local, LAN, and
 * hosted engines speak the identical protocol, so moving between them is a config
 * change rather than a rewrite — which is the property that keeps a hosted CORVVS
 * possible later without touching a line of caller code.
 */

import { CorvvsError } from './errors.js';
import { createFallback } from './fallback.js';
import { splitSentences } from './split.js';

const CLIENT_VERSION = '0.1.0';
const DEFAULT_URL = 'http://127.0.0.1:8765';

/**
 * @typedef {object} CorvvsOptions
 * @property {string}  [url]      Engine base URL. Default `http://127.0.0.1:8765`.
 * @property {string}  [key]      Bearer token, if the engine requires one.
 * @property {string}  [voice]    Default voice for this instance. Default `af_heart`.
 * @property {number}  [speed]    Default speed, 0.5–2.0. Default `1.0`.
 * @property {boolean} [fallback] Use in-process CPU synthesis when the engine is
 *   unreachable. Default `true`. Set `false` to fail loudly instead — worth doing in
 *   production, where silently becoming ~170x slower is worse than an error.
 * @property {number}  [timeout]  Per-request timeout in ms. Default `120000`.
 */

/**
 * @param {CorvvsOptions} [options]
 */
export function corvvs(options = {}) {
  const {
    url = process.env.CORVVS_URL || DEFAULT_URL,
    key = process.env.CORVVS_TOKEN,
    voice: defaultVoice = 'af_heart',
    speed: defaultSpeed = 1.0,
    fallback = true,
    timeout = 120_000,
  } = options;

  const base = url.replace(/\/+$/, '');
  let fallbackPromise = null;      // cached promise, not resolved value — see speak()
  let warnedMinorMismatch = false;

  function headers(extra) {
    return { ...extra, ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  }

  /**
   * Warns (once) or throws if the engine and client shipped from different releases.
   * They're developed and versioned together in the same repo, so a mismatch means one
   * of them was updated alone — usually a stale engine after `npm update`. Runs on
   * every request via the X-Corvvs-Version response header rather than a separate call,
   * so it's not limited to callers who happen to invoke health().
   */
  function checkVersion(engineVersion) {
    if (!engineVersion) return; // talking to something pre-header, or not a CORVVS engine

    const [engineMajor, engineMinor] = engineVersion.split('.');
    const [clientMajor, clientMinor] = CLIENT_VERSION.split('.');

    if (engineMajor !== clientMajor) {
      // Deliberately not cached as "checked" — a real protocol incompatibility should
      // keep surfacing on every request until someone fixes it, not go quiet after the
      // first one.
      throw new CorvvsError(
        'ERR_VERSION_MISMATCH',
        `engine ${engineVersion} and client ${CLIENT_VERSION} are different major versions — ` +
        `the protocol is incompatible. Update whichever is behind.`,
      );
    }
    if (engineMinor !== clientMinor && !warnedMinorMismatch) {
      warnedMinorMismatch = true;
      console.warn(
        `[corvvs] engine ${engineVersion} / client ${CLIENT_VERSION} — minor version skew. ` +
        `Probably fine, but update the engine if something behaves oddly.`,
      );
    }
  }

  async function request(path, init = {}) {
    const signal = AbortSignal.timeout(timeout);
    let response;
    try {
      response = await fetch(`${base}${path}`, { ...init, signal, headers: headers(init.headers) });
    } catch (cause) {
      // AbortSignal.timeout() aborts with a TimeoutError specifically (distinct from a
      // manually-aborted AbortError) — undici surfaces that name on the rejection. Only
      // a genuine connection failure should trigger the CPU fallback in speak(); a slow
      // engine that would've answered eventually should not be treated the same as no
      // engine at all and demoted to something ~170x slower still.
      if (cause?.name === 'TimeoutError') {
        throw new CorvvsError('ERR_TIMEOUT', `engine at ${base} did not respond within ${timeout}ms`, { cause });
      }
      throw new CorvvsError('ERR_UNREACHABLE', `could not reach the CORVVS engine at ${base}`, { cause });
    }

    checkVersion(response.headers.get('x-corvvs-version'));

    if (!response.ok) {
      // A running-but-unhappy engine. Never falls back — a 401 or a 413 is a real
      // problem the caller needs to see, not something to paper over.
      let payload = {};
      try { payload = await response.json(); } catch { /* non-JSON error body */ }
      throw new CorvvsError(
        payload.code || `ERR_HTTP_${response.status}`,
        payload.error || `engine returned ${response.status}`,
      );
    }

    return response;
  }

  function buildBody(text, opts) {
    if (typeof text !== 'string' || !text.trim()) {
      throw new CorvvsError('ERR_BAD_REQUEST', 'text must be a non-empty string');
    }
    return {
      text: text.trim(),
      voice: opts.voice || defaultVoice,
      speed: opts.speed ?? defaultSpeed,
    };
  }

  async function getFallback() {
    if (!fallbackPromise) {
      console.warn(
        `[corvvs] No engine at ${base} — falling back to CPU synthesis, which is ` +
        `dramatically slower. Start the engine (\`npm start\` in the corvvs repo) ` +
        `for GPU speed, or pass { fallback: false } to fail instead.`,
      );
      // Cache the in-flight promise, not the resolved value — two calls racing before
      // the first resolves must share one load rather than each loading their own
      // ~90MB model. Reset on failure so a later call gets to retry.
      fallbackPromise = createFallback().catch((err) => {
        fallbackPromise = null;
        throw err;
      });
    }
    return fallbackPromise;
  }

  return {
    /**
     * Synthesizes speech. Returns 24 kHz 16-bit mono WAV bytes.
     *
     * @param {string} text
     * @param {{ voice?: string, speed?: number }} [opts]
     * @returns {Promise<Buffer>}
     */
    async speak(text, opts = {}) {
      const body = buildBody(text, opts);

      try {
        const response = await request('/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return Buffer.from(await response.arrayBuffer());
      } catch (err) {
        if (err.code !== 'ERR_UNREACHABLE' || !fallback) throw err;
        const engine = await getFallback();
        return engine.speak(body.text, body.voice, body.speed);
      }
    },

    /**
     * Synthesizes speech incrementally, yielding each clip as soon as it's ready rather
     * than waiting for the whole text. Backed by `POST /synthesize/stream` — see
     * docs/protocol.md for the wire framing.
     *
     * Each yielded chunk is NOT one sentence — it's however much text Kokoro's own
     * pipeline decided to batch together (measured: anywhere from one to several
     * sentences per chunk). Use `split()` and call `speak()` per sentence if you need
     * finer-grained control than that.
     *
     * Falls back the same way `speak()` does when no engine is reachable, but the CPU
     * fallback can't stream: it synthesizes the whole text at once and yields a single
     * chunk. Callers that care about the difference should check `available()` first.
     *
     * @param {string} text
     * @param {{ voice?: string, speed?: number }} [opts]
     * @returns {AsyncGenerator<{ text: string, audio: Buffer }>}
     */
    async *speakStream(text, opts = {}) {
      const body = buildBody(text, opts);

      let response;
      try {
        response = await request('/synthesize/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (err.code !== 'ERR_UNREACHABLE' || !fallback) throw err;
        const engine = await getFallback();
        yield { text: body.text, audio: await engine.speak(body.text, body.voice, body.speed) };
        return;
      }

      let buf = Buffer.alloc(0);
      for await (const chunk of response.body) {
        buf = Buffer.concat([buf, Buffer.from(chunk)]);

        // A frame is: u32 metaLen, meta JSON, u32 wavLen, wav bytes. Drain as many
        // complete frames as the buffer currently holds.
        while (buf.length >= 4) {
          const metaLen = buf.readUInt32BE(0);
          if (buf.length < 4 + metaLen + 4) break;
          const meta = JSON.parse(buf.subarray(4, 4 + metaLen).toString('utf8'));
          const wavLenOffset = 4 + metaLen;
          const wavLen = buf.readUInt32BE(wavLenOffset);
          const wavStart = wavLenOffset + 4;
          if (buf.length < wavStart + wavLen) break;

          yield { text: meta.text, audio: Buffer.from(buf.subarray(wavStart, wavStart + wavLen)) };
          buf = buf.subarray(wavStart + wavLen);
        }
      }
    },

    /**
     * Splits text into TTS-sized sentences — see split.js. Handy for pipelining a long
     * document through speak()/speakStream() without writing your own splitter.
     *
     * @param {string} text
     * @returns {string[]}
     */
    split(text) {
      return splitSentences(text);
    },

    /**
     * The engine's available voices. Each carries the model author's own quality
     * `grade` — the roster is long, but only a handful of voices are actually good.
     *
     * @returns {Promise<Array<{id: string, name: string, gender: string, language: string, grade: string}>>}
     */
    async voices() {
      const response = await request('/voices');
      const { voices } = await response.json();
      return voices;
    },

    /**
     * Engine liveness, and — the part that matters — which device it's actually running
     * on. A `cpu` result from a machine with a GPU means the install fell back and
     * everything will be ~170x slower than it should be.
     *
     * @returns {Promise<{status: string, device: 'cuda'|'mps'|'cpu', model: string, version: string}>}
     */
    async health() {
      const response = await request('/health');
      return response.json();
    },

    /**
     * Whether an engine is currently reachable — for callers that want to choose a code
     * path rather than discover it mid-synthesis (a UI disabling a "read aloud" button,
     * say). Never throws.
     *
     * @returns {Promise<boolean>}
     */
    async available() {
      try {
        await request('/health');
        return true;
      } catch {
        return false;
      }
    },

    get url() { return base; },
  };
}

export { CorvvsError };
export { splitSentences } from './split.js';
export default corvvs;
