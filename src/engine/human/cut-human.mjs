/**
 * cut-human.mjs — build the native .livliv format-4 packages for the three human characters
 * (sua, father, mother) out of the four aligned states in livliv-cast/characters/<id>/.
 *
 * Everything is cut from closed / open / blink / blink-open, which share one body byte-for-byte
 * outside the eye and mouth patches, so every layer is registered by construction
 * (see livliv-cast/tools/assemble.mjs's header). See tools/livliv/SPEC.md for the layer table,
 * the anchors and the rig; §9a of that file lists what the renderer actually reads.
 *
 *   node livliv-cast/tools/livliv/cut-human.mjs [id ...] [--src=<set>] [--out=<dir>] [--masks] [--no-verify]
 *
 * --masks       stops after the mask / geometry stage (overlays land in _work/<id>/)
 * --src=<set>   which source art to cut from. Default `characters`:
 *                 characters  livliv-cast/characters/<id>/{closed,open,blink,blink-open}.png
 *                             768x1024, four states that already share one body byte-for-byte
 *                 gen2k       livliv-cast/tools/livliv/_gen2k/<id>/{base,blink,open}.png
 *                             1536x2048, THREE states, bodies ~1% apart. The four states are
 *                             assembled from them first by assemble-src.mjs (canonical body + an
 *                             eye patch + a mouth patch, which is also where `blink-open` comes
 *                             from, since the generator never drew it) and dropped in
 *                             _work/<id>-gen2k/src/ for inspection.
 *               Any other value is read as a directory holding one <id>/ subfolder per character;
 *               whether a set ships four states or three is read off the files it holds. Every set
 *               other than `characters` is first fitted into the shipped packages' framing — see
 *               fitFraming() in assemble-src.mjs — because the generated art follows the approved
 *               reference pack's framing, not the rescaled framing the cast was built with.
 * --tol-hair=N  override the Lab dE tolerance of the hair (or skin) mask for this run, without
 * --tol-skin=N  editing CFG. The generated art needs a looser hair tolerance than the flat
 *               approved art; measure with --masks, then record the number in CFG_BY_SRC.
 * --out=<dir>   package destination under livliv-cast/ (or an absolute path). Defaults to `livliv`
 *               for `characters` and to `livliv-2k` for any other set, so a 2x build cannot quietly overwrite the
 *               verified 768 packages; pass --out=livliv once it is the one you want shipped
 *               (validate.mjs and pack.mjs only ever look in livliv-cast/livliv/).
 *
 * RESOLUTION. The canvas is whatever the source art is: `canvas` in model.json, every layer box,
 * every anchor and every rig point come out in it. Each pixel constant below is written in BASE
 * pixels — the 768x1024 art the numbers were tuned on — and scaled through sp / si / sr / sa by
 * `S = W / 768`. All four are the identity at S = 1, so the 768 build is byte-for-byte what it was.
 *
 * What deliberately does NOT scale:
 *   - colour and alpha thresholds (they live in sRGB / Lab / 0..255 alpha, not in pixels), and
 *     every ratio, fraction and percentile;
 *   - the 1-px transparent ring and the 1-px box grow in cutLayer: CLAMP_TO_EDGE replicates the
 *     OUTERMOST texel, so one transparent texel is the whole requirement at any size (SPEC §9a.1);
 *   - the 96x96 avatar and the 12 brow_lines samples, which are output counts, not lengths;
 *   - the iris `range` measurement, which is re-run at the new resolution (its 0.5 px probe step
 *     and its 6-point clipping tolerance stay as they are) rather than measured at 768 and scaled.
 */
/* Vola-live port (DESIGN §6.5, §8 A1): tools/livliv/cut-human.mjs c959fc7d with the PLUMBING changed and
 * nothing else. Every value that came from CFG / NAMES / REPORT / SOURCES / FRAMING_REF / --work / --out /
 * LIVLIV_STAGE_OFF / the argv flags / the clock now comes from the build context (cutHuman(ctx), bottom of this
 * file): profile.cut, profile.model, profile.source, profile.stages, profile.lattice, ctx.outDir,
 * ctx.workDir, ctx.stamp. console.log -> LOG (ctx.log). Every write goes through guardWrite. The usage
 * notes above describe the old CLI and are kept as written. */
import path from 'node:path'
import fs from 'node:fs'
import { sharp } from '../../runtime.mjs'
import { castPath, guardWrite } from '../../config.mjs'
import { metaFor } from '../../stamp.mjs'
import { assembleStates, printAssembly, fitFraming, bboxOfAlpha, SRC_FRAMES } from './assemble-src.mjs'
import * as EXPR from '../expressions/expressions.mjs'   // only called when the profile has expressions

const BASE_W = 768, BASE_H = 1024
/* the canvas and the scale, set from the source art in build(); read at call time everywhere */
let W = BASE_W, H = BASE_H, S = 1
const sp = v => v * S                            // a length in canvas px, float (gaussian sigmas)
const si = v => Math.round(v * S)                // a length in canvas px, whole pixels
const sr = v => Math.max(1, Math.round(v * S))   // a filter radius, never below 1
const sa = v => v * S * S                        // a pixel-count area threshold

/** adopt the source art's size as the canvas and derive the scale from it */
function setCanvas(w, h, where) {
  const s = w / BASE_W
  if (!(s > 0) || Math.round(BASE_H * s) !== h) {
    throw new Error(`${where} is ${w}x${h}; expected ${BASE_W}x${BASE_H} scaled uniformly (that would be ${w}x${Math.round(BASE_H * s)})`)
  }
  W = w; H = h; S = s
}
/** a box measured on the 768 art, in canvas coordinates */
const scaleBox = b => ({
  x0: Math.round(b.x0 * S), y0: Math.round(b.y0 * S),
  x1: Math.round((b.x1 + 1) * S) - 1, y1: Math.round((b.y1 + 1) * S) - 1,
})

/* Vola-live: the work root (old --work / WORK) is ctx.workDir; the eye / mouth windows of a four-state set
 * (old REPORT = tools/assemble-report.json) are profile.source.regions; the generator stamp (old BUILD) is
 * ctx.stamp via metaFor(). */
/* The two changes marked [earOwn] (ear skin and outline belong to the face) and [hairClean] (grey-white
 * specks in the hair) are GLOBAL: every character gets them, and a character opts out with
 * `earOwn: false` / `hairClean: false` in its CFG. [earOwn] is also self-selecting: it only acts on an
 * ear whose skin the hair mask actually holds. LIVLIV_STAGE_OFF=ears,specks (comma list) turns either
 * off for one run, so what each moves in a measured number can be told apart.
 * Vola-live: the Set is built per build from profile.stages (false = in the set); the env is not read. */
let STAGE_OFF = new Set()
/* Vola-live: profile.lattice (default true); false skips latticePad (reproduces _backup/<id>-before-lattice) */
let LATTICE = true
/* Vola-live: ctx.log and the write guard, set per build in cutHuman() */
let LOG = line => { throw new Error(`cut-human: log before cutHuman(): ${line}`) }
let GUARD = abs => { throw new Error(`cut-human: write before cutHuman(): ${abs}`) }
const mkdirG = dir => fs.mkdirSync(GUARD(dir), { recursive: true })
const EAR_ZONE = 0.80      // [earOwn] the ear zone starts this far out from the centre line, in head radii
const EAR_RING = 3         // [earOwn] outline ring round the ear skin, px (base px, scaled)
const EAR_LEAK_MIN = 24    // [earOwn] skin-toned px the hair mask holds in one ear zone before that ear is re-owned

/* Vola-live: the old named source sets (SOURCES / resolveSrc / --src) are profile.source: `set` is a
 * castRoot-relative directory holding <id>/, and whether it holds four registered states or three is
 * DECLARED (`states: 4`), not read off the directory (DESIGN §3.4 #6). The old `fit` flag of a set is
 * "every set other than characters"; whether a refit actually happens is profile.source.refit (the old
 * FRAMING_REF = characters/<id>/closed.png existence test, made explicit). See sourceOpts() below. */
/** the eye / mouth region hints for the frames being cut, in canvas coordinates */
let REG = null

/* ------------------------------------------------------------------ per-character tuning
 * Vola-live: the per-character tables of c959fc7d (CFG, CFG_BY_SRC, NAMES) are not here any more.
 * CFG[id] minus name / build / generatorName / noAuthor / profile / rig is profile.cut (same keys, same
 * values, same comments: profiles/<id>.mjs); NAMES and the model fields are profile.model; the
 * generator stamp is profile.repro / ctx.stamp. CFG_BY_SRC held only commented-out gen2k entries.
 */
const LABELS = {
  back_hair:  { ko: '뒷머리', en: 'Back hair' },
  body:       { ko: '몸', en: 'Body' },
  neck_shadow:{ ko: '목 그림자', en: 'Neck shadow' },
  face:       { ko: '얼굴', en: 'Face' },
  eye_L_skin: { ko: '왼쪽 눈 피부', en: 'Left eye skin' },
  eye_R_skin: { ko: '오른쪽 눈 피부', en: 'Right eye skin' },
  eye_L_closed:{ ko: '왼쪽 감은 눈', en: 'Left eye closed' },
  eye_R_closed:{ ko: '오른쪽 감은 눈', en: 'Right eye closed' },
  eye_L:      { ko: '왼쪽 눈', en: 'Left eye' },
  eye_R:      { ko: '오른쪽 눈', en: 'Right eye' },
  iris_L:     { ko: '왼쪽 홍채', en: 'Left iris' },
  iris_R:     { ko: '오른쪽 홍채', en: 'Right iris' },
  mouth:      { ko: '입', en: 'Mouth' },
  side_hair:  { ko: '옆머리', en: 'Side hair' },
  front_hair: { ko: '앞머리', en: 'Front hair' },
  brows:      { ko: '눈썹', en: 'Brows' },
}

/* ------------------------------------------------------------------ pixels */

async function loadRGBA(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (info.width !== W || info.height !== H) throw new Error(`${file} is ${info.width}x${info.height}, expected ${W}x${H}`)
  return data
}
const idx = (x, y) => y * W + x
const writePng = (buf, w, h, file) =>
  sharp(Buffer.from(buf), { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 6 }).toFile(GUARD(file))

function srgbToLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
function rgb2lab(r, g, b) {
  const R = srgbToLin(r), G = srgbToLin(g), B = srgbToLin(b)
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047
  const Y = (R * 0.2126 + G * 0.7152 + B * 0.0722)
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883
  const f = t => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116)
  const fx = f(X), fy = f(Y), fz = f(Z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}
function labField(buf) {
  const L = new Float32Array(W * H * 3)
  for (let i = 0; i < W * H; i++) {
    const o = i * 4
    const l = rgb2lab(buf[o], buf[o + 1], buf[o + 2])
    L[i * 3] = l[0]; L[i * 3 + 1] = l[1]; L[i * 3 + 2] = l[2]
  }
  return L
}
const dEAt = (L, i, c) => {
  const a = L[i * 3] - c[0], b = L[i * 3 + 1] - c[1], d = L[i * 3 + 2] - c[2]
  return Math.sqrt(a * a + b * b + d * d)
}
function medianPatch(buf, cx, cy, r) {
  const rs = [], gs = [], bs = []
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue
    const o = idx(x, y) * 4
    if (buf[o + 3] < 200) continue
    rs.push(buf[o]); gs.push(buf[o + 1]); bs.push(buf[o + 2])
  }
  if (!rs.length) return null
  const m = a => { a.sort((p, q) => p - q); return a[a.length >> 1] }
  return [m(rs), m(gs), m(bs)]
}
function medianOfMask(buf, mask) {
  const rs = [], gs = [], bs = []
  for (let i = 0; i < W * H; i++) if (mask[i]) { const o = i * 4; rs.push(buf[o]); gs.push(buf[o + 1]); bs.push(buf[o + 2]) }
  if (!rs.length) return null
  const m = a => { a.sort((p, q) => p - q); return a[a.length >> 1] }
  return [m(rs), m(gs), m(bs)]
}

/* ------------------------------------------------------------------ masks (Uint8Array W*H, 0/1) */

function maxFilter(m, r, out) {
  const tmp = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    const row = y * W
    for (let x = 0; x < W; x++) {
      let v = 0
      for (let d = -r; d <= r && !v; d++) { const nx = x + d; if (nx >= 0 && nx < W && m[row + nx]) v = 1 }
      tmp[row + x] = v
    }
  }
  const o = out || new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0
    for (let d = -r; d <= r && !v; d++) { const ny = y + d; if (ny >= 0 && ny < H && tmp[ny * W + x]) v = 1 }
    o[y * W + x] = v
  }
  return o
}
/** anisotropic max filter: rx px horizontally, ry px vertically */
function maxFilterXY(m, rx, ry) {
  const tmp = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    const row = y * W
    for (let x = 0; x < W; x++) {
      let v = 0
      for (let d = -rx; d <= rx && !v; d++) { const nx = x + d; if (nx >= 0 && nx < W && m[row + nx]) v = 1 }
      tmp[row + x] = v
    }
  }
  const o = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0
    for (let d = -ry; d <= ry && !v; d++) { const ny = y + d; if (ny >= 0 && ny < H && tmp[ny * W + x]) v = 1 }
    o[y * W + x] = v
  }
  return o
}
function erodeXY(m, rx, ry) {
  const inv = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) inv[i] = m[i] ? 0 : 1
  const d = maxFilterXY(inv, rx, ry)
  for (let i = 0; i < W * H; i++) d[i] = d[i] ? 0 : 1
  return d
}
const openXY = (m, rx, ry) => maxFilterXY(erodeXY(m, rx, ry), rx, ry)
function dilate(m, r) { return r <= 0 ? Uint8Array.from(m) : maxFilter(m, r) }
function erode(m, r) {
  if (r <= 0) return Uint8Array.from(m)
  const inv = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) inv[i] = m[i] ? 0 : 1
  const d = maxFilter(inv, r)
  for (let i = 0; i < W * H; i++) d[i] = d[i] ? 0 : 1
  return d
}
const openM = (m, r) => dilate(erode(m, r), r)
const closeM = (m, r) => erode(dilate(m, r), r)
const andM = (a, b) => { const o = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) o[i] = a[i] && b[i] ? 1 : 0; return o }
const orM = (a, b) => { const o = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) o[i] = a[i] || b[i] ? 1 : 0; return o }
const subM = (a, b) => { const o = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) o[i] = a[i] && !b[i] ? 1 : 0; return o }
const countM = m => { let n = 0; for (let i = 0; i < m.length; i++) if (m[i]) n++; return n }

function labelCC(m) {
  const lab = new Int32Array(W * H).fill(-1)
  const comps = []
  const stack = new Int32Array(W * H)
  for (let s = 0; s < W * H; s++) {
    if (!m[s] || lab[s] >= 0) continue
    const id = comps.length
    let sp = 0; stack[sp++] = s; lab[s] = id
    let area = 0, x0 = W, y0 = H, x1 = -1, y1 = -1, sx = 0, sy = 0
    while (sp) {
      const i = stack[--sp], x = i % W, y = (i - x) / W
      area++; sx += x; sy += y
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
      if (x > 0 && m[i - 1] && lab[i - 1] < 0) { lab[i - 1] = id; stack[sp++] = i - 1 }
      if (x < W - 1 && m[i + 1] && lab[i + 1] < 0) { lab[i + 1] = id; stack[sp++] = i + 1 }
      if (y > 0 && m[i - W] && lab[i - W] < 0) { lab[i - W] = id; stack[sp++] = i - W }
      if (y < H - 1 && m[i + W] && lab[i + W] < 0) { lab[i + W] = id; stack[sp++] = i + W }
    }
    comps.push({ id, area, x0, y0, x1, y1, cx: sx / area, cy: sy / area })
  }
  return { lab, comps }
}
function keepCC(m, pred) {
  const { lab, comps } = labelCC(m)
  const keep = new Uint8Array(comps.length)
  for (const c of comps) keep[c.id] = pred(c) ? 1 : 0
  const o = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) o[i] = lab[i] >= 0 && keep[lab[i]] ? 1 : 0
  return o
}
/** every component of `allow` that holds at least one pixel of `seed` (morphological reconstruction) */
function reconstruct(seed, allow) {
  const { lab, comps } = labelCC(allow)
  const has = new Uint8Array(comps.length)
  for (let i = 0; i < W * H; i++) if (lab[i] >= 0 && seed[i]) has[lab[i]] = 1
  const o = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) if (lab[i] >= 0 && has[lab[i]]) o[i] = 1
  return o
}
function largestCC(m) {
  const { lab, comps } = labelCC(m)
  if (!comps.length) return new Uint8Array(W * H)
  let best = comps[0]
  for (const c of comps) if (c.area > best.area) best = c
  const o = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) o[i] = lab[i] === best.id ? 1 : 0
  return o
}
function fillHoles(m) {
  const inv = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) inv[i] = m[i] ? 0 : 1
  const seen = new Uint8Array(W * H)
  const stack = new Int32Array(W * H)
  let sp = 0
  const push = i => { if (inv[i] && !seen[i]) { seen[i] = 1; stack[sp++] = i } }
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x) }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1) }
  while (sp) {
    const i = stack[--sp], x = i % W, y = (i - x) / W
    if (x > 0) push(i - 1); if (x < W - 1) push(i + 1)
    if (y > 0) push(i - W); if (y < H - 1) push(i + W)
  }
  const o = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) o[i] = m[i] || !seen[i] ? 1 : 0
  return o
}
function bboxOfMask(m) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[idx(x, y)]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}
function ellipseMask(cx, cy, rx, ry) {
  const m = new Uint8Array(W * H)
  const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(H - 1, Math.ceil(cy + ry))
  for (let y = y0; y <= y1; y++) {
    const t = (y - cy) / ry
    if (Math.abs(t) > 1) continue
    const half = rx * Math.sqrt(1 - t * t)
    const x0 = Math.max(0, Math.ceil(cx - half)), x1 = Math.min(W - 1, Math.floor(cx + half))
    for (let x = x0; x <= x1; x++) m[idx(x, y)] = 1
  }
  return m
}

/** nearest-source colour propagation (Danielsson style, two sweeps) */
function nearestFill(rgba, src, need) {
  const best = new Int32Array(W * H).fill(-1)
  const dist = new Float64Array(W * H).fill(Infinity)
  for (let i = 0; i < W * H; i++) if (src[i]) { best[i] = i; dist[i] = 0 }
  const relax = (i, j) => {
    if (best[j] < 0) return
    const b = best[j], bx = b % W, by = (b - bx) / W
    const x = i % W, y = (i - x) / W
    const d = (x - bx) * (x - bx) + (y - by) * (y - by)
    if (d < dist[i]) { dist[i] = d; best[i] = b }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = idx(x, y)
    if (y > 0) { relax(i, i - W); if (x > 0) relax(i, i - W - 1); if (x < W - 1) relax(i, i - W + 1) }
    if (x > 0) relax(i, i - 1)
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = idx(x, y)
    if (y < H - 1) { relax(i, i + W); if (x > 0) relax(i, i + W - 1); if (x < W - 1) relax(i, i + W + 1) }
    if (x < W - 1) relax(i, i + 1)
  }
  const out = Buffer.from(rgba)
  for (let i = 0; i < W * H; i++) {
    if (!need[i] || best[i] < 0) continue
    const s = best[i] * 4, o = i * 4
    out[o] = rgba[s]; out[o + 1] = rgba[s + 1]; out[o + 2] = rgba[s + 2]; out[o + 3] = 255
  }
  return out
}

/** gaussian blur of a Uint8 alpha plane (0..255) through sharp */
async function blurPlane(plane, w, h, sigma) {
  const out = await sharp(Buffer.from(plane), { raw: { width: w, height: h, channels: 1 } })
    .blur(sigma).toColourspace('b-w').raw().toBuffer()
  const stride = out.length / (w * h)
  if (!Number.isInteger(stride)) throw new Error(`blur stride ${out.length} for ${w}x${h}`)
  if (stride === 1) return out
  const p = Buffer.alloc(w * h)
  for (let i = 0; i < w * h; i++) p[i] = out[i * stride]
  return p
}

/* ------------------------------------------------------------------ crops & writing */

/**
 * Cut a layer out of a full-canvas RGBA buffer + a full-canvas alpha plane (0..255).
 * The box is the alpha's bbox grown by 1 px (clamped to the canvas) and the outermost ring of
 * the result is forced fully transparent — the renderer's mesh samples up to cell-1 px outside
 * the box with CLAMP_TO_EDGE (SPEC §9a.1).
 */
function cutLayer(rgba, alpha, opts = {}) {
  let bx0 = W, by0 = H, bx1 = -1, by1 = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (alpha[idx(x, y)] > 0) {
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y
  }
  if (bx1 < 0) return null
  if (opts.box) {
    bx0 = Math.min(bx0, opts.box.x0); by0 = Math.min(by0, opts.box.y0)
    bx1 = Math.max(bx1, opts.box.x1); by1 = Math.max(by1, opts.box.y1)
  }
  const x = Math.max(0, bx0 - 1), y = Math.max(0, by0 - 1)
  const x1 = Math.min(W - 1, bx1 + 1), y1 = Math.min(H - 1, by1 + 1)
  const w = x1 - x + 1, h = y1 - y + 1
  const buf = Buffer.alloc(w * h * 4)
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const s = idx(x + i, y + j), d = (j * w + i) * 4
    const a = alpha[s]
    const ring = i === 0 || j === 0 || i === w - 1 || j === h - 1
    if (a <= 0 || ring) { buf[d] = rgba[s * 4]; buf[d + 1] = rgba[s * 4 + 1]; buf[d + 2] = rgba[s * 4 + 2]; buf[d + 3] = 0; continue }
    buf[d] = rgba[s * 4]; buf[d + 1] = rgba[s * 4 + 1]; buf[d + 2] = rgba[s * 4 + 2]; buf[d + 3] = a
  }
  return { x, y, w, h, buf }
}
/* Plain layers only: the player meshes every layer on one global lattice (livliv-player puppet.ts buildLayer), and a
 * vertex outside the rect clamps to an edge texel that small mip levels tint with the art (a band above the head).
 * So round the rect out to that lattice with transparent texels; the bbox+1 crop and its clear ring stay inside. */
function latticePad(L) {
  if (!L || !LATTICE) return L   // Vola-live: profile.lattice === false turns the pad off
  const cell = Math.max(6, Math.round(Math.max(W, H) / 128))
  const x0 = Math.floor(L.x / cell) * cell, y0 = Math.floor(L.y / cell) * cell
  const x1 = Math.min(Math.ceil((L.x + L.w) / cell) * cell, W), y1 = Math.min(Math.ceil((L.y + L.h) / cell) * cell, H)
  const w = x1 - x0, h = y1 - y0
  if (w === L.w && h === L.h) return L
  const buf = Buffer.alloc(w * h * 4)   // RGBA 0,0,0,0
  for (let j = 0; j < L.h; j++) L.buf.copy(buf, ((L.y - y0 + j) * w + L.x - x0) * 4, j * L.w * 4, (j + 1) * L.w * 4)
  return { x: x0, y: y0, w, h, buf }
}
/** same crop geometry, different pixels (mouth frames, masks, …) */
function cutAt(rgba, alpha, box) {
  const { x, y, w, h } = box
  const buf = Buffer.alloc(w * h * 4)
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const s = idx(x + i, y + j), d = (j * w + i) * 4
    const ring = i === 0 || j === 0 || i === w - 1 || j === h - 1
    const a = ring ? 0 : alpha[s]
    buf[d] = rgba[s * 4]; buf[d + 1] = rgba[s * 4 + 1]; buf[d + 2] = rgba[s * 4 + 2]; buf[d + 3] = a
  }
  return { x, y, w, h, buf }
}
/* Set per build from cfg.despeckle (daeun only; null for everyone else, so webp() is unchanged). */
let DESPECKLE = null
const SPECKS = { transparent: 0, recoloured: 0, keptInterior: 0, byFile: {} }
/**
 * cfg.despeckle (daeun): the source was lossy webp keyed off a pale-blue background, and its ringing
 * left pale bluish-white texels (alpha > 0, luma > 170, b > r) on the silhouette and in the gaps
 * between hair tips. On EDGE texels only (alpha < 255, or touching transparency): one that touches
 * a dark opaque mass takes that mass's colour (median of its dark neighbours), any other becomes
 * transparent. Opaque interior texels are drawn art (the hair's sheen streak, the camera's metal)
 * and are left alone. Eye and mouth textures are never passed through (sclera, teeth, catchlights).
 */
