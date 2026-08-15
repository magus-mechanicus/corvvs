/**
 * Every failure from this package is a CorvvsError with a stable `code`, so callers can
 * branch on the code rather than pattern-match error messages. The codes mirror the
 * engine's own (see ../../docs/protocol.md) plus two the client raises on its own.
 */
export class CorvvsError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'CorvvsError';
    this.code = code;
  }
}

/**
 * Client-raised:
 *   ERR_UNREACHABLE       no engine answered — the only condition the CPU fallback covers
 *   ERR_TIMEOUT           engine didn't respond within the configured timeout — distinct
 *                          from ERR_UNREACHABLE precisely so it does NOT trigger the CPU
 *                          fallback (a slow engine is not "no engine")
 *   ERR_VERSION_MISMATCH  engine and client are different major versions
 *   ERR_NO_FALLBACK       fallback needed but `kokoro-js` isn't installed
 *
 * Relayed from the engine:
 *   ERR_BAD_REQUEST  ERR_UNAUTHORIZED  ERR_NOT_FOUND  ERR_TOO_LARGE  ERR_SYNTHESIS
 */
