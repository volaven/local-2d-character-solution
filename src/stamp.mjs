/**
 * model.json `meta` (DESIGN §6.6, §7).   Owner after Step 0: Track B.
 *
 * Two modes:
 *  - 'repro': the profile's original generator + created, no x-vola-live. Only for bytes that
 *    reproduce the shipped package; the output goes to workRoot only (build --repro, verify).
 *  - 'new'  : generator { name: 'vola-live', build: '<version>+<engineHash8> <id>' } (max 40 chars,
 *    schema limit), created = --created / SOURCE_DATE_EPOCH / now (seconds, 'Z'),
 *    meta['x-vola-live'] = { profile, profileSha256, inputsSha256, engine, lineage }.
 *
 * `author` is about the art's owner, not the tool, so it does not depend on the mode.
 * The engine never builds meta itself: it calls metaFor(ctx.stamp, profile.model) (§6.5 table).
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { REPO_ROOT } from './config.mjs'
import { VolaError, EXIT } from './errors.mjs'

/** package.json version. */
export const VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version
const CREATED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const BUILD_MAX = 40

/**
 * @typedef {object} Stamp
 * @property {{ name: string, build: string }} generator
 * @property {string} created   'YYYY-MM-DDTHH:MM:SSZ'
 * @property {null | { profile: string, profileSha256: string, inputsSha256: string, engine: string, lineage: string|null }} x
 *           written as meta['x-vola-live'] when not null
 */

/**
 * §6.4: makeStamp({ profile, mode, created, engineId }).
 * Step 0 resolution: §6.6 puts profileSha256 and inputsSha256 into x-vola-live but the §6.4
 * signature has no source for them, so 'new' mode also takes them here (from loadProfile().sha256
 * and src/inputs.mjs). They are ignored in 'repro' mode.
 *
 * The caller (build command, never the engine) resolves `created`: --created=<ISO> first, then
 * SOURCE_DATE_EPOCH, else leave it undefined and makeStamp uses the current time.
 *
 * @param {object} a
 * @param {import('./profile.mjs').VolaProfile} a.profile
 * @param {'repro'|'new'} a.mode
 * @param {string} [a.created]        'new' only; 'YYYY-MM-DDTHH:MM:SSZ'
 * @param {string} a.engineId         engineHash() (8 hex); used in 'new'
 * @param {string} [a.profileSha256]  'new' only
 * @param {string} [a.inputsSha256]   'new' only
 * @returns {Readonly<Stamp>}
 * @throws {VolaError} exit 1 (repro without profile.repro, bad created, created given in repro)
 */
export function makeStamp({ profile, mode, created, engineId, profileSha256, inputsSha256 }) {
  if (mode === 'repro') {
    const r = profile.repro
    if (!r?.generator || !r.created) throw fail(`profile "${profile.id}" has no repro stamp; --repro is impossible`)
    if (created !== undefined) throw fail('created cannot be overridden in repro mode (it is pinned in the profile, §6.6)')
    return Object.freeze({
      generator: Object.freeze({ name: r.generator.name, build: r.generator.build }),
      created: r.created,
      x: null,
    })
  }
  if (mode !== 'new') throw fail(`makeStamp: unknown mode ${JSON.stringify(mode)}`)
  if (typeof engineId !== 'string' || !/^[0-9a-f]{8}$/.test(engineId)) throw fail('makeStamp: engineId must be 8 hex chars (engineHash())')
  for (const [k, v] of [['profileSha256', profileSha256], ['inputsSha256', inputsSha256]]) {
    if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) throw fail(`makeStamp: ${k} must be a 64-hex sha256 in 'new' mode`)
  }
  const when = created ?? nowSeconds()
  if (!CREATED_RE.test(when)) throw fail(`created must be 'YYYY-MM-DDTHH:MM:SSZ', got ${JSON.stringify(when)}`)
  return Object.freeze({
    generator: Object.freeze({ name: 'vola-live', build: `${VERSION}+${engineId} ${profile.id}`.slice(0, BUILD_MAX) }),
    created: when,
    x: Object.freeze({
      profile: profile.id,
      profileSha256,
      inputsSha256,
      engine: engineId,
      lineage: profile.repro?.generator?.build ?? null,
    }),
  })
}

/**
 * The model.json `meta` object. Key order is fixed (it is model.json bytes):
 *   generator{name, build}, created, author?{name}, watermark{kind:'none'}, 'x-vola-live'?
 *
 * Step 0 resolution of "model": it is the profile's `model` section; only `model.author` is read.
 * `author` must be present: a string -> { name }, null -> no author key (iseul, kai). undefined is
 * an error, so the ibi engine/profile must state ibi's author explicitly (cut-ibi always wrote
 * '가족 AI 생활박물관 (famcoach)').
 *
 * @param {Stamp} stamp
 * @param {{ author: string|null }} model
 * @returns {object}
 */
export function metaFor(stamp, model) {
  if (!model || !('author' in model) || (model.author !== null && typeof model.author !== 'string')) {
    throw fail('metaFor: model.author must be a string or null (null = no author)')
  }
  const meta = {
    generator: { name: stamp.generator.name, build: stamp.generator.build },
    created: stamp.created,
  }
  if (model.author !== null) meta.author = { name: model.author }
  meta.watermark = { kind: 'none' }
  if (stamp.x) meta['x-vola-live'] = { ...stamp.x }
  return meta
}

/**
 * engineHash: first 8 hex of sha256 over src/engine/** (§6.6). Step 0 definition of "over":
 * files sorted by repo-relative POSIX path; for each, the line `<path>\0<sha256 of the file with
 * CRLF->LF>\n`; sha256 of that text. Any file under src/engine counts (not only .mjs).
 * @returns {string} 8 lowercase hex chars
 */
export function engineHash() {
  const root = path.join(REPO_ROOT, 'src', 'engine')
  const files = []
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) files.push(p)
    }
  }
  walk(root)
  const lines = files
    .map(f => [path.relative(REPO_ROOT, f).split(path.sep).join('/'), f])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([rel, f]) => {
      const text = fs.readFileSync(f).toString('latin1').replace(/\r\n/g, '\n')
      return `${rel}\0${crypto.createHash('sha256').update(text, 'latin1').digest('hex')}\n`
    })
  return crypto.createHash('sha256').update(lines.join(''), 'utf8').digest('hex').slice(0, 8)
}

function nowSeconds() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function fail(msg) {
  return new VolaError(EXIT.FAIL, msg)
}