function despeckle(layer) {
  const { w, h, buf } = layer
  const pale = o => { const l = 0.299 * buf[o] + 0.587 * buf[o + 1] + 0.114 * buf[o + 2]; return buf[o + 3] > 0 && l > 170 && buf[o + 2] > buf[o] }
  /* A pale group that opens onto transparency AND holds a texel at or above the background's own
   * colour (every channel >= rgb(203,223,239)) is a background gap the matte could not reach —
   * the 3-px slit between two strands at (551-556, 232-252) is one, brightened by ringing from both
   * sides — so all of it goes, interior included. */
  const isEdge = (x, y) => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h || !buf[(ny * w + nx) * 4 + 3]) return true }
    return false
  }
  const grp = new Int32Array(w * h).fill(-1), gap = []
  for (let s = 0; s < w * h; s++) {
    if (grp[s] >= 0 || !pale(s * 4)) continue
    const id = gap.length, st = [s]
    let open = false, bgLike = false
    grp[s] = id
    while (st.length) {
      const i = st.pop(), x = i % w, y = (i - x) / w, o = i * 4
      if (isEdge(x, y)) open = true
      if (buf[o] >= 203 && buf[o + 1] >= 223 && buf[o + 2] >= 239) bgLike = true
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = ny * w + nx
        if (grp[j] < 0 && pale(j * 4)) { grp[j] = id; st.push(j) }
      }
    }
    gap.push(open && bgLike)
  }
  const todo = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4
    if (!pale(o)) continue
    const clear = isEdge(x, y)
    if (buf[o + 3] === 255 && !clear && !gap[grp[y * w + x]]) { SPECKS.keptInterior++; continue }
    const dark = []
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy
      if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const q = (ny * w + nx) * 4
      if (buf[q + 3] >= 200 && 0.299 * buf[q] + 0.587 * buf[q + 1] + 0.114 * buf[q + 2] < 100) dark.push(q)
    }
    todo.push([o, dark])
  }
  for (const [o, dark] of todo) {
    if (dark.length) {
      const med = c => { const v = dark.map(q => buf[q + c]).sort((a, b) => a - b); return v[v.length >> 1] }
      buf[o] = med(0); buf[o + 1] = med(1); buf[o + 2] = med(2)
      SPECKS.recoloured++
    } else { buf[o + 3] = 0; SPECKS.transparent++ }
  }

  /* Pass 2, any hue. The matte decontaminated each edge pixel toward its nearest foreground colour;
   * under the chin that was the skin, not the black outline the pixel actually borders, so a pixel
   * that was mostly outline came out pale peach at partial alpha, OUTSIDE the line. Candidate: an
   * outermost texel (4-neighbour of alpha 0), luma > 170, alpha 9..139 (<= 8 is a soft patch rim, by
   * design). Its strongest inward neighbour (highest alpha in the 8-neighbourhood) decides:
   *   dark (luma < 90)      pale outside, black inside -> take the dark mass's colour (median of
   *                         its dark opaque neighbours, or that neighbour's), alpha kept
   *   alpha < 60            nothing solid behind it: an isolated speck -> transparent
   *   otherwise             light behind it (skin on skin, cloth on cloth): correct antialiasing,
   *                         kept and listed. */
  const st = SPECKS.byFile[layer.name] = { recoloured: 0, transparent: 0, kept: [] }
  const lum = q => 0.299 * buf[q] + 0.587 * buf[q + 1] + 0.114 * buf[q + 2]
  const changes = []
  const art = DESPECKLE.art
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, a = buf[o + 3]
    if (a < 9 || a > 139 || lum(o) <= 170 || !isEdge(x, y)) continue
    // where the approved art itself is dark ink here, a pale texel is a fill or a decontamination
    // error showing through (the face egg's rim below the chin outline): take the art's colour
    const cx = layer.x + x, cy = layer.y + y, ao = (cy * W + cx) * 4
    if (art[ao + 3] >= 200 && 0.299 * art[ao] + 0.587 * art[ao + 1] + 0.114 * art[ao + 2] < 90) {
      changes.push([o, 'art', [art[ao], art[ao + 1], art[ao + 2]]]); continue
    }
    // the strongest inward neighbour, followed up the alpha slope (max 3 steps) past other
    // semi-transparent texels, so a chain of pale specks is judged by what finally holds it
    let px = x, py = y, best = -1
    for (let step = 0; step < 3; step++) {
      let nb = -1, bx = 0, by = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy
        if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const q = (ny * w + nx) * 4
        if (nb < 0 || buf[q + 3] > buf[nb + 3]) { nb = q; bx = nx; by = ny }
      }
      if (nb < 0 || buf[nb + 3] <= buf[(py * w + px) * 4 + 3]) break
      best = nb; px = bx; py = by
      if (buf[nb + 3] >= 140) break
    }
    /* The same walk on the ART, where the art itself is a silhouette edge here (alpha < 140): the
     * face egg keeps skin-coloured texels whose layer neighbours are skin, but in the picture they
     * sit in the gap between the hair tips and the neck, held by black outline — the matte's own
     * decontamination error, carried into the layer. */
    const artWalk = () => {
      if (art[ao + 3] >= 140) return null
      let qx = cx, qy = cy, b = -1
      for (let step = 0; step < 3; step++) {
        let nb = -1, bx = 0, by = 0
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx, ny = qy + dy
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const q = (ny * W + nx) * 4
          if (nb < 0 || art[q + 3] > art[nb + 3]) { nb = q; bx = nx; by = ny }
        }
        if (nb < 0 || art[nb + 3] <= art[(qy * W + qx) * 4 + 3]) break
        b = nb; qx = bx; qy = by
        if (art[nb + 3] >= 140) break
      }
      return b >= 0 && art[b + 3] >= 140 && 0.299 * art[b] + 0.587 * art[b + 1] + 0.114 * art[b + 2] < 90 ? b : null
    }
    if (best >= 0 && buf[best + 3] >= 140 && lum(best) < 90) changes.push([o, 'dark', [buf[best], buf[best + 1], buf[best + 2]]])
    else if (best < 0 || buf[best + 3] < 140) changes.push([o, 'isolated'])
    else if (artWalk() !== null) { const b = artWalk(); changes.push([o, 'art', [art[b], art[b + 1], art[b + 2]]]) }
    else st.kept.push(`${cx},${cy} a${a} rgb(${buf[o]},${buf[o + 1]},${buf[o + 2]}) inward a${buf[best + 3]} rgb(${buf[best]},${buf[best + 1]},${buf[best + 2]})`)
  }
  for (const [o, why, col] of changes) {
    if (why === 'art') { buf[o] = col[0]; buf[o + 1] = col[1]; buf[o + 2] = col[2]; st.recoloured++; st.art = (st.art || 0) + 1 }
    else if (why === 'dark') { buf[o] = col[0]; buf[o + 1] = col[1]; buf[o + 2] = col[2]; st.recoloured++ }
    else { buf[o + 3] = 0; st.transparent++ }
  }
}
const webp = (layer, file) => {
  if (DESPECKLE && !/[\\/](eye_|iris_|mouth)[^\\/]*$/.test(file)) despeckle({ ...layer, name: path.basename(file) })
  return sharp(layer.buf, { raw: { width: layer.w, height: layer.h, channels: 4 } })
    .webp({ lossless: true, effort: 6 }).toFile(GUARD(file))
}

/* ------------------------------------------------------------------ source repair */

/**
 * The generator left pure-white background in pockets its border flood fill could not reach:
 * gaps between sua's hair strands (604 px and 494 px at shoulder height) and a fold in mother's
 * sleeve (223 px). They are opaque, inside the figure, and ship as bright white wedges, so paint
 * them out of all four frames with their surroundings before anything is cut. The eye and mouth
 * windows are exempt — the sclera and the teeth are white on purpose — and a pocket that opens
 * onto the background is left alone, because that is a real edge of the drawing.
 */
async function cleanWhitePockets(id, F, workDir) {
  const eb = REG.eyeR.box, mo = REG.mouthR.box
  const closed = F.closed
  const alpha = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) alpha[i] = closed[i * 4 + 3] > 16 ? 1 : 0
  const exempt = new Uint8Array(W * H)
  const mark = (b, m) => {
    for (let y = b.y0 - m; y <= b.y1 + m; y++) for (let x = b.x0 - m; x <= b.x1 + m; x++)
      if (x >= 0 && y >= 0 && x < W && y < H) exempt[idx(x, y)] = 1
  }
  mark(eb, si(16)); mark(mo, si(20))

  /* Group on a loose test — light and near-neutral — so a sliver's antialiased grey flanks come
   * with its white spine instead of breaking it into 3-px fragments; then demand that the group
   * really is background white, not a pale garment (father's grey tee is near-neutral too). */
  const white = new Uint8Array(W * H)
  const core = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) {
    const o = i * 4
    if (exempt[i] || closed[o + 3] <= 200) continue
    const mn = Math.min(closed[o], closed[o + 1], closed[o + 2])
    const mx = Math.max(closed[o], closed[o + 1], closed[o + 2])
    if (mn > 200 && mx - mn < 22) white[i] = 1
    if (mn > 238) core[i] = 1
  }
  const { lab, comps } = labelCC(white)
  const coreN = new Int32Array(comps.length)
  for (let i = 0; i < W * H; i++) if (lab[i] >= 0 && core[i]) coreN[lab[i]]++
  const onBg = new Int32Array(comps.length)   // border pixels that touch the background
  const border = new Int32Array(comps.length)
  for (let i = 0; i < W * H; i++) {
    const c = lab[i]
    if (c < 0) continue
    const x = i % W, y = (i - x) / W
    let isEdge = false, isBg = false
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) { isEdge = true; isBg = true; continue }
      const n = idx(nx, ny)
      if (!white[n]) { isEdge = true; if (!alpha[n]) isBg = true }
    }
    if (isEdge) border[c]++
    if (isBg) onBg[c]++
  }
  const fill = new Uint8Array(W * H)
  const kept = []
  for (const c of comps) {
    if (c.area < sa(8) || c.area > sa(2500)) continue // mother's are 1-3 px wide slivers
    if (coreN[c.id] < c.area * 0.25) continue        // a pale garment, not background white
    if (onBg[c.id] > border[c.id] * 0.35) continue   // mostly open to the background: a real edge
    kept.push(c)
  }
  const keepIds = new Set(kept.map(c => c.id))
  for (let i = 0; i < W * H; i++) if (lab[i] >= 0 && keepIds.has(lab[i])) fill[i] = 1
  const need = dilate(fill, sr(1))                   // take the antialiased rim with it
  for (let i = 0; i < W * H; i++) if (!alpha[i] || exempt[i]) need[i] = 0
  const total = countM(need)
  if (!total) return { px: 0, blobs: [] }

  /* Fill each pocket flat with the colour of the material around *it* — hair for sua's wedges,
   * cloth for mother's sleeve fold. Nearest-pixel propagation mottles them, because the ring is
   * half flat material and half the black line that drew the fold, so take the median of the
   * ring's lighter 60%: the material, not the ink. */
  const colourOf = (cx0, cy0, cx1, cy1, mask) => {
    const sel = new Uint8Array(W * H)
    for (let y = Math.max(0, cy0 - si(10)); y <= Math.min(H - 1, cy1 + si(10)); y++)
      for (let x = Math.max(0, cx0 - si(10)); x <= Math.min(W - 1, cx1 + si(10)); x++) sel[idx(x, y)] = 1
    const r = andM(andM(subM(dilate(mask, sr(9)), dilate(mask, sr(2))), alpha), sel)
    /* Whichever material actually surrounds the pocket, not an average of everything that rings
     * it: on the hair/garment boundary the ring holds both, and the mode picks the owner.
     * Quantise to find the dominant material, then take that bin's median. Near-white bins are
     * skipped — that is the pocket's own antialiasing bleeding into the ring. */
    const bins = new Map()
    for (let i = 0; i < W * H; i++) {
      if (!r[i]) continue
      const o = i * 4
      if (Math.min(closed[o], closed[o + 1], closed[o + 2]) > 235) continue
      const k = ((closed[o] >> 3) << 10) | ((closed[o + 1] >> 3) << 5) | (closed[o + 2] >> 3)
      if (!bins.has(k)) bins.set(k, [])
      bins.get(k).push(i)
    }
    if (!bins.size) return [128, 128, 128]
    let best = null
    for (const v of bins.values()) if (!best || v.length > best.length) best = v
    const med = ch => { const v = best.map(i => closed[i * 4 + ch]).sort((a, b) => a - b); return v[v.length >> 1] }
    return [med(0), med(1), med(2)]
  }
  const colour = new Int32Array(W * H).fill(-1)
  for (const c of kept) {
    const one = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) if (lab[i] === c.id) one[i] = 1
    const oneNeed = andM(dilate(one, sr(1)), alpha)
    const [r, g2, b2] = colourOf(c.x0, c.y0, c.x1, c.y1, one)
    for (let i = 0; i < W * H; i++) if (oneNeed[i] && need[i]) colour[i] = (r << 16) | (g2 << 8) | b2
  }
  // the four frames are byte-identical outside the eye and mouth patches, and the pockets lie
  // outside both, so one colour map and one mask keeps them identical afterwards too
  for (const k of ['closed', 'open', 'blink', 'blinkOpen']) {
    const buf = F[k]
    for (let i = 0; i < W * H; i++) {
      if (!need[i] || colour[i] < 0) continue
      const o = i * 4
      buf[o] = colour[i] >> 16 & 255; buf[o + 1] = colour[i] >> 8 & 255; buf[o + 2] = colour[i] & 255; buf[o + 3] = 255
    }
    const soft = await sharp(Buffer.from(buf), { raw: { width: W, height: H, channels: 4 } }).blur(sp(1.6)).raw().toBuffer()
    const w = await blurPlane(((m) => { const p = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) p[i] = m[i] ? 255 : 0; return p })(need), W, H, sp(1.2))
    for (let i = 0; i < W * H; i++) {
      const t = w[i] / 255
      if (t <= 0) continue
      const o = i * 4
      for (let c = 0; c < 3; c++) buf[o + c] = Math.round(buf[o + c] * (1 - t) + soft[o + c] * t)
    }
  }
  if (workDir) {
    const ov = Buffer.alloc(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      const o = i * 4
      ov[o] = need[i] ? 255 : closed[o]
      ov[o + 1] = need[i] ? 0 : closed[o + 1]
      ov[o + 2] = need[i] ? 255 : closed[o + 2]
      ov[o + 3] = 255
    }
    await writePng(ov, W, H, path.join(workDir, 'white-pockets.png'))
  }
  return { px: total, blobs: kept.map(c => `${c.area} px at x ${c.x0}-${c.x1} y ${c.y0}-${c.y1}`) }
}

/**
 * A stroke drawn on the cheek beside the mouth reads as a nasolabial fold and ages the character.
 * sua's art has one. It is approved art, not something the cut introduced, so it is painted out
 * of all four source frames before anything is cut — that way it leaves `face`, every mouth
 * frame and every expression patch at once, and no viseme can flicker it back.
 *
 * Found, not hardcoded: inside a window round the mouth, the strokes that are neither the lips
 * (they do not move between closed and open) nor the nose mark (it sits above the mouth band).
 */
async function eraseCreases(id, F, workDir, dry = false) {
  const closed = F.closed, open = F.open
  const mo = REG.mouthR.box
  const lab = labField(closed)
  // the mouth's own change region, the same way the cutter finds it
  const change = new Uint8Array(W * H)
  for (let y = mo.y0 - si(24); y <= mo.y1 + si(24); y++) for (let x = mo.x0 - si(24); x <= mo.x1 + si(24); x++) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue
    const o = idx(x, y) * 4
    const d = Math.abs(closed[o] - open[o]) + Math.abs(closed[o + 1] - open[o + 1]) + Math.abs(closed[o + 2] - open[o + 2])
    if (d > 24) change[idx(x, y)] = 1
  }
  const cb = bboxOfMask(keepCC(closeM(change, sr(2)), c => c.area > sa(30)))
  if (!cb) return { px: 0, found: [] }
  // the flat cheek tone around the mouth
  const cnt = new Map()
  for (let y = cb.y0 - si(10); y <= cb.y1 + si(10); y++) for (let x = cb.x0 - si(50); x <= cb.x1 + si(50); x++) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue
    const o = idx(x, y) * 4
    if (closed[o + 3] < 250) continue
    const k = (closed[o] << 16) | (closed[o + 1] << 8) | closed[o + 2]
    cnt.set(k, (cnt.get(k) || 0) + 1)
  }
  const [bk] = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0]
  const base = rgb2lab(bk >> 16 & 255, bk >> 8 & 255, bk & 255)
  const M = si(26)
  const ink = new Uint8Array(W * H)
  for (let y = cb.y0 - M; y <= cb.y1 + M; y++) for (let x = cb.x0 - M; x <= cb.x1 + M; x++) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue
    const i = idx(x, y)
    if (closed[i * 4 + 3] < 200) continue
    if (Math.hypot(lab[i * 3] - base[0], lab[i * 3 + 1] - base[1], lab[i * 3 + 2] - base[2]) > 3.5) ink[i] = 1
  }
  const { lab: cl, comps } = labelCC(ink)
  /* Does the stroke itself move when the mouth opens? The lips do; a crease drawn on the cheek
   * does not. Touching the change region is not enough — the crease sits inside it. */
  const movesN = new Int32Array(comps.length)
  for (let i = 0; i < W * H; i++) {
    if (cl[i] < 0) continue
    const o = i * 4
    const d = Math.abs(closed[o] - open[o]) + Math.abs(closed[o + 1] - open[o + 1]) + Math.abs(closed[o + 2] - open[o + 2])
    if (d > 24) movesN[cl[i]]++
  }
  const moving = dilate(change, sr(2))
  /* The crease is a stroke BESIDE the mouth at mouth height: inside the mouth's own vertical
   * band, but clear of the lips horizontally. The lips themselves move between closed and open;
   * the jaw shading below sits under the band; the nose mark sits above it. */
  /* The lips are ink; a crease is soft shading a few dE off the cheek tone. Both sit in the
   * mouth's band, and both read as "changed" between closed and open because the open mouth is
   * drawn over the crease — so depth of tone, not motion, is what separates them. */
  const deSum = new Float64Array(comps.length)
  for (let i = 0; i < W * H; i++) {
    if (cl[i] < 0) continue
    deSum[cl[i]] += Math.hypot(lab[i * 3] - base[0], lab[i * 3 + 1] - base[1], lab[i * 3 + 2] - base[2])
  }
  const inBand = c => c.y0 >= cb.y0 - si(8) && c.y1 <= cb.y1 + si(6)
  const soft = c => deSum[c.id] / c.area < 12
  // and clear of the lip stroke: the dash can break into segments a few px apart, and a lighter
  // segment of it would otherwise pass the tone test
  const band = comps.filter(c => inBand(c) && c.area >= sa(10))
  const lip = band.length ? band.reduce((p2, q2) => q2.area > p2.area ? q2 : p2) : null
  const clear = c => lip && (c.x1 < lip.x0 - si(6) || c.x0 > lip.x1 + si(6))
  const pick = comps.filter(c => c.area >= sa(10) && c.area <= sa(400) && inBand(c) && soft(c) && clear(c))
  if (dry) {
    for (const c of comps.filter(c => c.area >= sa(10) && c.area <= sa(900))) {
      const take = inBand(c) && soft(c) && clear(c)
      LOG(`      cand ${String(c.area).padStart(4)} px  x ${c.x0}-${c.x1} y ${c.y0}-${c.y1}` +
        `  inBand=${inBand(c)} meanDE=${(deSum[c.id] / c.area).toFixed(1)} clearOfLip=${!!clear(c)}${take ? '   <- WOULD ERASE' : ''}`)
    }
    return { px: 0, found: pick.map(c => `${c.area} px at x ${c.x0}-${c.x1} y ${c.y0}-${c.y1}`), dry: true }
  }
  if (!pick.length) return { px: 0, found: [] }
  const erase = new Uint8Array(W * H)
  const ids = new Set(pick.map(c => c.id))
  for (let i = 0; i < W * H; i++) if (cl[i] >= 0 && ids.has(cl[i])) erase[i] = 1
  // the stroke has a soft falloff below the detection threshold; take it too, or a ghost of the
  // crease survives the fill
  const need = dilate(erase, sr(3))
  const src = subM(subM(new Uint8Array(W * H).fill(1), need), dilate(ink, sr(1)))
  for (let i = 0; i < W * H; i++) if (closed[i * 4 + 3] < 250) src[i] = 0
  const wPl = await blurPlane(opaqueOf(need), W, H, sp(2.4))
  for (const k of ['closed', 'open', 'blink', 'blinkOpen']) {
    const filled = nearestFill(F[k], src, need)
    const soft = await sharp(Buffer.from(filled), { raw: { width: W, height: H, channels: 4 } }).blur(sp(1.8)).raw().toBuffer()
    const buf = F[k]
    for (let i = 0; i < W * H; i++) {
      const t = wPl[i] / 255
      if (t <= 0) continue
      const o = i * 4
      for (let c = 0; c < 3; c++) buf[o + c] = Math.round(filled[o + c] * (1 - t) + soft[o + c] * t)
      if (need[i]) buf[o + 3] = Math.max(buf[o + 3], closed[o + 3])
    }
  }
  return { px: countM(need), found: pick.map(c => `${c.area} px at x ${c.x0}-${c.x1} y ${c.y0}-${c.y1}`) }
}

/* ------------------------------------------------------------------ head rescale
 *
 * The user's complaint is that the torso reads too small. Rather than redraw anything, the head
 * group is scaled about the point where it sits on the neck and the whole composition is then
 * scaled back up about the bottom edge, so the head/body ratio changes while the figure still
 * fills the frame — the body genuinely grows instead of the head merely shrinking.
 *
 * This happens on the SOURCE frames, before any cut: resampling finished textures runs already
 * antialiased line art through a second resample and stipples every edge, and it would leave the
 * anchors, brow_lines and the iris range walk measured on the wrong art.
 */
const opaqueOf = m => { const p = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) p[i] = m[i] ? 255 : 0; return p }

