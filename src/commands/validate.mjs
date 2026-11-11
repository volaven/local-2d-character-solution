/**
 * vola-live validate <id|dir> (DESIGN §6.2, §6.9).   Owner: Track B (B2).
 * Schema (Python jsonschema, `-I`, third_party/livliv-player/schema/livliv-model-v4.json) + FORMAT §8 rules
 * (src/validate/validate.mjs). Python comes from cfg.python (global --python=, §6.3).
 *   <id>             the build in <outRoot>/<id>
 *   <id> --shipped   the profile's shipped package in castRoot (read only)
 *   <dir>            any package folder (absolute, or relative to the current directory)
 * Exit 1 when there are errors; warnings never fail.
 */
import path from 'node:path'
import { EXIT, VolaError } from '../errors.mjs'

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/

export const spec = {
  name: 'validate',
  summary: 'schema + FORMAT §8 checks of a built package (or, with --shipped, the shipped one in castRoot)',
  usage: 'vola-live validate <id|dir> [--shipped] [--json] [--python=<exe>]',
  positionals: { names: ['id|dir'], min: 1, max: 1 },
  options: {
    shipped: { type: 'boolean', desc: "check the profile's shipped package in castRoot (read only)" },
    json: { type: 'boolean', desc: 'errors, warnings and stats as JSON' },
  },
  config: 'required',
}

export async function run({ args, cfg, log }) {
  const fs = await import('node:fs')
  const { validatePackage, formatResult, SCHEMA } = await import('../validate/validate.mjs')
  const arg = args.pos[0]
  const isId = ID_RE.test(arg) && !/[\\/]/.test(arg)
  let dir
  if (args.opts.shipped) {
    if (!isId) throw new VolaError(EXIT.USAGE, 'validate --shipped takes a profile id')
    const { loadProfile } = await import('../profile.mjs')
    const { castPath } = await import('../config.mjs')
    const { profile } = await loadProfile(arg)
    if (!profile.shipped) throw new VolaError(EXIT.USAGE, `validate --shipped: profile ${arg} has no "shipped"`)
    dir = castPath(cfg, profile.shipped.dir)
  } else {
    dir = isId ? path.join(cfg.outRoot, arg) : path.resolve(arg)
  }
  if (!fs.existsSync(dir)) throw new VolaError(EXIT.USAGE, `validate: ${dir} does not exist${isId && !args.opts.shipped ? `; build it first (vola-live build ${arg}) or add --shipped` : ''}`)
  const r = await validatePackage(dir, { python: cfg.python })
  if (args.opts.json) {
    log(JSON.stringify({ id: r.id, dir: r.dir, ok: !r.errors.length, errors: r.errors, warnings: r.warnings, stats: r.stats }, null, 2))
  } else {
    log(`validating ${dir}`)
    log(`schema: ${path.relative(process.cwd(), SCHEMA) || SCHEMA} (draft 2020-12), checked with ${cfg.python ?? 'NO PYTHON'} + jsonschema`)
    for (const l of formatResult(r)) log(l)
  }
  return r.errors.length ? EXIT.FAIL : EXIT.OK
}
