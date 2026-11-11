/**
 * Human engine entry (DESIGN §6.4).   Owner: Track A.
 *
 * Ported here (copies live in legacy/, which is never imported or run):
 *   cut-human.mjs     <- tools/livliv/cut-human.mjs        c959fc7d  plumbing only (§6.5 table, A1)
 *   assemble-src.mjs  <- tools/livliv/assemble-src.mjs     65d372b1  imports only
 *   keys.mjs          cut keys, expression knobs, shapes (used by validateProfile, docs/PROFILE-KEYS.md)
 *   ../expressions/   <- livliv-frozen-kai8/expressions.mjs ae8d8a3a + nose findShift/regHair/noseBase
 *                        (regHair default OFF: `=== true`) + browRoot v2 from shared d3278c47 (A2)
 *
 * Rules for everything under src/engine/ (§1 I3-I4, §6.4, §6.10):
 *  - never read process.argv, process.env, process.cwd() or Date; everything arrives in ctx;
 *  - import sharp from src/runtime.mjs (cache(false), concurrency(1));
 *  - read inputs only through castPath(ctx.cfg, rel); call guardWrite(ctx.cfg, abs) before every
 *    write and mkdir (src/config.mjs);
 *  - importing a module has no side effects: no CLI loop at the bottom, no work at import time
 *    (the old REPORT read at import, §3.4 #9, goes away: regions come from profile.source.regions);
 *  - meta is metaFor(ctx.stamp, profile.model) (src/stamp.mjs), never built here;
 *  - one build per process: module state (W/H/S, REG, DESPECKLE, SPECKS) is global. The CLI runs
 *    each build in a child process (`vola-live build <id> --child ...`, §6.4);
 *  - algorithm bodies are not touched in step 1 (§1 I4): arithmetic order, rounding, loop order,
 *    sharp calls stay byte-for-byte; only where values and paths come from changes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { castPath } from '../../config.mjs'
import { VolaError, EXIT } from '../../errors.mjs'
import { CUT_KEYS, MODEL_KEYS, SOURCE_KEYS, DEF_KEYS, PER_ZONE_KEYS, PER_LOOP_KEYS, PER_REG_KEYS, typeOk } from './keys.mjs'
import { BASE_EXPRESSIONS, EXTRA_EXPRESSIONS, expressionsOf } from '../expressions/tables.mjs'

/**
 * @typedef {import('../../profile.mjs').VolaProfile} VolaProfile
 * @typedef {import('../../config.mjs').VolaConfig} VolaConfig
 * @typedef {import('../../stamp.mjs').Stamp} Stamp
 */

/**
 * The single argument of build(). Same contract for every engine (human, ibi).
 * @typedef {object} BuildCtx
 * @property {Readonly<VolaProfile>} profile  from loadProfile(id)
 * @property {Readonly<VolaConfig>}  cfg      from loadConfig(); castRoot is read-only
 * @property {string} outDir   absolute. THE PACKAGE DIRECTORY ITSELF: model.json, avatar.webp,
 *                             cover.webp and textures/ go directly in it (old `<--out>/<id>/`).
 *                             build: <outRoot>/<id>   build --repro: <workRoot>/repro/<id>
 *                             verify: <workRoot>/verify/<id>/pkg
 *                             The caller passes it absent or empty; the engine creates it.
 * @property {string} workDir  absolute, under workRoot, private to this build: expr-cache.bin,
 *                             overlays, masks, ladder, reports (old WORK/<id>... folders).
 * @property {Readonly<Stamp>} stamp  from makeStamp(); pass to metaFor()
 * @property {(line: string) => void} log  progress output (what console.log printed before)
 * @property {Readonly<DevOptions>} [dev]  Step 0 addition: build's development flags (§6.2).
 *                             Absent in --repro and verify; the CLI refuses them together.
 */

/**
 * Development-only switches (§6.2 "개발용(repro 불가)"). Old opts field in brackets.
 * @typedef {object} DevOptions
 * @property {boolean}  [masks]    --masks: write mask overlays and stop [opts.masksOnly]
 * @property {number[]} [ladder]   --ladder=1,0.5: scale rungs [opts.ladder]
 * @property {number}   [tolHair]  --tol-hair=N [opts.tol.tolHair]
 * @property {number}   [tolSkin]  --tol-skin=N [opts.tol.tolSkin]
 * @property {string}   [exprOnly] --expr-only=<ids>, as typed [opts.exprOnly]
 * @property {boolean}  [noExpr]   --no-expr: skip expressions [!opts.expr]
 */