async function rescaleHead(F, g, s, workDir) {
  const closed = F.closed
  const PX = g.head.cx, PY = g.neckY
  /* The hair mask owns the ink at the hair/garment boundary, because that stroke is both the
   * hair's outline and the cardigan's front edge — sua's art draws them as one line. Carried off
   * with the head it leaves the cardigan unlined wherever the hair used to lie along it, and the
   * gap grows with the scale. Ink that touches the body and is not against the solid hair mass
   * belongs to the body, exactly as it does for the face egg's contour. */
  /* Cut the head plate's lower boundary ON THE JAW INK, not on the egg's ellipse edge. The egg
   * ends at an arbitrary row inside the neck's soft shadow, so scaling the head carried half of
   * that gradient away and left the other half — a faint second line below the jaw that no
   * feather can close, because the discontinuity is in the gradient itself. The ink is a hard
   * feature with face above and neck below, so the seam has nothing to tear. */
  const jawY = new Int32Array(W).fill(-1)
  let jawFound = 0, jawCols = 0
  for (let x = 0; x < W; x++) {
    let yBot = -1
    for (let y = H - 1; y >= 0; y--) if (g.eggShape[idx(x, y)]) { yBot = y; break }
    if (yBot < 0) continue
    jawCols++
    let best = -1, bestL = 1e9
    for (let y = yBot - si(20); y <= Math.min(H - 1, yBot + si(8)); y++) {
      if (y < 0) continue
      const o = idx(x, y) * 4
      if (closed[o + 3] < 200) continue
      const L = 0.299 * closed[o] + 0.587 * closed[o + 1] + 0.114 * closed[o + 2]
      if (L < bestL) { bestL = L; best = y }
    }
    if (best >= 0 && bestL < 150) { jawY[x] = best; jawFound++ }
  }
  // bridge the columns where hair crosses the jaw, so the boundary stays a smooth curve
  {
    const known = []
    for (let x = 0; x < W; x++) if (jawY[x] >= 0) known.push(x)
    if (known.length >= 2) {
      for (let x = 0; x < W; x++) {
        if (jawY[x] >= 0) continue
        let lo = null, hi = null
        for (const k of known) { if (k < x) lo = k; else { hi = k; break } }
        if (lo === null && hi === null) continue
        if (lo === null) jawY[x] = jawY[hi]
        else if (hi === null) jawY[x] = jawY[lo]
        else jawY[x] = Math.round(jawY[lo] + (jawY[hi] - jawY[lo]) * (x - lo) / (hi - lo))
      }
    }
  }
  const aboveJaw = new Uint8Array(W * H)
  for (let x = 0; x < W; x++) {
    const lim = jawY[x] >= 0 ? jawY[x] + si(1) : H - 1
    for (let y = 0; y <= Math.min(H - 1, lim); y++) aboveJaw[idx(x, y)] = 1
  }
  const headMask0 = dilate(orM(g.hair, andM(g.eggShape, aboveJaw)), sr(1))
  const bodyM0 = subM(g.alpha, headMask0)
  /* Only ink on the HAIR/garment boundary. The jaw stroke is also dark and also touches the body
   * (the neck is body), so without the egg exclusion it was handed to the body and left behind
   * when the face scaled off it — a dotted row along the jaw in the rescaled frame. */
  const bodyInk = subM(subM(andM(g.dark, dilate(bodyM0, sr(3))), dilate(g.hairThick, sr(2))),
    dilate(g.eggShape, sr(3)))
  const headMask = subM(headMask0, bodyInk)
  const bodyM = subM(g.alpha, headMask)
  // the garment under the head group has to exist before the head moves off it
  const need = andM(headMask, closeM(bodyM, sr(50)))
  /* Feather where the head meets the body. Two hard-edged plates butted together survive
   * compositing, but the reframe resamples across the join and rings along it — which is what
   * put a dotted seam down the jaw. A 2-3 px blend has nothing to ring against. */
  const headEdge = dilate(headMask, sr(2))
  /* Still worth it with the seam on the ink: the jaw no longer needs it, but the hair/neck
   * junction is a vertical boundary with no feature to hide on and steps without it. 1.2 keeps
   * both clean; 2.2 softened the jaw stroke itself (mean |d| 0.61 -> 0.67). */
  const headAlpha = await blurPlane(opaqueOf(headMask), W, H, sp(1.2))
  const hb = bboxOfMask(headEdge)
  const hw = hb.x1 - hb.x0 + 1, hh = hb.y1 - hb.y0 + 1
  const nw = Math.max(1, Math.round(hw * s)), nh = Math.max(1, Math.round(hh * s))
  const nx = Math.round(PX + (hb.x0 - PX) * s), ny = Math.round(PY + (hb.y0 - PY) * s)
  /* The weight has to be full at the RIM of the fill, not just deep inside it: the band the
   * scaled head stops covering is exactly that rim, and an eroded weight left the raw
   * nearest-pixel staircase showing there as a dotted seam along the jaw. */
  const wPlane = await blurPlane(opaqueOf(dilate(need, sr(2))), W, H, sp(3))

  for (const k of ['closed', 'open', 'blink', 'blinkOpen']) {
    const src = F[k]
    const filled = nearestFill(src, erode(bodyM, sr(1)), need)
    const plate = Buffer.alloc(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      const o = i * 4
      if (bodyM[i]) { plate[o] = src[o]; plate[o + 1] = src[o + 1]; plate[o + 2] = src[o + 2]; plate[o + 3] = src[o + 3] }
      else if (need[i]) { plate[o] = filled[o]; plate[o + 1] = filled[o + 1]; plate[o + 2] = filled[o + 2]; plate[o + 3] = 255 }
    }
    /* Heavily, not lightly. Nearest-pixel propagation stair-steps along a curved boundary, and
     * the 2 % band the scaled head stops covering runs right along the jaw, where that staircase
     * reads as a dotted seam. Everything here is a smooth skin or cloth gradient under the head,
     * so a wide blur costs nothing and removes the steps. */
    const soft = await sharp(Buffer.from(plate), { raw: { width: W, height: H, channels: 4 } }).blur(sp(7)).raw().toBuffer()
    for (let i = 0; i < W * H; i++) {
      const t = wPlane[i] / 255
      if (t <= 0) continue
      const o = i * 4
      for (let c = 0; c < 3; c++) plate[o + c] = Math.round(plate[o + c] * (1 - t) + soft[o + c] * t)
    }
    const hbuf = Buffer.alloc(hw * hh * 4)
    for (let j = 0; j < hh; j++) for (let i = 0; i < hw; i++) {
      const si2 = idx(hb.x0 + i, hb.y0 + j), d = (j * hw + i) * 4
      if (!headEdge[si2]) continue
      // RGB from the frame even just outside the mask, so the feather blends real skin into real
      // skin rather than into whatever happened to be left in the buffer
      hbuf[d] = src[si2 * 4]; hbuf[d + 1] = src[si2 * 4 + 1]; hbuf[d + 2] = src[si2 * 4 + 2]
      hbuf[d + 3] = Math.min(src[si2 * 4 + 3], headAlpha[si2])
    }
    const hres = await sharp(hbuf, { raw: { width: hw, height: hh, channels: 4 } })
      .resize(nw, nh, { kernel: 'mitchell', fit: 'fill' }).raw().toBuffer()
    for (let j = 0; j < nh; j++) for (let i = 0; i < nw; i++) {
      const x = nx + i, y = ny + j
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      const o = (j * nw + i) * 4, d = idx(x, y) * 4
      const a = hres[o + 3] / 255
      if (a <= 0) continue
      const da = plate[d + 3] / 255, oa = a + da * (1 - a)
      for (let c = 0; c < 3; c++) plate[d + c] = Math.round((hres[o + c] * a + plate[d + c] * da * (1 - a)) / oa)
      plate[d + 3] = Math.round(oa * 255)
    }
    F[k].set(plate)
  }
  return { filled: countM(need), headBox: hb, jawFound, jawCols }
}

/** scale the whole composition about the bottom edge, so the figure fills the frame again */
async function reframeFrames(F, wantTop) {
  let top = H
  for (let y = 0; y < H; y++) { let hit = false; for (let x = 0; x < W; x++) if (F.closed[idx(x, y) * 4 + 3] > 40) { hit = true; break } if (hit) { top = y; break } }
  const sf = (H - 1 - wantTop) / (H - 1 - top)
  const nw = Math.round(W * sf), nh = Math.round(H * sf)
  const ox = Math.round((W - nw) / 2), oy = H - nh
  for (const k of ['closed', 'open', 'blink', 'blinkOpen']) {
    const r = await sharp(Buffer.from(F[k]), { raw: { width: W, height: H, channels: 4 } })
      .resize(nw, nh, { kernel: 'mitchell', fit: 'fill' }).raw().toBuffer()
    const out = Buffer.alloc(W * H * 4)
    for (let j = 0; j < nh; j++) for (let i = 0; i < nw; i++) {
      const x = ox + i, y = oy + j
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      const o = (j * nw + i) * 4, d = idx(x, y) * 4
      out[d] = r[o]; out[d + 1] = r[o + 1]; out[d + 2] = r[o + 2]; out[d + 3] = r[o + 3]
    }
    F[k].set(out)
  }
  return { sf, topBefore: top, map: (x, y) => [ox + x * (nw / W), oy + y * (nh / H)] }
}

/* ------------------------------------------------------------------ geometry + masks */

async function geometry(id, F, workDir, cfg) {
  const closed = F.closed, blink = F.blink
  const eb = REG.eyeR.box, mb = REG.mouthR.box

  const alpha = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) alpha[i] = closed[i * 4 + 3] > 16 ? 1 : 0
  const figBox = bboxOfMask(alpha)

  const lab = labField(closed)

  // --- colour samples
  const faceCx0 = Math.round((eb.x0 + eb.x1) / 2)
  let crownY = H
  for (let y = 0; y < H; y++) { let hit = false; for (let x = faceCx0 - si(40); x <= faceCx0 + si(40); x++) if (closed[idx(x, y) * 4 + 3] > 200) { hit = true; break } if (hit) { crownY = y; break } }
  const hairSamples = [
    medianPatch(closed, faceCx0, crownY + si(14), sr(6)),
    medianPatch(closed, faceCx0 - si(60), crownY + si(40), sr(5)),
    medianPatch(closed, faceCx0 + si(60), crownY + si(40), sr(5)),
  ].filter(Boolean).map(c => rgb2lab(...c))
  const cheekY = Math.round((eb.y1 + mb.y0) / 2)
  const dx = Math.round((eb.x1 - eb.x0) * 0.32)
  const skinSamples = [
    medianPatch(closed, faceCx0 - dx, cheekY, sr(5)),
    medianPatch(closed, faceCx0 + dx, cheekY, sr(5)),
  ].filter(Boolean).map(c => rgb2lab(...c))

  const minDE = (i, set) => { let m = Infinity; for (const c of set) { const d = dEAt(lab, i, c); if (d < m) m = d } return m }

  /* --- skin.
   * The art is flat cel: each material is one or two exact colours. A Lab ball around the cheek
   * alone is not enough (sua's cream cardigan is dE 10.8 from her skin, father's chinos 10.5,
   * mother's trousers 10.2), so instead read the face's own palette — every colour covering
   * >=0.6% of the cheek/chin/neck window that is plausibly skin — and accept dE < tolSkin (7)
   * from any of its entries. That separates skin from cloth with ~4 dE to spare.
   */
  const paletteOf = (x0, y0, x1, y1) => {
    const m = new Map()
    let tot = 0
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
      const o = idx(x, y) * 4
      if (closed[o + 3] < 230) continue
      const k = (closed[o] << 16) | (closed[o + 1] << 8) | closed[o + 2]
      m.set(k, (m.get(k) || 0) + 1); tot++
    }
    return [...m.entries()].filter(([, c]) => c > tot * 0.006).sort((a, b) => b[1] - a[1])
      .map(([k]) => [k >> 16 & 255, k >> 8 & 255, k & 255])
  }
  const skinLike = c => {
    const l = rgb2lab(...c)
    return l[0] > 52 && l[1] > 3.5 && l[1] < 34 && l[2] > 9 && l[2] < 48
  }
  const skinPalette = []
  for (const c of [...paletteOf(eb.x0, eb.y1 + si(4), eb.x1, mb.y0 - si(4)),
                   ...paletteOf(faceCx0 - si(34), mb.y1 + si(8), faceCx0 + si(34), mb.y1 + si(95))]) {
    if (!skinLike(c)) continue
    const l = rgb2lab(...c)
    if (skinPalette.some(p => Math.hypot(p[0] - l[0], p[1] - l[1], p[2] - l[2]) < 5)) continue
    if (skinPalette.length && Math.hypot(skinPalette[0][0] - l[0], skinPalette[0][1] - l[1], skinPalette[0][2] - l[2]) > 34) continue
    skinPalette.push(l)
  }
  if (!skinPalette.length) skinPalette.push(...skinSamples)
  const isSkinLab = l => skinPalette.some(p => Math.hypot(p[0] - l[0], p[1] - l[1], p[2] - l[2]) < cfg.tolSkin)
  const skinRaw = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) if (alpha[i] && isSkinLab([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]])) skinRaw[i] = 1
  // the face's own skin blob: face + ears + neck, stopping at the collar
  const skinCC = largestCC(closeM(skinRaw, sr(2)))
  const skin = andM(orM(skinRaw, skinCC), alpha)

  // --- hair: solid masses only, then its own outline back
  const dark = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) if (alpha[i] && lab[i * 3] < 48) dark[i] = 1
  const hairRaw = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) if (alpha[i] && minDE(i, hairSamples) < cfg.tolHair) hairRaw[i] = 1
  /* A 3 px opening tells solid hair from the line art, but it also eats the pointed tips of the
   * bangs. So use the opened mass only as a *seed* and reconstruct the whole hairRaw component
   * around it: the tips come back, while the face's ink contour — which is darker than the hair
   * and so is not in hairRaw — never joins. Then add back the hair's own outline, the dark ring
   * within 2 px of it. */
  const hairBody = keepCC(openM(hairRaw, sr(2)), c => c.area > sa(400))
  /* cfg.hairNear (sua2): her figure's ink outline is the hair's own dark brown, joined to the hair
   * at both shoulders, so the reconstruction walked down the whole silhouette. Reconstruct only
   * within this many px of the solid hair mass. Unset = unchanged. */
  const hairRec = reconstruct(hairBody, cfg.hairNear ? andM(hairRaw, dilate(hairBody, sr(cfg.hairNear))) : hairRaw)
  /* cfg.hairOutlineL (iseul): her pale hair is outlined in mid grey (L* 60-73), not in the ink the
   * L* < 48 test looks for, so the strand outlines lying on the forehead fell to the face's ring and
   * would stay on the skin while the bangs sway. Within 2 px of the hair, non-skin texels darker than
   * this L* are the hair's outline too. Unset = unchanged. */
  const outlineInk = cfg.hairOutlineL ? (() => { const m = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) if (alpha[i] && !skinRaw[i] && lab[i * 3] < cfg.hairOutlineL) m[i] = 1; return m })() : dark
  const hairOutline = andM(dilate(hairRec, sr(2)), outlineInk)
  let hair = closeM(orM(hairRec, hairOutline), sr(1))
  const faceHoles = subM(fillHoles(skinCC), skinCC)
  hair = andM(subM(hair, faceHoles), alpha)
  /* cfg.hairMaxY (daeun): black clothes and a black camera share the hair's colour, so cap the hair
   * geometrically — rows above the cap only, then only components that touch the crown mass. */
  const hairCap = m => {
    if (!cfg.hairMaxY) return m
    // a number, or [[xFrom, yMax], ...] sorted by xFrom: the cap that applies from that column on
    const capAt = new Int32Array(W)
    for (let x = 0; x < W; x++) {
      if (typeof cfg.hairMaxY === 'number') { capAt[x] = cfg.hairMaxY; continue }
      let c = H
      for (const [xf, ym] of cfg.hairMaxY) if (x >= xf) c = ym
      capAt[x] = c
    }
    const out = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) if (m[i] && (i / W | 0) <= capAt[i % W]) out[i] = 1
    const { lab: cl, comps } = labelCC(out)
    if (!comps.length) return out
    // the crown mass: the largest component; keep what touches it within 3 px (loose strand tips)
    const main = comps.reduce((p, q) => q.area > p.area ? q : p)
    const near = dilate((() => { const k = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) if (cl[i] === main.id) k[i] = 1; return k })(), sr(3))
    const keep = new Set([main.id])
    for (let i = 0; i < W * H; i++) if (cl[i] >= 0 && near[i]) keep.add(cl[i])
    for (let i = 0; i < W * H; i++) out[i] = cl[i] >= 0 && keep.has(cl[i]) ? 1 : 0
    return out
  }
  hair = hairCap(hair)

  /* --- neck_y: the chin is the first local minimum of the face-skin row width below the mouth
   * (father's neck stays narrow all the way to his collar, so "the narrowest row" picks the collar) */
  const rowW = new Int32Array(H)
  for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) if (skinCC[idx(x, y)]) n++; rowW[y] = n }
  let neckY = mb.y1 + si(20), bestW = Infinity, rising = 0
  for (let y = mb.y1 + si(8); y < Math.min(H, mb.y1 + si(240)); y++) {
    if (rowW[y] === 0) break
    if (rowW[y] < bestW) { bestW = rowW[y]; neckY = y; rising = 0 }
    else if (rowW[y] > bestW * 1.1 + si(2)) { if (++rising >= si(5)) break } else rising = 0
  }

  /* --- brows: dark arcs a few px tall sitting above each eye. A vertical opening removes
   * everything thinner than 11 px, which is every brow and no bang strand, so the brows can be
   * told apart from the bangs they touch (sua's left brow runs into one). */
  const hairThick = openXY(hairRaw, sr(1), sr(5))

  // --- head ellipse: the skull, not the hair silhouette
  const skinHead = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) if (skinCC[i] && (i / W | 0) < neckY) skinHead[i] = 1
  const faceBox = bboxOfMask(skinHead)
  const headSil = largestCC(andM(orM(hair, skinCC), (() => { const m = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) m[i] = (i / W | 0) < neckY ? 1 : 0; return m })()))
  const headSilBox = bboxOfMask(headSil)
  // cfg.headCx (daeun): in a three-quarter view the eyes' midpoint is not the middle of the face;
  // centred there, the egg cut across her far cheek and jaw
  const cx = cfg.headCx ?? Math.round((eb.x0 + eb.x1) / 2)
  // forehead skin at the centre: where the bangs end
  let hairRootY = neckY
  for (let y = headSilBox.y0; y < neckY; y++) {
    let n = 0
    for (let x = cx - Math.round(0.35 * (faceBox.w / 2)); x <= cx + Math.round(0.35 * (faceBox.w / 2)); x++) if (skinCC[idx(x, y)]) n++
    if (n > si(6)) { hairRootY = y; break }
  }
  const skullTop = Math.round(headSilBox.y0 + 0.35 * (hairRootY - headSilBox.y0))
  const ry = (neckY - skullTop) / 2
  const cy = (neckY + skullTop) / 2
  // rx from the 1st/99th percentile of the face skin's columns, so a stray pixel in the hair
  // cannot stretch the egg past the silhouette
  const colN = new Int32Array(W)
  let colTot = 0
  for (let i = 0; i < W * H; i++) if (skinHead[i]) { colN[i % W]++; colTot++ }
  let acc = 0, px0 = faceBox.x0, px1 = faceBox.x1
  for (let x = 0; x < W; x++) { acc += colN[x]; if (acc >= colTot * 0.01) { px0 = x; break } }
  acc = 0
  for (let x = W - 1; x >= 0; x--) { acc += colN[x]; if (acc >= colTot * 0.01) { px1 = x; break } }
  // cfg.headRx (daeun): her far cheek and jaw bulge out low on the right, past any ellipse fitted to
  // the face's width; the egg has to reach them or its feathered rim crosses bare cheek
  const rx = cfg.headRx ?? Math.max(cx - px0, px1 - cx) + si(4)
  const head = { cx, cy, rx, ry }
  const headEll = ellipseMask(cx, cy, rx + sp(2), ry + sp(4))

  /* Inside the head egg the `face` layer keeps the drawn face — the skin blob with its eyes /
   * nose / lips filled back in, plus the ink contour round it (2 px of anything, 4 px of ink)
   * that the hair mask does not already own — and inpaints everything else with skin. Whatever
   * it inpaints, a hair layer has to redraw, so hand the hair every such pixel that sits within
   * 6 px of it: the thin dark strokes drawn *between* bang strands are darker than the hair
   * itself and would otherwise belong to neither layer and vanish. */
  const faceCore = fillHoles(skinCC)
  const faceRing = subM(orM(dilate(faceCore, sr(2)), andM(dilate(faceCore, sr(4)), dark)), hair)
  let faceKeep = orM(faceCore, faceRing)
  /* cfg.headSkinKeep (iseul): her bangs cut the forehead skin into pockets the largest skin component
   * does not reach, so they were neither face nor hair and fell to the body, which does not move with
   * the head. Skin inside the head ellipse above the jaw is the face's. Unset = unchanged. */
  if (cfg.headSkinKeep) faceKeep = orM(faceKeep, andM(andM(skinRaw, headEll), (() => { const m = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) m[i] = (i / W | 0) < neckY ? 1 : 0; return m })()))
  /* The egg is the head ellipse clipped to the head itself — skin or hair, never clothes. The
   * ellipse's lower corners reach past the jaw onto the collar (father's shirt sits 15 px inside
   * his), and anything there would be inpainted into a skin wedge over the cloth. */
  const headBlob = dilate(orM(faceKeep, hair), sr(1))
  let eggShape = andM(andM(headEll, dilate(alpha, sr(1))), headBlob)
  /* The ears stick out past the head ellipse, so the part beyond it fell to `body` — which does
   * not move with the head at all, while the inner half rides `face`. A turn then tore the ear in
   * two along a mask edge, with a sliver of back_hair (depth -0.32) opening between the halves.
   * An ear is skin and part of the head: take any of the drawn face that lies within a quarter
   * radius of the ellipse and above the jaw, so the whole ear travels with the face. The neck is
   * excluded by the jaw limit — it has to stay on the body.
   *   The limit is `cy + 0.7*ry`, not the neck line: faceKeep's outer ring is "dark within 4 px of
   * the face", which beside a jaw IS the collar (father's shirt is navy and touches his jaw), and
   * claiming collar into the egg takes it off the body while the face only feathers over it —
   * a hole at rest, which is worse than the tear this fixes. No ear hangs that low: the split
   * pixels measured on the real art are y 149-214 of 242 (father) and 249-292 of 323 (mother). */
  {
    const earBot = Math.min(neckY, cy + 0.70 * ry)
    const reach = andM(ellipseMask(cx, cy, rx * 1.25, ry * 1.12), (() => {
      const m = new Uint8Array(W * H)
      for (let i = 0; i < W * H; i++) m[i] = (i / W | 0) <= earBot ? 1 : 0
      return m
    })())
    const ears = andM(andM(faceKeep, reach), dilate(alpha, sr(1)))
    eggShape = orM(eggShape, ears)
  }
  /* Where the face ends up fully opaque. Its alpha is min(source alpha, 255 inside erode(egg,1)),
   * so this is exactly the set it hides. Fills that stop here instead of at the egg's outer
   * boundary cannot show through the 1 px in which that boundary fades (SPEC §3.2: a fill that
   * shows at rest is a bug). */
  let eggCore = andM(erode(eggShape, sr(1)), (() => {
    const m = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) m[i] = closed[i * 4 + 3] >= 200 ? 1 : 0
    return m
  })())
  hair = orM(hair, andM(subM(eggShape, faceKeep), dilate(hair, sr(6))))

  /* The hair is drawn with a bright rim-light stroke along its outer edge: neither hair-coloured
   * nor skin, so it falls out of both masks and ends up as white slivers floating over the hair
   * in the body layer. Any such off-palette scrap that hugs the hair and is too small to be a
   * garment belongs to the hair. */
  {
    const bodyRaw = subM(subM(alpha, headEll), hair)
    const near = dilate(hair, sr(3))
    const { lab: cl, comps } = labelCC(bodyRaw)
    const hit = new Int32Array(comps.length)
    for (let i = 0; i < W * H; i++) if (cl[i] >= 0 && near[i]) hit[cl[i]]++
    const claim = new Uint8Array(comps.length)
    // cfg.noRimClaim (daeun): her hair has no rim-light stroke, and the scrap this would claim is the
    // shaded neck and the navy collar tip beside the hair
    if (!cfg.noRimClaim) for (const c of comps) claim[c.id] = (c.area < sa(20000) && hit[c.id] / c.area >= 0.6) ? 1 : 0
    const rim = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) if (cl[i] >= 0 && claim[cl[i]]) rim[i] = 1
    hair = andM(orM(hair, rim), alpha)
  }

  /* Any near-white speck still hugging the hair is its rim-light too, whatever component it ended
   * up in. Left on the body it ships as white pixels in body.webp — the very defect the first
   * pocket pass exists to remove, except that this one is created by the cut rather than present
   * in the frame, so cleaning the source can never reach it. Outside the face egg, so the eye
   * whites and the mouth's teeth are untouched. */
  {
    const nearWhite = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) {
      const o = i * 4
      if (!alpha[i] || eggShape[i]) continue
      if (Math.min(closed[o], closed[o + 1], closed[o + 2]) > 235) nearWhite[i] = 1
    }
    hair = andM(orM(hair, andM(nearWhite, dilate(hair, sr(2)))), alpha)
  }
  hair = hairCap(hair)

  /* [earOwn] (global; cfg.earOwn === false opts out) the ear is skin, and skin is the face's.
   *   A feature that straddles two layers at different depths cannot survive a turn: back_hair sits
   * at depth -0.32 (about -10 px against the face at angleX 30), the face at 0. The ear's outer rim
   * is lit or shaded off the skin palette, so the palette test leaves it out of the face, and the
   * rim-light claim above takes it for hair: a small scrap outside the head ellipse that hugs the
   * hair. That is what happened to sua's outer rim (back_hair and front_hair), and the nearest-
   * colour backing painted behind it then carried the skin tone across the whole ear. On a turn the
   * pieces came apart. The ear's outline ink goes with it, since brown ink beside brown hair cannot
   * be told from hair by colour.
   *   So look at what the hair mask holds. skinWide is any skin tone, lit or shaded (L > 55, chroma
   * > 12, hue 45-95 deg), not only the palette's. In the ear zone (the outer part of the head
   * ellipse at ear height, one side at a time) count the skin-toned pixels the hair mask owns; an
   * ear with EAR_LEAK_MIN or more of them is split, and only then it is re-owned: its skin (the
   * skin component grown through skinWide) and the EAR_RING px outline round it go to the face, leave
   * the hair, join the egg, and get a dark backing in back_hair. An ear whose rim is already the
   * face's is not touched, so a build that was clean stays byte for byte what it was. */
  const skinWide = new Uint8Array(W * H)
  let earOwn = new Uint8Array(W * H)
  const earOn = cfg.earOwn !== false && !STAGE_OFF.has('ears')
  const earReport = { L: 0, R: 0, fixedL: false, fixedR: false }
  if (earOn) {
    for (let i = 0; i < W * H; i++) {
      if (!alpha[i]) continue
      const Lc = lab[i * 3], ac = lab[i * 3 + 1], bc = lab[i * 3 + 2]
      const ch = Math.hypot(ac, bc), hu = Math.atan2(bc, ac) * 57.29578
      if (Lc > 55 && ch > 12 && hu > 45 && hu < 95) skinWide[i] = 1
    }
    const earBot0 = Math.min(neckY, cy + 0.70 * ry)
    const ez = ellipseMask(cx, cy, rx * 1.30, ry * 1.15)
    for (const side of ['L', 'R']) {
      const zone = new Uint8Array(W * H)
      for (let y = Math.max(0, Math.floor(cy - 0.25 * ry)); y <= earBot0; y++) for (let x = 0; x < W; x++) {
        const i = idx(x, y)
        if (!ez[i] || (side === 'L' ? x >= cx : x <= cx) || Math.abs(x - cx) < EAR_ZONE * rx) continue
        zone[i] = 1
      }
      let leak = 0
      for (let i = 0; i < W * H; i++) if (zone[i] && hair[i] && skinWide[i]) leak++
      earReport[side] = leak
      if (leak < EAR_LEAK_MIN) continue
      // grow the palette skin through BRIGHT skin tones only (L > 72: the lit rim), so the growth stops at
      // the outline ink instead of leaking through its anti-aliased gaps into the hair's own edge; the
      // ring below takes the blends and the outline themselves
      const skinBright = new Uint8Array(W * H)
      for (let i = 0; i < W * H; i++) if (skinWide[i] && lab[i * 3] > 72) skinBright[i] = 1
      const earSkin = reconstruct(andM(skinCC, zone), andM(orM(skinCC, skinBright), zone))
      const earRing = andM(andM(subM(dilate(earSkin, sr(EAR_RING)), earSkin), zone), alpha)
      earOwn = orM(earOwn, orM(earSkin, earRing))
      earReport['fixed' + side] = true
    }
    if (countM(earOwn)) {
      hair = subM(hair, earOwn)
      faceKeep = orM(faceKeep, earOwn)
      eggShape = orM(eggShape, andM(earOwn, dilate(alpha, sr(1))))
      eggCore = andM(erode(eggShape, sr(1)), (() => {
        const m = new Uint8Array(W * H)
        for (let i = 0; i < W * H; i++) m[i] = closed[i * 4 + 3] >= 200 ? 1 : 0
        return m
      })())
    }
    if (workDir) LOG(`  ears: skin-toned px in the hair mask, left ${earReport.L} right ${earReport.R} (re-owned if >= ${EAR_LEAK_MIN}: left ${earReport.fixedL ? 'yes' : 'no'}, right ${earReport.fixedR ? 'yes' : 'no'}; ${countM(earOwn)} px now the face's)`)
  }
  /* cfg.hairFillAbove (daeun): above the cap line and outside the face egg there is nothing in her
   * art but hair, ear and neck. The colour test misses the hair's blue-grey sheen and parts of its
   * outline; left out, those land on `body`, whose hair-over-torso closing then bridges the whole
   * hair mass and paints it with a far-away cloth colour. So there, everything that is not skin-like
   * is hair — geometry first, colour second. */
  if (cfg.hairFillAbove && cfg.hairMaxY) {
    const capAt = x => typeof cfg.hairMaxY === 'number' ? cfg.hairMaxY : cfg.hairMaxY.reduce((c, [xf, ym]) => x >= xf ? ym : c, H)
    // not the face's own ink contour (jaw, chin, neck line): that stays with the face / body
    const faceInk = dilate(skinCC, sr(3))
    // cfg.hairFillInk (iseul): near the skin only the actual ink (L* < 48) is the face's contour; her pale
    // hair tips within 3 px of the jaw stayed on the static body. Unset = unchanged.
    if (cfg.hairFillInk) for (let i = 0; i < W * H; i++) if (faceInk[i] && !skinCC[i] && lab[i * 3] >= 48) faceInk[i] = 0
    for (let i = 0; i < W * H; i++) {
      if (!alpha[i] || hair[i] || eggShape[i] || skinCC[i] || faceInk[i]) continue
      const x = i % W, y = (i - x) / W
      if (y > capAt(x)) continue
      const o = i * 4
      const l = [lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]]
      const skinish = l[0] > 45 && l[1] > 3.5 && l[1] < 40 && l[2] > 6 && l[2] < 50
      if (!skinish) hair[i] = 1
    }
  }
  // A near-skin-coloured specular highlight may otherwise be misclassified as
  // static body. Profile boxes are confined to known hair-only regions.
  if (cfg.hairIncludeBoxes) {
    for (const [x0, y0, x1, y1] of cfg.hairIncludeBoxes) {
      for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
        for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
          const i = idx(x, y)
          if (alpha[i]) hair[i] = 1
        }
      }
    }
  }
  /* cfg.rimToHair (iseul, a radius): her lower hair tips become hair only in the fill above, after the
   * egg rule handed the non-face egg texels near the hair to it, so the egg's feathered outer rim under
   * those tips was left to the face's skin inpaint and drawn by nothing solid. Rim texels the face does
   * not keep and that lie within this many px of the hair go to the hair. Unset = unchanged. */
  if (cfg.rimToHair) hair = orM(hair, andM(subM(subM(eggShape, eggCore), faceKeep), dilate(hair, sr(cfg.rimToHair))))
  /* cfg.earBox (daeun): in her three-quarter view the far ear sits ~35 px outside the head egg,
   * between hair locks. Left alone it is neither face nor hair and lands on the BODY layer, where
   * it would stay put while the head turns. Everything drawn in the box goes with the hair instead
   * (and into front_hair, below), so the ear rides the head. */
  const earMask = new Uint8Array(W * H)
  if (cfg.earBox) {
    const [ex0, ey0, ex1, ey1] = cfg.earBox
    for (let y = ey0; y <= ey1; y++) for (let x = ex0; x <= ex1; x++) { const i = idx(x, y); if (alpha[i] && !eggShape[i]) earMask[i] = 1 }
    hair = orM(hair, earMask)
  }

  // --- collar
  const clothes = andM(subM(subM(alpha, hair), skin), (() => { const m = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) m[i] = (i / W | 0) > neckY ? 1 : 0; return m })())
  let collarY = neckY
  {
    const x0 = Math.round(cx - 0.6 * rx), x1 = Math.round(cx + 0.6 * rx)
    const need = (x1 - x0) * 0.35
    let run = 0
    for (let y = neckY; y < H; y++) {
      let n = 0
      for (let x = x0; x <= x1; x++) if (x >= 0 && x < W && clothes[idx(x, y)]) n++
      if (n > need) { if (++run >= si(3)) { collarY = y - si(2); break } } else run = 0
    }
  }

  /* --- eyes: split the measured both-eye box, then re-tighten on closed vs blink --- */
  const diffEye = new Uint8Array(W * H)
  for (let y = eb.y0 - si(14); y <= eb.y1 + si(14); y++) for (let x = eb.x0 - si(14); x <= eb.x1 + si(14); x++) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue
    const o = idx(x, y) * 4
    const d = Math.abs(closed[o] - blink[o]) + Math.abs(closed[o + 1] - blink[o + 1]) + Math.abs(closed[o + 2] - blink[o + 2]) + Math.abs(closed[o + 3] - blink[o + 3])
    if (d > (cfg.eyeDiffT ?? 24)) diffEye[idx(x, y)] = 1
  }
  const eyeChange = keepCC(closeM(diffEye, sr(2)), c => c.area > sa(40))
  const mid = Math.round((eb.x0 + eb.x1) / 2)
  const halfMask = (lo, hi) => { const m = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = lo; x <= hi; x++) if (x >= 0 && x < W) m[idx(x, y)] = 1; return m }
  /* cfg.eyeLargest (daeun): one generated blink redraws faint noise across the whole eye ellipse
   * (brows, fringe, lashes), so each half keeps only its largest change blob — the eye itself. */
  const eyeHalf = m => cfg.eyeLargest ? largestCC(m) : m
  const eyeBoxes = [
    bboxOfMask(eyeHalf(andM(eyeChange, halfMask(0, mid)))),
    bboxOfMask(eyeHalf(andM(eyeChange, halfMask(mid + 1, W - 1)))),
  ]
  /* cfg.eyeNoHair (daeun): her image-left eye is open to the hair on its outer side, so it is not a
   * hole in the face skin, and the egg step above handed its lashes and iris to the HAIR — the open
   * eye would then be baked into front_hair and stay open through every blink. What CHANGES between
   * the open and the closed eye (the eye-change blob, filled, grown 2 px) is not hair; a strand that
   * crosses the box but is the same in both frames stays hair. */
  // true = grow 2 px; a number = grow that many px (0 is valid)
  if (cfg.eyeNoHair != null && cfg.eyeNoHair !== false) {
    for (const [lo, hi] of [[0, mid], [mid + 1, W - 1]]) {
      const own = dilate(fillHoles(eyeHalf(andM(eyeChange, halfMask(lo, hi)))), cfg.eyeNoHair === true ? sr(2) : cfg.eyeNoHair)
      hair = subM(hair, own)
      /* cfg.eyeInEgg (iseul): an eye open to the hair is no hole in the face skin, so the egg left it
       * out and the face had a hole under each eye: through the lid's feather a blink showed back_hair's
       * fill. The eye goes into the egg, where the face inpaints skin under it. Unset = unchanged. */
      if (cfg.eyeInEgg) eggShape = orM(eggShape, andM(own, dilate(alpha, sr(1))))
    }
  }
  /* cfg.eyeHairIslands (iseul, a max area): the whites of her eyes are as pale as her hair, so specks of
   * the open eye's white along the rim of each opening passed the hair test, and on front_hair they
   * stayed over the closed lid in a blink. Hair pieces no larger than this lying inside an eye box
   * (grown 4 px) are the eye's: off the hair, into the egg. Unset = unchanged. */
  if (cfg.eyeHairIslands) {
    const { lab: hl, comps: hc } = labelCC(hair)
    const drop = new Set()
    for (const c of hc) if (c.area <= sa(cfg.eyeHairIslands) && eyeBoxes.some(b => b && c.x0 >= b.x0 - si(4) && c.x1 <= b.x1 + si(4) && c.y0 >= b.y0 - si(4) && c.y1 <= b.y1 + si(4))) drop.add(c.id)
    const isl = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) if (hl[i] >= 0 && drop.has(hl[i])) isl[i] = 1
    hair = subM(hair, isl)
    eggShape = orM(eggShape, isl)
  }

  /* --- mouth --- */
  const diffMouth = new Uint8Array(W * H)
  for (let y = mb.y0 - si(24); y <= mb.y1 + si(24); y++) for (let x = mb.x0 - si(24); x <= mb.x1 + si(24); x++) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue
    const o = idx(x, y) * 4
    const d = Math.abs(F.closed[o] - F.open[o]) + Math.abs(F.closed[o + 1] - F.open[o + 1]) + Math.abs(F.closed[o + 2] - F.open[o + 2]) + Math.abs(F.closed[o + 3] - F.open[o + 3])
    if (d > 24) diffMouth[idx(x, y)] = 1
  }
  /* cfg.mouthLargest (kai): the open frame's mouth patch feather reaches his nose line, which the
   * generator redrew a little, so a second change blob above the mouth lifted the upper-lip line (the
   * half / wide pivot) to the nose. Keep only the largest change blob, the mouth. Unset = unchanged. */
  const mouthChange = cfg.mouthLargest ? largestCC(closeM(diffMouth, sr(2))) : keepCC(closeM(diffMouth, sr(2)), c => c.area > sa(30))
  let mouthBox = bboxOfMask(mouthChange)
  mouthBox = {
    x0: Math.min(mouthBox.x0, mb.x0), y0: Math.min(mouthBox.y0, mb.y0),
    x1: Math.max(mouthBox.x1, mb.x1), y1: Math.max(mouthBox.y1, mb.y1),
  }
  mouthBox.w = mouthBox.x1 - mouthBox.x0 + 1; mouthBox.h = mouthBox.y1 - mouthBox.y0 + 1
  /* Where the mouth layer is fully opaque the face never shows, so inpaint the face there --
   * otherwise the closed-lip dash and the shading crescent beside it stay baked on the face and
   * read as a stray wrinkle once the mouth animates over them. Eroded by 2 so it stops short of
   * the mouth's feather, where the face does still show through. */
  const mouthErase = erode((() => {
    const m = new Uint8Array(W * H)
    for (let y = mouthBox.y0 - si(6); y <= mouthBox.y1 + si(6); y++) for (let x = mouthBox.x0 - si(6); x <= mouthBox.x1 + si(6); x++)
      if (x >= 0 && y >= 0 && x < W && y < H) m[idx(x, y)] = 1
    return m
  })(), sr(2))

  /* --- brows.
   * A brow is a dark stroke 5-14 px tall sitting on skin just above the eye; a bang strand
   * crossing the same band is much longer vertically. So: vertical run length of `dark` <= 16
   * and skin within 14 px straight below. That separates the brow from the bangs it touches
   * (sua's left brow and mother's left brow both run into one). */
  // "ink" = drawn but not skin: the brow's dark outline *and* its lighter body (mother's brows
  // are a dark top edge over a mid-brown body, so a darkness test alone cuts them in half)
  const ink = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) if (alpha[i] && !skinRaw[i] && lab[i * 3] < 72) ink[i] = 1
  const vrun = new Int32Array(W * H)
  for (let x = 0; x < W; x++) {
    let y = 0
    while (y < H) {
      if (!ink[idx(x, y)]) { y++; continue }
      let e = y
      while (e < H && ink[idx(x, e)]) e++
      for (let k = y; k < e; k++) vrun[idx(x, k)] = e - y
      y = e
    }
  }
  const skinBelow = new Uint8Array(W * H)
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
    for (let d = 1; d <= si(18); d++) { const yy = y + d; if (yy >= H) break; if (skinCC[idx(x, yy)]) { skinBelow[idx(x, y)] = 1; break } }
  }
  const browMasks = [], browBoxes = []
  for (const bx of eyeBoxes) {
    const band = new Uint8Array(W * H)
    const yTop = Math.max(0, Math.round(bx.y0 - 1.9 * bx.h - si(16))), yBot = bx.y0 - 1
    for (let y = yTop; y <= yBot; y++) for (let x = bx.x0 - si(16); x <= bx.x1 + si(16); x++) {
      if (x < 0 || x >= W) continue
      const i = idx(x, y)
      if (ink[i] && vrun[i] <= si(18) && skinBelow[i]) band[i] = 1
    }
    const cc = labelCC(closeM(band, sr(1)))
    const ok = cc.comps.filter(c => c.area > sa(40) && c.x1 - c.x0 > bx.w * 0.22)
    let b = new Uint8Array(W * H)
    if (ok.length) {
      const main = ok.reduce((p, q) => q.area > p.area ? q : p)
      const take = new Set(ok.filter(c => Math.abs(c.cy - main.cy) < sp(10)).map(c => c.id))
      for (let i = 0; i < W * H; i++) if (cc.lab[i] >= 0 && take.has(cc.lab[i])) b[i] = 1
      // walk on along the arc under the bangs: dark, still short vertically, still in the band
      const allow = new Uint8Array(W * H)
      for (let y = yTop; y <= yBot; y++) for (let x = bx.x0 - si(18); x <= bx.x1 + si(18); x++) {
        if (x < 0 || x >= W) continue
        const i = idx(x, y)
        if (ink[i] && vrun[i] <= si(24)) allow[i] = 1
      }
      // 10 steps of a radius that scales, so the arc is followed the same distance either way
      for (let k = 0; k < 10; k++) b = andM(dilate(b, sr(1)), allow)
    }
    /* cfg.browBoxes (daeun): the detector cannot follow her brows — the image-right one is a heavy
     * stroke that runs into a bang, the image-left one a thin stroke under a strand — so the brows
     * are the ink inside boxes measured by eye on base.png (they feed only anchors.brows and
     * brow_lines; with browLayer false nothing is cut from them). */
    if (cfg.browBoxes) {
      const bb = cfg.browBoxes[browMasks.length]
      b = new Uint8Array(W * H)
      for (let y = bb[1]; y <= bb[3]; y++) for (let x = bb[0]; x <= bb[2]; x++) if (ink[idx(x, y)]) b[idx(x, y)] = 1
    }
    browMasks.push(b)
    browBoxes.push(bboxOfMask(b))
  }
  if (cfg.browLayer) {
    // a brow drawn on bare skin leaves the hair mask; the part that lies on solid bangs stays hair
    const browOnSkin = subM(orM(browMasks[0], browMasks[1]), maxFilterXY(hairThick, sr(1), sr(1)))
    hair = subM(hair, browOnSkin)
  }

  const skinColour = medianOfMask(closed, andM(skinHead, erode(skinHead, sr(3))))
  const hairColour = medianOfMask(closed, erode(hair, sr(3))) || medianOfMask(closed, hair)

  const g = {
    id, cfg, alpha, lab, skin, skinCC, skinHead, hair, dark, clothes, headEll,
    head, neckY, collarY, hairRootY, faceBox, headSilBox, figBox,
    eyeBoxes, browMasks, browBoxes, mouthBox, mouthChange, eyeChange,
    skinColour, hairColour, skinPalette, isSkinLab, hairThick, faceCore, faceKeep, eggShape, eggCore, mouthErase,
    hairSamples, skinSamples, crownY, earMask, earOwn, skinWide, earOn, earReport,
  }

  if (workDir) await dumpOverlays(id, closed, g, workDir)
  return g
}

