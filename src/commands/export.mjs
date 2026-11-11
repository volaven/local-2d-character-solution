/** Export a validated build as the native .vola character container. */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { guardWrite } from '../config.mjs'
import { EXIT, VolaError } from '../errors.mjs'
import { fromPackageDir, decodeVola } from '../vola/format.mjs'

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/
export const spec = {
  name: 'export',
  summary: 'export a validated character as a native .vola file',
  usage: 'vola-live export <id|dir> [--to=<file.vola>]',
  positionals: { names: ['id|dir'], min: 1, max: 1 },
  options: { to: { type: 'string', arg: 'file.vola', desc: 'destination inside outRoot/workRoot' } },
  config: 'required',
}

export async function run({ args, cfg, log }) {
  const arg = args.pos[0]
  const dir = ID_RE.test(arg) && !/[\\/]/.test(arg) ? path.join(cfg.outRoot, arg) : path.resolve(arg)
  if (!fs.existsSync(path.join(dir, 'model.json')))
    throw new VolaError(EXIT.USAGE, `export: ${dir} is not a package folder (no model.json)`)
  const destination = path.resolve(args.opts.to ?? `${dir}.vola`)
  if (path.extname(destination).toLowerCase() !== '.vola')
    throw new VolaError(EXIT.USAGE, 'export: output file must have the .vola extension')
  const file = guardWrite(cfg, destination)
  const { validatePackage, formatResult } = await import('../validate/validate.mjs')
  const validation = await validatePackage(dir, { python: cfg.python })
  for (const line of formatResult(validation)) log(line)
  if (validation.errors.length) return EXIT.FAIL
  const { buffer, manifest, skipped } = await fromPackageDir(dir)
  decodeVola(buffer)
  await fsp.mkdir(guardWrite(cfg, path.dirname(file)), { recursive: true })
  await fsp.writeFile(file, buffer)
  decodeVola(await fsp.readFile(file))
  log(`wrote ${file}  ${buffer.length} bytes  ${manifest.entries.length} entries, verified`)
  if (skipped.length) log(`left out: ${skipped.join(', ')}`)
  return EXIT.OK
}
