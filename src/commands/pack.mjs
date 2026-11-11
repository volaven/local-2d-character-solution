/**
 * vola-live pack <id|dir> (DESIGN §6.2, §6.9).   Owner: Track B (B1).
 * Validates the package (errors: not packed, exit 1), writes the .livliv with src/pack/pack.mjs
 * packDir (zip writer/reader in src/pack/zip.mjs, Apache-2.0 notice) and reads it back.
 *   <id>   the build in <outRoot>/<id>  -> <outRoot>/<id>.livliv
 *   <dir>  any package folder (absolute, or relative to the current directory) -> <dir>.livliv
 * --to=<file> must pass guardWrite (outRoot/workRoot only), and so must the default.
 */
import path from 'node:path'
import { EXIT, VolaError } from '../errors.mjs'

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/

export const spec = {
  name: 'pack',
  summary: 'write the .livliv zip of a built package and read it back',
  usage: 'vola-live pack <id|dir> [--to=<file>]',
  positionals: { names: ['id|dir'], min: 1, max: 1 },
  options: {
    to: { type: 'string', arg: 'file', desc: 'zip path (inside outRoot/workRoot only)' },
  },
  config: 'required',
}

export async function run({ args, cfg, log }) {
  const fs = await import('node:fs')
  const { validatePackage, formatResult } = await import('../validate/validate.mjs')
  const { packDir } = await import('../pack/pack.mjs')
  const arg = args.pos[0]
  const dir = ID_RE.test(arg) && !/[\\/]/.test(arg) ? path.join(cfg.outRoot, arg) : path.resolve(arg)
  if (!fs.existsSync(path.join(dir, 'model.json'))) throw new VolaError(EXIT.USAGE, `pack: ${dir} is not a package folder (no model.json)${ID_RE.test(arg) ? `; build it first: vola-live build ${arg}` : ''}`)
  const zipPath = args.opts.to !== undefined ? path.resolve(args.opts.to) : `${dir}.livliv`
  const v = await validatePackage(dir, { python: cfg.python })
  for (const l of formatResult(v)) log(l)
  const r = await packDir(dir, zipPath, { cfg, validation: v })
  for (const p of r.problems) log(`  REFUSED  ${p}`)
  for (const w of r.warnings) log(`  warn     ${w}`)
  if (!r.ok) return EXIT.FAIL
  const stored = r.entries.filter((e) => e.method === 0).length
  log(`wrote ${r.file}  ${(r.bytes / 1e6).toFixed(2)} MB  ${r.entries.length} entries (${stored} stored, ${r.entries.length - stored} deflated), model.json first, verified`)
  log(`sha256 ${r.sha256}`)
  if (r.skipped.length) log(`left out: ${r.skipped.join(', ')}`)
  return EXIT.OK
}