async function dumpOverlays(id, closed, g, workDir) {
  const tint = (mask, rgb) => {
    const b = Buffer.alloc(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      const o = i * 4
      const m = mask[i]
      b[o] = m ? Math.round(closed[o] * 0.35 + rgb[0] * 0.65) : Math.round(closed[o] * 0.5 + 128 * 0.5)
      b[o + 1] = m ? Math.round(closed[o + 1] * 0.35 + rgb[1] * 0.65) : Math.round(closed[o + 1] * 0.5 + 128 * 0.5)
      b[o + 2] = m ? Math.round(closed[o + 2] * 0.35 + rgb[2] * 0.65) : Math.round(closed[o + 2] * 0.5 + 128 * 0.5)
      b[o + 3] = 255
    }
    return b
  }
  // one combined overlay: hair magenta, skin cyan, clothes yellow + the geometry drawn on it
  const comb = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    const o = i * 4
    let c = [40, 40, 40]
    if (g.hair[i]) c = [230, 40, 200]
    else if (g.skin[i]) c = [40, 210, 220]
    else if (g.clothes[i]) c = [230, 210, 50]
    else if (g.alpha[i]) c = [150, 150, 150]
    comb[o] = Math.round(closed[o] * 0.4 + c[0] * 0.6)
    comb[o + 1] = Math.round(closed[o + 1] * 0.4 + c[1] * 0.6)
    comb[o + 2] = Math.round(closed[o + 2] * 0.4 + c[2] * 0.6)
    comb[o + 3] = 255
  }
  const put = (x, y, rgb) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = idx(Math.round(x), Math.round(y)) * 4; comb[o] = rgb[0]; comb[o + 1] = rgb[1]; comb[o + 2] = rgb[2] }
  const hline = (y, rgb) => { for (let x = 0; x < W; x++) put(x, y, rgb) }
  const rect = (b, rgb) => { if (!b) return; for (let x = b.x0; x <= b.x1; x++) { put(x, b.y0, rgb); put(x, b.y1, rgb) } for (let y = b.y0; y <= b.y1; y++) { put(b.x0, y, rgb); put(b.x1, y, rgb) } }
  const steps = Math.round(1440 * S)      // enough samples that the ellipse stays a line at any size
  for (let t = 0; t < steps; t++) {
    const a = t * 2 * Math.PI / steps
    put(g.head.cx + g.head.rx * Math.cos(a), g.head.cy + g.head.ry * Math.sin(a), [255, 255, 255])
  }
  hline(g.neckY, [255, 80, 80]); hline(g.hairRootY, [80, 255, 120]); hline(g.collarY, [255, 180, 60])
  rect(g.faceBox, [255, 255, 255])
  for (const b of g.eyeBoxes) rect(b, [0, 0, 255])
  for (const b of g.browBoxes) rect(b, [0, 255, 0])
  rect(g.mouthBox, [255, 0, 0])
  await writePng(comb, W, H, path.join(workDir, 'mask-overlay.png'))
  // a zoomed strip over the brows / eyes so the brow cut can actually be looked at
  {
    const b0 = g.browBoxes[0], b1 = g.browBoxes[1]
    const x0 = Math.max(0, Math.min(g.eyeBoxes[0].x0, b0 ? b0.x0 : 1e9) - si(18))
    const x1 = Math.min(W - 1, Math.max(g.eyeBoxes[1].x1, b1 ? b1.x1 : 0) + si(18))
    const y0 = Math.max(0, Math.min(g.eyeBoxes[0].y0, b0 ? b0.y0 : 1e9) - si(24))
    const y1 = Math.min(H - 1, Math.max(g.eyeBoxes[0].y1, g.eyeBoxes[1].y1) + si(10))
    const w = x1 - x0 + 1, h = y1 - y0 + 1
    const strip = Buffer.alloc(w * h * 4)
    const bm = orM(g.browMasks[0], g.browMasks[1])
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const s = idx(x0 + i, y0 + j), d = (j * w + i) * 4
      const on = bm[s]
      strip[d] = on ? 255 : closed[s * 4]
      strip[d + 1] = on ? 0 : closed[s * 4 + 1]
      strip[d + 2] = on ? 255 : closed[s * 4 + 2]
      strip[d + 3] = 255
    }
    const zoom = Math.max(1, Math.round(3 / S))   // the same apparent magnification at any size
    await sharp(strip, { raw: { width: w, height: h, channels: 4 } })
      .resize(w * zoom, h * zoom, { kernel: 'nearest' }).png().toFile(GUARD(path.join(workDir, 'brows-zoom.png')))
  }
  await writePng(tint(g.hair, [255, 0, 255]), W, H, path.join(workDir, 'mask-hair.png'))
  // who owns each pixel of the head egg: green = kept on the face, magenta = hair, red = neither
  {
    const own = Buffer.alloc(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      const o = i * 4
      let c = [20, 20, 20]
      if (!g.alpha[i]) c = [0, 0, 0]
      else if (g.faceKeep[i] && !g.hair[i]) c = [0, 220, 0]
      else if (g.hair[i]) c = [230, 40, 200]
      else c = [255, 0, 0]
      own[o] = c[0]; own[o + 1] = c[1]; own[o + 2] = c[2]; own[o + 3] = 255
    }
    await writePng(own, W, H, path.join(workDir, 'mask-owner.png'))
  }
  await writePng(tint(g.skin, [0, 255, 255]), W, H, path.join(workDir, 'mask-skin.png'))
}

/* ------------------------------------------------------------------ layer builders */