/**
 * Cut one character into a LivLiv package directory and return its model.
 * Order (§5.2): source -> (assemble) -> (refit) -> white pockets -> (creases/report) -> (headScale)
 * -> geometry -> layers (+latticePad when profile.lattice !== false) -> arms -> anchors ->
 * avatar/cover -> expressions (begin ... finish) -> model.json -> self-check.
 * model.json is written as JSON.stringify(model, null, 1) + '\n' (§3.6).
 * Validation and packing are NOT done here (the build command does them).
 * With dev.masks or dev.ladder the cut stops early (as the old flags did) and `model` is null.
 *
 * @param {BuildCtx} ctx
 * @returns {Promise<{ pkgDir: string, model: object|null }>}  pkgDir === ctx.outDir; model = what model.json holds
 */
export async function build(ctx) {
  const problems = validateProfile(ctx.profile)
  if (problems.length) throw new VolaError(EXIT.FAIL, `profile "${ctx.profile?.id}" (human engine):\n  ${problems.join('\n  ')}`)
  for (const k of ['outDir', 'workDir']) {
    if (typeof ctx[k] !== 'string' || !path.isAbsolute(ctx[k])) throw new VolaError(EXIT.USAGE, `human engine: ctx.${k} must be an absolute path`)
  }
  if (typeof ctx.log !== 'function') throw new VolaError(EXIT.USAGE, 'human engine: ctx.log must be a function')
  // loaded here, not at the top: validateProfile / inputsOf (profile loading, lock, inputs) need no sharp
  const { cutHuman } = await import('./cut-human.mjs')
  const model = await cutHuman(ctx)
  return { pkgDir: ctx.outDir, model: model ?? null }
}

/**
 * Every file the build opens, castRoot-relative ('/' separators), in a stable order:
 *   four-state set: state:closed, state:open, state:blink, state:blink-open   (<set>/<id>/<state>.png)
 *   three-frame set: frame:base, frame:blink, frame:open                       (<set>/<id>/<frame>.png)
 *   refit (when profile.source.refit is set)                                   (refit.ref)
 *   expr:<expression id>, in model order (the four, then profile.expressions.extra)
 * An expression frame is looked up in profile.expressions.frames in order and must be in exactly one
 * of them (the same rule the build uses), which is why cfg (castRoot) is needed.
 * tools/assemble-report.json is NOT an input: its eye / mouth boxes are copied into profile.source.regions.
 *
 * @param {Readonly<VolaProfile>} profile
 * @param {Readonly<VolaConfig>} cfg
 * @returns {{ role: string, rel: string }[]}
 * @throws {VolaError} exit 3 when an expression frame is in none or in more than one frame dir
 */
export function inputsOf(profile, cfg) {
  const src = profile.source
  const out = []
  if (src.states === 4) {
    for (const s of ['closed', 'open', 'blink', 'blink-open']) out.push({ role: `state:${s}`, rel: `${src.set}/${profile.id}/${s}.png` })
  } else {
    for (const s of ['base', 'blink', 'open']) out.push({ role: `frame:${s}`, rel: `${src.set}/${profile.id}/${s}.png` })
  }
  if (src.refit) out.push({ role: 'refit', rel: src.refit.ref })
  const x = profile.expressions
  if (x) {
    for (const e of expressionsOf(x.extra)) {
      const hits = x.frames.filter(d => fs.existsSync(castPath(cfg, `${d}/${e.src}.png`)))
      if (hits.length !== 1) {
        throw new VolaError(EXIT.INPUT_DRIFT, `INPUT DRIFT: expression frame ${e.src}.png of "${profile.id}" is in ${hits.length ? hits.join(' and ') : 'none'} of profile.expressions.frames (${x.frames.join(', ')}); it must be in exactly one`)
      }
      out.push({ role: `expr:${e.id}`, rel: `${hits[0]}/${e.src}.png` })
    }
  }
  return out
}

