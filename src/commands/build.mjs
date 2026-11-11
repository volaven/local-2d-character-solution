/**
 * vola-live build <id> (DESIGN §6.2, §6.4, §6.6).   Owner: Track B (CLI); engines: A (human) / B (ibi).
 *
 * One build per process (§3.4 #10): a `vola-live build <id>` invocation is that process; verify
 * spawns `build <id> --repro --child --into=<pkg> --work-into=<work>` once per id.
 *
 *   loadProfile -> input lock check (exit 3; skipped with a warning when there is no lock yet)
 *   -> env (repro: lock env, else the pins; exit 4. Skipped in --child: verify checked it)
 *   -> makeStamp -> clear outDir/workDir -> engine.build({ profile, cfg, outDir, workDir, stamp, log, dev })
 *   -> validate (errors: exit 1) -> (--pack) packDir.
 *
 *   new build : outDir <outRoot>/<id>, workDir <workRoot>/build/<id>, stamp 'new'
 *               (created: --created, else SOURCE_DATE_EPOCH, else now), --pack -> <outRoot>/<id>.livliv
 *   --repro   : outDir <workRoot>/repro/<id>, workDir <workRoot>/repro-work/<id>, stamp 'repro'
 *               (original generator/created). Never writes to outRoot. --pack -> <workRoot>/repro/<id>.livliv
 *   --child   : outDir/workDir from --into/--work-into (both must be under workRoot). Prints one
 *               `@@vola-live-result {json}` line at the end for the parent.
 * LIVLIV_STAGE_OFF in the environment is ignored with a warning (§3.4 #5): stages are profile data.
 * When the engine stops early (dev --masks / --ladder) it returns model null: validate and pack are skipped.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EXIT, VolaError } from '../errors.mjs'

const CREATED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
export const RESULT_TAG = '@@vola-live-result '

export const spec = {
  name: 'build',
  summary: 'cut <id> into <outRoot>/<id>/ and validate it (--repro: original stamp, into <workRoot>/repro/<id>/)',
  usage: 'vola-live build <id> [--pack] [--created=<ISO>] [--repro] [dev: --masks --ladder= --tol-hair= --tol-skin= --expr-only= --no-expr]',
  positionals: { names: ['id'], min: 1, max: 1 },
  options: {
    pack: { type: 'boolean', desc: 'also write the .livliv (zip) and read it back' },
    created: { type: 'string', arg: 'YYYY-MM-DDTHH:MM:SSZ', desc: 'pin meta.created of a new build (else SOURCE_DATE_EPOCH, else now)' },
    repro: { type: 'boolean', desc: 'original generator/created from the profile; output only under workRoot' },
    masks: { type: 'boolean', dev: true, desc: 'write mask overlays and stop' },
    ladder: { type: 'numbers', dev: true, arg: '1,0.5', desc: 'scale rungs (transform only)' },
    'tol-hair': { type: 'number', dev: true, arg: 'N', desc: 'override the hair Lab dE tolerance' },
    'tol-skin': { type: 'number', dev: true, arg: 'N', desc: 'override the skin Lab dE tolerance' },
    'expr-only': { type: 'string', dev: true, arg: 'ids', desc: 'cut only these expressions' },
    'no-expr': { type: 'boolean', dev: true, desc: 'skip expressions' },
    child: { type: 'boolean', hidden: true, desc: 'internal: this process is the per-id build child' },
    into: { type: 'string', hidden: true, arg: 'abs', desc: 'internal (--child): package folder' },
    'work-into': { type: 'string', hidden: true, arg: 'abs', desc: 'internal (--child): work folder' },
    'ignore-inputs': { type: 'boolean', hidden: true, desc: 'internal (--child of verify --ignore-inputs): report drift, build anyway' },
  },
  config: 'required',
  check({ opts }) {
    const devUsed = devFlags(opts)
    if (opts.repro && devUsed.length) throw usage(`build: ${devUsed.join(', ')} cannot be combined with --repro (development only)`)
    if (opts.repro && opts.created !== undefined) throw usage('build: --created cannot be combined with --repro (created is pinned in the profile)')
    if (opts.created !== undefined && !CREATED_RE.test(opts.created)) throw usage(`build: --created must look like 2026-11-08T20:21:48Z, got ${opts.created}`)
    if ((opts.into !== undefined || opts.workInto !== undefined) && !opts.child) throw usage('build: --into/--work-into are internal (verify) and need --child')
    if (opts.child && (opts.into === undefined || opts.workInto === undefined)) throw usage('build: --child needs --into=<abs> and --work-into=<abs>')
    if (opts.ignoreInputs && !opts.child) throw usage('build: --ignore-inputs is internal (verify) and needs --child')
    for (const k of ['into', 'workInto']) if (opts[k] !== undefined && !path.isAbsolute(opts[k])) throw usage(`build: --${k === 'into' ? 'into' : 'work-into'} must be absolute`)
  },
}

export async function run({ args, cfg, env, log }) {
  const { loadProfile } = await import('../profile.mjs')
  const { guardWrite, isInside } = await import('../config.mjs')
  const { hashInputs, compareInputs, assertNoDrift, inputsSha256, loadEngine } = await import('../inputs.mjs')
  const { readLock } = await import('../verify/golden.mjs')
  const { makeStamp, engineHash } = await import('../stamp.mjs')
  const { assertReproEnv, checkPinned } = await import('../runtime.mjs')
  const { validatePackage, formatResult } = await import('../validate/validate.mjs')

  const { opts } = args
  const id = args.pos[0]
  const mode = opts.repro ? 'repro' : 'new'
  const t0 = Date.now()
  const { profile, sha256: profileSha256 } = await loadProfile(id)
  const engine = await loadEngine(profile)

  const devUsed = devFlags(opts)
  if (devUsed.length && profile.cutter !== 'human') throw usage(`build ${id}: ${devUsed.join(', ')} apply to the human engine only (${id} is cutter "${profile.cutter}")`)
  if (env?.LIVLIV_STAGE_OFF) log(`warning: LIVLIV_STAGE_OFF=${env.LIVLIV_STAGE_OFF} is ignored; stages come from profiles/${id}.mjs (DESIGN §3.4 #5)`)

  // 1. inputs (§5.2 step 1)
  const inputs = await hashInputs(profile, cfg)
  const lock = readLock(id)
  if (lock) {
    const cmp = compareInputs(inputs, lock.inputs)
    if (!cmp.ok && opts.ignoreInputs) log(`warning: INPUT DRIFT ignored (verify --ignore-inputs): ${cmp.drift.map((d) => d.rel).join(', ')}`)
    else assertNoDrift(id, cmp)
  } else {
    const missing = inputs.filter((i) => i.sha256 === null)
    if (missing.length) throw new VolaError(EXIT.FAIL, `build ${id}: cannot read input(s): ${missing.map((i) => i.rel).join(', ')}`)
    log(`warning: no profiles/${id}.lock.json; inputs are not checked against a lock`)
  }

  // 2. environment (repro only; the child of verify relies on the parent's check)
  if (mode === 'repro' && !opts.child) {
    if (lock) assertReproEnv(lock.env)
    else {
      const bad = checkPinned().filter((c) => !c.ok)
      if (bad.length) throw new VolaError(EXIT.ENV, `ENV-MISMATCH: ${bad.map((c) => `${c.key} ${c.got} (want ${c.want})`).join(', ')}`)
    }
  }

  // 3. stamp
  let stamp
  if (mode === 'repro') stamp = makeStamp({ profile, mode })
  else {
    const created = opts.created ?? fromEpoch(env?.SOURCE_DATE_EPOCH)
    stamp = makeStamp({ profile, mode, created, engineId: engineHash(), profileSha256, inputsSha256: inputsSha256(inputs) })
  }

  // 4. folders
  let outDir, workDir, zipPath
  if (opts.child) {
    outDir = opts.into
    workDir = opts.workInto
    for (const d of [outDir, workDir]) if (!isInside(d, cfg.workRoot)) throw usage(`build --child: ${d} is not under workRoot ${cfg.workRoot}`)
    zipPath = `${outDir}.livliv`
  } else if (mode === 'repro') {
    outDir = path.join(cfg.workRoot, 'repro', id)
    workDir = path.join(cfg.workRoot, 'repro-work', id)
    zipPath = path.join(cfg.workRoot, 'repro', `${id}.livliv`)
  } else {
    outDir = path.join(cfg.outRoot, id)
    workDir = path.join(cfg.workRoot, 'build', id)
    zipPath = path.join(cfg.outRoot, `${id}.livliv`)
  }
  outDir = guardWrite(cfg, outDir)
  workDir = guardWrite(cfg, workDir)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.rmSync(workDir, { recursive: true, force: true })
  fs.mkdirSync(workDir, { recursive: true })

  const dev = devUsed.length ? Object.freeze({
    masks: opts.masks, ladder: opts.ladder, tolHair: opts.tolHair, tolSkin: opts.tolSkin, exprOnly: opts.exprOnly, noExpr: opts.noExpr,
  }) : undefined

  log(`build ${id} (${profile.cutter} engine, ${mode}${dev ? ', dev' : ''}) -> ${outDir}`)
  const ctx = { profile, cfg, outDir, workDir, stamp, log: (s) => log(`  ${s}`) }
  if (dev) ctx.dev = dev
  const result = await engine.build(Object.freeze(ctx))
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  if (!result || result.model === null) {
    log(`build ${id}: stopped early (development flags), ${secs} s; not validated, not packed`)
    if (opts.child) log(RESULT_TAG + JSON.stringify({ id, ok: true, early: true, pkgDir: outDir }))
    return EXIT.OK
  }

  // 5. validate
  const v = await validatePackage(outDir, { python: cfg.python })
  for (const l of formatResult(v)) log(`  ${l}`)
  if (v.errors.length) {
    if (opts.child) log(RESULT_TAG + JSON.stringify({ id, ok: false, pkgDir: outDir, validateErrors: v.errors.length }))
    log(`build ${id}: ${v.errors.length} validation error(s)`)
    return EXIT.FAIL
  }

  // 6. pack
  let packed = null
  if (opts.pack) {
    const { packDir } = await import('../pack/pack.mjs')
    packed = await packDir(outDir, zipPath, { cfg, validation: v })
    for (const p of packed.problems) log(`  REFUSED  ${p}`)
    for (const w of packed.warnings) log(`  warn     ${w}`)
    if (!packed.ok) return EXIT.FAIL
    log(`  wrote ${packed.file}  ${packed.entries.length} entries, sha256 ${packed.sha256.slice(0, 16)}, read back and verified`)
  }
  log(`build ${id}: ok in ${secs} s (${mode === 'repro' ? `repro stamp ${stamp.generator.build} / ${stamp.created}` : `${stamp.generator.build} / ${stamp.created}`})`)
  if (opts.child) log(RESULT_TAG + JSON.stringify({ id, ok: true, pkgDir: outDir, zip: packed?.file ?? null, seconds: Number(secs) }))
  return EXIT.OK
}

function fromEpoch(v) {
  if (v === undefined || v === '') return undefined
  if (!/^\d+$/.test(v)) throw usage(`SOURCE_DATE_EPOCH must be whole seconds, got ${v}`)
  return new Date(Number(v) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function devFlags(opts) {
  return Object.entries(spec.options).filter(([n, d]) => d.dev && opts[camel(n)] !== undefined).map(([n]) => `--${n}`)
}

const camel = s => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
function usage(msg) {
  return new VolaError(EXIT.USAGE, msg)
}
