/**
 * Golden manifests and profiles/<id>.lock.json (DESIGN §6.1, §6.2 `lock`, §6.7).   Owner: Track B (B3).
 *
 * lock.json (lockVersion 1), written by `vola-live lock`, read by `verify`, `inputs` and `build`:
 *   {
 *     lockVersion: 1, id, cutter,
 *     golden: 'shipped',                         where outputs/zip came from
 *     shipped: { dir, livliv },                  castRoot-relative (profile.shipped)
 *     profileSha256,                             loadProfile().sha256 at lock time (informational)
 *     env: envFingerprint(),                     verify step 1 (assertReproEnv)
 *     inputs: [{ role, rel, sha256, bytes }],    engine.inputsOf order (verify step 2)
 *     outputs: { '<rel>': sha256, ... },         every file of the golden folder, keys sorted (step 4)
 *     outputCount,
 *     model: { sha256, created, generator },     model.json bytes; created/generator for the §6.6 check
 *     zip: { sha256, bytes, entries },           the .livliv (= in-memory zip of the folder) (step 5)
 *     validate: { warnings: ['<rule> <where>: <msg>', ...] }   (step 6; errors must be 0)
 *   }
 * The text is JSON.stringify(lock, null, 2) + '\n', with no time stamp, so re-locking unchanged
 * inputs and outputs rewrites the same bytes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { lockPath } from '../config.mjs'
import { VolaError, EXIT } from '../errors.mjs'
import { zipDir } from '../pack/pack.mjs'
import { validatePackage, warningKey } from '../validate/validate.mjs'
import { fileShas, sha256 } from './diff.mjs'

export const LOCK_VERSION = 1

/**
 * Everything the lock records about one package folder (outputs, model, zip, validate).
 * @param {string} dir  package folder (read only)
 * @param {{ python: string|null }} opts
 * @returns {Promise<{ outputs: Record<string,string>, outputCount: number, model: object, zip: object, validate: { errors: object[], warnings: string[] }, skipped: string[] }>}
 */
export async function goldenOf(dir, { python }) {
  const outputs = await fileShas(dir)
  const modelRaw = fs.readFileSync(path.join(dir, 'model.json'))
  const model = JSON.parse(modelRaw.toString('utf8'))
  const z = await zipDir(dir)
  const v = await validatePackage(dir, { python })
  return {
    outputs,
    outputCount: Object.keys(outputs).length,
    model: { sha256: sha256(modelRaw), created: model.meta?.created ?? null, generator: model.meta?.generator ?? null },
    zip: { sha256: z.sha256, bytes: z.zip.length, entries: z.entries.length },
    validate: { errors: v.errors, warnings: v.warnings.map(warningKey) },
    skipped: z.skipped,
  }
}

/** @returns {object|null} the parsed lock, or null when profiles/<id>.lock.json does not exist */
export function readLock(id) {
  const file = lockPath(id)
  if (!fs.existsSync(file)) return null
  let lock
  try {
    lock = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new VolaError(EXIT.FAIL, `profiles/${id}.lock.json is not valid JSON: ${e.message}`)
  }
  if (lock?.lockVersion !== LOCK_VERSION || lock.id !== id) {
    throw new VolaError(EXIT.FAIL, `profiles/${id}.lock.json: expected lockVersion ${LOCK_VERSION} and id "${id}"`)
  }
  return lock
}

/** Canonical lock text. */
export function lockText(lock) {
  return JSON.stringify(lock, null, 2) + '\n'
}