/**
 * Check every cutter-specific key: cut (Appendix A list), model, expressions (DEF/PER/PER_X keys),
 * source shape, stages present. Pure: no file system.
 * @param {Readonly<VolaProfile>} profile
 * @returns {string[]} problems; [] means valid
 */
export function validateProfile(profile) {
  const p = []
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  const isRel = v => typeof v === 'string' && v.length > 0 && !/^([A-Za-z]:|[\\/])/.test(v) && !v.split(/[\\/]/).includes('..')
  const isBox = v => Array.isArray(v) && v.length === 4 && v.every(n => Number.isInteger(n))
  if (!isObj(profile)) return ['profile: expected an object']
  if (profile.cutter !== 'human') p.push(`cutter: expected 'human', got ${JSON.stringify(profile.cutter)}`)

  // source
  const s = profile.source
  if (!isObj(s)) p.push('source: required object')
  else {
    if (!isRel(s.set)) p.push('source.set: a castRoot-relative directory holding <id>/')
    if (s.states === 4) {
      const extra = Object.keys(s).filter(k => !SOURCE_KEYS.four.includes(k))
      if (extra.length) p.push(`source: unknown key(s) for a four-state set: ${extra.join(', ')}`)
      if (s.refit !== null) p.push('source.refit: must be null for a four-state set (its frames ARE the framing)')
      const r = s.regions
      const rbox = b => isObj(b) && ['x0', 'y0', 'x1', 'y1'].every(k => Number.isInteger(b[k])) && Object.keys(b).length === 4
      if (!isObj(r) || !rbox(r.eyeR) || !rbox(r.mouthR) || Object.keys(r).length !== 2) {
        p.push('source.regions: four-state sets need { eyeR: {x0,y0,x1,y1}, mouthR: {x0,y0,x1,y1} } (tools/assemble-report.json boxes)')
      }
    } else {
      if (s.states !== undefined) p.push('source.states: 4 or absent (absent = the three generated frames base/blink/open)')
      const extra = Object.keys(s).filter(k => !SOURCE_KEYS.three.includes(k))
      if (extra.length) p.push(`source: unknown key(s) for a three-frame set: ${extra.join(', ')}`)
      if (!['base', 'blink', 'open'].includes(s.canon)) p.push("source.canon: 'base' | 'blink' | 'open' (the canonical body frame)")
      if (s.regions !== null) p.push('source.regions: must be null for a three-frame set (assembly measures them)')
      if (s.refit !== null && !(isObj(s.refit) && isRel(s.refit.ref) && ['translate', 'scale'].includes(s.refit.mode) && Object.keys(s.refit).length === 2)) {
        p.push("source.refit: null or { ref: <castRoot-relative png>, mode: 'translate' | 'scale' }")
      }
    }
  }

  // stages, lattice (shape is checked by defineProfile; the human engine wants both stages stated)
  if (!isObj(profile.stages)) p.push('stages: required for the human engine ({ ears, specks }, both stated, DESIGN §4.2)')

  // cut
  const cut = profile.cut
  if (!isObj(cut)) p.push('cut: required object (shared CFG keys)')
  else {
    for (const [k, v] of Object.entries(cut)) {
      const spec = CUT_KEYS[k]
      if (!spec) { p.push(`cut.${k}: unknown key${['name', 'build', 'generatorName', 'noAuthor', 'profile', 'rig'].includes(k) ? ' (it lives in model / repro now)' : ''}`); continue }
      if (!typeOk(v, spec.t)) p.push(`cut.${k}: expected ${[].concat(spec.t).join(' | ')}`)
    }
    if (cut.hairIncludeBoxes !== undefined && !(Array.isArray(cut.hairIncludeBoxes) && cut.hairIncludeBoxes.every(b => isBox(b) && b[0] <= b[2] && b[1] <= b[3]))) {
      p.push('cut.hairIncludeBoxes: expected boxes [[x0,y0,x1,y1], ...]')
    }
    for (const k of ['tolSkin', 'tolHair']) if (!(k in cut)) p.push(`cut.${k}: required`)
  }

  // model
  const m = profile.model
  if (!isObj(m)) p.push('model: required { name, author, profile, rig }')
  else {
    const keys = Object.keys(m)
    if (keys.join() !== MODEL_KEYS.join()) p.push(`model: keys must be exactly ${MODEL_KEYS.join(', ')} in that order (got ${keys.join(', ')})`)
    if (typeof m.name !== 'string' || !m.name) p.push('model.name: non-empty string')
    if (m.author !== null && typeof m.author !== 'string') p.push('model.author: string or null (null = no author field)')
    if (m.profile !== null && !isObj(m.profile)) p.push('model.profile: object or null (null = { id: anime_half, facing: front, glasses: false })')
    if (m.rig !== null && !isObj(m.rig)) p.push('model.rig: object or null (null = the default rig with body.bust = cut.bust)')
    if (m.rig === null && isObj(cut) && typeof cut.bust !== 'number') p.push('cut.bust: required when model.rig is null (the default rig reads it)')
  }

  // expressions
  const x = profile.expressions
  if (x !== undefined) {
    if (!isObj(x)) p.push('expressions: object')
    else {
      const want = ['frames', 'extra', 'regHair', 'per', 'perX']
      const extraKeys = Object.keys(x).filter(k => !want.includes(k))
      if (extraKeys.length) p.push(`expressions: unknown key(s) ${extraKeys.join(', ')}`)
      if (!Array.isArray(x.frames) || !x.frames.length || !x.frames.every(isRel)) p.push('expressions.frames: non-empty list of castRoot-relative directories')
      if (!Array.isArray(x.extra) || !x.extra.every(e => e in EXTRA_EXPRESSIONS) || new Set(x.extra).size !== x.extra.length) {
        p.push(`expressions.extra: list of distinct ids from ${Object.keys(EXTRA_EXPRESSIONS).join(', ')}`)
      }
      if (typeof x.regHair !== 'boolean') p.push('expressions.regHair: boolean, stated (engine default false; father/mother true)')
      const ids = new Set([...BASE_EXPRESSIONS.map(e => e.id), ...(Array.isArray(x.extra) ? x.extra : [])])
      const checkKnobs = (obj, where, allowZone) => {
        for (const [k, v] of Object.entries(obj)) {
          if (k === 'regHair') { p.push(`${where}.regHair: regHair is expressions.regHair (one place, docs/PROFILE-KEYS.md)`); continue }
          const spec = PER_LOOP_KEYS[k] || (allowZone && (PER_ZONE_KEYS[k] || (PER_REG_KEYS.includes(k) && { t: 'num' })))
            || (allowZone && DEF_KEYS.includes(k) && { t: 'num' })
          if (!spec) {
            p.push(`${where}.${k}: ${PER_ZONE_KEYS[k] || PER_REG_KEYS.includes(k) ? 'read before the per-expression loop, so it does nothing in perX' : 'unknown knob'}`)
            continue
          }
          if (!typeOk(v, spec.t)) p.push(`${where}.${k}: expected ${[].concat(spec.t).join(' | ')}`)
          if ((k === 'suppress' || k === 'noseBase') && isObj(v)) {
            for (const [e, val] of Object.entries(v)) {
              if (!ids.has(e)) p.push(`${where}.${k}.${e}: not one of this character's expressions`)
              if (k === 'noseBase' && !(Array.isArray(val) && val.every(isBox))) p.push(`${where}.noseBase.${e}: [[x0, y0, x1, y1], ...]`)
              if (k === 'suppress' && !(typeof val === 'number' || (Array.isArray(val) && val.every(b => Array.isArray(b) && (isBox(b) || (b.length === 5 && isBox(b.slice(0, 4)) && b[4] === 'face')))))) {
                p.push(`${where}.suppress.${e}: a row number or [[x0, y0, x1, y1(, 'face')], ...]`)
              }
            }
          }
        }
      }
      if (!isObj(x.per)) p.push('expressions.per: object (the character knobs, merged over DEF)')
      else checkKnobs(x.per, 'expressions.per', true)
      if (!isObj(x.perX)) p.push('expressions.perX: object ({ <expr>: knobs }, {} when none)')
      else for (const [e, o] of Object.entries(x.perX)) {
        if (!ids.has(e)) p.push(`expressions.perX.${e}: not one of this character's expressions`)
        if (!isObj(o)) p.push(`expressions.perX.${e}: object`)
        else checkKnobs(o, `expressions.perX.${e}`, false)
      }
    }
  }
  return p
}
