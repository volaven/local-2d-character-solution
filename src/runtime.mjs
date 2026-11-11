/**
 * The one sharp instance and the environment fingerprint (DESIGN §3.1, §3.4 #12, §6.3, §6.7 step 1).
 * Owner after Step 0: Track B.
 *
 * sharp is loaded from Vola-live's own node_modules (resolution starts at this file, not cwd),
 * never from webapp/node_modules. `doctor --compare-sharp=<webapp>/node_modules` proves the two
 * installs hold the same binaries.
 *
 * Every module that touches pixels imports `sharp` from HERE, so cache(false)/concurrency(1)
 * (what tools/cut-lib.mjs did) is applied exactly once, before any pipeline runs.
 */
import sharpModule from 'sharp'
import { VolaError, EXIT } from './errors.mjs'

sharpModule.cache(false)
sharpModule.concurrency(1)

/** sharp with cache(false) and concurrency(1) applied. */
export const sharp = sharpModule

/**
 * The versions the shipped bytes were produced with (§3.1). doctor compares against these;
 * verify compares against the lock's `env` (assertReproEnv). pixman is what the same
 * @img/sharp-win32-x64@0.35.5 build reports; §3.1 does not list it.
 */
export const PINNED = Object.freeze({
  node: '24.15.0',
  sharp: '0.35.5',
  vips: '8.18.7',
  webp: '1.6.0',
  rsvg: '2.63.2',
  cairo: '1.18.6',
  pixman: '0.46.4',
})

/**
 * @typedef {object} EnvFingerprint
 * @property {string} node      process.versions.node
 * @property {string} platform  process.platform
 * @property {string} arch      process.arch
 * @property {string} sharp
 * @property {string} vips
 * @property {string} webp
 * @property {string} rsvg      ibi renders SVG through librsvg
 * @property {string} cairo
 * @property {string} pixman
 */

/**
 * What the bytes depend on (§3.4 #12). Written into profiles/<id>.lock.json as `env`.
 * @returns {EnvFingerprint}
 */
export function envFingerprint() {
  const v = sharp.versions
  return {
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    sharp: v.sharp,
    vips: v.vips,
    webp: v.webp,
    rsvg: v.rsvg,
    cairo: v.cairo,
    pixman: v.pixman,
  }
}

/**
 * Throws when the running environment differs from the lock's (verify step 1, build --repro).
 * Every key of the current fingerprint is compared; a key missing from the lock is a difference.
 *
 * @param {Partial<EnvFingerprint>} lockEnv  `env` from profiles/<id>.lock.json
 * @returns {void}
 * @throws {VolaError} exit 4 (EXIT.ENV); `details` = [{ key, lock, now }]
 */
export function assertReproEnv(lockEnv) {
  const diffs = diffEnv(lockEnv ?? {}, envFingerprint())
  if (diffs.length) {
    const lines = diffs.map(d => `  ${d.key}: lock ${d.lock ?? '(missing)'}, now ${d.now}`).join('\n')
    throw new VolaError(EXIT.ENV, `ENV-MISMATCH: environment differs from the lock\n${lines}`, { details: diffs })
  }
}

/**
 * Pinned-version check for doctor (and for verify before a lock exists). Step 0 addition.
 * @param {EnvFingerprint} [fp]
 * @returns {{ key: string, want: string, got: string, ok: boolean }[]}
 */
export function checkPinned(fp = envFingerprint()) {
  return Object.entries(PINNED).map(([key, want]) => ({ key, want, got: fp[key], ok: fp[key] === want }))
}

/**
 * @param {Partial<EnvFingerprint>} lockEnv
 * @param {EnvFingerprint} now
 * @returns {{ key: string, lock: string|undefined, now: string }[]}
 */
export function diffEnv(lockEnv, now) {
  return Object.keys(now)
    .filter(k => lockEnv[k] !== now[k])
    .map(k => ({ key: k, lock: lockEnv[k], now: now[k] }))
}