async function buildLayers(id, F, g, dirs) {
  const { textures } = dirs
  const layers = []
  const notes = []
  const { closed, open, blink } = F
  const head = g.head
  const file = n => path.join(textures, `${n}.webp`)

  const opaque = a => { const p = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) p[i] = a[i] ? 255 : 0; return p }
  const soften = async (mask, sigma, core) => {
    const base = opaque(core || mask)
    const b = await blurPlane(base, W, H, sigma)
    const out = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) out[i] = mask[i] ? Math.max(core && core[i] ? 255 : 0, b[i]) : 0
    return out
  }

  /* [hairClean] (global; cfg.hairClean === false opts out) grey-white specks in the hair. The art draws the hair with a bright
   * rim-light stroke and a few light flecks on lock tips; on the dark scene they pass as shine, on
   * the game's light desk they read as holes. Repaint them, in the three hair layers only, with the
   * hair's own dark tone from the nearest dark hair pixel beside each (not black). */
  const specksOn = g.cfg.hairClean !== false && !STAGE_OFF.has('specks')
  const closedH = specksOn ? paintSpecks(closed, g, notes, false) : closed
  const closedB = specksOn ? paintSpecks(closed, g, notes, true) : closed  // back_hair: also nothing light behind the face
  /* ---------------- 1. back_hair */
  /* [earOwn] a re-owned ear: the face draws it now, and the face's rim is feathered over the hair
   * behind it. back_hair therefore keeps its own copy of that rim (the outermost pixel of the ear,
   * as drawn: a feathered face edge over nothing would be a hole at rest) and gets a dark backing
   * under the rest of the ear, or a turn that slides back_hair off the ear shows the background
   * between them. The backing stops at what the face fully covers (eggCore): any more would show
   * round the ear's rim at rest, which is a fill showing (SPEC 3.2). */
  const earBk = g.earOn && countM(g.earOwn)
  const hairBk = earBk ? orM(g.hair, subM(g.earOwn, g.eggCore)) : g.hair
  let hairFilled = fillHoles(hairBk)
  if (earBk) hairFilled = orM(hairFilled, andM(g.earOwn, g.eggCore))
  /* cfg.backFillNoRim (daeun): her hair + ear ring the whole lower cheek, so the hole fill reaches
   * under the face egg's feathered rim and shows there as a dark arc across the cheek. Keep the
   * filled-in part off that rim, as ell106 below already is. */
  if (g.cfg.backFillNoRim) hairFilled = orM(g.hair, subM(hairFilled, subM(g.eggShape, g.eggCore)))
  // the ellipse fill is a backing for the hair, so keep it inside the figure's own silhouette —
  // outside it there is nothing to back up and it would show as a dark halo past the hair
  const solid = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) solid[i] = closed[i * 4 + 3] >= 250 ? 1 : 0
  const ell106 = subM(andM(ellipseMask(head.cx, head.cy, head.rx * 1.06, head.ry * 1.06), erode(solid, sr(2))),
    subM(g.eggShape, g.eggCore))
  const backMask = orM(hairFilled, ell106)
  const backNeed = subM(backMask, hairBk)
  const synth = { back: backNeed }
  // [earOwn] the nearest-colour backing may only copy hair colour: a skin-toned pixel among its sources
  // carried that tone across a whole forehead block / ear (father 1182 px, sua 715 px)
  const backSrc = g.earOn ? subM(erode(hairBk, sr(1)), g.skinWide) : erode(hairBk, sr(1))
  const backRGBA = nearestFill(closedB, backSrc, backNeed)
  const backAlphaCore = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) backAlphaCore[i] = hairFilled[i] ? (hairBk[i] ? closed[i * 4 + 3] : 255) : 0
  const addedBlur = await blurPlane(opaque(ell106), W, H, sp(3))
  const backAlpha = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) backAlpha[i] = backMask[i] ? Math.min(closed[i * 4 + 3], Math.max(backAlphaCore[i], addedBlur[i])) : 0
  const backHair = latticePad(cutLayer(backRGBA, backAlpha))
  await webp(backHair, file('back_hair'))
  layers.push({ id: 'back_hair', label: LABELS.back_hair, texture: 'textures/back_hair.webp', ...box(backHair), group: 'hair_back', depth: g.cfg.hairTune?.backDepth ?? -0.32 })  // [hairTune]
  notes.push(`back_hair: hair mask, holes filled, head ellipse x1.06 painted behind it with nearest-hair colour (${countM(subM(ell106, hairFilled))} px added), added edge feathered sigma ${r2(sp(3))}`)

  /* ---------------- 2. body */
  // complementary to the face egg, not to the ellipse: where the egg stops short of the ellipse
  // (the collar inside its lower corner) the body has to carry the pixels instead
  const outEll = subM(g.alpha, g.eggShape)
  let bodyMask = subM(outEll, g.hair)
  /* cfg.bodyUnderRim (daeun): the egg's lower rim crosses her neck and jaw shading, and the face
   * fades out over that rim with nothing under it. Below the mouth, the body also carries the rim's
   * own art (not a fill: the drawn pixels, 1-2 px wide), so the rest pose has no gap. */
  if (g.cfg.bodyUnderRim) {
    const rim = subM(subM(g.eggShape, g.eggCore), g.hair)
    for (let i = 0; i < W * H; i++) if (rim[i] && (i / W | 0) >= g.mouthBox.y1) bodyMask[i] = 1
  }
  // Fill the holes the hair left where it lies over the torso. "Over the torso" = inside the
  // torso closed over the hair gaps (radius 24 bridges a 48 px lock); hair hanging free against
  // the background stays a hole, so the body never grows a cloth-coloured flap outside itself.
  /* Radius 24 bridges a 48 px lock, which is enough for a strand over the chest but not for
   * the hair mass lying on the shoulders (70-90 px on sua): the garment under that band was never
   * continued, so the body layer had no art there at all. 50 bridges 100 px. The fill cannot
   * leave the figure — bodyNeed is intersected with outEll, which is inside `alpha`. */
  const bodySolid = closeM(bodyMask, sr(50))
  const bodyNeed = andM(subM(outEll, bodyMask), bodySolid)
  synth.bodyHair = bodyNeed
  let bodyRGBA = nearestFill(closed, erode(bodyMask, sr(1)), bodyNeed)
  const bodyFull = orM(bodyMask, bodyNeed)

  // continue the neck ~40 base px up under the jaw so a tilt never shows a gap
  const neckAdd = new Uint8Array(W * H)
  const neckUp = si(40)
  const nx0 = Math.round(head.cx - 0.62 * head.rx), nx1 = Math.round(head.cx + 0.62 * head.rx)
  let neckCols = 0
  for (let x = Math.max(0, nx0); x <= Math.min(W - 1, nx1); x++) {
    let top = -1
    for (let y = Math.max(0, g.neckY - si(30)); y < Math.min(H, g.neckY + si(80)); y++) if (bodyFull[idx(x, y)] && g.skin[idx(x, y)]) { top = y; break }
    if (top < 0) continue
    neckCols++
    const src = idx(x, Math.min(H - 1, top + si(3))) * 4
    for (let d = 1; d <= neckUp; d++) {
      const y = top - d; if (y < 0) break
      const i = idx(x, y)
      // only into the hole the head ellipse left; never over the collar or anything already drawn
      if (bodyFull[i] || !g.eggShape[i]) break
      const o = i * 4
      bodyRGBA[o] = closed[src]; bodyRGBA[o + 1] = closed[src + 1]; bodyRGBA[o + 2] = closed[src + 2]; bodyRGBA[o + 3] = 255
      neckAdd[i] = 1
    }
  }
  const bodyMaskAll = orM(bodyFull, neckAdd)
  const bodyAlpha = new Uint8Array(W * H)
  // the source's own alpha everywhere it drew something — including over the inpainted hair
  // holes, where the hair was as opaque as the cloth behind it — and solid only for the
  // synthesised neck column, which sits inside the head ellipse and is covered by the face
  for (let i = 0; i < W * H; i++) bodyAlpha[i] = neckAdd[i] ? 255 : (bodyMaskAll[i] ? closed[i * 4 + 3] : 0)
  /* [earOwn] stray specks: a few faint texels of the hair's and the ear's anti-aliased edge fall to the
   * body (father: 10 specks of 1-6 px, alpha 18-81, along his left ear and jaw). The body never moves
   * with the head, so at rest they hide under the face and on a turn they are left behind as a dotted
   * tick line in the background. Anything above the neck that is not part of a piece of 40 px or more
   * (grown 1 px so a diagonal chain counts as one) is not drawing anything the body needs. */
  if (g.earOn) {
    const live = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) live[i] = bodyAlpha[i] > 0 ? 1 : 0
    const { lab: bl, comps: bc } = labelCC(dilate(live, sr(1)))
    const drop = new Uint8Array(bc.length)
    let dropped = 0
    for (const c of bc) if (c.area < sa(40) && c.y1 < g.neckY) drop[c.id] = 1
    for (let i = 0; i < W * H; i++) if (live[i] && bl[i] >= 0 && drop[bl[i]]) { bodyAlpha[i] = 0; dropped++ }
    if (dropped) notes.push(`body: ${dropped} px of stray specks above the neck removed (${drop.reduce((a, v) => a + v, 0)} pieces)`)
  }
  const body = latticePad(cutLayer(bodyRGBA, bodyAlpha))
  await webp(body, file('body'))
  layers.push({ id: 'body', label: LABELS.body, texture: 'textures/body.webp', ...box(body), group: 'body', depth: 0 })
  notes.push(`body: everything outside the face egg that is not hair; ${countM(bodyNeed)} px of hair-over-torso filled with the nearest cloth colour; neck continued ${neckUp} px up over ${neckCols} columns`)

  /* ---------------- 3. neck_shadow (synthesised) */
  const shadowRGBA = Buffer.alloc(W * H * 4)
  const shadowAlpha = new Uint8Array(W * H)
  const sc = g.skinColour
  const shadeRGB = [Math.round(sc[0] * 0.74), Math.round(sc[1] * 0.70), Math.round(sc[2] * 0.70)]
  const neckSkin = new Uint8Array(W * H)
  for (let y = Math.round(g.neckY - si(6)); y < Math.min(H, g.neckY + 0.9 * head.ry); y++)
    for (let x = Math.round(head.cx - 0.8 * head.rx); x <= Math.round(head.cx + 0.8 * head.rx); x++) {
      if (x < 0 || x >= W) continue
      const i = idx(x, y)
      if (g.skin[i] && !g.hair[i]) neckSkin[i] = 1
    }
  const neckSoft = await blurPlane(opaque(neckSkin), W, H, sp(2.5))
  const yTop = g.neckY - 0.05 * head.ry, fall = 0.45 * head.ry
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = idx(x, y)
    if (!neckSoft[i]) continue
    const t = (y - yTop) / fall
    if (t < -0.25 || t > 1) continue
    const v = Math.max(0, 1 - Math.max(0, t))
    const hx = Math.min(1, Math.abs(x - head.cx) / (0.62 * head.rx))
    const a = 0.26 * v * (1 - 0.65 * hx * hx) * (neckSoft[i] / 255)
    if (a <= 0.004) continue
    const o = i * 4
    shadowRGBA[o] = shadeRGB[0]; shadowRGBA[o + 1] = shadeRGB[1]; shadowRGBA[o + 2] = shadeRGB[2]
    shadowAlpha[i] = Math.round(a * 255)
  }
  const neckShadow = cutLayer(shadowRGBA, shadowAlpha)
  await webp(neckShadow, file('neck_shadow'))
  layers.push({ id: 'neck_shadow', label: LABELS.neck_shadow, texture: 'textures/neck_shadow.webp', ...box(neckShadow), group: 'head', depth: 0, role: 'neck_shadow' })
  notes.push(`neck_shadow: synthesised — skin colour x0.72, peak alpha 0.26 at the jaw falling to 0 over ${Math.round(fall)} px, clipped to the neck skin (the art already draws its own jaw shadow, so this one only deepens it)`)

  /* ---------------- 4. face: the skin egg */
  const faceShape = g.eggShape
  const browAll = g.cfg.browLayer ? orM(g.browMasks[0], g.browMasks[1]) : new Uint8Array(W * H)
  /* Keep the drawn face: the skin blob with its eyes / nose / lips filled back in, plus the ink
   * contour around it — 2 px of anything, 4 px of ink — minus whatever the hair mask owns, so the
   * jaw, chin, ear and cheek outlines stay on the face while the hairline outline stays on the
   * hair. Everything else inside the egg is inpainted with skin. */
  /* cfg.browsOnFace (kai): his low brows sit inside the eye patch, and the generated blink frame drew
   * them 2-3 px off, so with browLayer false the lid patch carried that brow (it jumped at every blink)
   * and the open eye squashed the drawn one down with it. The eye, lid and eye-skin patches leave out
   * every row down to each brow box's bottom over the patch's columns (browCut), and the face keeps
   * everything there that is not hair as drawn (brows, strand bits, skin), plus the skin of the 3 rows
   * under the cut where the patches fade in. Unset = unchanged (browFaceKeep empty, browCut null). */
  const browCut = g.cfg.browsOnFace ? (() => {
    const m = new Uint8Array(W * H)
    g.browBoxes.forEach((bb, s) => {
      if (!bb) return
      const eb = g.eyeBoxes[s]
      for (let y = 0; y <= bb.y1; y++) for (let x = Math.max(0, Math.min(bb.x0, eb.x0) - si(14)); x <= Math.min(W - 1, Math.max(bb.x1, eb.x1) + si(14)); x++) m[idx(x, y)] = 1
    })
    return m
  })() : null
  const browFaceKeep = new Uint8Array(W * H)
  if (browCut) {
    const fadeBand = subM(maxFilterXY(browCut, 0, sr(3)), browCut)
    for (let i = 0; i < W * H; i++) {
      if (!faceShape[i] || g.hair[i]) continue
      if (browCut[i] || (fadeBand[i] && g.isSkinLab([g.lab[i * 3], g.lab[i * 3 + 1], g.lab[i * 3 + 2]]))) browFaceKeep[i] = 1
    }
  }
  const faceKeep = orM(subM(subM(g.faceKeep, dilate(browAll, sr(2))), g.mouthErase), browFaceKeep)
  const faceNeed = subM(faceShape, faceKeep)
  synth.face = faceNeed
  const faceSrc = subM(andM(faceShape, g.skin), faceNeed)
  /* cfg.faceFrom = 'closed' (iseul): her eye patch spans the forehead, and the face crop of blink.png
   * showed the generated frame's brow and strand edges at rest between the bangs (a doubled brow). The
   * face is cut from the rest frame instead; the lid layers still carry the closed eyes. Unset = unchanged. */
  let faceRGBA = nearestFill(g.cfg.faceFrom === 'closed' ? closed : blink, erode(faceSrc, sr(1)), faceNeed)
  // soften only what was inpainted
  const blurred = await sharp(Buffer.from(faceRGBA), { raw: { width: W, height: H, channels: 4 } }).blur(sp(3.5)).raw().toBuffer()
  /* [earOwn] a re-owned ear brings its outline ink into the face as drawn pixels, and the soft inpaint
   * (the blur above) would carry that brown 7 px into the skin fill beside it: a gradient band that
   * hair sliding off it uncovers as a faint tan line. Within 12 px of such an ear, blur a copy in
   * which every pixel that is not plain skin is first filled with the nearest skin colour. */
  if (g.earOn && countM(g.earOwn)) {
    const notSkin = subM(faceShape, erode(faceSrc, sr(1)))
    const skinOnly = nearestFill(blink, erode(faceSrc, sr(1)), notSkin)
    const blurredSkin = await sharp(Buffer.from(skinOnly), { raw: { width: W, height: H, channels: 4 } }).blur(sp(3.5)).raw().toBuffer()
    const nearEar = dilate(g.earOwn, sr(12))
    for (let i = 0; i < W * H; i++) if (nearEar[i]) { const o = i * 4; blurred[o] = blurredSkin[o]; blurred[o + 1] = blurredSkin[o + 1]; blurred[o + 2] = blurredSkin[o + 2] }
  }
  const wMask = await blurPlane(opaque(dilate(faceNeed, sr(1))), W, H, sp(1.5))
  for (let i = 0; i < W * H; i++) {
    // never over what we kept: the blur reaches 2 px past the inpaint and would otherwise fade
    // the ink contour at the silhouette into the skin beside it
    if (faceKeep[i]) continue
    const t = wMask[i] / 255
    if (t <= 0) continue
    const o = i * 4
    faceRGBA[o] = Math.round(faceRGBA[o] * (1 - t) + blurred[o] * t)
    faceRGBA[o + 1] = Math.round(faceRGBA[o + 1] * (1 - t) + blurred[o + 1] * t)
    faceRGBA[o + 2] = Math.round(faceRGBA[o + 2] * (1 - t) + blurred[o + 2] * t)
  }
  const faceAlpha = await (async () => {
    /* The egg's edge is feathered so the face fades into whatever abuts it rather than ending on a
     * hard step. That is right where the egg meets the REST OF THE FIGURE — the body carries those
     * pixels underneath, so the feather blends two layers. It is wrong where the egg's edge IS the
     * figure's outline (the bare jaw, and since the ear fix the ear's outer rim): nothing is behind
     * it there, so the feather fades the silhouette itself into the background and leaves a hole.
     * So erode only the boundary shared with the rest of the figure; keep the silhouette solid and
     * let the min() below take the art's own antialiasing, which is the edge the artist drew. */
    /* "the rest of the figure" is what the art draws SOLIDLY outside the egg (the same >=200 test
     * eggCore uses). The silhouette's own antialiased fringe is in `alpha` too, and counting it
     * would erode the very edge this is protecting — the fringe is the outline, not a neighbour. */
    const solid = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) solid[i] = closed[i * 4 + 3] >= 200 ? 1 : 0
    const rest = subM(solid, faceShape)
    const core = subM(faceShape, andM(faceShape, dilate(rest, sr(1))))
    const b = await blurPlane(opaque(core), W, H, sp(1.1))
    const out = new Uint8Array(W * H)
    // never more opaque than the figure itself, so the skin egg cannot spill past the silhouette
    for (let i = 0; i < W * H; i++) out[i] = faceShape[i] ? Math.min(closed[i * 4 + 3], Math.max(core[i] ? 255 : 0, b[i])) : 0
    /* cfg.faceKeepSolid (iseul): the feathered rim also runs through drawn face art (her ear outline,
     * the jaw line under the hair tips) that no other layer carries, so it was drawn at alpha 20-103.
     * The face's own kept art keeps the art's alpha; only the inpainted skin is feathered. Unset = unchanged. */
    if (g.cfg.faceKeepSolid) for (let i = 0; i < W * H; i++) if (faceShape[i] && faceKeep[i]) out[i] = closed[i * 4 + 3]
    /* cfg.faceOffFringe (kai): his hair tips beside the jaw are the figure's outline inside the egg, and
     * the inpainted skin under their antialiased fringe (art alpha < 250) showed through as a light
     * rim on a dark background. Nothing is drawn behind the outline there. Unset = unchanged. */
    if (g.cfg.faceOffFringe) for (let i = 0; i < W * H; i++) if (g.hair[i] && !faceKeep[i] && closed[i * 4 + 3] < 250) out[i] = 0
    return out
  })()
  const face = latticePad(cutLayer(faceRGBA, faceAlpha))
  await webp(face, file('face'))
  layers.push({ id: 'face', label: LABELS.face, texture: 'textures/face.webp', ...box(face), group: 'head', depth: 0 })
  notes.push(`face: head-ellipse crop of blink.png; everything outside the drawn face (${countM(faceNeed)} px of hair, hair edge, background and brow, ${countM(andM(faceShape, g.mouthErase))} of them the lip dash and the crescent under the mouth layer) inpainted with the nearest skin colour and blurred ${r2(sp(3.5))} px over the inpaint only`)

  /* ---------------- 5-12. eyes */
  // An eye patch is a rectangle of the frame, so near the temple it can pick up a bang strand.
  // eye_* squashes onto the lid line when the eye closes, which would squash that hair with it,
  // so fade the patches out over anything that is hair or brow. The hair layers are drawn after
  // the eyes, so nothing is lost.
  const browAllEye = browAll
  const notFace = await blurPlane(opaque(orM(g.hair, dilate(browAllEye, sr(1)))), W, H, sp(1.6))
  // cfg.browsOnFace (kai): a hard cut, not a feather — the face holds the art above it, the patches below
  const faceClip = i => (browCut && browCut[i]) ? 0 : 1 - notFace[i] / 255

  /* cfg.irisOpening (sua2): the eye opening and the iris inside it, found without the whites having to
   * surround the iris. The span detector below takes the opening as the row and column span of the
   * whites, which breaks where an iris is drawn against its lid and the whites stop at its edge — there
   * it cuts that iris in two. Here the iris is found first, as the thickest dark disc in the box (a lash
   * is a thin stroke and loses the thickness test to the disc), and the opening is then the row span of
   * (white u iris) pushed outward while the pixel is not skin, at most 6 px, a drawn lid stroke being
   * 1-4 px. Same measurement as tools/livliv/iris-room.mjs, which reproduces the three shipped gazes.
   * Returns null when no dark disc sits in the box. */
  const openingIris = (white, dark, skin, bx) => {
    const inBox = (x, y) => x >= bx.x0 && x <= bx.x1 && y >= bx.y0 && y <= bx.y1
    const each = fn => { for (let y = bx.y0; y <= bx.y1; y++) for (let x = bx.x0; x <= bx.x1; x++) fn(x, y, idx(x, y)) }
    // the thickest dark pixel: the half-width of the largest all-dark square that fits around it
    let seed = -1, thick = -1
    each((x, y, i) => {
      if (!dark[i]) return
      let r = 0
      for (; r < si(40); r++) {
        let clean = true
        for (let dy = -(r + 1); dy <= r + 1 && clean; dy++) for (let dx = -(r + 1); dx <= r + 1; dx++) { if (!inBox(x + dx, y + dy) || !dark[idx(x + dx, y + dy)]) { clean = false; break } }
        if (!clean) break
      }
      if (r > thick) { thick = r; seed = i }
    })
    if (seed < 0) return null
    const half = Math.max(1, thick >> 1)
    const core = new Uint8Array(W * H)
    each((x, y, i) => {
      if (!dark[i]) return
      for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++) if (!inBox(x + dx, y + dy) || !dark[idx(x + dx, y + dy)]) return
      core[i] = 1
    })
    if (!core[seed]) return null
    let ir = new Uint8Array(W * H)
    const st = [seed]; ir[seed] = 1
    while (st.length) { const i = st.pop(), x = i % W, y = (i / W) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const j = idx(x + dx, y + dy); if (inBox(x + dx, y + dy) && core[j] && !ir[j]) { ir[j] = 1; st.push(j) } } }
    for (let k = 0; k < half + 2; k++) {
      const nxt = Uint8Array.from(ir)
      each((x, y, i) => { if (ir[i] || !dark[i]) return; if ((inBox(x - 1, y) && ir[i - 1]) || (inBox(x + 1, y) && ir[i + 1]) || (inBox(x, y - 1) && ir[idx(x, y - 1)]) || (inBox(x, y + 1) && ir[idx(x, y + 1)])) nxt[i] = 1 })
      ir = nxt
    }
    // the iris is a disc: its catchlight and its rim highlight are inside it, so fill each row
    const I = new Uint8Array(W * H)
    for (let y = bx.y0; y <= bx.y1; y++) { let lo = -1, hi = -1; for (let x = bx.x0; x <= bx.x1; x++) if (ir[idx(x, y)]) { if (lo < 0) lo = x; hi = x } if (lo >= 0) for (let x = lo; x <= hi; x++) I[idx(x, y)] = 1 }
    const open = new Uint8Array(W * H)
    for (let y = bx.y0; y <= bx.y1; y++) {
      let lo = 1e9, hi = -1
      for (let x = bx.x0; x <= bx.x1; x++) { const i = idx(x, y); if (white[i] || I[i]) { lo = Math.min(lo, x); hi = Math.max(hi, x) } }
      if (hi < 0) continue
      for (let x = lo; x <= hi; x++) open[idx(x, y)] = 1
      for (let x = lo - 1, k = 0; x >= bx.x0 && !skin[idx(x, y)] && k < si(6); x--, k++) open[idx(x, y)] = 1
      for (let x = hi + 1, k = 0; x <= bx.x1 && !skin[idx(x, y)] && k < si(6); x++, k++) open[idx(x, y)] = 1
    }
    return { opening: fillHoles(largestCC(open)), iris: I }
  }

  const eyeInfo = []
  let synthEyeSkin = null
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? 'L' : 'R'
    const tb = g.eyeBoxes[s]
    const M = si(12)
    const bx = { x0: Math.max(1, tb.x0 - M), y0: Math.max(1, tb.y0 - M), x1: Math.min(W - 2, tb.x1 + M), y1: Math.min(H - 2, tb.y1 + M) }
    const boxMask = new Uint8Array(W * H)
    for (let y = bx.y0; y <= bx.y1; y++) for (let x = bx.x0; x <= bx.x1; x++) boxMask[idx(x, y)] = 1
    const coreMask = new Uint8Array(W * H)
    for (let y = tb.y0 - si(4); y <= tb.y1 + si(4); y++) for (let x = tb.x0 - si(4); x <= tb.x1 + si(4); x++) { if (x >= 0 && y >= 0 && x < W && y < H) coreMask[idx(x, y)] = 1 }
    const patchAlpha = await soften(boxMask, sp(4), coreMask)
    for (let i = 0; i < W * H; i++) if (patchAlpha[i]) patchAlpha[i] = Math.round(Math.min(patchAlpha[i], blink[i * 4 + 3]) * faceClip(i))

    // lid
    const lid = cutLayer(blink, patchAlpha, { box: bx })
    await webp(lid, file(`eye_${side}_closed`))

    // open eye
    const openAlpha = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) openAlpha[i] = Math.round(Math.min(patchAlpha[i], closed[i * 4 + 3]) * (patchAlpha[i] ? 1 : 0))

    // sclera + iris inside the tight box
    const white = new Uint8Array(W * H), darkE = new Uint8Array(W * H)
    // cfg.irisOpening only: the third class openingIris needs, the lid line's skin side
    const skinE = new Uint8Array(W * H)
    for (let y = tb.y0 - si(3); y <= tb.y1 + si(3); y++) for (let x = tb.x0 - si(3); x <= tb.x1 + si(3); x++) {
      if (x < 1 || y < 1 || x >= W || y >= H) continue
      const i = idx(x, y), o = i * 4
      if (closed[o + 3] < 200) continue
      const L = g.lab[i * 3], a = g.lab[i * 3 + 1], b2 = g.lab[i * 3 + 2]
      const chroma = Math.sqrt(a * a + b2 * b2)
      if (L > 82 && chroma < 16) white[i] = 1
      if (L < 52) darkE[i] = 1
      if (L > 60 && chroma >= 16) skinE[i] = 1
    }
    const whiteCCs = labelCC(white)
    const bigWhite = whiteCCs.comps.filter(c => c.area > sa(25)).sort((p, q) => q.area - p.area)
    let scleraMask = null, irisMask = null, irisOK = false, why = ''
    if (g.cfg.irisOpening) {
      const found = openingIris(white, darkE, skinE, {
        x0: Math.max(1, tb.x0 - si(3)), y0: Math.max(1, tb.y0 - si(3)),
        x1: Math.min(W - 1, tb.x1 + si(3)), y1: Math.min(H - 1, tb.y1 + si(3)),
      })
      if (!found) why = 'no dark disc in the eye box'
      else {
        scleraMask = found.opening
        /* The DRAWN iris is the disc plus the ink that outlines it and the catchlight inside it. The
         * disc alone is what travels, so the outline and the highlight stay behind in eye_* and show
         * the moment the gaze moves (measured on the first cut: 74 / 93 px of the old iris still
         * sitting in the whites). Take the dark that touches the disc — bounded to 2 px, because the
         * disc meets the lash at the top and an unbounded grow would run away along it — then the
         * catchlight, which is how the span path below builds its iris for the other characters. */
        const allowI = andM(darkE, andM(dilate(found.iris, sr(2)), scleraMask))
        let ir = andM(found.iris, scleraMask)
        for (let k = 0; k < 2; k++) ir = orM(ir, andM(dilate(ir, sr(1)), allowI))
        ir = fillHoles(closeM(ir, sr(2)))
        const irBox = bboxOfMask(ir)
        if (irBox) for (const c of whiteCCs.comps) {
          if (bigWhite.length && c.area > bigWhite[0].area * 0.3) continue
          if (c.x0 >= irBox.x0 - si(2) && c.x1 <= irBox.x1 + si(2) && c.y0 >= irBox.y0 - si(2) && c.y1 <= irBox.y1 + si(2)) {
            for (let i = 0; i < W * H; i++) if (whiteCCs.lab[i] === c.id) ir[i] = 1
          }
        }
        ir = fillHoles(closeM(ir, sr(2)))
        const m = andM(ir, scleraMask)
        const frac = countM(m) / countM(scleraMask)
        if (frac > 0.04 && frac < 0.72) { irisMask = m; irisOK = true }
        else why = `iris disc is ${(frac * 100).toFixed(0)}% of the opening`
      }
    } else if (!bigWhite.length) {
      why = 'no sclera found'
    } else {
      const wkeep = new Uint8Array(W * H)
      const ids = new Set(bigWhite.map(c => c.id))
      for (let i = 0; i < W * H; i++) if (whiteCCs.lab[i] >= 0 && ids.has(whiteCCs.lab[i])) wkeep[i] = 1
      // eye opening = the row/column span of the whites (covers the iris between them)
      const span = new Uint8Array(W * H)
      for (let y = 0; y < H; y++) { let lo = -1, hi = -1; for (let x = 0; x < W; x++) if (wkeep[idx(x, y)]) { if (lo < 0) lo = x; hi = x } if (lo >= 0) for (let x = lo; x <= hi; x++) span[idx(x, y)] = 1 }
      for (let x = 0; x < W; x++) { let lo = -1, hi = -1; for (let y = 0; y < H; y++) if (wkeep[idx(x, y)]) { if (lo < 0) lo = y; hi = y } if (lo >= 0) for (let y = lo; y <= hi; y++) span[idx(x, y)] = 1 }
      scleraMask = closeM(largestCC(span), sr(2))
      const inner = erode(scleraMask, sr(2))
      const cand = keepCC(andM(darkE, inner), c => c.area > sa(20))
      const ccs = labelCC(cand).comps.sort((p, q) => q.area - p.area)
      const scArea = countM(scleraMask)
      if (ccs.length) {
        const best = ccs[0]
        const frac = best.area / scArea
        if (frac > 0.04 && frac < 0.72) {
          const lbl = labelCC(cand)
          const m = new Uint8Array(W * H)
          for (let i = 0; i < W * H; i++) m[i] = lbl.lab[i] === best.id ? 1 : 0
          let ir = fillHoles(closeM(m, sr(2)))
          // the blob was found inside the sclera eroded by 2, but the iris usually runs under the
          // lash line; walk it back out over the dark that is still inside the sclera
          const allowI = andM(darkE, scleraMask)
          for (let k = 0; k < 6; k++) ir = orM(ir, andM(dilate(ir, sr(1)), allowI))
          ir = fillHoles(closeM(ir, sr(2)))
          // the highlight: a small white blob sitting inside the iris
          const irBox = bboxOfMask(ir)
          for (const c of whiteCCs.comps) {
            if (c.area > bigWhite[0].area * 0.3) continue
            if (c.x0 >= irBox.x0 - si(2) && c.x1 <= irBox.x1 + si(2) && c.y0 >= irBox.y0 - si(2) && c.y1 <= irBox.y1 + si(2)) {
              for (let i = 0; i < W * H; i++) if (whiteCCs.lab[i] === c.id) ir[i] = 1
            }
          }
          ir = fillHoles(closeM(ir, sr(2)))
          irisMask = andM(ir, scleraMask)
          irisOK = true
        } else why = `iris blob is ${(frac * 100).toFixed(0)}% of the sclera`
      } else why = 'no dark blob inside the sclera'
    }
    // cfg.noIris (daeun): a reason string; both irises are dropped together so gaze is never one-eyed
    if (g.cfg.noIris && irisOK) { irisOK = false; why = g.cfg.noIris }
    if (!scleraMask) scleraMask = new Uint8Array(W * H)

    const scBox = bboxOfMask(scleraMask) || { x0: tb.x0, y0: tb.y0, x1: tb.x1, y1: tb.y1, w: tb.w, h: tb.h }
    let pcx = 0, pcy = 0, pn = 0
    for (let i = 0; i < W * H; i++) if (scleraMask[i]) { pcx += i % W; pcy += (i / W | 0); pn++ }
    const pivot = pn ? [r2(pcx / pn), r2(pcy / pn)] : [r2((tb.x0 + tb.x1) / 2), r2((tb.y0 + tb.y1) / 2)]

    // eye_* = the open eye with the iris painted out in the sclera's own white
    const eyeRGBA = Buffer.from(closed)
    if (irisOK) {
      /* cfg.irisOpening: the opening holds the lid's OWN ink, which the whites' span never did, so the
       * paint below — and the 1.2 px blur that softens its edge, which reaches 2-3 px further — would
       * land on the lash. The iris layer's edge is a soft alpha ramp, so that fresh paint shows through
       * it as a pale arc the drawing has not got (measured on sua2 before this: dE up to 68 over 38 px
       * under the image-right lash). Keep both off the lid: anything dark inside the opening that is
       * not the iris, plus one pixel of its antialiased foot. The iris itself is always painted, so it
       * still vanishes from eye_* when it travels. The blur goes with the lid rule — its only job is
       * the painted disc's edge, which under this rule only ever meets the whites, where it is
       * invisible. Unset (every other character): the whites' span, exactly as before. */
      const lidInk = g.cfg.irisOpening ? dilate(andM(darkE, subM(scleraMask, irisMask)), sr(1)) : null
      const canPaint = lidInk ? orM(irisMask, subM(scleraMask, lidInk)) : scleraMask
      const wCol = medianOfMask(closed, subM(canPaint, dilate(irisMask, sr(3)))) || [250, 250, 250]
      const paintOut = andM(dilate(irisMask, sr(1)), canPaint)
      if (lidInk) {
        /* cfg.irisOpening: one flat white over the footprint reads as a patch, because the drawn
         * sclera is not flat — it darkens under the lid. Take the colour from the nearest sclera
         * instead and smooth the result, so what the travelling iris uncovers carries the whites'
         * own shading. (Measured flat: the footprint sits 16 L above the sclera around it.) */
        const scleraSrc = subM(andM(canPaint, white), dilate(irisMask, sr(1)))
        const fill = nearestFill(closed, scleraSrc, paintOut)
        for (let i = 0; i < W * H; i++) if (paintOut[i]) { const o = i * 4; eyeRGBA[o] = fill[o]; eyeRGBA[o + 1] = fill[o + 1]; eyeRGBA[o + 2] = fill[o + 2]; eyeRGBA[o + 3] = 255 }
        const sm = await sharp(Buffer.from(eyeRGBA), { raw: { width: W, height: H, channels: 4 } }).blur(sp(2.5)).raw().toBuffer()
        const inner = erode(paintOut, sr(2))
        for (let i = 0; i < W * H; i++) if (inner[i]) { const o = i * 4; eyeRGBA[o] = sm[o]; eyeRGBA[o + 1] = sm[o + 1]; eyeRGBA[o + 2] = sm[o + 2] }
      } else for (let i = 0; i < W * H; i++) if (paintOut[i]) { const o = i * 4; eyeRGBA[o] = wCol[0]; eyeRGBA[o + 1] = wCol[1]; eyeRGBA[o + 2] = wCol[2]; eyeRGBA[o + 3] = 255 }
      if (!lidInk) {
        const sm = await sharp(Buffer.from(eyeRGBA), { raw: { width: W, height: H, channels: 4 } }).blur(sp(1.2)).raw().toBuffer()
        const edge = subM(dilate(paintOut, sr(1)), erode(paintOut, sr(1)))
        for (let i = 0; i < W * H; i++) if (edge[i]) { const o = i * 4; eyeRGBA[o] = sm[o]; eyeRGBA[o + 1] = sm[o + 1]; eyeRGBA[o + 2] = sm[o + 2] }
      }
    }
    const eye = cutAt(eyeRGBA, openAlpha, lid)
    await webp(eye, file(`eye_${side}`))

    // eye_*_mask = the sclera shape, white on transparent, lossless, same box
    const maskRGBA = Buffer.alloc(W * H * 4)
    const maskAlpha = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) if (scleraMask[i]) { const o = i * 4; maskRGBA[o] = 255; maskRGBA[o + 1] = 255; maskRGBA[o + 2] = 255; maskAlpha[i] = 255 }
    const eyeMask = cutAt(maskRGBA, maskAlpha, lid)
    if (irisOK) await webp(eyeMask, file(`eye_${side}_mask`))

    // eye_*_skin = plain skin over the drawn closed eye
    // cfg.eyeSkin (daeun): a tighter skin patch, so less of it shows through the eye patch's
    // feather at rest; defaults are the original 7 / 2 / 3
    const ES = g.cfg.eyeSkin || { pad: 7, core: 2, sigma: 3 }
    const skinBoxMask = new Uint8Array(W * H)
    for (let y = tb.y0 - si(ES.pad); y <= tb.y1 + si(ES.pad); y++) for (let x = tb.x0 - si(ES.pad); x <= tb.x1 + si(ES.pad); x++) { if (x >= 1 && y >= 1 && x < W - 1 && y < H - 1) skinBoxMask[idx(x, y)] = 1 }
    const skinCore = new Uint8Array(W * H)
    for (let y = tb.y0 - si(ES.core); y <= tb.y1 + si(ES.core); y++) for (let x = tb.x0 - si(ES.core); x <= tb.x1 + si(ES.core); x++) { if (x >= 0 && y >= 0 && x < W && y < H) skinCore[idx(x, y)] = 1 }
    // what is skin in blink.png (which has the closed eye drawn) inside this box
    const skinBlink = new Uint8Array(W * H)
    for (let y = bx.y0 - si(4); y <= bx.y1 + si(4); y++) for (let x = bx.x0 - si(4); x <= bx.x1 + si(4); x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      const i = idx(x, y), o = i * 4
      if (blink[o + 3] < 200) continue
      if (g.isSkinLab(rgb2lab(blink[o], blink[o + 1], blink[o + 2]))) skinBlink[i] = 1
    }
    const needInBox = subM(skinBoxMask, erode(skinBlink, sr(1)))
    const skinSrc = subM(andM(skinBoxMask, skinBlink), needInBox)
    const skinFill = nearestFill(blink, skinSrc, needInBox)
    synthEyeSkin = synthEyeSkin ? orM(synthEyeSkin, needInBox) : needInBox
    const skinA = await soften(skinBoxMask, sp(ES.sigma), skinCore)
    for (let i = 0; i < W * H; i++) if (skinA[i]) skinA[i] = Math.round(skinA[i] * faceClip(i))
    const eyeSkin = cutLayer(skinFill, skinA)
    await webp(eyeSkin, file(`eye_${side}_skin`))

    eyeInfo.push({ side, tb, bx, lid, eye, eyeMask, eyeSkin, pivot, scBox, irisOK, why, irisMask, scleraMask })
  }

  /* How far an iris may travel before the whites cut it. The player scales each iris by its own
   * range, so if the two differ the eyes diverge at full gaze — measure both, then give both the
   * tighter one.
   *
   * This is measured on the masks at the canvas's own resolution, not measured at 768 and scaled:
   * the sclera and the iris are re-found from the new art, and the walk answers in canvas pixels,
   * which is what `range` is in. The 0.5 px probe step and the 6-point clipping tolerance are
   * deliberately absolute — the step is measurement granularity (and `cutFrac` rounds the shift to
   * whole pixels anyway) and the tolerance is a fraction of the iris, not a length. */
  const measureRange = e => {
    const ib = bboxOfMask(e.irisMask)
    const pts = []
    for (let i = 0; i < W * H; i++) if (e.irisMask[i]) pts.push([i % W, (i / W) | 0])
    const cutFrac = (dx, dy) => {
      let out = 0
      for (const [x, y] of pts) {
        const nx = Math.round(x + dx), ny = Math.round(y + dy)
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || !e.scleraMask[idx(nx, ny)]) out++
      }
      return out / pts.length
    }
    const atRest = cutFrac(0, 0)
    const walk = (ax, cap) => {
      let best = 0.5
      for (let r = 0.5; r <= cap; r += 0.5) {
        const f = Math.max(cutFrac(ax ? r : 0, ax ? 0 : r), cutFrac(ax ? -r : 0, ax ? 0 : -r))
        if (f > atRest + 0.06) break
        best = r
      }
      return best
    }
    const cap = g.cfg.rangeCap || [0.22, 0.16]
    /* cfg.irisRangeTemporal (sua2): the symmetric walk above is the right answer only while both
     * directions are clips. Toward the nose the player does not clip (puppet.ts ~1396, irisNasal):
     * it parks the iris's inner edge where its eye's whites end, lets the far edge travel on — the
     * iris narrows as a turning eyeball does — and only once it is down to irisNasalNarrow (0.70)
     * of its width does it stop whole, which is what makes the two eyes diverge. So the walk is
     * one-sided OUTWARD, and the nose side enters only as that stop: `room` and `w` below are
     * puppet.ts's own nasalRoom() measurement, read off the two masks this build ships, and the
     * walk is held a quarter of the iris's width inside the stop (NASAL_KEEP) so full travel
     * narrows the iris without ever reaching it. */
    if (g.cfg.irisRangeTemporal) {
      const NASAL_KEEP = 0.25            // of the iris's width; the player's own floor is 0.30
      const mid = g.eyeBoxes.reduce((t, b) => t + (b.x0 + b.x1) / 2, 0) / g.eyeBoxes.length
      const sign = mid > (ib.x0 + ib.x1) / 2 ? 1 : -1
      // nasalRoom(): over the iris rows at least 90 % as wide as its widest, the median room past
      // its inner edge and the median width there
      const rows = []
      for (let y = ib.y0; y <= ib.y1; y++) {
        let n = 0, lo = Infinity, hi = -Infinity
        for (let x = ib.x0; x <= ib.x1; x++) { const i = idx(x, y); if (!e.irisMask[i] || !e.scleraMask[i]) continue; n++; lo = Math.min(lo, x); hi = Math.max(hi, x) }
        if (n) rows.push([y, n, sign > 0 ? hi : lo, sign > 0 ? lo : hi])
      }
      const top = Math.max(...rows.map(r => r[1]))
      const room = [], width = []
      for (const [y, n, near, far] of rows) {
        if (n < 0.9 * top) continue
        let k = 0
        while (e.scleraMask[idx(near + sign * (k + 1), y)]) k++
        room.push(k); width.push(Math.abs(near - far) + 1)
      }
      const med = v => v.sort((p, q) => p - q)[v.length >> 1]
      const nasal = { sign, room: med(room), w: med(width) }
      const out = (() => {
        let best = 0.5
        for (let r = 0.5; r <= e.scBox.w * cap[0]; r += 0.5) { if (cutFrac(-sign * r, 0) > atRest + 0.06) break; best = r }
        return best
      })()
      const stop = Math.floor((nasal.room + NASAL_KEEP * nasal.w) * 2) / 2
      return { ib, atRest, cutFrac, nasal, want: [Math.min(out, stop), walk(0, e.scBox.h * cap[1])] }
    }
    return { ib, atRest, cutFrac, want: [walk(1, e.scBox.w * cap[0]), walk(0, e.scBox.h * cap[1])] }
  }
  for (const e of eyeInfo) if (e.irisOK) e.rm = measureRange(e)
  const withIris = eyeInfo.filter(e => e.irisOK)
  const common = withIris.length
    ? [r2(Math.min(...withIris.map(e => e.rm.want[0]))), r2(Math.min(...withIris.map(e => e.rm.want[1])))]
    : [1, 1]

  for (const e of eyeInfo) {
    const s = e.side
    layers.push({ id: `eye_${s}_skin`, label: LABELS[`eye_${s}_skin`], texture: `textures/eye_${s}_skin.webp`, ...box(e.eyeSkin), group: 'head', depth: 0 })
    layers.push({ id: `eye_${s}_closed`, label: LABELS[`eye_${s}_closed`], texture: `textures/eye_${s}_closed.webp`, ...box(e.lid), group: 'head', depth: 0, role: `lid_${s}` })
    const eyeLayer = { id: `eye_${s}`, label: LABELS[`eye_${s}`], texture: `textures/eye_${s}.webp`, ...box(e.eye), group: 'head', depth: 0, role: `eye_${s}`, pivot: e.pivot }
    if (e.irisOK) eyeLayer.mask = `textures/eye_${s}_mask.webp`
    layers.push(eyeLayer)
    if (e.irisOK) {
      const irisAlphaRaw = new Uint8Array(W * H)
      for (let i = 0; i < W * H; i++) irisAlphaRaw[i] = e.irisMask[i] ? 255 : 0
      const soft = await blurPlane(irisAlphaRaw, W, H, sp(0.6))
      const irisDil = dilate(e.irisMask, sr(1))
      const irisAlpha = new Uint8Array(W * H)
      for (let i = 0; i < W * H; i++) irisAlpha[i] = e.irisMask[i] ? 255 : (irisDil[i] ? soft[i] : 0)
      const iris = cutLayer(closed, irisAlpha)
      await webp(iris, file(`iris_${s}`))
      const { ib, atRest, cutFrac } = e.rm
      const range = common
      layers.push({
        id: `iris_${s}`, label: LABELS[`iris_${s}`], texture: `textures/iris_${s}.webp`, ...box(iris),
        group: 'head', depth: 0, role: `iris_${s}`, pivot: e.pivot, clip: `eye_${s}`, range,
      })
      notes.push(`iris_${s}: ${countM(e.irisMask)} px ${ib.w}x${ib.h} inside a ${e.scBox.w}x${e.scBox.h} sclera; it could take [${r2(e.rm.want[0])}, ${r2(e.rm.want[1])}] px, both eyes get [${range[0]}, ${range[1]}] (the whites cut ${(atRest * 100).toFixed(0)}% of it at rest, ${(Math.max(cutFrac(range[0], range[1]), cutFrac(-range[0], -range[1])) * 100).toFixed(0)}% at full travel); the catchlight is baked into the iris so it travels with it`)
      // cfg.irisRangeTemporal: the two numbers that limit, which the symmetric figure above hides
      if (e.rm.nasal) {
        const n = e.rm.nasal
        notes.push(`iris_${s}: outward it is cut ${(cutFrac(-n.sign * range[0], 0) * 100).toFixed(1)}% at full travel (${(cutFrac(-n.sign * range[0], -range[1]) * 100).toFixed(1)}% with the up-and-out corner); toward the nose the player (irisNasal) parks it ${n.room} px in and narrows it to ${(100 - 100 * Math.max(0, Math.min(range[0] - n.room, 0.3 * n.w)) / n.w).toFixed(0)}% of its ${n.w} px width, floor 70%`)
      }
    } else {
      notes.push(`iris_${s}: DROPPED — ${e.why}; eye_${s} keeps the whole open eye and gets no mask, so gaze is lost on this side`)
    }
  }

  /* ---------------- 13. mouth */
  const mb = g.mouthBox
  const MM = si(16)
  const mBox = { x0: Math.max(1, mb.x0 - MM), y0: Math.max(1, mb.y0 - MM), x1: Math.min(W - 2, mb.x1 + MM), y1: Math.min(H - 2, mb.y1 + MM) }
  const mBoxMask = new Uint8Array(W * H)
  for (let y = mBox.y0; y <= mBox.y1; y++) for (let x = mBox.x0; x <= mBox.x1; x++) mBoxMask[idx(x, y)] = 1
  const mCore = new Uint8Array(W * H)
  for (let y = mb.y0 - si(6); y <= mb.y1 + si(6); y++) for (let x = mb.x0 - si(6); x <= mb.x1 + si(6); x++) { if (x >= 0 && y >= 0 && x < W && y < H) mCore[idx(x, y)] = 1 }
  let mouthAlpha = await soften(mBoxMask, sp(4), mCore)
  for (let i = 0; i < W * H; i++) mouthAlpha[i] = Math.round(Math.min(mouthAlpha[i], closed[i * 4 + 3]) * faceClip(i))

  const chBox = bboxOfMask(g.mouthChange)
  const upperLipY = chBox.y0
  let mcx = 0, mcy = 0, mn = 0
  for (let i = 0; i < W * H; i++) if (g.mouthChange[i]) { mcx += i % W; mcy += (i / W | 0); mn++ }
  mcx /= mn; mcy /= mn
  const changeSoft = await blurPlane(opaque(dilate(g.mouthChange, sr(1))), W, H, sp(1.0))

  const sampleOpen = (x, y) => {
    const xi = Math.max(0, Math.min(W - 1.001, x)), yi = Math.max(0, Math.min(H - 1.001, y))
    const x0 = Math.floor(xi), y0 = Math.floor(yi), fx = xi - x0, fy = yi - y0
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1)
    const out = [0, 0, 0, 0]
    const g00 = idx(x0, y0), g10 = idx(x1, y0), g01 = idx(x0, y1), g11 = idx(x1, y1)
    for (let c = 0; c < 4; c++) {
      const v = open[g00 * 4 + c] * (1 - fx) * (1 - fy) + open[g10 * 4 + c] * fx * (1 - fy) +
                open[g01 * 4 + c] * (1 - fx) * fy + open[g11 * 4 + c] * fx * fy
      out[c] = v
    }
    const m = changeSoft[g00] * (1 - fx) * (1 - fy) + changeSoft[g10] * fx * (1 - fy) +
              changeSoft[g01] * (1 - fx) * fy + changeSoft[g11] * fx * fy
    return { rgb: out, m: m / 255 }
  }
  /* cfg.mouthClean (sua2): her closed smile is a long thin line, wider than the round and half
   * mouths, so compositing those over the closed frame left the smile's two ends standing beside
   * them. Composite f1/f3/f4 over the closed frame with the lip line (the mouth-change region, grown
   * 1 px) filled with the nearest skin instead. f0 and f2 are untouched. Unset = unchanged. */
  let warpBase = closed
  if (g.cfg.mouthClean) {
    const need = andM(dilate(g.mouthChange, sr(1)), mBoxMask)
    const src = andM(subM(mBoxMask, dilate(g.mouthChange, sr(2))), g.skin)
    warpBase = nearestFill(closed, src, need)
  }
  const warpMouth = (sx, sy, ox, oy) => {
    const out = Buffer.from(warpBase)
    for (let y = mBox.y0; y <= mBox.y1; y++) for (let x = mBox.x0; x <= mBox.x1; x++) {
      const u = ox + (x - ox) / sx, v = oy + (y - oy) / sy
      const { rgb, m } = sampleOpen(u, v)
      if (m <= 0.003) continue
      const o = idx(x, y) * 4
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(out[o + c] * (1 - m) + rgb[c] * m)
      out[o + 3] = Math.max(out[o + 3], Math.round(rgb[3] * m + out[o + 3] * (1 - m)))
    }
    return out
  }
  const frames = [
    { n: 'mouth_f0', v: 'closed', buf: closed },
    { n: 'mouth_f1', v: 'half', buf: warpMouth(1.0, 0.45, mcx, upperLipY) },
    { n: 'mouth_f2', v: 'open', buf: open },
    { n: 'mouth_f3', v: 'round', buf: warpMouth(0.62, 0.95, mcx, mcy) },
    { n: 'mouth_f4', v: 'wide', buf: warpMouth(1.12, 0.62, mcx, upperLipY) },
  ]
  let mouthCut = null
  for (const f of frames) {
    const c = cutLayer(f.buf, mouthAlpha, { box: mBox })
    if (!mouthCut) mouthCut = c
    await webp({ ...c, x: mouthCut.x, y: mouthCut.y, w: mouthCut.w, h: mouthCut.h }, file(f.n))
  }
  await webp(cutAt(closed, mouthAlpha, mouthCut), file('mouth'))
  layers.push({
    id: 'mouth', label: LABELS.mouth, texture: 'textures/mouth.webp',
    frames: frames.map(f => `textures/${f.n}.webp`), visemes: frames.map(f => f.v),
    ...box(mouthCut), group: 'head', depth: 0, role: 'mouth', pivot: [r2(mcx), upperLipY],
  })
  notes.push(`mouth: box ${mouthCut.w}x${mouthCut.h}; f0=closed.png, f2=open.png, f1/f3/f4 are the open-mouth change region warped about (${r2(mcx)}, ${upperLipY}) by (1,0.45)/(0.62,0.95 about cy ${r2(mcy)})/(1.12,0.62) and composited back over the closed frame's skin`)

  /* ---------------- 14. side_hair */
  // everything from the cheeks down: the locks beside the face and every lock that falls in
  // front of the body. back_hair has the same pixels but is drawn under body, so without this
  // the front locks would be hidden by the torso.
  const sideBand = new Uint8Array(W * H)
  const sy0 = Math.round(head.cy + 0.45 * head.ry), sy1 = H - 1
  for (let y = Math.max(0, sy0); y <= sy1; y++) for (let x = 0; x < W; x++) if (g.hair[idx(x, y)]) sideBand[idx(x, y)] = 1
  // cfg.hairMinArea (iseul): the smallest piece side_hair / front_hair keep (default 150 / 80). Her
  // fine lower tips fall apart into smaller pieces at these cuts and were then drawn by back_hair
  // alone — under the body's hair-over-torso fill, which showed as teal tips at rest. Unset = unchanged.
  const sideKept = keepCC(sideBand, c => c.area > sa(g.cfg.hairMinArea ?? 150))
  let sideLayer = null
  if (countM(sideKept) > sa(400)) {
    const sideAlpha = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) sideAlpha[i] = sideKept[i] ? closed[i * 4 + 3] : 0
    sideLayer = latticePad(cutLayer(closedH, sideAlpha))
    await webp(sideLayer, file('side_hair'))
    layers.push({ id: 'side_hair', label: LABELS.side_hair, texture: 'textures/side_hair.webp', ...box(sideLayer), group: 'hair_side', depth: 0.10 })
    notes.push(`side_hair: hair between y ${sy0} and ${sy1} (cy+0.45ry .. neck_y+0.08ry), ${countM(sideKept)} px`)
  } else {
    notes.push(`side_hair: OMITTED — only ${countM(sideKept)} hair px beside the cheeks/shoulders`)
  }

  /* ---------------- 15. front_hair */
  let frontMask = andM(g.hair, ellipseMask(head.cx, head.cy, head.rx * 1.08, head.ry * 1.08))
  if (g.cfg.frontHairAbove !== undefined) {
    for (let y = 0; y <= Math.min(H - 1, g.cfg.frontHairAbove); y++) {
      for (let x = 0; x < W; x++) if (g.hair[idx(x, y)]) frontMask[idx(x, y)] = 1
    }
  }
  if (g.cfg.earBox) frontMask = orM(frontMask, g.earMask)
  const frontKept = keepCC(frontMask, c => c.area > sa(g.cfg.hairMinArea ?? 80))
  const frontAlpha = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) frontAlpha[i] = frontKept[i] ? closed[i * 4 + 3] : 0
  const frontLayer = latticePad(cutLayer(closedH, frontAlpha))
  await webp(frontLayer, file('front_hair'))
  layers.push({ id: 'front_hair', label: LABELS.front_hair, texture: 'textures/front_hair.webp', ...box(frontLayer), group: 'hair_front', depth: 0.07 })
  notes.push(`front_hair: hair inside the head ellipse x1.08 (bangs + crown), ${countM(frontKept)} px`)

  /* ---------------- 16. brows */
  let browsLayer = null
  const browPx = countM(browAll)
  if (g.cfg.browLayer && browPx > sa(150)) {
    // the strip has to redraw everything the face inpainted, which is the brow dilated by 2 —
    // one pixel short and a pale notch shows wherever the brow runs into a bang strand
    const bcore = dilate(browAll, sr(2))
    const bwin = dilate(browAll, sr(4))
    const browAlphaRaw = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) browAlphaRaw[i] = bcore[i] ? 255 : 0
    const bsoft = await blurPlane(browAlphaRaw, W, H, sp(1.3))
    const browAlpha = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) browAlpha[i] = bwin[i] ? Math.min(closed[i * 4 + 3], Math.max(bcore[i] ? 255 : 0, bsoft[i])) : 0
    browsLayer = cutLayer(closed, browAlpha)
    await webp(browsLayer, file('brows'))
    layers.push({ id: 'brows', label: LABELS.brows, texture: 'textures/brows.webp', ...box(browsLayer), group: 'head', depth: 0 })
    notes.push(`brows: both brow arcs in one strip, ${browPx} px, cut from closed.png and inpainted out of face`)
  } else {
    notes.push(g.cfg.browLayer
      ? `brows: OMITTED — only ${browPx} px of visible brow found`
      : `brows: no layer by choice — the arcs share their ink with the bangs, so they stay on front_hair; anchors.brows and brow_lines are still published`)
  }

  synth.neck = neckAdd
  synth.eyeSkin = synthEyeSkin || new Uint8Array(W * H)
  return { layers, notes, synth, eyeInfo, mouth: { mcx, mcy, upperLipY, box: mouthCut }, browsLayer }
}

