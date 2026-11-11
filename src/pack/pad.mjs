/**
 * Lattice padding of an OLD package, applied to a copy (DESIGN §6.9 pad, B6).   Owner: Track B.
 *
 * Port of the post-hoc script pad-lattice.mjs ab39085a (legacy/scratch/pad-lattice.mjs.txt), which
 * padded the shipped packages on 11-10 03:12 before the cutters did it themselves (latticePad /
 * writePlain). Not part of any build recipe; it exists to reproduce or audit that step.
 *
 * Why (from the original): the player builds every layer on a global lattice
 * (cell = max(6, round(max(W,H)/128))). Lattice vertices that fall outside a texture rect get UVs
 * outside [0,1]; with CLAMP_TO_EDGE + mipmaps the clamped edge row of a smaller mip level carries the
 * art's colour, so at small display sizes a flat-edged smear appears beside the layer. Padding with
 * transparent pixels keeps every lattice vertex inside the texture; mip level 0 is unchanged.
 *
 * Changes from the original (plumbing only; the padding arithmetic, the checks, the sharp calls and
 * the textual model.json edit are unchanged):
 *  - sharp comes from src/runtime.mjs (adds concurrency(1); cache(false) as before);
 *  - the source package is never modified: it is copied to `to` (guardWrite: outRoot/workRoot only)
 *    and the copy is padded; `dry` writes nothing;
 *  - arguments instead of argv; log lines instead of console.log; errors are VolaError (exit 1).
 */
import fs from 'node:fs'
import path from 'node:path'
import { sharp } from '../runtime.mjs'
import { guardWrite } from '../config.mjs'
import { VolaError, EXIT } from '../errors.mjs'

/**
 * @param {string} srcDir    package folder to read (any readable folder, castRoot included)
 * @param {string[]} ids     layer ids to pad
 * @param {{ cfg: object, to?: string, dry?: boolean, log?: (s: string) => void }} opts
 * @returns {Promise<{ dir: string|null, layers: { id: string, before: number[], after: number[], pad: object, changed: boolean }[] }>}
 */
export async function padPackage(srcDir, ids, { cfg, to, dry = false, log = () => {} }) {
  if (!dry && !to) throw new VolaError(EXIT.USAGE, 'pad: --to=<dir> is required (the source package is never modified); or use --dry')
  if (!fs.existsSync(path.join(srcDir, 'model.json'))) throw new VolaError(EXIT.USAGE, `pad: ${srcDir} has no model.json`)
  const dup = ids.find((id, i) => ids.indexOf(id) !== i)
  if (dup) throw new VolaError(EXIT.USAGE, `pad: layer ${dup} given twice`)
  let pkg = srcDir
  if (!dry) {
    const dest = guardWrite(cfg, path.resolve(to))
    if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new VolaError(EXIT.USAGE, `pad: --to=${dest} exists and is not empty`)
    fs.cpSync(srcDir, dest, { recursive: true })
    pkg = dest
  }
  const fail = (msg) => new VolaError(EXIT.FAIL, msg)

  const mfile = path.join(pkg, 'model.json')
  let text = fs.readFileSync(mfile, 'utf8')
  const m = JSON.parse(text)
  const [MW, MH] = m.canvas
  const cell = Math.max(6, Math.round(Math.max(MW, MH) / 128))
  const report = []

  for (const id of ids) {
    const L = m.layers.find((l) => l.id === id)
    if (!L) throw fail(`no layer ${id}`)
    if (L.frames || L.mask || L.talk || L.brow_tex || L.pivot) throw fail(`${id} has linked textures or a pivot; not padded`)
    if (/^(eye_|iris_|shine_|lid_|mouth)/.test(L.role || '')) throw fail(`${id} has role ${L.role}; its rect is used by the rig`)
    const x0 = Math.floor(L.x / cell) * cell, y0 = Math.floor(L.y / cell) * cell
    const x1 = Math.min(Math.ceil((L.x + L.w) / cell) * cell, Math.ceil(MW / cell) * cell)
    const y1 = Math.min(Math.ceil((L.y + L.h) / cell) * cell, Math.ceil(MH / cell) * cell)
    const pad = { left: L.x - x0, top: L.y - y0, right: x1 - (L.x + L.w), bottom: y1 - (L.y + L.h) }
    const file = path.join(pkg, L.texture)
    const meta = await sharp(file).metadata()
    if (meta.width !== L.w || meta.height !== L.h) throw fail(`${id}: texture ${meta.width}x${meta.height} != rect ${L.w}x${L.h}`)
    const before = `${L.x},${L.y},${L.w},${L.h}`
    const nx = x0, ny = y0, nw = x1 - x0, nh = y1 - y0
    const changed = !!(pad.left || pad.top || pad.right || pad.bottom)
    report.push({ id, before: [L.x, L.y, L.w, L.h], after: [nx, ny, nw, nh], pad, changed })
    log(`${id}: ${before} -> ${nx},${ny},${nw},${nh} pad l${pad.left} t${pad.top} r${pad.right} b${pad.bottom}`)
    if (!changed) continue
    if (dry) continue
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const out = Buffer.alloc(nw * nh * 4)
    for (let y = 0; y < info.height; y++) data.copy(out, ((y + pad.top) * nw + pad.left) * 4, y * info.width * 4, (y + 1) * info.width * 4)
    const tmp = guardWrite(cfg, file + '.tmp')
    await sharp(out, { raw: { width: nw, height: nh, channels: 4 } }).webp({ lossless: true, effort: 6 }).toFile(tmp)
    // check: decoded padded texture, cropped back, equals the original on every pixel with alpha > 0
    const chk = await sharp(tmp).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let bad = 0
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const a = (y * info.width + x) * 4, b = ((y + pad.top) * nw + x + pad.left) * 4
      if (data[a + 3] !== chk.data[b + 3] || (data[a + 3] > 0 && (data[a] !== chk.data[b] || data[a + 1] !== chk.data[b + 1] || data[a + 2] !== chk.data[b + 2]))) bad++
    }
    let padAlpha = 0
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const inside = x >= pad.left && x < pad.left + info.width && y >= pad.top && y < pad.top + info.height
      if (!inside && chk.data[(y * nw + x) * 4 + 3]) padAlpha++
    }
    if (bad || padAlpha) { fs.unlinkSync(tmp); throw fail(`${id}: verify failed (changed ${bad}, opaque pad ${padAlpha})`) }
    fs.renameSync(tmp, guardWrite(cfg, file))
    // edit the rect in model.json textually, so the file keeps its formatting
    const re = new RegExp(`("id":\\s*"${id}"[\\s\\S]*?"x":\\s*)${L.x}(,\\s*"y":\\s*)${L.y}(,\\s*"w":\\s*)${L.w}(,\\s*"h":\\s*)${L.h}`)
    if (!re.test(text)) throw fail(`${id}: rect not found in model.json text`)
    text = text.replace(re, `$1${nx}$2${ny}$3${nw}$4${nh}`)
  }
  if (!dry) {
    const after = JSON.parse(text)
    for (const id of ids) { const L = after.layers.find((l) => l.id === id); log(`model ${id} ${L.x} ${L.y} ${L.w} ${L.h}`) }
    fs.writeFileSync(guardWrite(cfg, mfile), text)
  }
  return { dir: dry ? null : pkg, layers: report }
}
