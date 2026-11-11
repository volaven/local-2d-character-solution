/**
 * Exit codes and the one error type every Vola-live module throws (DESIGN §6.2).
 *
 * Step 0 addition: §6.1 does not list this file, but config (2), runtime (4), inputs (3) and
 * verify (1) all need to tell bin/vola-live.mjs which exit code a failure maps to.
 * Throw `new VolaError(EXIT.X, message)`; anything else that escapes a command exits 1.
 */

/** @readonly */
export const EXIT = Object.freeze({
  OK: 0,
  /** mismatch, validation error, failed check, bad profile */
  FAIL: 1,
  /** usage: unknown/misspelt option, bad arguments, missing or unsafe path config */
  USAGE: 2,
  /** INPUT DRIFT: an input file's sha256 differs from profiles/<id>.lock.json */
  INPUT_DRIFT: 3,
  /** environment differs from the pinned / locked one (node, sharp, vips, webp, ...) */
  ENV: 4,
})

export class VolaError extends Error {
  /**
   * @param {number} exitCode  one of EXIT
   * @param {string} message
   * @param {{ cause?: unknown, details?: unknown }} [extra]
   */
  constructor(exitCode, message, extra = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause })
    this.name = 'VolaError'
    this.exitCode = exitCode
    if (extra.details !== undefined) this.details = extra.details
  }
}

/** Thrown by Step 0 stubs. Exit 1, names the owner and the step that implements it. */
export function notImplemented(what, owner) {
  return new VolaError(EXIT.FAIL, `${what}: not implemented yet (${owner})`)
}
