/**
 * Input list and input lock (DESIGN §5.2 step 1, §6.2 `inputs`, §6.7 step 2).   Owner: Track B (B3).
 *
 * The engine names its inputs (engine.inputsOf(profile, cfg) -> [{ role, rel }], castRoot-relative);
 * this module hashes them and compares them with profiles/<id>.lock.json `inputs`. A difference is
 * INPUT DRIFT (exit 3): the build would not be the locked one, so it is not run.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT, castPath } from './config.mjs'
import { VolaError, EXIT } from './errors.mjs'

/**
 * The engine module for a profile (src/engine/<cutter>/index.mjs). Importing it has no side effects.
 * @param {{ cutter: string }} profile
 */
export async function loadEngine(profile) {
  return import(pathToFileURL(path.join(REPO_ROOT, 'src', 'engine', profile.cutter, 'index.mjs')).href)
}

/**
 * @typedef {object} InputRecord
 * @property {string} role     engine label, e.g. 'state:closed', 'frame:base', 'expr:x_hatred'
 * @property {string} rel      castRoot-relative, '/' separators
 * @property {string|null} sha256  null when the file cannot be read
 * @property {number|null} bytes
 */

/**
 * inputsOf + sha256 of each file. Order is the engine's.
 * @param {Readonly<object>} profile
 * @param {Readonly<object>} cfg
 * @returns {Promise<InputRecord[]>}
 * @throws {VolaError} exit 1 when the engine returns something malformed or a rel twice
 */
export async function hashInputs(profile, cfg) {
  const engine = await loadEngine(profile)
  const list = engine.inputsOf(profile, cfg)
  if (!Array.isArray(list) || list.some((e) => !e || typeof e.role !== 'string' || typeof e.rel !== 'string')) {
    throw new VolaError(EXIT.FAIL, `engine ${profile.cutter}: inputsOf must return [{ role, rel }]`)
  }
  const seen = new Set()
  const out = []
  for (const { role, rel } of list) {
    const norm = rel.replace(/\\/g, '/')
    if (seen.has(norm)) throw new VolaError(EXIT.FAIL, `engine ${profile.cutter}: input ${norm} listed twice`)
    seen.add(norm)
    const abs = castPath(cfg, norm)
    let buf = null
    try { buf = fs.readFileSync(abs) } catch { /* reported as sha256 null */ }
    out.push({ role, rel: norm, sha256: buf ? sha256(buf) : null, bytes: buf ? buf.length : null })
  }
  return out
}

/**
 * One sha256 for the whole input set (x-vola-live.inputsSha256): over `<rel>\0<sha256>\n` lines in
 * the engine's order.
 * @param {InputRecord[]} records
 */
export function inputsSha256(records) {
  return sha256(Buffer.from(records.map((r) => `${r.rel}\0${r.sha256 ?? 'missing'}\n`).join(''), 'utf8'))
}

/**
 * Compare current inputs with the lock's.
 * @param {InputRecord[]} now
 * @param {{ role: string, rel: string, sha256: string }[]} locked  lock.inputs
 * @returns {{ ok: boolean, drift: { rel: string, role: string, why: string, lock: string|null, now: string|null }[] }}
 */
export function compareInputs(now, locked) {
  const drift = []
  const lockBy = new Map((locked ?? []).map((e) => [e.rel, e]))
  const nowBy = new Map(now.map((e) => [e.rel, e]))
  for (const n of now) {
    const l = lockBy.get(n.rel)
    if (n.sha256 === null) drift.push({ rel: n.rel, role: n.role, why: 'missing (cannot be read)', lock: l?.sha256 ?? null, now: null })
    else if (!l) drift.push({ rel: n.rel, role: n.role, why: 'not in the lock (new input)', lock: null, now: n.sha256 })
    else if (l.sha256 !== n.sha256) drift.push({ rel: n.rel, role: n.role, why: 'content changed', lock: l.sha256, now: n.sha256 })
  }
  for (const l of locked ?? []) {
    if (!nowBy.has(l.rel)) drift.push({ rel: l.rel, role: l.role, why: 'in the lock but no longer an input', lock: l.sha256, now: null })
  }
  return { ok: drift.length === 0, drift }
}

/** throws INPUT DRIFT (exit 3) with one line per file */
export function assertNoDrift(id, cmp) {
  if (cmp.ok) return
  const lines = cmp.drift.map((d) => `  ${d.rel} [${d.role}]: ${d.why}${d.lock ? ` (lock ${d.lock.slice(0, 12)}` : ''}${d.lock && d.now ? `, now ${d.now.slice(0, 12)})` : d.lock ? ')' : ''}`)
  throw new VolaError(EXIT.INPUT_DRIFT, `INPUT DRIFT: ${id}: ${cmp.drift.length} input(s) differ from profiles/${id}.lock.json\n${lines.join('\n')}`, { details: cmp.drift })
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}
