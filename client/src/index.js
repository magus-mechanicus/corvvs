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
  let fallbackEngine = null;   // lazily created — loading the CPU model is expensive
  let versionChecked = false;

  function headers(extra) {
    return { ...extra, ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  }

  async function request(path, init = {}) {
    const signal = AbortSignal.timeout(timeout);
    let response;
    try {
      response = await fetch(`${base}${path}`, { ...init, signal, headers: headers(init.headers) });
    } catch (cause) {
      // Connection-level failure — the engine isn't running, isn't reachable, or timed
      // out. This is the one case the fallback covers; see speak().
      throw new CorvvsError('ERR_UNREACHABLE', `could not reach the CORVVS engine at ${base}`, { cause });
    }

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

  /**
   * Warns once per instance if the engine and client shipped from different releases.
   * They're developed and versioned together, so a mismatch means one of them was
   * updated alone — usually a stale engine after `npm update`.
   */
  async function checkVersion(engineVersion) {
    if (versionChecked) return;
    versionChecked = true;

    const [engineMajor, engineMinor] = engineVersion.split('.');
    const [clientMajor, clientMinor] = CLIENT_VERSION.split('.');

    if (engineMajor !== clientMajor) {
      throw new CorvvsError(
        'ERR_VERSION_MISMATCH',
        `engine ${engineVersion} and client ${CLIENT_VERSION} are different major versions — ` +
        `the protocol is incompatible. Update whichever is behind.`,
      );
    }
    if (engineMinor !== clientMinor) {
      console.warn(
        `[corvvs] engine ${engineVersion} / client ${CLIENT_VERSION} — minor version skew. ` +
        `Probably fine, but update the engine if something behaves oddly.`,
      );
    }
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
      if (typeof text !== 'string' || !text.trim()) {
        throw new CorvvsError('ERR_BAD_REQUEST', 'text must be a non-empty string');
      }

      const body = {
        text: text.trim(),
        voice: opts.voice || defaultVoice,
        speed: opts.speed ?? defaultSpeed,
      };

      try {
        const response = await request('/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return Buffer.from(await response.arrayBuffer());
      } catch (err) {
        if (err.code !== 'ERR_UNREACHABLE' || !fallback) throw err;

        // No engine. Fall back to running the same model on the CPU in this process:
        // correct audio, ~170x slower. Loud, because a caller who thinks they're on a
        // GPU and isn't will otherwise just conclude CORVVS is slow.
        if (!fallbackEngine) {
          console.warn(
            `[corvvs] No engine at ${base} — falling back to CPU synthesis, which is ` +
            `dramatically slower. Start the engine (\`npm start\` in the corvvs repo) ` +
            `for GPU speed, or pass { fallback: false } to fail instead.`,
          );
          fallbackEngine = await createFallback();
        }
        return fallbackEngine.speak(body.text, body.voice, body.speed);
      }
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
      const payload = await response.json();
      await checkVersion(payload.version);
      return payload;
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
export default corvvs;
