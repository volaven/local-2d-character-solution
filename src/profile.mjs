/**
 * Character profiles (DESIGN §6.5, Appendix A).   Owner after Step 0: Track B.
 * profiles/{sua,father,mother,daeun,sua2,iseul,kai}.mjs belong to Track A, profiles/ibi.mjs to Track B.
 *
 * A profile file is pure data:
 *
 *     import { defineProfile } from '../src/profile.mjs'
 *     export default defineProfile({ id: 'sua2', cutter: 'human', engineLevel: 1, ... })
 *
 * No logic, no function calls other than defineProfile, no computed values (a lint test will
 * enforce this; Track A/B). Keep object-literal key order identical to the source tables:
 * `model.rig` and `model.profile` become model.json bytes in that order.
 *
 * Division of checks ("키 검사 위임"):
 *  - defineProfile: pure data, deep freeze, common shape (the keys below), no absolute paths.
 *  - engine validateProfile(profile): every cutter-specific key (cut, model, expressions, source
 *    internals). loadProfile calls it through src/engine/<cutter>/index.mjs.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT } from './config.mjs'
import { VolaError, EXIT } from './errors.mjs'

export const PROFILES_DIR = path.join(REPO_ROOT, 'profiles')
export const CUTTERS = Object.freeze(['human', 'ibi'])
const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/
const CREATED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
/** Top-level keys a profile may have. Add here (Track B) when an engine needs a new one. */
const KNOWN_TOP = new Set(['id', 'cutter', 'engineLevel', 'shipped', 'source', 'stages', 'lattice',
  'cut', 'model', 'expressions', 'repro', 'history'])
/** Subtrees where free text (which may mention a path) is allowed. */
const FREE_TEXT = new Set(['history', 'model'])
const ABS_PATH_RE = /^([A-Za-z]:[\\/]|[\\/])/

/**
 * @typedef {object} VolaProfile
 * Common (checked by defineProfile):
 * @property {string} id                 = file name; [a-z][a-z0-9_-]*
 * @property {'human'|'ibi'} cutter      selects src/engine/<cutter>/index.mjs
 * @property {number} engineLevel        integer >= 1 (currently 1). Output-changing engine
 *                                       behaviour for an existing key goes behind a higher level (§4.6)
 * @property {{ dir: string, livliv: string }} [shipped]   castRoot-relative shipped folder / .livliv
 * @property {object} source             castRoot-relative inputs; shape is cutter-specific:
 *    human 3-frame: { set, canon: 'base', refit: null | { ref, mode: 'translate'|'scale' }, regions: null }
 *    human 4-state: { set: 'characters', states: 4, refit: null, regions: { eyeR: {x0,y0,x1,y1}, mouthR: {...} } }
 *    ibi:           { states: 'characters/ibi' }      (§6.5; Track B may rename, it is ibi-internal)
 * @property {{ ears: boolean, specks: boolean }} [stages]  human only. Engine default true/true,
 *                                       every shipped profile states both (§4.2, C5)
 * @property {boolean} [lattice]         latticePad on (default true); false reproduces _backup/<id>-before-lattice
 * @property {{ generator: { name: string, build: string }, created: string }} [repro]
 *                                       original stamp; created is 'YYYY-MM-DDTHH:MM:SSZ' (§6.6)
 * @property {string[]} [history]        free text, why engineLevel/golden changed
 * Cutter-specific (checked by the engine's validateProfile):
 * @property {object} [cut]              human: shared CFG[id] keys verbatim minus name/build (Appendix A)
 * @property {{ name: string, author: string|null, profile: object|null, rig: object|null }} [model]
 *                                       author null = no author field (iseul, kai). metaFor reads model.author.
 * @property {{ frames: string[], extra: string[], regHair: boolean, per: object, perX: object }} [expressions]
 *                                       human: frame dirs (castRoot-relative, searched in order), EXTRA ids,
 *                                       regHair (engine default false; father/mother true), PER/PER_X knobs.
 *                                       Merge rules stay shallow: {...DEF, ...per}, {...per, ...perX[e]} (§4.3)
 */

/**
 * Validate a profile literal, deep-freeze it and return it. Called at module top level by every
 * profiles/<id>.mjs, so a bad profile fails at import time.
 *
 * Checks: pure JSON-like data only (plain objects, arrays, strings, finite numbers, booleans,
 * null; no undefined, functions, getters, class instances, Dates, sparse arrays); known top-level
 * keys; id/cutter/engineLevel present and well-formed; shipped/stages/lattice/repro/history
 * shapes when present; no absolute path string outside `history`/`model`.
 *
 * @template {VolaProfile} T
 * @param {T} obj
 * @returns {Readonly<T>} the same object, deep-frozen
 * @throws {VolaError} exit 1 with every problem listed
 */