/* [hairClean] grey-white specks inside the hair mask -> the hair's own dark tone.
 * A speck is colourless and light: L > 50 and chroma < 9 when opaque (cream skin and the hair's warm
 * highlights have chroma 12 and up, so they are never specks), or a bright colourless semi-
 * transparent edge texel (L > 60, chroma < 12). The repaint takes each texel's colour from the
 * nearest dark hair pixel (L < 45) that is not itself a speck, grown 1 px so the anti-aliased halo
 * round a stroke goes with it; alpha is never touched, so the silhouette cannot move.
 *   back_hair lies behind the face and behind the other two hair layers, so what it holds under and
 * within 12 px of the face egg (inside the silhouette) is never meant to be seen as drawn: the
 * anti-aliased skin-and-hair blends along the ear and face contour and the hairline-thin light gaps
 * between locks (a dotted or thin light stroke that a turn slides out from under the face and the
 * front hair) are repainted there too, anything lighter than the hair by more than 16 L. */
function paintSpecks(closed, g, notes, behind) {
  const { lab, hair } = g
  const speck = new Uint8Array(W * H)
  const dark = new Uint8Array(W * H)
  // back_hair is exposed wherever the face and the other hair layers slide off it: within about 12 px
  // of the egg (the largest slide is 10 px), but never along the silhouette itself
  const solid = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) solid[i] = closed[i * 4 + 3] >= 250 ? 1 : 0
  const near = behind ? andM(dilate(g.eggShape, sr(12)), erode(solid, sr(2))) : null
  const hairL = rgb2lab(...g.hairColour)[0]
  let n = 0, nb = 0
  for (let i = 0; i < W * H; i++) {
    if (!hair[i]) continue
    const a = closed[i * 4 + 3], L = lab[i * 3], c = Math.hypot(lab[i * 3 + 1], lab[i * 3 + 2])
    if (a >= 200) {
      if (L > 50 && c < 9) { speck[i] = 1; n++; continue }
      if (behind && near[i] && L > hairL + 16) { speck[i] = 1; nb++; continue }
      if (L < 45) dark[i] = 1
    } else if (a > 0 && L > 60 && c < 12) { speck[i] = 1; n++ }
  }
  if (!n && !nb) { if (!behind) notes.push('hairClean: no grey-white specks in the hair'); return closed }
  const need = andM(dilate(speck, sr(1)), hair)
  const src = subM(dark, need)
  const out = nearestFill(closed, src, need)
  for (let i = 0; i < W * H; i++) if (need[i]) out[i * 4 + 3] = closed[i * 4 + 3]
  notes.push(behind
    ? `hairClean (back_hair): ${n} grey-white specks and ${nb} light texels under / round the face (${countM(need)} px with their halo) repainted with the hair's dark tone`
    : `hairClean (front_hair, side_hair): ${n} grey-white specks (${countM(need)} px with their halo) repainted with the hair's dark tone`)
  return out
}

