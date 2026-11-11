/**
 * vola-live pad <pkgDir> <layerIds...> (DESIGN §6.2, §6.9).   Owner: Track B (B6).
 * Port of pad-lattice.mjs (legacy/scratch/pad-lattice.mjs.txt, ab39085a): src/pack/pad.mjs.
 * Refuses role layers and layers with linked textures or a pivot. Never modifies the source
 * package: --to=<dir> (outRoot/workRoot only, absent or empty) receives a padded copy; --dry only reports.
 */
import path from 'node:path'
import { EXIT, VolaError } from '../errors.mjs'

export const spec = {
  name: 'pad',
  summary: 'lattice-pad layers of an old package into a copy (never in place)',
  usage: 'vola-live pad <pkgDir> <layerIds...> [--dry] [--to=<dir>]',
  positionals: { names: ['pkgDir', 'layerIds...'], min: 2, max: Infinity },
  options: {
    dry: { type: 'boolean', desc: 'report what would change, write nothing' },
    to: { type: 'string', arg: 'dir', desc: 'destination copy (inside outRoot/workRoot only)' },
  },
  config: 'required',
  check({ opts }) {
    if (opts.dry && opts.to !== undefined) throw new VolaError(EXIT.USAGE, 'pad: --dry writes nothing; drop --to')
    if (!opts.dry && opts.to === undefined) throw new VolaError(EXIT.USAGE, 'pad: --to=<dir> is required (the source package is never modified); or use --dry')
  },
}

export async function run({ args, cfg, log }) {
  const { padPackage } = await import('../pack/pad.mjs')
  const [pkg, ...ids] = args.pos
  const r = await padPackage(path.resolve(pkg), ids, { cfg, to: args.opts.to, dry: !!args.opts.dry, log })
  const n = r.layers.filter((l) => l.changed).length
  log(r.dir ? `padded ${n} of ${r.layers.length} layer(s) in ${r.dir}` : `dry run: ${n} of ${r.layers.length} layer(s) would change`)
  return EXIT.OK
}