export function defineProfile(obj) {
  const problems = []
  if (!isPlainObject(obj)) throw fail('defineProfile: expected an object literal')
  checkPureData(obj, 'profile', problems, false)
  for (const k of Object.keys(obj)) if (!KNOWN_TOP.has(k)) problems.push(`profile.${k}: unknown top-level key (known: ${[...KNOWN_TOP].join(', ')})`)

  if (typeof obj.id !== 'string' || !ID_RE.test(obj.id)) problems.push(`profile.id: must match ${ID_RE}`)
  if (!CUTTERS.includes(obj.cutter)) problems.push(`profile.cutter: must be one of ${CUTTERS.join(', ')}`)
  if (!Number.isInteger(obj.engineLevel) || obj.engineLevel < 1) problems.push('profile.engineLevel: must be an integer >= 1')
  if (!isPlainObject(obj.source)) problems.push('profile.source: required object')
  if (obj.shipped !== undefined) {
    if (!isPlainObject(obj.shipped) || typeof obj.shipped.dir !== 'string' || typeof obj.shipped.livliv !== 'string'
      || Object.keys(obj.shipped).length !== 2) problems.push('profile.shipped: must be { dir, livliv } (castRoot-relative strings)')
  }
  if (obj.stages !== undefined) {
    const s = obj.stages
    if (!isPlainObject(s) || typeof s.ears !== 'boolean' || typeof s.specks !== 'boolean' || Object.keys(s).length !== 2) {
      problems.push('profile.stages: must be { ears: boolean, specks: boolean }')
    }
  }
  if (obj.lattice !== undefined && typeof obj.lattice !== 'boolean') problems.push('profile.lattice: must be boolean')
  if (obj.repro !== undefined) {
    const r = obj.repro
    const g = r?.generator
    if (!isPlainObject(r) || !isPlainObject(g) || typeof g.name !== 'string' || typeof g.build !== 'string'
      || Object.keys(g).join() !== 'name,build' || typeof r.created !== 'string' || !CREATED_RE.test(r.created)) {
      problems.push("profile.repro: must be { generator: { name, build }, created: 'YYYY-MM-DDTHH:MM:SSZ' }")
    }
  }
  if (obj.history !== undefined && (!Array.isArray(obj.history) || obj.history.some(h => typeof h !== 'string'))) {
    problems.push('profile.history: must be an array of strings')
  }
  if (problems.length) throw fail(`invalid profile${typeof obj.id === 'string' ? ` "${obj.id}"` : ''}:\n  ${problems.join('\n  ')}`)
  return deepFreeze(obj)
}

/**
 * Load profiles/<id>.mjs (resolved from the repo root, not cwd), check it, delegate the
 * cutter-specific key check to src/engine/<cutter>/index.mjs validateProfile, and hash it.
 *
 * @param {string} id
 * @returns {Promise<{ profile: Readonly<VolaProfile>, file: string, sha256: string }>}
 *   sha256 = hex sha256 of canonicalJson(profile) (keys sorted), so comment edits do not change it.
 *   NOTE: key ORDER inside model.rig/model.profile changes model.json bytes but not this hash;
 *   verify catches that, the hash does not.
 * @throws {VolaError} exit 2 unknown id; exit 1 bad profile or engine-reported problems
 */
export async function loadProfile(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new VolaError(EXIT.USAGE, `bad profile id ${JSON.stringify(id)}`)
  const file = path.join(PROFILES_DIR, `${id}.mjs`)
  if (!fs.existsSync(file)) {
    const have = fs.existsSync(PROFILES_DIR) ? fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.mjs')).map(f => f.slice(0, -4)) : []
    throw new VolaError(EXIT.USAGE, `no profile "${id}" (profiles/${id}.mjs). Known: ${have.join(', ') || '(none yet)'}`)
  }
  const mod = await import(pathToFileURL(file).href)
  const profile = mod.default
  if (!isPlainObject(profile) || !Object.isFrozen(profile)) {
    throw fail(`profiles/${id}.mjs must \`export default defineProfile({...})\``)
  }
  if (profile.id !== id) throw fail(`profiles/${id}.mjs declares id "${profile.id}"`)
  const engine = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'engine', profile.cutter, 'index.mjs')).href)
  const problems = engine.validateProfile(profile)
  if (!Array.isArray(problems)) throw fail(`engine ${profile.cutter}: validateProfile must return string[]`)
  if (problems.length) throw fail(`profile "${id}" (${profile.cutter} engine):\n  ${problems.join('\n  ')}`)
  return { profile, file, sha256: profileSha256(profile) }
}

/** JSON with object keys sorted at every level, arrays in order, no whitespace. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value))
}

/** hex sha256 of canonicalJson(profile). */
export function profileSha256(profile) {
  return crypto.createHash('sha256').update(canonicalJson(profile), 'utf8').digest('hex')
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (isPlainObject(v)) {
    const o = {}
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k])
    return o
  }
  return v
}

function checkPureData(v, where, problems, freeText) {
  if (v === null || typeof v === 'boolean') return
  if (typeof v === 'string') {
    if (!freeText && ABS_PATH_RE.test(v)) problems.push(`${where}: absolute path "${v}"; profile paths are castRoot-relative (§6.3)`)
    return
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) problems.push(`${where}: non-finite number`)
    return
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (!(i in v)) { problems.push(`${where}[${i}]: hole in array`); continue }
      checkPureData(v[i], `${where}[${i}]`, problems, freeText)
    }
    return
  }
  if (isPlainObject(v)) {
    for (const k of Object.keys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, k)
      if (d.get || d.set) { problems.push(`${where}.${k}: accessor property`); continue }
      const top = where === 'profile'
      checkPureData(v[k], `${where}.${k}`, problems, freeText || (top && FREE_TEXT.has(k)))
    }
    if (Object.getOwnPropertySymbols(v).length) problems.push(`${where}: symbol keys`)
    return
  }
  problems.push(`${where}: ${v === undefined ? 'undefined' : typeof v === 'object' ? v.constructor?.name ?? 'object' : typeof v} is not plain data`)
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const p = Object.getPrototypeOf(v)
  return p === Object.prototype || p === null
}

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    for (const k of Object.keys(v)) deepFreeze(v[k])
    Object.freeze(v)
  }
  return v
}

function fail(msg) {
  return new VolaError(EXIT.FAIL, msg)
}