const box = l => ({ x: l.x, y: l.y, w: l.w, h: l.h })
const r2 = v => Math.round(v * 100) / 100

/* ------------------------------------------------------------------ anchors */

function anchors(id, F, g, built) {
  const head = g.head
  const fb = g.faceBox
  const eyes = g.eyeBoxes.map(b => [b.x0, b.y0, b.x1, b.y1])
  const brows = g.browBoxes.map(b => b ? [b.x0, b.y0, b.x1, b.y1] : null)

  const browLines = g.browBoxes.map((bb, s) => {
    if (!bb) return null
    const bm = g.browMasks[s], eb = g.eyeBoxes[s]
    const N = 12                              // a sample count, not a length: it does not scale
    const xs = [], bottom = [], lid = [], cap = []
    let capCols = 0
    for (let k = 0; k < N; k++) {
      const x = Math.round(bb.x0 + (bb.w - 1) * k / (N - 1))
      xs.push(r2(bb.x0 + (bb.w - 1) * k / (N - 1)))
      let lo = -1, hi = -1
      for (let d = 0; d <= si(3) && lo < 0; d++) for (const xx of [x - d, x + d]) {
        if (xx < 0 || xx >= W) continue
        for (let y = bb.y0; y <= bb.y1; y++) if (bm[idx(xx, y)]) { if (lo < 0) lo = y; hi = y }
        if (lo >= 0) break
      }
      bottom.push(hi >= 0 ? hi : (bottom.length ? bottom[bottom.length - 1] : bb.y1))
      const topHere = lo >= 0 ? lo : bb.y0
      // lash line of the closed eye at this column
      let best = -1, bestL = 999
      // cfg.browsOnFace (kai): his eye boxes reach up over the brows, so look only below the brow box
      for (let y = g.cfg.browsOnFace ? Math.max(eb.y0 - si(6), bb.y1 + 1) : eb.y0 - si(6); y <= eb.y1 + si(6); y++) {
        if (y < 0 || y >= H) continue
        const i = idx(x, y)
        if (F.blink[i * 4 + 3] < 200) continue
        const L = rgb2lab(F.blink[i * 4], F.blink[i * 4 + 1], F.blink[i * 4 + 2])[0]
        if (L < bestL) { bestL = L; best = y }
      }
      lid.push(best >= 0 && bestL < 55 ? best : (lid.length ? lid[lid.length - 1] : r2((eb.y0 + eb.y1) / 2)))
      // how far up the brow may go before the bangs cover it
      let hairBot = -1
      for (let y = topHere - 1; y >= Math.max(0, topHere - si(90)); y--) if (g.hair[idx(x, y)]) { hairBot = y; break }
      if (hairBot >= 0) { cap.push(r2(Math.max(0, topHere - hairBot - 1))); capCols++ }
      else cap.push(r2(Math.max(0, topHere - g.headSilBox.y0)))
    }
    const o = { x: xs, bottom, lid }
    if (capCols > N * 0.45) o.cap = cap
    return o
  })

  const bottomY = g.figBox.y1
  const chestCy = g.neckY + 0.72 * (bottomY - g.neckY)
  let cx0 = W, cx1 = -1
  for (let x = 0; x < W; x++) { let hit = false; for (let y = Math.round(chestCy - si(40)); y <= Math.round(chestCy + si(40)); y++) if (y >= 0 && y < H && g.alpha[idx(x, y)]) { hit = true; break } if (hit) { if (x < cx0) cx0 = x; cx1 = x } }

  return {
    head: { cx: r2(head.cx), cy: r2(head.cy), rx: r2(head.rx), ry: r2(head.ry) },
    face: [fb.x0, fb.y0, fb.x1, fb.y1],
    neck_y: g.neckY,
    top_y: g.figBox.y0,
    bottom_y: bottomY,
    collar_y: g.collarY,
    hair_root_y: g.hairRootY,
    eyes,
    brows,
    brow_lines: browLines,
    jaw: { top: built.mouth.upperLipY, chin: g.neckY, half: 0, open: 0, round: 0, wide: 0 },
    // the figure's width there is torso + both arms, so take 0.6 of it for the torso itself
    chest: { cx: r2((cx0 + cx1) / 2), cy: r2(chestCy), rx: r2((cx1 - cx0) / 2 * 0.6), ry: r2((bottomY - g.neckY) * 0.19) },
  }
}

/* ------------------------------------------------------------------ arms
 *
 * The art gives no boundary between sleeve and torso — 581 of 581 torso rows are one unbroken
 * opaque run, and no ink line runs down either arm — so the arms are not cut. Instead a rope is
 * laid down the middle of each sleeve and the existing `body` layer names both in `bones`:
 * puppet.ts's skinOf() weights every vertex of that layer by exp(-(d/sigma)^2), so the sleeve
 * bends and the torso does not. No cut, no seam, no fill invented behind an arm.
 *
 * `reach` is not optional here. skinOf normalises the weights across the chains a layer names,
 * so with two chains and no reach every vertex — the middle of the chest included — ends up with
 * weights summing to 1 and takes the average of both arms. `reach` is the only thing that zeroes
 * a vertex far from both ropes (w *= 1 - smoothstep(reach, 1.6*reach, offset)).
 */
/* cfg.armHands (sua2): her arms hang straight and pressed to the torso with the hands beside the
 * thighs, and the figure goes on below the hands (jeans to the frame), so armChains()'s "cuff =
 * bottom of the figure" and "shoulder = 80% of the widest row" both land wrong. Here each rope runs
 * from the first row below the hair whose outer texel is cardigan, down the sleeve `inset` px inside
 * the outer edge, to the top of the hand, and ends in the hand's centroid over its lowest 40 rows —
 * through the wrist into the hand. reach = 1.18 x half the NARROWER sleeve (puppet.ts takes the
 * minimum reach over the chains a layer names, so the narrow sleeve sets it for both).
 * Measured with _gen-sua2/arm-sim.mjs (skinOf/skinOffset replicated): see the report. */
function armChainsHands(g, closed, opt) {
  const A = (x, y) => closed[idx(x, y) * 4 + 3]
  const rgb = (x, y) => { const o = idx(x, y) * 4; return [closed[o], closed[o + 1], closed[o + 2]] }
  const lum = (x, y) => { const [r, gg, b] = rgb(x, y); return 0.299 * r + 0.587 * gg + 0.114 * b }
  const skinT = (x, y) => { const [r, gg, b] = rgb(x, y); return A(x, y) > 200 && r > 190 && r - b > 55 && gg > 130 && gg < r - 25 }
  const outer = (y, side) => { if (side < 0) { for (let x = 0; x < W; x++) if (A(x, y) > 128) return x } else { for (let x = W - 1; x >= 0; x--) if (A(x, y) > 128) return x } return -1 }
  const inset = si(opt.inset)
  const out = {}
  for (const [side, key] of [[-1, 'L'], [1, 'R']]) {
    let y0 = g.collarY - si(40)
    for (let y = y0; y < g.collarY + si(160); y++) { const x = outer(y, side); if (x >= 0 && lum(x - side * si(4), y) >= 70) { y0 = y; break } }
    const handRows = {}
    for (let y = Math.round(H * 0.8); y < H; y++) {
      const xo = outer(y, side); let lo = Infinity, hi = -Infinity
      for (let d = 0; d < si(70); d++) { const x = xo - side * d; if (x < 0 || x >= W) break; if (skinT(x, y)) { lo = Math.min(lo, x); hi = Math.max(hi, x) } }
      if (hi >= lo && hi - lo >= si(4)) handRows[y] = [lo, hi]
    }
    const hy = Object.keys(handRows).map(Number)
    if (!hy.length) return null
    const handTop = Math.min(...hy), handEnd = Math.max(...hy)
    const ws = []
    for (let y = Math.round(y0 + 0.3 * (handTop - y0)); y <= Math.round(y0 + 0.75 * (handTop - y0)); y += 4) {
      const x0 = outer(y, side)
      for (let d = si(10); d < si(140); d++) { const x = x0 - side * d; if (Math.abs(lum(x, y) - lum(x - side, y)) > 40) { ws.push(d); break } }
    }
    ws.sort((a, b) => a - b)
    let cx = 0, cy = 0, n = 0
    for (let y = handEnd - si(40); y <= handEnd; y++) { const r = handRows[y]; if (!r) continue; for (let x = r[0]; x <= r[1]; x++) if (skinT(x, y)) { cx += x; cy += y; n++ } }
    const pts = [y0, y0 + (handTop - y0) / 3, y0 + 2 * (handTop - y0) / 3, handTop].map(Math.round).map(y => [outer(y, side) - side * inset, y])
    pts.push([Math.round(cx / n), Math.round(cy / n)])
    out[key] = { pts, sleeveW: ws[ws.length >> 1] }
  }
  const rch = Math.max(2, Math.round(1.18 * Math.min(out.L.sleeveW, out.R.sleeveW) / 2))
  LOG(`  armHands: sleeves ${out.L.sleeveW} / ${out.R.sleeveW} px wide, inset ${inset}, reach = sigma = ${rch}`)
  const common = { k: [260, 150], damp: 5, drive: 0.35, hang: 0.3, wind: 7, freq: 0.26, limit: si(6), sigma: rch, reach: rch }
  return [
    { id: 'arm_L', attach: 'body', depth: 0, points: out.L.pts, ...common },
    { id: 'arm_R', attach: 'body', depth: 0, points: out.R.pts, ...common },
  ]
}

function armChains(g, closed) {
  const widthAt = y => {
    let a = -1, b = -1
    for (let x = 0; x < W; x++) if (g.alpha[idx(x, y)]) { if (a < 0) a = x; b = x }
    return a < 0 ? null : { a, b, w: b - a }
  }
  let maxW = 0
  for (let y = g.collarY; y <= g.figBox.y1; y++) { const r = widthAt(y); if (r && r.w > maxW) maxW = r.w }
  // the shoulder: the first row under the collar where the figure has most of its torso width
  let shoulderY = g.collarY
  for (let y = g.collarY; y <= g.figBox.y1; y++) { const r = widthAt(y); if (r && r.w >= 0.8 * maxW) { shoulderY = y; break } }
  /* down to the bottom of the hand, not the cuff: a rope that stops at the cuff leaves the hand
   * outside `reach` (measured: cuff 6.2 px, wrist 4.3 px, hand 0.0 px — the wrist sheared and the
   * hand detached). The hand is part of the arm and has to swing with it. */
  const cuffY = g.figBox.y1 - si(8)
  if (cuffY - shoulderY < si(200)) return null
  /* Measure the sleeve rather than assume it. `si()` scales with the CANVAS, and a reframe
   * changes the drawing's scale inside an unchanged canvas, so a hardcoded 22 would silently be
   * wrong by the reframe factor — and sigma and reach are derived from it. */
  const lum = (x, y) => { const o = idx(x, y) * 4; return 0.299 * closed[o] + 0.587 * closed[o + 1] + 0.114 * closed[o + 2] }
  const widths = []
  for (let y = Math.round(shoulderY + (cuffY - shoulderY) * 0.35); y <= Math.round(shoulderY + (cuffY - shoulderY) * 0.8); y += 4) {
    const r = widthAt(y)
    if (!r) continue
    for (let d = si(10); d < si(140); d++) {
      const x = r.a + d
      if (x >= W - 1) break
      if (Math.abs(lum(x, y) - lum(x + 1, y)) > 40) { widths.push(d); break }
    }
  }
  widths.sort((a, b) => a - b)
  const sleeveW = widths.length ? widths[widths.length >> 1] : si(44)
  const half = Math.max(1, Math.round(sleeveW / 2))
  const N = 5
  const mk = side => {
    const pts = []
    for (let k = 0; k < N; k++) {
      const y = Math.round(shoulderY + (cuffY - shoulderY) * k / (N - 1))
      const r = widthAt(y)
      if (!r) return null
      pts.push([side < 0 ? r.a + half : r.b - half, y])
    }
    return pts
  }
  const pL = mk(-1), pR = mk(+1)
  if (!pL || !pR) return null
  /* The player sub-steps physics to 1/120 s, so in its Verlet step the damping ratio works out at
   * zeta = damp / (2*sqrt(k)) independently of frame rate. k 150 at the tip with damp 5 gives
   * zeta 0.20, i.e. a disturbance decays to 5% in about 2.3 swings of the 0.51 s period — it
   * settles without ringing. k is stiffer at the root than the tip, as a limb is.
   * wind is what moves it at rest: it is added to the rest target in px and scaled by rig.wind
   * (0.5 here), so 7 gives the hand about 4 px at 0.26 Hz. hang 0.3 lets the arm lag the torso's
   * roll, which is what reads as weight. limit caps any joint at 6 px.
   * reach is the only taper that survives skinOf()'s normalisation across chains, so it — not
   * sigma — is what keeps the torso still: full effect within 26 px of the rope, nothing past
   * 41.6 px, against a sleeve ~44 px wide. */
  // sigma and reach follow the measured sleeve: full effect across it, nothing past 1.6x reach
  const rch = Math.max(2, Math.round(half * 1.18))
  const common = { k: [260, 150], damp: 5, drive: 0.35, hang: 0.3, wind: 7, freq: 0.26, limit: si(6), sigma: rch, reach: rch }
  return [
    { id: 'arm_L', attach: 'body', depth: 0, points: pL, ...common },
    { id: 'arm_R', attach: 'body', depth: 0, points: pR, ...common },
  ]
}

/* ------------------------------------------------------------------ verification renders */

