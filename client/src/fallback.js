/**
 * In-process CPU synthesis, used only when no engine is reachable.
 *
 * Runs the same Kokoro-82M weights through `kokoro-js` (ONNX) instead of the engine's
 * PyTorch build. Identical voices, near-identical audio — but on the CPU, which is
 * roughly 170x slower (~29 s/sentence vs ~0.17 s on a GPU). It exists so that
 * `npm install corvvs` does something useful on its own, and so a project doesn't
 * hard-fail on a machine where nobody has installed the engine yet.
 *
 * `kokoro-js` is an optionalDependency: present by default, but `npm install
 * --omit=optional` gives you the thin HTTP-only client if you'd rather not carry the
 * model runtime.
 */

import { CorvvsError } from './errors.js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// q8 trades a little fidelity for speed. On the CPU path that trade is clearly worth it
// — this is the "at least it works" tier, not the quality tier.
const DTYPE = 'q8';

export async function createFallback() {
  let KokoroTTS;
  try {
    ({ KokoroTTS } = await import('kokoro-js'));
  } catch (cause) {
    throw new CorvvsError(
      'ERR_NO_FALLBACK',
      'No CORVVS engine is running and `kokoro-js` is not installed, so there is no way ' +
      'to synthesize. Either start the engine, or `npm install kokoro-js` for the (slow) ' +
      'CPU fallback.',
      { cause },
    );
  }

  // First call downloads ~90 MB of model weights and caches them; subsequent process
  // starts are local. Slow either way — that's the nature of this path.
  const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: DTYPE, device: 'cpu' });

  return {
    /**
     * @param {string} text
     * @param {string} voice
     * @param {number} speed
     * @returns {Promise<Buffer>}
     */
    async speak(text, voice, speed) {
      const audio = await tts.generate(text, { voice, speed });
      return Buffer.from(audio.toWav());
    },
  };
}