function compose(canvasBuf, layer) {
  for (let j = 0; j < layer.h; j++) for (let i = 0; i < layer.w; i++) {
    const x = layer.x + i, y = layer.y + j
    if (x < 0 || y < 0 || x >= W || y >= H) continue
    const s = (j * layer.w + i) * 4, d = idx(x, y) * 4
    const a = layer.buf[s + 3] / 255
    if (a <= 0) continue
    const da = canvasBuf[d + 3] / 255
    const oa = a + da * (1 - a)
    for (let c = 0; c < 3; c++) canvasBuf[d + c] = Math.round((layer.buf[s + c] * a + canvasBuf[d + c] * da * (1 - a)) / oa)
    canvasBuf[d + 3] = Math.round(oa * 255)
  }
}
async function readLayerFile(dir, rel, x, y) {
  const { data, info } = await sharp(path.join(dir, rel)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { buf: data, w: info.width, h: info.height, x, y }
}

async function renderComposite(pkgDir, model, pick) {
  const canvas = Buffer.alloc(W * H * 4)
  for (const l of model.layers) {
    const rel = pick(l)
    if (!rel) continue
    compose(canvas, await readLayerFile(pkgDir, rel, l.x, l.y))
  }
  return canvas
}

/* ------------------------------------------------------------------ source sets */

/**
 * The four registered states to cut from, in the canvas the source art defines, plus the frame the
 * avatar and the cover are made from and the eye / mouth region hints the rest of the tool needs.
 *
 * A four-state set is loaded as it is: those frames already share one body byte-for-byte, and the
 * hints come from tools/assemble-report.json, which measured them on the 768 art (scaled here, so
 * a 768 set is untouched). A three-frame set is assembled into four states first — see
 * assemble-src.mjs — and then the hints are the regions that assembly just measured on the real
 * art, which is better than a scaled 768 measurement.
 */
async function loadSource(id, opts, workDir) {
  const dir = opts.set.dir(id)
  if (!fs.existsSync(dir)) throw new Error(`profile.source.set ${opts.set.name}: ${dir} does not exist`)
  const have = f => fs.existsSync(path.join(dir, `${f}.png`))
  const four = opts.set.states === 4   // Vola-live: declared in the profile, not read off the directory

  if (four) {
    const missing = ['closed', 'open', 'blink'].filter(f => !have(f))
    if (missing.length) throw new Error(`${dir} has blink-open.png but not ${missing.map(f => f + '.png').join(', ')}`)
    const rest = path.join(dir, 'closed.png')
    const meta = await sharp(rest).metadata()
    setCanvas(meta.width, meta.height, rest)
    let F = {}
    for (const s of ['closed', 'open', 'blink', 'blink-open']) {
      F[s === 'blink-open' ? 'blinkOpen' : s] = await loadRGBA(path.join(dir, `${s}.png`))
    }
    let framing = null, restFile = rest
    if (opts.set.fit) {
      ({ frames: F, info: framing } = await refitFraming(id, F, 'closed', opts))
      // the fitted pixels, not the file on disk, are what the avatar and cover must come from
      const srcDir = path.join(workDir, 'src')
      mkdirG(srcDir)
      restFile = path.join(srcDir, 'closed.png')
      await writePng(F.closed, W, H, restFile)
    }
    const rep = opts.regions   // Vola-live: profile.source.regions, the boxes of tools/assemble-report.json
    REG = { eyeR: { box: scaleBox(rep.eyeR) }, mouthR: { box: scaleBox(rep.mouthR) } }
    return { F, restFile, assembly: null, framing }
  }

  const absent = SRC_FRAMES.filter(f => !have(f))
  if (absent.length) {
    throw new Error(`${dir} holds neither the four states (closed, open, blink, blink-open) nor the three `
      + `generated frames — ${absent.map(f => f + '.png').join(', ')} missing`)
  }
  const probe = path.join(dir, `${SRC_FRAMES[0]}.png`)
  const meta = await sharp(probe).metadata()
  setCanvas(meta.width, meta.height, probe)
  let frames = {}
  for (const s of SRC_FRAMES) frames[s] = await loadRGBA(path.join(dir, `${s}.png`))

  let framing = null
  if (opts.set.fit) ({ frames, info: framing } = await refitFraming(id, frames, SRC_FRAMES[0], opts))

  GUARD(path.join(workDir, 'src'))   // Vola-live: assembleStates writes its inspection files there
  const { states, regions, files, info } = await assembleStates(id, frames, { W, H }, path.join(workDir, 'src'), { canon: opts.canon, ...(opts.cut.assemble || {}) })
  REG = { eyeR: { box: regions.eyeR.box }, mouthR: { box: regions.mouthR.box } }
  return { F: states, restFile: files.closed, assembly: info, framing }
}

/**
 * Fit a set into the shipped packages' framing, before anything else touches it. The target is the
 * alpha box of livliv-cast/characters/<id>/closed.png, in this canvas's coordinates — the framing
 * the current packages, and therefore livliv.html's layout, already use.
 */
async function refitFraming(id, frames, refKey, opts = {}) {
  /* Vola-live: profile.source.refit names the reference (old FRAMING_REF = characters/<id>/closed.png,
   * used when it existed); refit null is the old "no framing reference" case */
  const refFile = opts.refitRef
  if (!refFile) {
    return { frames, info: { skipped: 'no framing reference (profile.source.refit is null)' } }
  }
  if (!fs.existsSync(refFile)) throw new Error(`profile.source.refit.ref: ${refFile} does not exist`)
  const { data, info } = await sharp(refFile).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const b = bboxOfAlpha(data, info.width, info.height)
  const k = W / info.width
  const target = {
    x0: Math.round(b.x0 * k), y0: Math.round(b.y0 * k),
    x1: Math.round((b.x1 + 1) * k) - 1, y1: Math.round((b.y1 + 1) * k) - 1,
  }
  target.w = target.x1 - target.x0 + 1; target.h = target.y1 - target.y0 + 1
  return fitFraming(frames, target, { W, H }, refKey, opts.fitMode || 'scale')
}

function printFraming(f) {
  if (f.skipped) { LOG(`  framing: NOT fitted — ${f.skipped}`); return }
  const box = b => `${b.x0},${b.y0}-${b.x1},${b.y1} (${b.w}x${b.h})`
  LOG(`  framing: ${box(f.ref)} -> ${box(f.got)}, target ${box(f.target)}`
    + `  scale ${r2(f.s)} offset ${r2(f.tx)},${r2(f.ty)}  ${f.cutAtBottom ? 'bottom pinned to the frame' : 'centred'}`)
  for (const w of f.warn) LOG(`    ! ${w}`)
}

/* ------------------------------------------------------------------ main */

async function build(id, opts) {
  /* Vola-live: the work dir is ctx.workDir (private to this build, old _work/<id>[-<tag>]/) and the
   * package dir is ctx.outDir itself (old <--out>/<id>/) */
  const workDir = opts.workDir
  const pkgDir = opts.pkgDir
  const textures = path.join(pkgDir, 'textures')
  mkdirG(workDir)
  mkdirG(textures)

  const { F, restFile, assembly, framing } = await loadSource(id, opts, workDir)

  const pockets = await cleanWhitePockets(id, F, workDir)

  const cfg = { ...opts.cut, ...opts.tol }   // Vola-live: profile.cut (old CFG[id]; CFG_BY_SRC had no live entry)
  const EX = opts.expr ? await EXPR.begin({ id, opts, framing, W, H, S }) : null   // --expr: expression frames, same transforms as the base
  if (cfg.creases || opts.creaseReport) {
    const cr = await eraseCreases(id, F, workDir, !cfg.creases)
    if (cr.dry) LOG(`  crease detector (report only, not applied): ${cr.found.length ? cr.found.join('; ') : 'nothing qualifies'}`)
    else
    LOG(`  cheek creases painted out: ${cr.px} px${cr.found.length ? ' — ' + cr.found.join('; ') : ' (none found)'}`)
  }
  if (opts.ladder) {
    // cheap rung: the transform only, no cut — a source frame is already a finished picture
    const dir = path.join(workDir, 'ladder')
    mkdirG(dir)
    for (const sc of opts.ladder) {
      const G = {}
      for (const k of ['closed', 'open', 'blink', 'blinkOpen']) G[k] = Buffer.from(F[k])
      if (sc !== 1) {
        const g0 = await geometry(id, G, null, cfg)
        const want = g0.figBox.y0
        await rescaleHead(G, g0, sc, null)
        const r = await reframeFrames(G, want)
        LOG(`  ladder ${sc}: reframe x${r.sf.toFixed(4)} (head top had risen to ${r.topBefore})`)
      } else LOG('  ladder 1: untouched')
      await writePng(G.closed, W, H, path.join(dir, `head-${String(sc).replace('.', '')}.png`))
    }
    return
  }

  if (cfg.headScale && cfg.headScale !== 1) {
    const g0 = await geometry(id, F, null, cfg)
    const topWanted = g0.figBox.y0
    if (EX) await EXPR.headScale(EX, { rescaleHead, reframeFrames, g0, topWanted, scale: cfg.headScale, closed: F.closed })
    const r1 = await rescaleHead(F, g0, cfg.headScale, workDir)
    const r2 = await reframeFrames(F, topWanted)
    /* The eye and mouth search windows come from assemble-report.json, measured on the art as it
     * was. They are head content, so they move with it — without this the eye detection starts
     * from a window 14 px off and clips the top of the real eye band. */
    const S0 = cfg.headScale, PX0 = g0.head.cx, PY0 = g0.neckY
    const moveBox = b => {
      const [x0, y0] = r2.map(PX0 + (b.x0 - PX0) * S0, PY0 + (b.y0 - PY0) * S0)
      const [x1, y1] = r2.map(PX0 + (b.x1 - PX0) * S0, PY0 + (b.y1 - PY0) * S0)
      return { x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x1), y1: Math.round(y1) }
    }
    REG = { eyeR: { box: moveBox(REG.eyeR.box) }, mouthR: { box: moveBox(REG.mouthR.box) } }
    LOG(`  region windows moved with the art: eyeR ${JSON.stringify(REG.eyeR.box)} mouthR ${JSON.stringify(REG.mouthR.box)}`)
    /* A second pass: the first ran before any of this existed, and the ink rule that keeps the
     * garment's edge on the body also hands it the hair's white rim-light where the two shared a
     * stroke. The eye and mouth exemptions use the moved REG, so sclera and teeth stay safe. */
    const after = await cleanWhitePockets(id, F, null)
    LOG(`  white pockets after the rescale: ${after.px} px${after.blobs.length ? ' — ' + after.blobs.join('; ') : ''}`)
    LOG(`  head scale ${cfg.headScale} about (${g0.head.cx}, ${g0.neckY}): ${r1.filled} px of garment continued under the head group`)
    LOG(`  head cut on the jaw ink in ${r1.jawFound}/${r1.jawCols} columns (${(r1.jawFound / r1.jawCols * 100).toFixed(0)}%), the rest bridged`)
    LOG(`  reframe x${r2.sf.toFixed(4)} about the bottom edge (head top had risen to y ${r2.topBefore}, back to ${topWanted}; bottom stays ${H - 1})`)
    const srcDump = path.join(workDir, 'src-scaled')
    mkdirG(srcDump)
    for (const k of ['closed', 'open', 'blink', 'blinkOpen']) await writePng(F[k], W, H, path.join(srcDump, `${k}.png`))
  }
  const g = await geometry(id, F, workDir, cfg)
  LOG(`\n== ${id} ==`)
  LOG(`  source ${opts.set.name}: canvas ${W}x${H} (${r2(S)}x the ${BASE_W}x${BASE_H} art)`)
  if (framing) printFraming(framing)
  if (assembly) printAssembly(id, assembly)
  LOG(`  white pockets filled: ${pockets.px} px${pockets.blobs.length ? ' — ' + pockets.blobs.join('; ') : ''}`)

  LOG(`  head ${JSON.stringify(g.head)}  neck_y ${g.neckY}  hair_root_y ${g.hairRootY}  collar_y ${g.collarY}`)
  LOG(`  face box ${JSON.stringify(g.faceBox)}  eyes ${JSON.stringify(g.eyeBoxes.map(b => [b.x0, b.y0, b.x1, b.y1]))}`)
  LOG(`  brows ${JSON.stringify(g.browBoxes.map(b => b && [b.x0, b.y0, b.x1, b.y1]))}  mouth ${JSON.stringify(g.mouthBox)}`)
  LOG(`  hair px ${countM(g.hair)}  skin px ${countM(g.skin)}  skin colour ${g.skinColour}  hair colour ${g.hairColour}`)
  if (cfg.hairTune) LOG(`  rig: short-hair tuning (SPEC 5: said so) — tuning ${JSON.stringify(cfg.hairTune.tuning)}, back_hair depth ${cfg.hairTune.backDepth}; the shared hair springs, hair_limit and wind are unchanged`)
  if (opts.masksOnly) return

  DESPECKLE = cfg.despeckle ? { art: F.closed } : null
  const built = await buildLayers(id, F, g, { textures })
  if (DESPECKLE) {
    LOG(`  despeckle: ${SPECKS.transparent} pale edge texels made transparent, ${SPECKS.recoloured} recoloured to the dark mass they sit on, ${SPECKS.keptInterior} opaque interior light texels kept as drawn`)
    for (const [f, s] of Object.entries(SPECKS.byFile)) {
      if (!s.recoloured && !s.transparent && !s.kept.length) continue
      LOG(`  despeckle any-hue ${f}: ${s.recoloured} recoloured (${s.art || 0} where the art is dark ink, the rest dark inside), ${s.transparent} transparent (nothing solid within 3 px), ${s.kept.length} kept (light inside: skin/cloth antialiasing)`)
      for (const k of s.kept) LOG(`      kept ${k}`)
    }
    DESPECKLE = null
  }
  const chains = cfg.armHands ? armChainsHands(g, F.closed, cfg.armHands) : cfg.arms ? armChains(g, F.closed) : null
  if (chains) {
    const body = built.layers.find(l => l.id === 'body')
    body.bones = chains.map(c => c.id)
    LOG(`  arms: ${chains.map(c => c.id + ' ' + JSON.stringify(c.points)).join('  ')}`)
    LOG(`         k ${JSON.stringify(chains[0].k)} damp ${chains[0].damp} drive ${chains[0].drive} hang ${chains[0].hang} wind ${chains[0].wind} limit ${chains[0].limit} sigma ${chains[0].sigma} reach ${chains[0].reach}`)
  }
  const a = anchors(id, F, g, built)

  const model = {
    format: 'livliv-model',
    version: 4,
    name: opts.model.name,   // Vola-live: profile.model.name (old cfg.name ?? NAMES[id])
    /* Vola-live: generator / created / author / watermark come from the stamp and profile.model.author
     * (old cfg.generatorName / cfg.build / BUILD / the current time / cfg.noAuthor), same key order */
    meta: metaFor(opts.stamp, opts.model),
    requires: [],
    files: { avatar: 'avatar.webp', cover: 'cover.webp' },
    canvas: [W, H],
    profile: opts.model.profile ?? { id: 'anime_half', facing: 'front', glasses: false },   // Vola-live: profile.model.profile
    rig: opts.model.rig ? { ...opts.model.rig, ...(chains ? { chains } : {}) } : {   // Vola-live: profile.model.rig
      yaw: 0.30, pitch: 0.22, roll: 0.5, bulge: 0.65,
      hair: { front: [140, 11, 0.022, 70, 7], back: [48, 5.5, 0.06, 24, 3.5], side: [90, 8, 0.03, 45, 5] },
      hair_limit: 0.25, wind: 0.5, breath: 1, sway: 1, brow: 0.06,
      body: { yaw: 0.35, roll: 0.3, breath: 1, bust: cfg.bust },
      ...(chains ? { chains } : {}),
    },
    ...(cfg.hairTune ? { tuning: cfg.hairTune.tuning } : {}),  // [hairTune]
    anchors: a,
    expressions: [],
    layers: built.layers,
  }

  // avatar + cover, from the rest frame of whichever set was cut. 96x96 is the avatar's declared
  // size (SPEC §1), not a length in the art, so it does not scale; the cover is the full canvas.
  let hb = { left: Math.max(0, Math.round(g.head.cx - g.head.rx * 1.25)), top: Math.max(0, Math.round(g.head.cy - g.head.ry * 1.25)) }
  let side = Math.min(W - hb.left, H - hb.top, Math.round(2.5 * Math.max(g.head.rx, g.head.ry)))
  /* cfg.avatarPad (daeun): her anchors.head is set for the rig warp and is narrower than her bob,
   * so the head-derived square clips the hair. Use the whole hair mass + pad instead, centred on it;
   * anchors.head is untouched. */
  if (cfg.avatarPad != null) {
    const hm = bboxOfMask(orM(g.hair, g.skinHead))
    side = Math.max(hm.w, hm.h) + 2 * cfg.avatarPad
    const cxh = (hm.x0 + hm.x1 + 1) / 2
    hb = { left: Math.max(0, Math.min(W - side, Math.round(cxh - side / 2))), top: Math.max(0, hm.y0 - cfg.avatarPad) }
    side = Math.min(side, W - hb.left, H - hb.top)
    LOG(`  avatar: hair mass ${hm.x0}-${hm.x1} x ${hm.y0}-${hm.y1} -> square ${side} at (${hb.left}, ${hb.top})`)
  }
  await sharp(restFile).extract({ left: hb.left, top: hb.top, width: side, height: side })
    .resize(96, 96).webp({ quality: 92 }).toFile(GUARD(path.join(pkgDir, 'avatar.webp')))
  await sharp(restFile).webp({ quality: 92 }).toFile(GUARD(path.join(pkgDir, 'cover.webp')))

  fs.writeFileSync(GUARD(path.join(pkgDir, 'model.json')), JSON.stringify(model, null, 1) + '\n')
  for (const n of built.notes) LOG('  - ' + n)

  /* Every pixel the cutter invents, one colour per region, so the at-rest exposure of each can be
   * measured against the shipped textures (SPEC §3.2: a fill that shows at rest is a bug). */
  {
    const S5 = built.synth
    const key = [['back', [255, 0, 0]], ['face', [0, 255, 0]], ['neck', [0, 0, 255]],
                 ['bodyHair', [255, 255, 0]], ['eyeSkin', [0, 255, 255]]]
    const buf = Buffer.alloc(W * H * 4)
    for (const [k, c] of key) {
      const m = S5[k]
      if (!m) continue
      for (let i = 0; i < W * H; i++) if (m[i]) { const o = i * 4; buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 255 }
    }
    await writePng(buf, W, H, path.join(workDir, 'synth-map.png'))
  }

  if (!opts.noVerify) await verify(id, model, pkgDir, workDir, F)
  if (EX) { await EXPR.finish(EX, { F, g, built, model, textures, pkgDir, workDir, cfg, opts, W, H, S }); fs.writeFileSync(GUARD(path.join(pkgDir, 'model.json')), JSON.stringify(model, null, 1) + '\n') }
  return model
}

async function verify(id, model, pkgDir, workDir, F) {
  const problems = []
  // 1. every texture is exactly its layer's w x h and the box is inside the canvas
  for (const l of model.layers) {
    const files = [l.texture, l.mask, l.talk, l.brow_tex, ...(l.frames || [])].filter(Boolean)
    for (const f of files) {
      const p = path.join(pkgDir, f)
      if (!fs.existsSync(p)) { problems.push(`${l.id}: missing ${f}`); continue }
      const m = await sharp(p).metadata()
      if (m.width !== l.w || m.height !== l.h) problems.push(`${l.id}: ${f} is ${m.width}x${m.height}, layer box is ${l.w}x${l.h}`)
    }
    if (l.x < 0 || l.y < 0 || l.x + l.w > W || l.y + l.h > H) problems.push(`${l.id}: box ${l.x},${l.y} ${l.w}x${l.h} leaves the canvas`)
    // transparent 1-px ring
    const { data } = await sharp(path.join(pkgDir, l.texture)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let ringMax = 0
    for (let i = 0; i < l.w; i++) { ringMax = Math.max(ringMax, data[i * 4 + 3], data[((l.h - 1) * l.w + i) * 4 + 3]) }
    for (let j = 0; j < l.h; j++) { ringMax = Math.max(ringMax, data[(j * l.w) * 4 + 3], data[(j * l.w + l.w - 1) * 4 + 3]) }
    if (ringMax > 0) problems.push(`${l.id}: outer ring alpha max ${ringMax}, expected 0`)
  }
  // 2. the lid texture must keep a dark lash line in >= 20% of columns
  for (const s of ['L', 'R']) {
    const l = model.layers.find(x => x.id === `eye_${s}_closed`)
    if (!l) continue
    const { data } = await sharp(path.join(pkgDir, l.texture)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let cols = 0
    for (let i = 0; i < l.w; i++) {
      for (let j = 0; j < l.h; j++) {
        const o = (j * l.w + i) * 4
        const luma = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]
        if (data[o + 3] >= 200 && luma < 110) { cols++; break }
      }
    }
    const frac = cols / l.w
    LOG(`  lid ${s}: dark lash line in ${(frac * 100).toFixed(0)}% of columns${frac < 0.2 ? '  <-- TOO FEW, flat blink' : ''}`)
    if (frac < 0.2) problems.push(`eye_${s}_closed: lash line present in only ${(frac * 100).toFixed(0)}% of columns (<20%)`)
  }

  // 3. composites
  const base = await renderComposite(pkgDir, model, l => {
    if (l.id.endsWith('_closed')) return null
    if (l.id === 'mouth') return l.frames[0]
    return l.texture
  })
  await writePng(base, W, H, path.join(workDir, 'composite-rest.png'))
  const blinkC = await renderComposite(pkgDir, model, l => {
    if (l.role === 'eye_L' || l.role === 'eye_R' || l.role === 'iris_L' || l.role === 'iris_R') return null
    if (l.id === 'mouth') return l.frames[0]
    return l.texture
  })
  await writePng(blinkC, W, H, path.join(workDir, 'composite-blink.png'))
  for (let k = 0; k < 5; k++) {
    const c = await renderComposite(pkgDir, model, l => {
      if (l.id.endsWith('_closed')) return null
      if (l.id === 'mouth') return l.frames[k]
      return l.texture
    })
    const mb = model.layers.find(l => l.id === 'mouth')
    const pad = si(46)
    const x0 = Math.max(0, mb.x - pad), y0 = Math.max(0, mb.y - pad)
    const w = Math.min(W - x0, mb.w + pad * 2), h = Math.min(H - y0, mb.h + pad * 2)
    const crop = Buffer.alloc(w * h * 4)
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const s = idx(x0 + i, y0 + j) * 4, d = (j * w + i) * 4
      crop[d] = c[s]; crop[d + 1] = c[s + 1]; crop[d + 2] = c[s + 2]; crop[d + 3] = c[s + 3]
    }
    await writePng(crop, w, h, path.join(workDir, `viseme-${k}-${mb.visemes[k]}.png`))
  }
  // difference against the original
  const diff = Buffer.alloc(W * H * 4)
  let sum = 0, n = 0, worst = 0
  for (let i = 0; i < W * H; i++) {
    const o = i * 4
    const d = Math.max(Math.abs(base[o] - F.closed[o]), Math.abs(base[o + 1] - F.closed[o + 1]), Math.abs(base[o + 2] - F.closed[o + 2]),
      Math.abs(base[o + 3] - F.closed[o + 3]))
    sum += d; n++; if (d > worst) worst = d
    const v = Math.min(255, d * 3)
    diff[o] = v; diff[o + 1] = v > 90 ? 0 : v; diff[o + 2] = v > 90 ? 0 : v; diff[o + 3] = 255
  }
  await writePng(diff, W, H, path.join(workDir, 'composite-diff.png'))
  LOG(`  composite vs closed.png: mean |d| ${(sum / n).toFixed(2)}, max ${worst}`)
  if (problems.length) { LOG('  PROBLEMS:'); for (const p of problems) LOG('    ! ' + p) }
  else LOG('  self-check: all textures match their boxes, boxes inside the canvas, rings transparent')
  return problems
}

/* ------------------------------------------------------------------ Vola-live entry
 * Replaces the old CLI loop (argv flags, default set sua/father/mother, --out under livliv-cast).
 * Builds ONE character into ctx.outDir (the package directory itself) and returns its model.
 * Importing this module does nothing; module state (W/H/S, REG, DESPECKLE, SPECKS, STAGE_OFF, LATTICE)
 * is global, so the CLI runs one build per process (DESIGN §3.4 #10). */

/** the old `opts` object, built from the profile and ctx instead of argv (same field names) */
export function sourceOpts(profile, cfg) {
  const src = profile.source
  const setRel = src.set
  return {
    canon: src.canon ?? null,                                      // old --canon
    fitMode: src.refit ? src.refit.mode : 'scale',                 // old --fit (default 'scale')
    refitRef: src.refit ? castPath(cfg, src.refit.ref) : null,     // old FRAMING_REF(id), when it existed
    regions: src.regions ?? null,                                  // old REPORT[id] boxes (four-state sets)
    set: {
      name: setRel,
      states: src.states === 4 ? 4 : 3,
      dir: id => castPath(cfg, `${setRel}/${id}`),
      fit: src.states !== 4,                                       // old: every set but `characters` is refitted
    },
  }
}

/**
 * @param {import('./index.mjs').BuildCtx} ctx
 * @returns {Promise<object>} the model written to <ctx.outDir>/model.json
 */
export async function cutHuman(ctx) {
  const { profile, cfg: vcfg, outDir, workDir, stamp, log } = ctx
  const dev = ctx.dev || {}
  LOG = log
  GUARD = abs => guardWrite(vcfg, abs)
  GUARD(outDir); GUARD(workDir)
  STAGE_OFF = new Set(Object.entries(profile.stages || {}).filter(([, on]) => on === false).map(([k]) => k))
  LATTICE = profile.lattice !== false
  const tol = {}
  if (dev.tolHair != null) tol.tolHair = dev.tolHair
  if (dev.tolSkin != null) tol.tolSkin = dev.tolSkin
  const x = profile.expressions
  const opts = {
    ...sourceOpts(profile, vcfg),
    creaseReport: false,
    ladder: dev.ladder ?? null,
    masksOnly: !!dev.masks,
    noVerify: false,
    expr: !!x && !dev.noExpr,
    exprOnly: dev.exprOnly ?? null,
    exprFringe: null,
    exprSpec: x ? {
      frames: x.frames.map(rel => ({ rel, abs: castPath(vcfg, rel) })),
      extra: x.extra, per: x.per, perX: x.perX, regHair: x.regHair,
    } : null,
    tol,
    cut: profile.cut,
    model: profile.model,
    stamp,
    pkgDir: outDir,
    workDir,
    log,
    guard: GUARD,
  }
  LOG(`cut-human (vola-live): ${profile.id} src=${opts.set.name}  ->  ${outDir}`)
  return build(profile.id, opts)
}
