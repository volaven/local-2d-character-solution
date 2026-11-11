/**
 * livliv-frozen-kai8: livliv-frozen-kai/expressions.mjs (2302ca0e) + EXTRA / exprsFor + PER_X ported from
 * livliv-frozen-iseul8 (1015a511), with kai listed in EXTRA. Characters without EXTRA / PER_X entries run exactly as in
 * livliv-frozen-kai. See README.
 *
 * expressions.mjs — the expression layers (smile / worried / surprised / excited) for the cut-human
 * packages. Off by default: cut-human.mjs only calls in here behind `--expr`, and a build without the
 * flag never reaches this file's code (it only imports it).
 *
 *   node livliv-cast/tools/livliv/cut-human.mjs sua --expr [--expr-src=<dir>] [--expr-only=smile,...]
 *
 * <dir> holds one <id>/ folder per character with {smile,worried,surprised,excited}.png, 768x1024 RGBA
 * (default livliv-cast/tools/livliv/_expr). A frame that is not there is skipped and reported.
 *
 * WHAT IT DOES, per character and per expression
 *   1. the frame is put through exactly the transform that character's base frames get — 수아: head
 *      scale + reframe (the very rescaleHead / reframeFrames calls, jaw cut and all, with the base
 *      closed frame in the `closed` slot); 엄마: the whole-pixel translate of her refit (copied, never
 *      resampled); 아빠: none;
 *   2. it is registered to the final base closed frame by a rigid sub-pixel shift measured on the
 *      structure OUTSIDE the feature zone (nose, face contour, jaw, hairline) — nothing is warped;
 *   3. its skin tone is matched to the base's along the patch's outer ring (median offset);
 *   4. the patch = where the expression frame differs from the base's clean face (the `face` layer) in
 *      the feature zone, UNIONED with where the base itself draws a feature (so the base's eyes, brows
 *      and mouth are always fully covered), grown and feathered; intersected with the face-skin
 *      ownership and with everything that is not hair;
 *   5. `texture` is that patch; `talk` is the same patch with the whole expression mouth (not the
 *      neutral mouth box) replaced by the face layer's clean skin, so the viseme layer shows alone.
 *
 * The layers land after `mouth` and before `side_hair` (or whatever follows the mouth), with
 * role `expr`, group head, depth 0; `brows: "redrawn"` on characters that have a `brows` layer.
 * Known limit, same as s01: the patch carries its own eyes and sits above the eye stack, so blink
 * and gaze do nothing while an expression is fully on.
 */
/* Vola-live port (DESIGN §4.3, §8 A2): livliv-frozen-kai8/expressions.mjs ae8d8a3a, plus
 *   (1) from livliv-frozen-nose 8b7533b8: findShift's optional weights, ptsOf's exclusion + [regHair] (default
 *       FLIPPED to off: `per.regHair === true`), r.shift.mode, the residual floor residMinPts + residN, the
 *       [noseBase] block, the DEF additions (now in tables.mjs) and the report line;
 *   (2) browRootToBrows replaced by browRoot v2 from the shared d3278c47 (the one shipped mother matches);
 *   (3) PLUMBING: the tables (EXPRESSIONS / EXTRA / DEF -> tables.mjs; PER / PER_X -> profile.expressions.per /
 *       perX, regHair -> profile.expressions.regHair), the frame dirs (DEFAULT_SRC / --expr-src ->
 *       profile.expressions.frames), console.log -> LOG (ctx.log), every write through the guard, no env read
 *       (EXPR_DEBUG dump dropped), no CLI (the --replay dev entry at the bottom is not ported).
 * The usage notes below describe the old CLI and are kept as written. */
import fs from 'node:fs'
import v8 from 'node:v8'
import path from 'node:path'
import { sharp } from '../../runtime.mjs'
import { BASE_EXPRESSIONS, EXTRA_EXPRESSIONS, DEF } from './tables.mjs'

/** the four expressions, in UI order; `src` is the frame's file name in <dir>/<id>/ */
export const EXPRESSIONS = BASE_EXPRESSIONS   // Vola-live: tables.mjs
/** (livliv-frozen-kai8) more expressions for one character, after the four above, same shape (the same ids, labels,
 *  hotkeys and frame names as 이슬's in livliv-frozen-iseul8); a character not listed here gets exactly the four
 *  Vola-live: { [id]: profile.expressions.extra mapped through EXTRA_EXPRESSIONS }, set by begin() */
let EXTRA = {}
export const exprsFor = id => [...EXPRESSIONS, ...(EXTRA[id] || [])]
/* Vola-live: the build's expression spec ({ frames: [{rel, abs}], extra, per, perX, regHair }), the log and the write guard */
let SPEC = null
let LOG = line => { throw new Error(`expressions: log before begin(): ${line}`) }
let GUARD = abs => { throw new Error(`expressions: write before begin(): ${abs}`) }

/** per-character knobs (base px at 768)
 *  ownEyes: m     — the patch also owns both eye boxes grown by m px (for an eye the cutter's faceKeep leaves out), hard up to dark hair
 *  eyeHairGap: g  — inside those owned eye boxes, the px kept clear of dark hair (default 1) so the lock's anti-aliased rim stays the base's
 *  suppress: { <expr>: [[x0, y0, x1, y1], ...] } — box form: the expression's drawn ink inside the boxes becomes face skin (a number = every row above it)
 *  talkBox: [[x0, y0, x1, y1|null], ...] — extra boxes unioned into the talk mouth zone (null y1 = the default bottom)
 *  suppressFill: 'base' | 'frame' | 'skin' — (이슬) the face layer itself carries ink inside her suppress boxes (bits of the base
 *                 lash and their soft rim), so it is not used as is. 'base' (used): the boxes take the package's own rest composite
 *                 > 2 px from its non-hair dark ink, and that ink is filled (sigma 2/4/8) from those pixels and the frame's skin
 *                 outside the boxes, never from hair. 'frame' / 'skin': a gaussian fill (sigma 3/6/12) from the frame's / the
 *                 face layer's skin > 2 px from ink. Unset = the plain face-layer copy.
 *  suppressWhole: true — (이슬) every pixel of the suppress boxes is replaced, not only the frame's ink grown 4 px
 *  eyeHairL: L    — (이슬) with ownEyes, the luma below which a hair-mask pixel counts as dark hair (default 150). Her hair is pale,
 *                 so the only dark pixels in her hair mask at the eyes are lash bits: 0 = none, the patch covers them (a base lash
 *                 dot showed through beside a strand)
 *  topPad: n      — (이슬) with noBrows, the patch zone and the owned eye boxes start n px higher, so a widened eye's whole lash is
 *                 in the patch (it was cut flat at the default top)
 *  strandAA: w    — (이슬) the layers above the patch have opaque, un-anti-aliased strand rims coloured from the base; dark patch ink
 *                 (luma < 150) within w px of them is mixed toward their colour (0.5 at 1 px, 0.25 at 2 px), so a lash meeting
 *                 a strand edge does not read as stair-steps
 *  holeMax: n     — (카이) with ownEyes + eyeHairL 0, a non-hair speck of <= n px enclosed by the hair mask (his black bangs keep the
 *                 drawing's light flecks, hairClean off) is not owned, so the base shows it; else the frame's strand put a dark dot
 *                 into a strand highlight
 *  suppress box with a 5th element 'face' — (카이) [x0, y0, x1, y1, 'face']: every pixel of the box takes the face layer (exactly
 *                 the rest look), applied after the other boxes whatever suppressFill / suppressWhole say
 *  (카이) topPad without noBrows raises only the owned eye boxes (the zone already starts 34 px above the brows)
 */
/*  Vola-live: the values (old PER[id]) are profile.expressions.per; DEF is tables.mjs (with the nose additions).
 *  (nose) noseBase: { <expr>: [[x0, y0, x1, y1], ...] } — [noseBase] inside the boxes the patch takes the BASE's own face layer
 *                  over the drawn stroke (+ noseGrow px, feathered out over noseFeather px), so a feature the
 *                  generator redrew in a different place can never double against the base's. See the block below.
 *  (nose) regHair — [regHair] leave hair strands out of the registration point set. Vola-live: profile.expressions.regHair,
 *                  default OFF (the nose copy had it on for everyone; only father / mother shipped with it).
 */

/** (livliv-frozen-iseul8, ported to livliv-frozen-kai8) per-expression knobs: { <character>: { <exprId>: {...} } }, merged
 *  over that character's PER for that one expression only (an expression not listed here runs on PER exactly as before).
 *  Read inside the per-expression loop, so only keys used there take effect (not the zone / ownership keys: ownEyes, topPad,
 *  eyeHairL, hairGap, noBrows, holeMax).
 *  suppressInk: [[x0, y0, x1, y1], ...] — inside these boxes the frame's grey / lavender-white ink (Lab chroma < 14 and b* < 6,
 *                 or L* > 91 and chroma < 9; L* >= 45, so never a lash; her skin is b* ~10-15) grown suppressInkGrow px (default 1;
 *                 never onto L* < 45) is painted out from the frame's own pixels around it (never base hair grown 1 px;
 *                 see the last lines for the fill). 이슬's brows
 *                 are drawn into front_hair, above every patch, so a frame's moved brow inside the patch shows as a second brow;
 *                 and a frame strand that sits beside the base's strand shows as a doubled strand.
 *  suppressInkFill: 'skin' (default) — the fill takes only the frame's skin (skin palette dE <= ns); 'all' — every frame pixel
 *                 that is not painted out (a strand crossing a lash: the lash runs on under it)
 *  suppressInkAll: [[x0, y0, x1, y1], ...] — the same paint-out with the 'all' fill, for boxes that need it beside 'skin' ones
 *  suppressShade: [[x0, y0, x1, y1], ...] — every pixel of these boxes is painted out ('skin' fill; dark ones too, so keep
 *                 the boxes off the lashes): a frame's shading that belonged to its moved brow and is left as a smudge once
 *                 that brow is painted out
 *  suppress / suppressFeather — PER's own box suppress (with 이슬's suppressWhole + suppressFill 'base': the box takes the
 *                 package's rest composite) can be set per expression here; suppressFeather f ramps it in over f px inside
 *                 each box edge (see the 'base' fill; only the 'base' fill reads it)
 *  shadeLift: [[x0, y0, x1, y1], ...], shadeLiftL: L (84), shadeLiftFeather: f — the shading in these boxes (not lashes and
 *                 their 1 px rim, not hair) becomes the even light skin around it (sources: frame skin with L* >= L), mixed in
 *                 over f px from the boxes' outer edge (a lash side is no edge): 증오's leftover frown shading
 *  blushFeat: d   — the frame's blush (G drop vs the clean face >= d, red drop <= half that, components >= 30 px) counts as a
 *                 feature, so the patch covers all of it instead of cutting it where the eyes' feather ends
 *  talkZone: [x0, y0, x1, y1] — the talk cut (expression mouth -> clean skin) looks only inside this box, not the default
 *                 wide zone, so a blush / cheek shading does not blink off while talking
 *  A suppressInk box may carry a 5th value, its own grow. The paint is a gaussian start (sigma 1.5/3/6) + a harmonic fill
 *  (each painted pixel the mean of its painted / source 4-neighbours, 200 sweeps), so it meets the skin around it on every side. */
/* Vola-live: the values (old PER_X[id]) are profile.expressions.perX. */
/** {...DEF, ...per} for the character (old `{ ...DEF, ...(PER[id] || {}), ...fringe }`); regHair rides in it as per.regHair.
 *  Exported for the A2 equality test; finish() resolves through exactly this. */
export function resolvePer(spec, fringe = null) {
  const charPer = spec.regHair === true ? { ...spec.per, regHair: true } : spec.per
  return { ...DEF, ...(charPer || {}), ...(fringe ? { fringe } : {}) }
}
/** one expression's knobs (old perOf: `{ ...per, ...PER_X[id][eid] }` when listed, else the same object) */
export function perForExpr(per, spec, eid) {
  const o = (spec.perX || {})[eid]
  return o ? { ...per, ...o } : per
}

/* canvas + scale, set at call time */
let W = 768, H = 1024, S = 1
const si = v => Math.round(v * S)
const sr = v => Math.max(1, Math.round(v * S))
const sp = v => v * S
const sa = v => v * S * S
const idx = (x, y) => y * W + x

/* ------------------------------------------------------------------ small pixel kit */

/** squared-distance transform of one line (Felzenszwalb) */
function edt1d(g, n, out, v, z) {
  let k = 0
  v[0] = 0; z[0] = -1e20; z[1] = 1e20
  for (let q = 1; q < n; q++) {
    let s
    for (;;) {
      const p = v[k]
      s = ((g[q] + q * q) - (g[p] + p * p)) / (2 * q - 2 * p)
      if (s <= z[k]) k--; else break
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = 1e20
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const p = v[k]
    out[q] = (q - p) * (q - p) + g[p]
  }
}
/** Euclidean distance (px) from every pixel to the nearest pixel of `mask`; 0 on the mask */
function distTo(mask) {
  const INF = 1e12
  const f = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) f[i] = mask[i] ? 0 : INF
  const n = Math.max(W, H)
  const g = new Float32Array(n), o = new Float32Array(n), v = new Int32Array(n), z = new Float32Array(n + 1)
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) g[y] = f[y * W + x]
    edt1d(g, H, o, v, z)
    for (let y = 0; y < H; y++) f[y * W + x] = o[y]
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) g[x] = f[y * W + x]
    edt1d(g, W, o, v, z)
    for (let x = 0; x < W; x++) f[y * W + x] = Math.sqrt(o[x])
  }
  return f
}
const dilateR = (m, r) => { const d = distTo(m); const o = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) o[i] = d[i] <= r ? 1 : 0; return o }
const erodeR = (m, r) => {
  const inv = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) inv[i] = m[i] ? 0 : 1
  const d = distTo(inv); const o = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) o[i] = m[i] && d[i] > r ? 1 : 0; return o
}
const andM = (a, b) => { const o = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) o[i] = a[i] && b[i] ? 1 : 0; return o }
const orM = (a, b) => { const o = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) o[i] = a[i] || b[i] ? 1 : 0; return o }
const subM = (a, b) => { const o = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) o[i] = a[i] && !b[i] ? 1 : 0; return o }
const countM = m => { let n = 0; for (let i = 0; i < m.length; i++) if (m[i]) n++; return n }
const boxMask = (x0, y0, x1, y1) => {
  const m = new Uint8Array(W * H)
  for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) m[idx(x, y)] = 1
  return m
}
const bboxOf = m => {
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[idx(x, y)]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}
/** separable gaussian on a float plane, edge-clamped */
function blurF(src, sigma) {
  if (sigma <= 0) return Float32Array.from(src)
  const r = Math.max(1, Math.ceil(sigma * 3))
  const k = new Float32Array(2 * r + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + r] }
  for (let i = 0; i < k.length; i++) k[i] /= sum
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = 0
    for (let i = -r; i <= r; i++) a += src[y * W + Math.min(W - 1, Math.max(0, x + i))] * k[i + r]
    tmp[y * W + x] = a
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = 0
    for (let i = -r; i <= r; i++) a += tmp[Math.min(H - 1, Math.max(0, y + i)) * W + x] * k[i + r]
    out[y * W + x] = a
  }
  return out
}
/** 8-connected components of a mask: { lab (Int32, -1 outside), comps:[{id,area,x0,y0,x1,y1}] } */
function labelCC(m) {
  const lab = new Int32Array(W * H).fill(-1), comps = [], st = []
  for (let s = 0; s < W * H; s++) {
    if (!m[s] || lab[s] >= 0) continue
    const id = comps.length
    let area = 0, x0 = W, y0 = H, x1 = -1, y1 = -1
    lab[s] = id; st.push(s)
    while (st.length) {
      const i = st.pop(), x = i % W, y = (i - x) / W
      area++
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const j = ny * W + nx
        if (m[j] && lab[j] < 0) { lab[j] = id; st.push(j) }
      }
    }
    comps.push({ id, area, x0, y0, x1, y1 })
  }
  return { lab, comps }
}
function srgbToLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
function rgb2lab(r, g, b) {
  const R = srgbToLin(r), G = srgbToLin(g), B = srgbToLin(b)
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, Y = R * 0.2126 + G * 0.7152 + B * 0.0722, Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883
  const f = t => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116)
  const fx = f(X), fy = f(Y), fz = f(Z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}
const smooth01 = t => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t) }
const lumaAt = (b, o) => 0.299 * b[o] + 0.587 * b[o + 1] + 0.114 * b[o + 2]

/** ink = darkness x alpha, the thing the registration compares */
function inkOf(buf) {
  const v = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) { const o = i * 4; v[i] = (255 - lumaAt(buf, o)) * (buf[o + 3] / 255) }
  return v
}
function at(v, x, y) {
  if (x < 0 || y < 0 || x > W - 1 || y > H - 1) return 0
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1)
  const fx = x - x0, fy = y - y0
  return v[y0 * W + x0] * (1 - fx) * (1 - fy) + v[y0 * W + x1] * fx * (1 - fy) + v[y1 * W + x0] * (1 - fx) * fy + v[y1 * W + x1] * fx * fy
}
/** whole-pixel copy; RGB 0 under zero alpha, exactly what the cutter's own shift writes */
function shiftWhole(buf, tx, ty) {
  if (!tx && !ty) return buf
  const out = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) {
    const sy = y - ty
    if (sy < 0 || sy >= H) continue
    for (let x = 0; x < W; x++) {
      const sx = x - tx
      if (sx < 0 || sx >= W) continue
      const o = (y * W + x) * 4, q = (sy * W + sx) * 4, a = buf[q + 3]
      out[o] = a ? buf[q] : 0; out[o + 1] = a ? buf[q + 1] : 0; out[o + 2] = a ? buf[q + 2] : 0; out[o + 3] = a
    }
  }
  return out
}
/** bilinear shift on premultiplied alpha (assemble-src.mjs's shiftRGBA) */
function shiftSub(buf, tx, ty) {
  const out = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sxf = x - tx, syf = y - ty
    const x0 = Math.floor(sxf), y0 = Math.floor(syf), fx = sxf - x0, fy = syf - y0
    let r = 0, g = 0, b = 0, a = 0
    for (let k = 0; k < 4; k++) {
      const xx = Math.min(W - 1, Math.max(0, x0 + (k & 1))), yy = Math.min(H - 1, Math.max(0, y0 + (k >> 1)))
      const wgt = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy)
      if (wgt <= 0) continue
      const o = (yy * W + xx) * 4, al = buf[o + 3] / 255
      r += buf[o] * al * wgt; g += buf[o + 1] * al * wgt; b += buf[o + 2] * al * wgt; a += buf[o + 3] * wgt
    }
    const o = (y * W + x) * 4, al = a / 255
    out[o] = al > 0.002 ? Math.min(255, Math.round(r / al)) : 0
    out[o + 1] = al > 0.002 ? Math.min(255, Math.round(g / al)) : 0
    out[o + 2] = al > 0.002 ? Math.min(255, Math.round(b / al)) : 0
    out[o + 3] = Math.round(a)
  }
  return out
}
async function loadRGBA(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (info.width !== W || info.height !== H) throw new Error(`${file} is ${info.width}x${info.height}, expected ${W}x${H}`)
  return Buffer.from(data)
}
const writePng = (buf, w, h, file) => sharp(Buffer.from(buf), { raw: { width: w, height: h, channels: 4 } }).png().toFile(GUARD(file))

/** a layer file decoded onto its own box */
async function readLayer(pkgDir, rel, l) {
  const { data } = await sharp(path.join(pkgDir, rel)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { buf: data, x: l.x, y: l.y, w: l.w, h: l.h }
}
function over(canvas, L, alphaMul = 1) {
  for (let j = 0; j < L.h; j++) for (let i = 0; i < L.w; i++) {
    const x = L.x + i, y = L.y + j
    if (x < 0 || y < 0 || x >= W || y >= H) continue
    const s = (j * L.w + i) * 4, d = (y * W + x) * 4
    const a = L.buf[s + 3] / 255 * alphaMul
    if (a <= 0) continue
    const da = canvas[d + 3] / 255, oa = a + da * (1 - a)
    for (let c = 0; c < 3; c++) canvas[d + c] = Math.round((L.buf[s + c] * a + canvas[d + c] * da * (1 - a)) / oa)
    canvas[d + 3] = Math.round(oa * 255)
  }
}

/* ------------------------------------------------------------------ registration */

/**
 * The rigid shift that lays X's structure on B's, over `pts` (pixels away from the feature zone).
 * Coarse integer search on a slightly blurred ink map, then 0.25 px refinement on the sharp one.
 * `wts` (optional, one weight per point) weights the cost; with it null the arithmetic is what it was.
 */
function findShift(inkB, inkX, inkBs, inkXs, pts, span, wts = null) {
  const score = (b, x, tx, ty) => { let s = 0; for (let k = 0; k < pts.length; k++) { const i = pts[k], px = i % W, py = (i - px) / W; const d = Math.abs(b[i] - at(x, px - tx, py - ty)); s += wts ? wts[k] * d : d } return s }
  const e0 = score(inkB, inkX, 0, 0)
  let best = { tx: 0, ty: 0, e: score(inkBs, inkXs, 0, 0) }
  for (let ty = -span; ty <= span; ty++) for (let tx = -span; tx <= span; tx++) {
    const e = score(inkBs, inkXs, tx, ty)
    if (e < best.e) best = { tx, ty, e }
  }
  let fine = { tx: best.tx, ty: best.ty, e: score(inkB, inkX, best.tx, best.ty) }
  for (let dy = -1; dy <= 1 + 1e-9; dy += 0.25) for (let dx = -1; dx <= 1 + 1e-9; dx += 0.25) {
    const tx = best.tx + dx, ty = best.ty + dy
    const e = score(inkB, inkX, tx, ty)
    if (e < fine.e) fine = { tx, ty, e }
  }
  return { tx: fine.tx, ty: fine.ty, n: pts.length, gain: e0 ? 1 - fine.e / e0 : 0 }
}

/* ------------------------------------------------------------------ the hook API */

/**
 * Load the expression frames and put them where the base frames are BEFORE the head-scale step.
 * @param ctx { id, opts, framing, W, H, S }
 */
export async function begin(ctx) {
  W = ctx.W; H = ctx.H; S = ctx.S
  adopt(ctx.opts, ctx.id)   // Vola-live
  const dir = SPEC.frames.map(f => f.rel).join(' + ')
  const only = ctx.opts.exprOnly ? ctx.opts.exprOnly.split(',') : null
  const frames = {}, missing = []
  for (const e of exprsFor(ctx.id)) {
    if (only && !only.includes(e.src) && !only.includes(e.id)) continue
    /* Vola-live: the frame is <dir>/<src>.png in exactly ONE of profile.expressions.frames, searched in order; none or
       two is an error (the old tool skipped a missing frame and the expression vanished, DESIGN §3.4 #7) */
    const f = frameFile(SPEC.frames, e.src)
    frames[e.id] = await loadRGBA(f)
  }
  const fr = ctx.framing
  let moved = null
  if (fr && !fr.skipped && !fr.identity) {
    if (fr.s !== 1 || !Number.isInteger(fr.tx) || !Number.isInteger(fr.ty)) {
      throw new Error(`expressions: ${ctx.id}'s base refit is not a whole-pixel translate (s ${fr.s}, ${fr.tx},${fr.ty}); the expression frames would have to be resampled, which this pass refuses`)
    }
    for (const k of Object.keys(frames)) frames[k] = shiftWhole(frames[k], fr.tx, fr.ty)
    moved = [fr.tx, fr.ty]
  }
  LOG(`  expressions: ${Object.keys(frames).length} frame(s) from ${dir}`
    + (missing.length ? `  (missing: ${missing.join(', ')})` : '') + (moved ? `  translated by the base's refit (${moved[0]}, ${moved[1]})` : ''))
  return { id: ctx.id, frames, missing, dir, xform: moved ? `translate ${moved[0]},${moved[1]}` : 'none' }
}

/** Vola-live: the spec, log and guard of this build; EXTRA for this character from the profile's id list */
function adopt(opts, id) {
  SPEC = opts.exprSpec; LOG = opts.log; GUARD = opts.guard
  EXTRA = { [id]: (SPEC.extra || []).map(x => EXTRA_EXPRESSIONS[x]) }
}

/** Vola-live: the one file `<src>.png` among the frame dirs ([{ rel, abs }]); throws when it is in none or in two.
 *  Exported: index.mjs inputsOf() resolves the inputs with the same rule. Returns the absolute path. */
export function frameFile(dirs, src) {
  const hits = dirs.filter(d => fs.existsSync(path.join(d.abs, `${src}.png`)))
  if (hits.length !== 1) {
    throw new Error(`expression frame ${src}.png is in ${hits.length ? hits.map(d => d.rel).join(' and ') : 'none'} of profile.expressions.frames (${dirs.map(d => d.rel).join(', ')}); it must be in exactly one`)
  }
  return path.join(hits[0].abs, `${src}.png`)
}

/**
 * The base's head-scale transform, applied to the expression frames with the SAME functions and the
 * SAME base `closed` frame (the jaw cut is read off it), before the base frames themselves change.
 * @param ctx { rescaleHead, reframeFrames, g0, topWanted, scale, closed }
 */
export async function headScale(EX, ctx) {
  const keys = Object.keys(EX.frames)
  for (let i = 0; i < keys.length; i += 3) {
    const chunk = keys.slice(i, i + 3)
    const Fx = { closed: Buffer.from(ctx.closed) }
    const slots = ['open', 'blink', 'blinkOpen']
    slots.forEach((s, j) => { Fx[s] = chunk[j] ? EX.frames[chunk[j]] : Buffer.from(ctx.closed) })
    await ctx.rescaleHead(Fx, ctx.g0, ctx.scale, null)
    await ctx.reframeFrames(Fx, ctx.topWanted)
  }
  EX.xform = `head scale ${ctx.scale} + reframe`
}

/**
 * Cut the patches and add the layers + the `expressions` list to the model.
 * @param ctx { F, g, built, model, textures, pkgDir, workDir, cfg, W, H, S }
 */
export async function finish(EX, ctx) {
  W = ctx.W; H = ctx.H; S = ctx.S
  adopt(ctx.opts, EX.id)   // Vola-live
  const { F, g, model, textures, pkgDir, workDir } = ctx
  const id = EX.id
  /* what a re-cut needs, so the patches can be tuned without rebuilding the character:
     node expressions.mjs --replay <work>/expr-cache.bin <pkgDir> [--work=<dir>] */
  fs.mkdirSync(GUARD(workDir), { recursive: true })
  fs.writeFileSync(GUARD(path.join(workDir, 'expr-cache.bin')), v8.serialize({
    W, H, S, id, xform: EX.xform, frames: EX.frames, closed: F.closed,
    g: { eggShape: g.eggShape, eggCore: g.eggCore, faceKeep: g.faceKeep, hair: g.hair, eyeBoxes: g.eyeBoxes, browBoxes: g.browBoxes, mouthBox: g.mouthBox, neckY: g.neckY,
         faceBox: g.faceBox, headSilBox: g.headSilBox, head: g.head, skinPalette: g.skinPalette },
  }))
  const per = resolvePer(SPEC, ctx.opts.exprFringe)   // Vola-live: was { ...DEF, ...(PER[id] || {}), ...fringe }
  const B = F.closed
  const outDir = path.join(workDir, 'expr')
  fs.mkdirSync(GUARD(outDir), { recursive: true })
  /* PER.browRoot: brow ink the cutter left in front_hair at a brow's root moves to `brows` first */
  if (per.browRoot && model.layers.some(l => l.id === 'brows')) {
    for (const s of await browRootToBrows(per.browRoot, { B, hair: g.hair, browBoxes: g.browBoxes, model, pkgDir })) LOG('  ' + s)
  }

  /* ---- what the base is made of */
  const layerBy = lid => model.layers.find(l => l.id === lid)
  const faceL = layerBy('face'), mouthL = layerBy('mouth'), browsL = layerBy('brows')
  const faceC = Buffer.alloc(W * H * 4)
  over(faceC, await readLayer(pkgDir, faceL.texture, faceL))
  /* the base with no features: the face layer where it is solid, the frame itself elsewhere */
  const clean = Buffer.from(B)
  for (let i = 0; i < W * H; i++) if (faceC[i * 4 + 3] >= 250) { const o = i * 4; clean[o] = faceC[o]; clean[o + 1] = faceC[o + 1]; clean[o + 2] = faceC[o + 2]; clean[o + 3] = 255 }

  /* ---- geometry: zone and ownership */
  const eb = g.eyeBoxes, bb = g.browBoxes.filter(Boolean), mb = g.mouthBox
  const ex0 = Math.min(...eb.map(b => b.x0)), ex1 = Math.max(...eb.map(b => b.x1))
  const ey0 = Math.min(...eb.map(b => b.y0)), ey1 = Math.max(...eb.map(b => b.y1))
  const hasBrowLayer = !!browsL
  /* 수아: her brow arcs are drawn into front_hair, which sits ABOVE every expression layer, so a patch
     that redraws them shows two brows (measured). Her patch therefore starts just above the eyes and
     her brows stay as drawn; every other character's starts 34 px above its brows. */
  const topPad = per.topPad || 0   // PER.topPad (이슬): a widened eye's lash rises above the default noBrows top
  const topY = per.noBrows ? ey0 - si(5 + topPad) : Math.min(ey0, ...bb.map(b => b.y0)) - si(34)
  const botY = g.neckY - si(8)
  const zx0 = Math.min(ex0, ...bb.map(b => b.x0)), zx1 = Math.max(ex1, ...bb.map(b => b.x1))
  const zone = boxMask(zx0 - si(5), topY, zx1 + si(5), botY)
  const hair = g.hair
  /* the jaw: per column, the ink row of the jaw line (the search rescaleHead uses); the patch stays
     6 px above it, so it can never take the jaw stroke or the neck */
  const jawY = new Int32Array(W).fill(-1)
  for (let x = 0; x < W; x++) {
    let yBot = -1
    for (let y = H - 1; y >= 0; y--) if (g.eggShape[idx(x, y)]) { yBot = y; break }
    if (yBot < 0) continue
    let best = -1, bestL = 1e9
    for (let y = Math.max(0, yBot - si(20)); y <= Math.min(H - 1, yBot + si(8)); y++) {
      const o = idx(x, y) * 4
      if (B[o + 3] < 200) continue
      const L = lumaAt(B, o)
      if (L < bestL) { bestL = L; best = y }
    }
    if (best >= 0 && bestL < 150) jawY[x] = best
  }
  { const known = []; for (let x = 0; x < W; x++) if (jawY[x] >= 0) known.push(x)
    for (let x = 0; x < W; x++) {
      if (jawY[x] >= 0 || known.length < 2) continue
      let lo = null, hi = null
      for (const k of known) { if (k < x) lo = k; else { hi = k; break } }
      jawY[x] = lo === null ? jawY[hi] : hi === null ? jawY[lo] : Math.round(jawY[lo] + (jawY[hi] - jawY[lo]) * (x - lo) / (hi - lo))
    } }
  const aboveJaw = new Uint8Array(W * H)
  for (let x = 0; x < W; x++) for (let y = 0; y <= (jawY[x] >= 0 ? jawY[x] : g.neckY) - si(6); y++) aboveJaw[idx(x, y)] = 1
  /* the outline: nothing within 7 px of the figure's silhouette (cheek, jaw and ear outlines) */
  const sil = distTo(Uint8Array.from({ length: W * H }, (_, i) => B[i * 4 + 3] > 16 ? 0 : 1))
  const silOK = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) silOK[i] = sil[i] > si(per.sil) ? 1 : 0
  let skinOwn = andM(andM(andM(g.eggCore, g.faceKeep), aboveJaw), andM(silOK, zone))    // tapered at its edge
  /* PER.ownEyes = m. faceKeep is fillHoles(skin) + ring; an eye that opens onto the hair (다은's image-left
     eye, outer corner against a bang lock) is not a hole in the skin, so faceKeep leaves it out and no patch
     could ever cover it. Own the eye boxes grown by m px (solid, not dark hair, above the jaw, off the
     silhouette, in the zone); the hair is still subtracted below by notHair. Not eggCore: the egg is built
     from faceKeep too, so the same unfilled eye is missing from it. */
  if (per.ownEyes) {
    let eyeOwn = new Uint8Array(W * H)
    for (const b of g.eyeBoxes) eyeOwn = orM(eyeOwn, boxMask(b.x0 - si(per.ownEyes), b.y0 - si(per.ownEyes + topPad), b.x1 + si(per.ownEyes), b.y1 + si(per.ownEyes)))
    const solid = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) solid[i] = B[i * 4 + 3] >= 200 && !(g.hair[i] && lumaAt(B, i * 4) < (per.eyeHairL ?? 150)) ? 1 : 0
    skinOwn = orM(skinOwn, andM(andM(andM(eyeOwn, solid), aboveJaw), andM(silOK, zone)))
  }
  const ones = new Uint8Array(W * H).fill(1)
  /* hard: the hair layer covers that edge. Right at a brow the gap is 0 — the neutral brows layer
     fades out with `redrawn`, so every pixel of it has to be covered, strand contact included */
  let browNear = new Uint8Array(W * H)
  if (hasBrowLayer) for (const b of bb) browNear = orM(browNear, boxMask(b.x0 - si(10), b.y0 - si(10), b.x1 + si(10), b.y1 + si(10)))
  /* At an owned eye the gap to the hair is 0, as at a brow: the base eye layer lies under the patch, so
     every pixel of it next to the hair has to be covered (front_hair above hides the edge). There only DARK
     hair-mask pixels count as hair (the cutter's mask also takes bright eye pixels beside a lock — 다은's
     lower sclera edge, 3 px — that no layer above the patch draws), grown by eyeHairGap (default 1) so the
     base keeps the lock's anti-aliased rim (a hard patch edge there showed as stair-steps). */
  let eyeNear = new Uint8Array(W * H), hairInk = null
  if (per.ownEyes) {
    for (const b of g.eyeBoxes) eyeNear = orM(eyeNear, boxMask(b.x0 - si(per.ownEyes), b.y0 - si(per.ownEyes + topPad), b.x1 + si(per.ownEyes), b.y1 + si(per.ownEyes)))
    const hairInk0 = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) hairInk0[i] = hair[i] && lumaAt(B, i * 4) < (per.eyeHairL ?? 150) ? 1 : 0
    hairInk = dilateR(hairInk0, per.eyeHairGap ?? 1)
  }
  let notHair = orM(subM(ones, dilateR(hair, per.hairGap)), andM(browNear, subM(ones, hair)))
  if (per.ownEyes) notHair = orM(notHair, andM(eyeNear, subM(ones, hairInk)))
  let own = andM(skinOwn, notHair)
  if (per.fringe === 'below') {
    /* start under the fringe: per column, below the lowest hair pixel above the eyes */
    const lim = new Uint8Array(W * H)
    for (let x = 0; x < W; x++) {
      let low = -1
      for (let y = Math.max(0, ey0 - si(2)); y >= 0; y--) if (hair[idx(x, y)]) { low = y; break }
      for (let y = low + si(per.hairGap + 1); y < H; y++) lim[idx(x, y)] = 1
    }
    own = andM(own, lim)
  }
  /* PER.holeMax = n (카이): his black bangs keep the drawing's own light flecks as drawn (hairClean off), so the hair mask
     has pin-holes in it, and with ownEyes + eyeHairL 0 the patch owns them: it printed the expression frame's pixel there
     (its strand lies a pixel off), a dark dot inside a strand's highlight. A non-hair component (solid, 8-connected) of
     <= n px that the hair mask encloses (not touching the zone's edge) is not owned, so the base shows it as at rest; it is
     all hair around it, which the layers above cover. Unset = unchanged. */
  let holeNote = null
  if (per.holeMax) {
    const zb = bboxOf(zone)
    const nh = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) nh[i] = zone[i] && !hair[i] && B[i * 4 + 3] >= 200 ? 1 : 0
    const cc = labelCC(nh), small = new Uint8Array(cc.comps.length)
    let nC = 0, nPx = 0
    for (const c of cc.comps) if (c.area <= sa(per.holeMax) && c.x0 > zb.x0 && c.y0 > zb.y0 && c.x1 < zb.x1 && c.y1 < zb.y1) { small[c.id] = 1; nC++ }
    for (let i = 0; i < W * H; i++) if (cc.lab[i] >= 0 && small[cc.lab[i]]) { if (own[i]) nPx++; own[i] = 0 }
    holeNote = `holeMax ${per.holeMax}: ${nC} enclosed non-hair speck(s) in the zone, ${nPx} owned px of them left to the base`
  }
  const ownI = andM(own, zone)
  /* Vola-live: the EXPR_DEBUG ownership dump (an env-gated debug write, no output effect) is not ported */
  const featZone = dilateR(zone, si(6))

  /* ---- registration structure points: everything solid, in the head window, outside the feature zone */
  const inkB = inkOf(B), inkBs = blurF(inkB, sp(1.2))
  const win = boxMask(g.faceBox.x0 - si(10), Math.max(0, g.headSilBox.y0), g.faceBox.x1 + si(10), g.neckY + si(6))
  const grad = new Float32Array(W * H)
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = idx(x, y); grad[i] = Math.abs(inkBs[i + 1] - inkBs[i - 1]) + Math.abs(inkBs[i + W] - inkBs[i - W]) }
  const ptsOf = (region, excl) => { const p = []; for (let i = 0; i < W * H; i++) if (region[i] && !featZone[i] && B[i * 4 + 3] >= 200 && grad[i] > 5 && !(excl && excl[i])) p.push(i); return p }
  /* [regHair] hair is NOT structure to register on. A strand is one or two px wide, the generator redraws
     every strand freehand, and the head window above the brows is almost nothing else: 64% of 아빠's points
     and 84% of 엄마's were hair (measured; 72% / 91% once the strands' anti-aliased rims count too). The fit
     followed them, so 아빠's 기쁨 came out -1.75 px and his 고민 -1.5 px where the face itself wants about 0,
     and the patch's nose landed off the base's (livliv-lab findings.md §5, cause 1). The hair mask grown by
     regHairGrow px therefore leaves the point set, which keeps the face contour, the jaw, the ears and the
     collar — and 엄마's 고민, where the non-hair structure agreed with the old fit, barely moves (-2.5 ->
     -2.25 px) while the fit's gain triples. If a character has too few non-hair points for a stable fit the
     hair comes back at weight regHairW instead of being dropped; `mode` on the shift says which happened.
     Vola-live: default OFF (`=== true`; the nose copy had `=== false ? null :`, i.e. on for everyone) */
  const regHairM = per.regHair === true ? dilateR(hair, sr(per.regHairGrow)) : null
  const ptsAll = ptsOf(win, null)
  const ptsFree = regHairM ? ptsOf(win, regHairM) : ptsAll
  let pts0 = ptsFree, regW = null, regMode = 'every structure point'
  if (regHairM) {
    if (ptsFree.length >= per.regMinPts) regMode = `hair out (grow ${per.regHairGrow}): ${ptsAll.length} -> ${ptsFree.length} points`
    else {
      pts0 = ptsAll
      regW = Float32Array.from(ptsAll, i => regHairM[i] ? per.regHairW : 1)
      regMode = `hair at weight ${per.regHairW} (only ${ptsFree.length} non-hair points of ${ptsAll.length})`
    }
  }
  LOG(`  registration: ${regMode}`)

  const notes = [], results = [], layersOut = []
  if (holeNote) notes.push(holeNote)
  const baseRest = await compositeBase(model, pkgDir, null)
  await writePng(baseRest, W, H, path.join(outDir, 'base-rest.png'))
  const mouthFrames = []
  for (const f of mouthL.frames) mouthFrames.push(await readLayer(pkgDir, f, mouthL))
  const layerCache = {}
  const getLayer = async l => (layerCache[l.id + ':' + l.texture] ||= await readLayer(pkgDir, l.texture, l))

  const skinDE = (b, o) => { const l = rgb2lab(b[o], b[o + 1], b[o + 2]); let m = 1e9; for (const p of g.skinPalette) m = Math.min(m, Math.hypot(p[0] - l[0], p[1] - l[1], p[2] - l[2])); return m }
  /* PER_X: one expression's knobs over the character's (the same object when it has none) */
  const perOf = eid => perForExpr(per, SPEC, eid)   // Vola-live: was PER_X[id][eid] over per
  for (const E of exprsFor(id)) {
    const X0 = EX.frames[E.id]
    if (!X0) continue
    const per = perOf(E.id)
    const r = { id: E.id, src: E.src }
    if ((SPEC.perX || {})[E.id]) r.perX = SPEC.perX[E.id]
    /* 1. register */
    const inkX = inkOf(X0), inkXs = blurF(inkX, sp(1.2))
    const sh = findShift(inkB, inkX, inkBs, inkXs, pts0, si(10), regW)
    const round = v => Math.abs(v - Math.round(v)) < 0.13 ? Math.round(v) : v
    const tx = round(sh.tx), ty = round(sh.ty)
    const X1 = Number.isInteger(tx) && Number.isInteger(ty) ? shiftWhole(X0, tx, ty) : shiftSub(X0, tx, ty)
    r.shift = { tx, ty, points: sh.n, gain: +sh.gain.toFixed(3), mode: regMode }
    /* residual per quadrant of the structure, after the shift: a rigid shift is enough only if these are ~0 */
    {
      const ink1 = inkOf(X1), ink1s = blurF(ink1, sp(1.2))
      const cx = Math.round(g.head.cx), cy = Math.round(g.head.cy)
      const quads = { L: p => p % W < cx, R: p => p % W >= cx, top: p => (p / W | 0) < cy, bot: p => (p / W | 0) >= cy }
      r.resid = {}; r.residN = {}
      for (const [k, f] of Object.entries(quads)) {
        const sub = [], subW = regW ? [] : null
        pts0.forEach((p, q) => { if (f(p)) { sub.push(p); if (subW) subW.push(regW[q]) } })
        r.residN[k] = sub.length
        const s2 = sub.length > per.residMinPts ? findShift(inkB, ink1, inkBs, ink1s, sub, si(3), subW && Float32Array.from(subW)) : null
        r.resid[k] = s2 ? [+s2.tx.toFixed(2), +s2.ty.toFixed(2)] : null
      }
    }
    /* 2. skin tone: median (B - X) over flat skin just outside the zone */
    const ring = andM(subM(dilateR(zone, si(40)), zone), andM(g.eggCore, subM(new Uint8Array(W * H).fill(1), dilateR(hair, si(4)))))
    const dev = [[], [], []]
    for (let i = 0; i < W * H; i++) {
      if (!ring[i]) continue
      const o = i * 4
      const dd = [B[o] - X1[o], B[o + 1] - X1[o + 1], B[o + 2] - X1[o + 2]]
      if (Math.max(...dd.map(Math.abs)) < 24 && X1[o + 3] >= 250 && lumaAt(B, o) > 150) for (let c = 0; c < 3; c++) dev[c].push(dd[c])
    }
    const med = a => { if (!a.length) return 0; a.sort((p, q) => p - q); return a[a.length >> 1] }
    const off = dev.map(med).map(v => Math.max(-12, Math.min(12, Math.round(v))))
    r.tone = { offset: off, samples: dev[0].length }
    const X = Buffer.from(X1)
    for (let i = 0; i < W * H; i++) { const o = i * 4; if (!X[o + 3]) continue; for (let c = 0; c < 3; c++) X[o + c] = Math.max(0, Math.min(255, X[o + c] + off[c])) }

    /* 3. feature masks. D = max channel difference against the clean face; the expression's drawn
          features and the base's drawn features both count, so the base is always fully covered. */
    /* Where a brow runs into a strand of bangs (엄마's image-left one), the expression frame's strand
       edge is a pixel or two off the base's, and with gap 0 that lands as a dark chunk beside the
       strand (measured). So within 4 px of the hair, at a brow, anything drawn in the expression frame
       is painted over with the face layer's skin: no drawn pixel of the patch touches the hair mask,
       the brow simply starts a few px clear of the strand. */
    if (hasBrowLayer) {
      const band = andM(andM(browNear, dilateR(hair, 4)), subM(ones, hair))
      for (let i = 0; i < W * H; i++) if (band[i] && faceC[i * 4 + 3] >= 250) { const o = i * 4; if (X[o + 3] && skinDE(X, o) > 10) { X[o] = clean[o]; X[o + 1] = clean[o + 1]; X[o + 2] = clean[o + 2] } }
    }
    /* PER_X suppressInk / suppressInkAll (이슬8): the frame's grey / lavender-white ink in the boxes is painted out with the
       frame's own surroundings (see the PER_X comment). Done before the feature masks, so they see the painted frame. */
    for (const [boxes, mode, whole] of [[per.suppressInk, per.suppressInkFill || 'skin', false], [per.suppressInkAll, 'all', false], [per.suppressShade, 'skin', true]]) {
      if (!boxes || !boxes.length) continue
      const inBox = new Uint8Array(W * H)
      for (const [a, b, c, d] of boxes) for (let y = si(b); y <= si(d); y++) for (let x = si(a); x <= si(c); x++) inBox[idx(x, y)] = 1
      const sel = new Uint8Array(W * H), dark = new Uint8Array(W * H)
      for (let i = 0; i < W * H; i++) {
        if (!inBox[i] || X[i * 4 + 3] < 128) continue
        const [L, A, Bb] = rgb2lab(X[i * 4], X[i * 4 + 1], X[i * 4 + 2]), ch = Math.hypot(A, Bb)
        if (L < 45 && !whole) { dark[i] = 1; continue }
        if (whole || (ch < 14 && Bb < 6) || (L > 91 && ch < 9)) sel[i] = 1
      }
      /* grown by suppressInkGrow (default 1), or by a box's own 5th value, inside that box */
      let kill = new Uint8Array(W * H)
      const grows = new Map()
      for (const bx of boxes) { const gr = bx[4] ?? per.suppressInkGrow ?? 1; if (!grows.has(gr)) grows.set(gr, []); grows.get(gr).push(bx) }
      for (const [gr, bxs] of grows) {
        const m = new Uint8Array(W * H)
        for (const [a, b, c, d] of bxs) for (let y = si(b); y <= si(d); y++) for (let x = si(a); x <= si(c); x++) m[idx(x, y)] = 1
        kill = orM(kill, andM(dilateR(andM(sel, inBox), gr), m))
      }
      kill = andM(kill, subM(ones, dark))
      const hair1 = dilateR(hair, 1)
      const okM = new Float32Array(W * H), chs = [0, 1, 2].map(() => new Float32Array(W * H))
      for (let i = 0; i < W * H; i++) {
        if (kill[i] || hair1[i] || X[i * 4 + 3] < 250) continue
        if (mode !== 'all' && skinDE(X, i * 4) > per.ns) continue
        okM[i] = 1; for (let c = 0; c < 3; c++) chs[c][i] = X[i * 4 + c]
      }
      const fl3 = [1.5, 3, 6].map(sg => ({ bm: blurF(okM, sp(sg)), bc: chs.map(p => blurF(p, sp(sg))) }))
      /* the gaussian is the start; then a harmonic fill (Gauss-Seidel, 4-neighbours, 200 sweeps): every painted pixel becomes
         the mean of its painted / source neighbours, so the fill meets the skin around it on every side with no mean shift
         (a plain gaussian took the shade of the darker skin by the lash). Non-source neighbours (lash, hair) do not count. */
      const kl = [], val = new Float32Array(W * H * 3)
      let n = 0, miss = 0
      for (let i = 0; i < W * H; i++) {
        if (okM[i]) for (let c = 0; c < 3; c++) val[i * 3 + c] = X[i * 4 + c]
        if (!kill[i]) continue
        const fl = fl3.find(f => f.bm[i] > 0.15)
        if (fl) { for (let c = 0; c < 3; c++) val[i * 3 + c] = fl.bc[c][i] / fl.bm[i]; n++ }
        else { for (let c = 0; c < 3; c++) val[i * 3 + c] = X[i * 4 + c]; miss++ }   // no source near: starts as drawn, the sweeps reach it if they can
        kl.push(i)
      }
      const live = new Uint8Array(W * H); for (const i of kl) live[i] = 1
      for (let it = 0; it < 200; it++) for (const i of kl) {
        let s0 = 0, s1 = 0, s2 = 0, k = 0
        for (const j of [i - 1, i + 1, i - W, i + W]) {
          if (j < 0 || j >= W * H || !(live[j] || okM[j])) continue
          s0 += val[j * 3]; s1 += val[j * 3 + 1]; s2 += val[j * 3 + 2]; k++
        }
        if (k) { val[i * 3] = s0 / k; val[i * 3 + 1] = s1 / k; val[i * 3 + 2] = s2 / k }
      }
      for (const i of kl) for (let c = 0; c < 3; c++) X[i * 4 + c] = Math.max(0, Math.min(255, Math.round(val[i * 3 + c])))
      r[whole ? 'suppressShade' : mode === 'all' ? 'suppressInkAll' : 'suppressInk'] = { painted: n, unfilled: miss }
    }
    /* PER_X.shadeLift (이슬8): boxes whose shading is lifted to the light skin around them. Painted: every pixel of the boxes
       with L* >= 45 that is more than 1 px from L* < 45 ink (so a lash keeps its own 1 px rim).
       Sources: the frame's skin (palette dE <= ns) outside the painted set with L* >= shadeLiftL, never base hair. Gaussian
       start (sigma 2..32) + the harmonic fill (1500 sweeps; non-source neighbours do not count), so the painted area is the
       even light skin of its surroundings; then mixed in with weight d / (shadeLiftFeather + 1), d = distance to the
       nearest pixel outside the boxes that is not within 3 px of L* < 45 ink (the boxes may step along a lash: the lash
       side and the joins between boxes are not edges). */
    if (per.shadeLift && per.shadeLift.length) {
      const inBox = new Uint8Array(W * H), fe = per.shadeLiftFeather || 0
      for (const [a, b, c, d] of per.shadeLift) for (let y = si(b); y <= si(d); y++) for (let x = si(a); x <= si(c); x++) inBox[idx(x, y)] = 1
      const Lof = i => rgb2lab(X[i * 4], X[i * 4 + 1], X[i * 4 + 2])[0]
      const dark = new Uint8Array(W * H)
      for (let i = 0; i < W * H; i++) if (X[i * 4 + 3] >= 128 && Lof(i) < 45) dark[i] = 1
      const nearDark = dilateR(dark, 1), hair1 = dilateR(hair, 1)
      const dEdge = distTo(subM(subM(ones, inBox), dilateR(dark, 3)))
      const wB = new Float32Array(W * H); for (let i = 0; i < W * H; i++) wB[i] = fe ? Math.min(1, dEdge[i] / (fe + 1)) : 1
      const paint = new Uint8Array(W * H), okM = new Float32Array(W * H), chs = [0, 1, 2].map(() => new Float32Array(W * H))
      for (let i = 0; i < W * H; i++) {
        if (X[i * 4 + 3] < 250) continue
        // painted also inside the hair mask: in her owned eye boxes the patch shows there (eyeHairL 0), and anything under
        // front_hair / side_hair is hidden anyway; the sources never come from it
        if (inBox[i] && !nearDark[i] && !dark[i]) { paint[i] = 1; continue }
        if (!hair1[i] && skinDE(X, i * 4) <= per.ns && Lof(i) >= (per.shadeLiftL ?? 84)) { okM[i] = 1; for (let c = 0; c < 3; c++) chs[c][i] = X[i * 4 + c] }
      }
      const fl3 = [2, 4, 8, 16, 32].map(sg => ({ bm: blurF(okM, sp(sg)), bc: chs.map(p => blurF(p, sp(sg))) }))
      const kl = [], val = new Float32Array(W * H * 3)
      for (let i = 0; i < W * H; i++) {
        if (okM[i]) for (let c = 0; c < 3; c++) val[i * 3 + c] = X[i * 4 + c]
        if (!paint[i]) continue
        const fl = fl3.find(f => f.bm[i] > 0.05)
        for (let c = 0; c < 3; c++) val[i * 3 + c] = fl ? fl.bc[c][i] / fl.bm[i] : X[i * 4 + c]
        kl.push(i)
      }
      for (let it = 0; it < 1500; it++) for (const i of kl) {
        let s0 = 0, s1 = 0, s2 = 0, k = 0
        for (const j of [i - 1, i + 1, i - W, i + W]) {
          if (j < 0 || j >= W * H || !(paint[j] || okM[j])) continue
          s0 += val[j * 3]; s1 += val[j * 3 + 1]; s2 += val[j * 3 + 2]; k++
        }
        if (k) { val[i * 3] = s0 / k; val[i * 3 + 1] = s1 / k; val[i * 3 + 2] = s2 / k }
      }
      for (const i of kl) { const w = wB[i]; for (let c = 0; c < 3; c++) X[i * 4 + c] = Math.max(0, Math.min(255, Math.round(X[i * 4 + c] * (1 - w) + val[i * 3 + c] * w))) }
      r.shadeLift = kl.length
    }
    /* "Drawn" = not skin: farther than T_NS (dE) from every colour of the face's own skin palette.
       Smooth shading and blush stay inside that, ink, sclera, teeth, tongue and mouth interior do
       not. A drawn pixel of the expression counts as a NEW feature when the base has nothing drawn
       within 2 px of it (a line both frames share, the nose, never does), and a drawn pixel of the
       base counts as GONE when the expression has nothing within 2 px. On top of that the base's own
       eye / brow / mouth boxes are always covered, so no neutral feature can show through. */
    const nsX = new Uint8Array(W * H), nsB = new Uint8Array(W * H)
    const zoneBox = bboxOf(zone)
    for (let y = zoneBox.y0; y <= zoneBox.y1; y++) for (let x = zoneBox.x0; x <= zoneBox.x1; x++) {
      const i = idx(x, y)
      if (!own[i] || !zone[i]) continue
      const o = i * 4
      if (X[o + 3] >= 128 && skinDE(X, o) > per.ns) nsX[i] = 1
      if (B[o + 3] >= 128 && skinDE(B, o) > per.ns) nsB[i] = 1
    }
    /* per.suppress[id] = y: X's drawn ink above that row is replaced by the face layer's skin. 수아's
       worried brows sit 8-13 px below the ones drawn into front_hair, which is above every expression
       layer, so keeping them would show two pairs of brows. */
    const supY = per.suppress && per.suppress[E.id]
    if (supY) {
      /* a number = every row above it; an array = boxes [x0, y0, x1, y1] (다은: her tilted head puts a brow and
         the other eye's lash on the same rows) */
      const inSup = new Uint8Array(W * H)
      /* a box with a 5th element 'face' (카이) is not a suppress box: every pixel of it takes the face layer, i.e. exactly
         what shows there at rest (applied after the suppress boxes, whatever suppressFill / suppressWhole say) */
      const inFace = new Uint8Array(W * H)
      if (Array.isArray(supY)) { for (const [a, b, c, d, mode] of supY) { const m = mode === 'face' ? inFace : inSup; for (let y = si(b); y <= si(d); y++) for (let x = si(a); x <= si(c); x++) m[idx(x, y)] = 1 } }
      else for (let i = 0; i < W * H; i++) inSup[i] = ((i / W) | 0) < si(supY) ? 1 : 0
      const above = new Uint8Array(W * H)
      for (let i = 0; i < W * H; i++) above[i] = nsX[i] && inSup[i] ? 1 : 0
      const kill = per.suppressWhole ? inSup : dilateR(above, 4)   // PER.suppressWhole: every px of the boxes, not only the ink grown 4 px
      /* PER.suppressFill 'frame' | 'skin' (이슬): the face layer is not ink-free above her eyes (it still holds bits
         of the base lash and their soft rim), so every suppressed pixel takes the gaussian mean (sigma 3) of the
         solid skin around it (the frame's own, or the face layer's) that is > 2 px from ink and not itself suppressed */
      let fill = null, nFill = 0, nBase = 0
      /* 'base': the boxes take the BASE's own pixels (the package's rest composite: skin between the strands, the
         strands' rims exactly as they show at rest) more than 2 px from the base's dark ink (luma < 170: the neutral lash);
         the rest (that lash and its light anti-aliased rim) is filled (sigma 2, 4, 8) from those base pixels and,
         outside the boxes, from the frame's own skin (> 2 px from its ink), so the fill runs on into the frame's skin */
      if (per.suppressFill === 'base') {
        const B = baseRest   // the package's own rest composite (what shows at rest), not the source frame
        // dark = the base's non-hair ink (the strands' own grey outlines are hair, drawn above anyway); the fill never
        // samples hair (cutter hair mask grown 1 px), so no lavender bleeds into the skin
        const dark = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) dark[i] = B[i * 4 + 3] >= 128 && lumaAt(B, i * 4) < 170 && !hair[i] ? 1 : 0
        const nearDark = dilateR(dark, 2), hair1 = dilateR(hair, 1)
        const inkXm = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) inkXm[i] = X[i * 4 + 3] >= 128 && skinDE(X, i * 4) > per.ns ? 1 : 0
        const nearInkX = dilateR(inkXm, 2)
        const okM = new Float32Array(W * H), ch = [0, 1, 2].map(() => new Float32Array(W * H))
        for (let i = 0; i < W * H; i++) {
          if (hair1[i]) continue
          if (inSup[i]) { if (B[i * 4 + 3] >= 250 && !nearDark[i]) { okM[i] = 1; for (let c = 0; c < 3; c++) ch[c][i] = B[i * 4 + c] } }
          else if (X[i * 4 + 3] >= 250 && faceC[i * 4 + 3] >= 250 && !nearInkX[i]) { okM[i] = 1; for (let c = 0; c < 3; c++) ch[c][i] = X[i * 4 + c] }
        }
        const fl3 = [2, 4, 8].map(sg => ({ bm: blurF(okM, sp(sg)), bc: ch.map(p => blurF(p, sp(sg))) }))
        /* PER_X.suppressFeather = f (이슬8, box form only): the replacement ramps in over the f px inside each box's edge
           (weight (edge distance + 1) / (f + 1)), so a box laid over the frame's own shading leaves no straight edge.
           Unset = weight 1 everywhere, exactly the copy above. (kai8: 'face' boxes are not suppress boxes, so skipped.) */
        const fe = Array.isArray(supY) ? per.suppressFeather || 0 : 0, wSup = fe ? new Float32Array(W * H) : null
        if (fe) for (const [a, b, c, d, mode] of supY) { if (mode === 'face') continue; for (let y = si(b); y <= si(d); y++) for (let x = si(a); x <= si(c); x++) {
          const e = Math.min(x - si(a), si(c) - x, y - si(b), si(d) - y) + 1, q = idx(x, y)
          wSup[q] = Math.max(wSup[q], Math.min(1, e / (fe + 1)))
        } }
        const put = (o, i, v) => { const w = wSup ? wSup[i] : 1; for (let c = 0; c < 3; c++) X[o + c] = w >= 1 ? v[c] : Math.round(X[o + c] * (1 - w) + v[c] * w) }
        let n = 0
        for (let i = 0; i < W * H; i++) if (kill[i] && inSup[i] && B[i * 4 + 3] >= 250) {
          const o = i * 4
          if (!nearDark[i]) { put(o, i, [B[o], B[o + 1], B[o + 2]]); nBase++ }
          else { const fl = fl3.find(f => f.bm[i] > 0.15); if (fl) { put(o, i, [0, 1, 2].map(c => Math.round(fl.bc[c][i] / fl.bm[i]))); nFill++ } }
          nsX[i] = 0; n++
        }
        r.suppressed = n; r.suppressFromBase = nBase; r.suppressFilled = nFill
      } else {
      if (per.suppressFill === 'skin' || per.suppressFill === 'frame') {
        const src = per.suppressFill === 'frame' ? X : clean
        const inkF = new Uint8Array(W * H)
        for (let i = 0; i < W * H; i++) inkF[i] = src[i * 4 + 3] >= 250 && skinDE(src, i * 4) > per.ns ? 1 : 0
        const nearInk = dilateR(inkF, 2)
        const okM = new Float32Array(W * H), ch = [0, 1, 2].map(() => new Float32Array(W * H))
        for (let i = 0; i < W * H; i++) if (src[i * 4 + 3] >= 250 && faceC[i * 4 + 3] >= 250 && !nearInk[i] && !(inSup[i] && kill[i])) { okM[i] = 1; for (let c = 0; c < 3; c++) ch[c][i] = src[i * 4 + c] }
        // sigma 3, falling back to 6 and 12 where no source skin is near (never to the face layer's ink)
        fill = [3, 6, 12].map(sg => ({ bm: blurF(okM, sp(sg)), bc: ch.map(p => blurF(p, sp(sg))) }))
      }
      let n = 0
      for (let i = 0; i < W * H; i++) if (kill[i] && inSup[i] && faceC[i * 4 + 3] >= 250) {
        const o = i * 4
        const fl = fill && fill.find(f => f.bm[i] > 0.15)
        if (fl) { for (let c = 0; c < 3; c++) X[o + c] = Math.round(fl.bc[c][i] / fl.bm[i]); nFill++ }
        else { X[o] = clean[o]; X[o + 1] = clean[o + 1]; X[o + 2] = clean[o + 2] }
        nsX[i] = 0; n++
      }
      r.suppressed = n
      if (fill) r.suppressFilled = nFill
      }
      let nFace = 0
      for (let i = 0; i < W * H; i++) if (inFace[i] && faceC[i * 4 + 3] >= 250) { const o = i * 4; X[o] = clean[o]; X[o + 1] = clean[o + 1]; X[o + 2] = clean[o + 2]; nsX[i] = nsB[i]; nFace++ }
      if (nFace) r.suppressFace = nFace
    }
    /* [noseBase] per.noseBase[id] = boxes: inside them the patch takes the BASE's own face layer.
       `suppress` above answers "this expression drew a feature the base draws somewhere ELSE, and the base's
       copy sits above the patch, so drop the expression's". The nose is the other case: nothing above the
       patch draws it, so dropping the expression's nose would leave the patch painting flat skin over the
       base's and the nose would simply go. What is needed is the base's nose IN the patch. So over the stroke
       either frame draws inside the box, `baseRest` — the rest-pose composite, already built above — is
       blended in at full weight out to noseGrow px and feathered to nothing over the next noseFeather px,
       exactly the taper the rest of the cut uses. Nothing else about the cut changes: the alpha, the feature
       mask and the patch box are what they were, only these pixels of the patch's RGB differ, and they now
       carry what the viewer sees at rest rather than a nose redrawn a px or several off it.
         Why `baseRest` and not `clean`: the eye layers sit over `face` and are cut from a different frame, and
       아빠's right one covers the top half of his nose bridge with a crisper stroke than `face` holds there
       (dL 32 between them). The patch sits above the eye layers, so blitting `clean` would have put the softer
       copy on screen — measured, 18 px over dL 12 against the rest face in every one of his four. Nothing
       above the expression patch draws inside either character's boxes (checked, 0 px of front_hair, side_hair
       and brows), so `baseRest` there is exactly what the patch has to reproduce and nothing is applied twice.
         Why only some expressions: the AI redrew the nose in a different place in every expression of 아빠
       and in 엄마's 고민 / 놀람 / 신남 — the stroke, the nostril mark, or both (아빠's 고민 loses the mark
       entirely at the feature bar and draws it 3 px low at this one; his 신남 draws it 5 px high; 엄마's 고민
       7 px low, her 신남 4 px high). Measured frame against frame, so no registration can fix them
       (findings.md §5, cause 2). 엄마's 기쁨 draws both within a px of the base and is left alone — her two
       expr_smile textures come out byte-identical to the ones that shipped.
         The boxes bound the nose and the mark and nothing else: they stop clear of both eyes' ink and above
       the mouth, and `dIn` makes each one a hard bound on the blend, so it can never walk down the stroke
       into a grin. That is what sets the odd edges: 아빠's boxes start at x 389 because his 신남 grin's top
       corner reaches x 384-387 at y 208, and his 고민 alone runs to y 213 because its displaced nose tip
       reaches y 210; 엄마's 신남 and 놀람 stop at y 285 because her 신남 grin starts at y 287, while her
       고민's displaced tip reaches y 290 and needs y 293. */
    const nb = per.noseBase && per.noseBase[E.id]
    if (nb) {
      let inBox = new Uint8Array(W * H)
      for (const [a, b, c, d] of nb) inBox = orM(inBox, boxMask(si(a), si(b), si(c), si(d)))
      /* the stroke, at `noseNs` rather than `ns`: the nose line is well over either bar, but the nostril
         mark beside it is a faded dash that `ns` does not see at all (아빠: 13 px over dE 8 in the rest
         face, 4 over 12, 0 over 22), and the generator displaces it with the rest of the nose. */
      const ink = new Uint8Array(W * H)
      for (let i = 0; i < W * H; i++) {
        if (!inBox[i]) continue
        const o = i * 4
        if ((X[o + 3] >= 128 && skinDE(X, o) > per.noseNs) || (B[o + 3] >= 128 && skinDE(B, o) > per.noseNs)) ink[i] = 1
      }
      const fw = Math.max(1, si(per.noseFeather))
      const dOut = distTo(dilateR(ink, sr(per.noseGrow)))   // 0 on the stroke and its grow, rising outward
      const dIn = distTo(subM(ones, inBox))                 // 0 outside the box, rising inward
      let n = 0, full = 0
      for (let i = 0; i < W * H; i++) {
        if (dOut[i] >= fw || !dIn[i] || faceC[i * 4 + 3] < 250 || baseRest[i * 4 + 3] < 250) continue
        /* taper off the stroke AND off the box: the box is a hard bound, so the blend can never walk
           out of it along the stroke (아빠's 신남 grin starts 2 px under his box, 엄마's 2 px under hers) */
        const k = (1 - smooth01(dOut[i] / fw)) * smooth01(Math.min(1, dIn[i] / fw))
        if (!(k > 0)) continue
        const o = i * 4
        for (let c = 0; c < 3; c++) X[o + c] = Math.round(X[o + c] * (1 - k) + baseRest[o + c] * k)
        n++; if (k > 0.99) full++
      }
      r.noseBase = { boxes: nb, grow: sr(per.noseGrow), feather: fw, inkPx: countM(ink), px: n, fullPx: full }
    }
    const dInkB = distTo(nsB), dInkX = distTo(nsX)
    const newX = new Uint8Array(W * H), goneB = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) { if (nsX[i] && dInkB[i] > per.prox) newX[i] = 1; if (nsB[i] && dInkX[i] > per.prox) goneB[i] = 1 }
    /* the base's feature boxes, grown: where its eyes / brows / mouth are drawn */
    const grown = (b, m) => boxMask(b.x0 - si(m), b.y0 - si(m), b.x1 + si(m), b.y1 + si(m))
    let baseFeat = new Uint8Array(W * H)
    for (const b of eb) baseFeat = orM(baseFeat, grown(b, 8))
    baseFeat = orM(baseFeat, grown(mb, 8))
    if (hasBrowLayer) for (const b of bb) baseFeat = orM(baseFeat, grown(b, 6))
    baseFeat = andM(baseFeat, andM(own, zone))
    let feat = orM(orM(newX, goneB), baseFeat)
    if (hasBrowLayer) {
      // brows drawn by the expression, wherever they are in the band above the eyes
      const band = boxMask(ex0 - si(10), topY, ex1 + si(10), ey0 + si(2))
      feat = orM(feat, andM(nsX, band))
    }
    {
      const cc = labelCC(feat), keep = new Uint8Array(cc.comps.length)
      const big = Math.max(...cc.comps.map(c => c.area), 1)
      for (const c of cc.comps) keep[c.id] = c.area >= sa(per.minArea) || c.area >= big * 0.03 ? 1 : 0
      for (let i = 0; i < W * H; i++) feat[i] = cc.lab[i] >= 0 && keep[cc.lab[i]] ? 1 : 0
    }
    /* PER_X.blushFeat = d (이슬8): a blush is skin to the feature test (inside the skin palette), so the patch took it only as
       far as the feather around the eyes reached and cut it there (measured: the image-right cheek of 감동). Here the
       frame's blush counts as a feature: own ∩ zone pixels where the frame (tone-matched) is greener-darker than the clean
       face by >= d (G drop) while its red drops by at most half that (pink, not shade), in components of >= 30 px. The patch
       then covers it out to rCore and fades over the feather, past where the blush itself fades out. */
    if (per.blushFeat) {
      const bl = new Uint8Array(W * H)
      for (let i = 0; i < W * H; i++) {
        if (!own[i] || !zone[i] || X[i * 4 + 3] < 250 || faceC[i * 4 + 3] < 250) continue
        const o = i * 4, dG = clean[o + 1] - X[o + 1], dR = clean[o] - X[o]
        if (dG >= per.blushFeat && dR <= dG / 2) bl[i] = 1
      }
      const cc = labelCC(bl)
      let nb = 0
      for (let i = 0; i < W * H; i++) if (cc.lab[i] >= 0 && cc.comps[cc.lab[i]].area >= sa(30)) { if (!feat[i]) nb++; feat[i] = 1 }
      r.blushFeat = nb
    }
    const dB = nsB, T = per.T
    r.featPx = countM(feat); r.newPx = countM(newX); r.gonePx = countM(goneB)
    /* 4. alpha: opaque out to rCore from any feature, then a smooth fall over the feather, then
          tapered at the ownership boundary so nothing is cut with a hard edge */
    const dist = distTo(feat)
    const wf = si(per.sigma * 2.56)
    const soft = blurF(Float32Array.from(erodeR(skinOwn, sr(2)), v => v), sp(1.5))
    /* no ownership taper inside an owned eye box: hard up to the (dark) hair edge */
    if (per.ownEyes) for (let i = 0; i < W * H; i++) if (eyeNear[i] && skinOwn[i] && !hairInk[i]) soft[i] = 1
    const alphaF = new Float32Array(W * H)
    for (let i = 0; i < W * H; i++) {
      if (!own[i]) continue
      const t = (dist[i] - si(per.rCore)) / wf
      if (t >= 1) continue
      alphaF[i] = (1 - smooth01(t)) * Math.min(1, soft[i] * 1.0)
    }
    const alpha8 = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) alpha8[i] = Math.round(Math.min(1, alphaF[i]) * 255)
    const patchBox = bboxOf(alpha8)
    if (!patchBox) { notes.push(`${E.id}: empty patch — dropped`); continue }
    r.patch = { ...patchBox, px: countM(alpha8) }

    /* 5. talk: replace the whole expression mouth with the face layer's clean skin */
    const mouthTop = mb.y0, mouthCx = (mb.x0 + mb.x1) / 2
    const halfW = Math.max(mb.w * 1.9, si(96))
    /* PER_X.talkZone = [x0, y0, x1, y1] (이슬8): the talk cut looks only inside this box instead of the default zone (mouth
       centre ± 1.9 mouth widths, from just under the eyes to the jaw), which also took a blush and the cheek shading at the
       hair edge, so they blinked off while talking */
    let mouthZone = per.talkZone ? boxMask(si(per.talkZone[0]), si(per.talkZone[1]), si(per.talkZone[2]), si(per.talkZone[3]))
      : boxMask(Math.round(mouthCx - halfW), Math.round(ey1 + (mb.y0 - ey1) * 0.45), Math.round(mouthCx + halfW), botY + si(6))
    /* PER.talkBox: extra boxes unioned in (다은's excited grin reaches 8 px above the default top, which her
       tilted head's image-left eye sets) */
    for (const tb of per.talkBox || []) mouthZone = orM(mouthZone, boxMask(si(tb[0]), si(tb[1]), si(tb[2]), tb[3] == null ? botY + si(6) : si(tb[3])))
    const mAll = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) {
      if (!alpha8[i] || !mouthZone[i]) continue
      const o = i * 4
      if (Math.max(Math.abs(X[o] - clean[o]), Math.abs(X[o + 1] - clean[o + 1]), Math.abs(X[o + 2] - clean[o + 2])) > T) mAll[i] = 1
    }
    let mCut = mAll
    {
      const cc = labelCC(dilateR(mAll, si(3))), keep = new Uint8Array(cc.comps.length)
      const big = Math.max(...cc.comps.map(c => c.area), 1)
      for (const c of cc.comps) keep[c.id] = c.area >= sa(30) || c.area >= big * 0.05 ? 1 : 0
      mCut = new Uint8Array(W * H)
      for (let i = 0; i < W * H; i++) mCut[i] = cc.lab[i] >= 0 && keep[cc.lab[i]] && alpha8[i] ? 1 : 0
    }
    const wm = blurF(Float32Array.from(mCut, v => v), sp(1.5))
    r.talkCut = { ...bboxOf(mCut), px: countM(mCut) }

    /* PER.strandAA = w (이슬): the layers drawn above the patch (side_hair, front_hair) have opaque, un-anti-aliased
       strand rims, coloured from the base. Where the expression puts DARK ink (a raised lash) right against such a
       rim, the rim reads as stair-steps. Patch pixels within w px of that coverage whose ink is dark (luma < 150)
       are mixed toward the mean colour of the covering pixels around them (0.5 at 1 px, 0.25 at 2 px), so the
       strand edge gets an anti-aliased band from below. Nothing outside the patch changes. */
    if (per.strandAA) {
      if (!ctx._topCov) {
        const at = model.layers.findIndex(l => l.id === 'mouth')
        const top = Buffer.alloc(W * H * 4)
        for (const l of model.layers.slice(at + 1)) if (l.role !== 'expr' && l.texture) over(top, await readLayer(pkgDir, l.texture, l))
        const cov = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) cov[i] = top[i * 4 + 3] >= 128 ? 1 : 0
        ctx._topCov = { top, cov, d: distTo(cov) }
      }
      const { top, cov, d } = ctx._topCov
      let nAA = 0
      for (let i = 0; i < W * H; i++) {
        if (!alpha8[i] || cov[i] || d[i] > per.strandAA + 0.5) continue
        const o = i * 4
        if (lumaAt(X, o) >= 150) continue
        const x = i % W, y = (i / W) | 0, rr = d[i] <= 1.5 ? 1 : 2
        let s = [0, 0, 0], n = 0
        for (let yy = y - rr; yy <= y + rr; yy++) for (let xx = x - rr; xx <= x + rr; xx++) {
          if (xx < 0 || yy < 0 || xx >= W || yy >= H || !cov[idx(xx, yy)]) continue
          const q = idx(xx, yy) * 4; s[0] += top[q]; s[1] += top[q + 1]; s[2] += top[q + 2]; n++
        }
        if (!n) continue
        const wgt = d[i] <= 1.5 ? 0.5 : 0.25
        for (let c = 0; c < 3; c++) X[o + c] = Math.round(X[o + c] * (1 - wgt) + (s[c] / n) * wgt)
        nAA++
      }
      r.strandAA = nAA
    }
    /* 6. cut: one box, the patch's, plus the 1 px transparent ring */
    const x0 = Math.max(0, patchBox.x0 - 1), y0 = Math.max(0, patchBox.y0 - 1)
    const x1 = Math.min(W - 1, patchBox.x1 + 1), y1 = Math.min(H - 1, patchBox.y1 + 1)
    const w = x1 - x0 + 1, h = y1 - y0 + 1
    const tex = Buffer.alloc(w * h * 4), talk = Buffer.alloc(w * h * 4)
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const s = idx(x0 + i, y0 + j), d = (j * w + i) * 4, so = s * 4
      const ring = i === 0 || j === 0 || i === w - 1 || j === h - 1
      const a = ring ? 0 : alpha8[s]
      tex[d] = X[so]; tex[d + 1] = X[so + 1]; tex[d + 2] = X[so + 2]; tex[d + 3] = a
      const m = a ? wm[s] : 0
      const useFace = faceC[so + 3] >= 250
      for (let c = 0; c < 3; c++) talk[d + c] = useFace ? Math.round(X[so + c] * (1 - m) + faceC[so + c] * m) : X[so + c]
      talk[d + 3] = a
    }
    const webp = (b, f) => sharp(b, { raw: { width: w, height: h, channels: 4 } }).webp({ lossless: true, effort: 6 }).toFile(GUARD(path.join(textures, f)))
    await webp(tex, `expr_${E.id}.webp`)
    await webp(talk, `expr_${E.id}_talk.webp`)
    const layer = {
      id: `expr_${E.id}`, label: { ko: `표정: ${E.label.ko}`, en: `Expression: ${E.label.en}` },
      texture: `textures/expr_${E.id}.webp`, talk: `textures/expr_${E.id}_talk.webp`,
      x: x0, y: y0, w, h, group: 'head', depth: 0, role: 'expr', expression: E.id,
    }
    if (hasBrowLayer) layer.brows = 'redrawn'
    layersOut.push(layer)
    results.push({ E, r, layer, alpha8, X, mCut, dB })
  }

  /* ---- model edits: after `mouth`, before whatever follows it */
  const at0 = model.layers.findIndex(l => l.id === 'mouth')
  model.layers.splice(at0 + 1, 0, ...layersOut)
  model.expressions = results.map(({ E }) => ({ id: E.id, label: E.label, hotkey: E.hotkey }))

  /* ---- verification: composites, numbers, crops */
  const report = { id, transform: EX.xform, zone: bboxOf(zone), per, expressions: [] }
  const cropBox = (() => { const b = bboxOf(orM(zone, boxMask(mb.x0 - si(40), mb.y0 - si(30), mb.x1 + si(40), botY))); return { x0: b.x0 - si(14), y0: b.y0 - si(14), x1: b.x1 + si(14), y1: b.y1 + si(8) } })()
  for (const { E, r, layer, alpha8, X: Xp, dB } of results) {
    const exprLayer = await readLayer(pkgDir, layer.texture, layer), talkLayer = await readLayer(pkgDir, layer.talk, layer)
    const stack = async (talking, mouthFrame) => compositeBase(model, pkgDir, { expr: E.id, texture: talking ? talkLayer : exprLayer, talking, mouth: mouthFrame, hideBrows: hasBrowLayer })
    const full = await stack(false, 0), talk0 = await stack(true, 0), talk2 = await stack(true, 2)
    /* changed pixels outside the patch (alpha 0 in its texture), full weight and talk */
    const outside = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) outside[i] = 1
    for (let j = 0; j < layer.h; j++) for (let i = 0; i < layer.w; i++) if (exprLayer.buf[(j * layer.w + i) * 4 + 3] > 0) outside[idx(layer.x + i, layer.y + j)] = 0
    const cmp = (A, Bc, mask) => { let n = 0; for (let i = 0; i < W * H; i++) { if (!mask[i]) continue; const o = i * 4; if (A[o] !== Bc[o] || A[o + 1] !== Bc[o + 1] || A[o + 2] !== Bc[o + 2] || A[o + 3] !== Bc[o + 3]) n++ } return n }
    r.outsideChanged = { full: cmp(full, baseRest, outside), talk: cmp(talk0, baseRest, outside) }
    /* the seam: support = alpha > 0; ring = support pixels within 3 px of its edge */
    const sup = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) sup[i] = outside[i] ? 0 : 1
    const dIn = distTo(subM(new Uint8Array(W * H).fill(1), sup))
    const ringM = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) ringM[i] = sup[i] && dIn[i] <= si(3) ? 1 : 0
    let n = 0, sVis = 0, sRaw = 0, vis = []
    for (let i = 0; i < W * H; i++) {
      if (!ringM[i]) continue
      const o = i * 4
      const dv = (Math.abs(full[o] - baseRest[o]) + Math.abs(full[o + 1] - baseRest[o + 1]) + Math.abs(full[o + 2] - baseRest[o + 2])) / 3
      const dr = (Math.abs(Xp[o] - baseRest[o]) + Math.abs(Xp[o + 1] - baseRest[o + 1]) + Math.abs(Xp[o + 2] - baseRest[o + 2])) / 3
      sVis += dv; sRaw += dr; n++; vis.push(dv)
    }
    vis.sort((a, b) => a - b)
    /* where the seam is worst: the 40x40 window (stride 10) with the largest summed ring difference, 6x, base | expression | difference */
    {
      const ws = si(40); let bestS = -1, bx = 0, by = 0
      for (let y = 0; y + ws <= H; y += 10) for (let x = 0; x + ws <= W; x += 10) {
        let acc = 0
        for (let j = 0; j < ws; j += 2) for (let i = 0; i < ws; i += 2) { const q = idx(x + i, y + j); if (ringM[q]) { const o = q * 4; acc += (Math.abs(full[o] - baseRest[o]) + Math.abs(full[o + 1] - baseRest[o + 1]) + Math.abs(full[o + 2] - baseRest[o + 2])) / 3 } }
        if (acc > bestS) { bestS = acc; bx = x; by = y }
      }
      r.worstWindow = { x: bx, y: by, w: ws, h: ws }
      const cut = (src, amp) => { const b = Buffer.alloc(ws * ws * 4); for (let j = 0; j < ws; j++) for (let i = 0; i < ws; i++) { const q = idx(bx + i, by + j) * 4, d = (j * ws + i) * 4; if (amp) { const v = Math.min(255, amp * Math.max(Math.abs(full[q] - baseRest[q]), Math.abs(full[q + 1] - baseRest[q + 1]), Math.abs(full[q + 2] - baseRest[q + 2]))); b[d] = b[d + 1] = b[d + 2] = v } else { b[d] = src[q]; b[d + 1] = src[q + 1]; b[d + 2] = src[q + 2] } b[d + 3] = 255 } return sharp(b, { raw: { width: ws, height: ws, channels: 4 } }).resize(ws * 6, ws * 6, { kernel: 'nearest' }).png().toBuffer() }
      const t = [await cut(baseRest), await cut(full), await cut(null, 4)]
      await sharp({ create: { width: ws * 18 + 8, height: ws * 6, channels: 3, background: { r: 30, g: 30, b: 30 } } }).composite(t.map((b, q) => ({ input: b, left: q * (ws * 6 + 4), top: 0 }))).png().toFile(GUARD(path.join(outDir, `${E.id}-worst-seam.png`)))
    }
    r.seam = { ringPx: n, meanVisible: +(sVis / Math.max(1, n)).toFixed(2), p95Visible: +(vis[Math.floor(vis.length * 0.95)] || 0).toFixed(1), meanRaw: +(sRaw / Math.max(1, n)).toFixed(2) }
    /* any hair-like pixel dragged into the patch: patch pixels near the base's hair edge that are hair-coloured */
    const nearHair = subM(dilateR(hair, si(4)), hair)
    let hairPx = 0
    for (let i = 0; i < W * H; i++) {
      if (!nearHair[i] || alpha8[i] < 26) continue
      const o = i * 4
      if (lumaAt(Xp, o) < 110 && !dB[i]) hairPx++
    }
    r.darkNearHair = hairPx
    /* the brows layer must not leave anything un-covered when it fades out */
    if (hasBrowLayer) {
      const bl = await readLayer(pkgDir, browsL.texture, browsL)
      let lost = 0, tot = 0
      for (let j = 0; j < bl.h; j++) for (let i = 0; i < bl.w; i++) {
        if (bl.buf[(j * bl.w + i) * 4 + 3] < 128) continue
        tot++
        const q = idx(bl.x + i, bl.y + j)
        if (outside[q]) lost++
      }
      r.brows = { neutralPx: tot, uncovered: lost }
    }
    report.expressions.push(r)
    await writePng(full, W, H, path.join(outDir, `${E.id}-full.png`))
    await writePng(talk0, W, H, path.join(outDir, `${E.id}-talk-closed.png`))
    await writePng(talk2, W, H, path.join(outDir, `${E.id}-talk-open.png`))
    /* crops: base | expression | talk (open mouth) at 3x, plus the support outline at 6x on the seam */
    const cw = cropBox.x1 - cropBox.x0 + 1, ch = cropBox.y1 - cropBox.y0 + 1
    const crop = src => { const b = Buffer.alloc(cw * ch * 4); for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) { const s = idx(cropBox.x0 + i, cropBox.y0 + j) * 4, d = (j * cw + i) * 4; b[d] = src[s]; b[d + 1] = src[s + 1]; b[d + 2] = src[s + 2]; b[d + 3] = 255 } return b }
    const tile = async (src, k) => sharp(crop(src), { raw: { width: cw, height: ch, channels: 4 } }).resize(cw * k, ch * k, { kernel: 'nearest' }).png().toBuffer()
    const edge = Buffer.from(full)
    for (let i = 0; i < W * H; i++) if (ringM[i] && dIn[i] <= 1.5) { const o = i * 4; edge[o] = 255; edge[o + 1] = 0; edge[o + 2] = 255 }
    const k3 = 3
    /* difference map: expression composite vs base composite; red where it is OUTSIDE the patch */
    const dm = Buffer.alloc(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      const o = i * 4
      const d = Math.min(255, 4 * Math.max(Math.abs(full[o] - baseRest[o]), Math.abs(full[o + 1] - baseRest[o + 1]), Math.abs(full[o + 2] - baseRest[o + 2])))
      dm[o] = outside[i] && d ? 255 : d; dm[o + 1] = outside[i] && d ? 0 : d; dm[o + 2] = outside[i] && d ? 0 : d; dm[o + 3] = 255
    }
    const tiles = [await tile(baseRest, k3), await tile(full, k3), await tile(talk2, k3), await tile(edge, k3), await tile(dm, k3)]
    await sharp({ create: { width: cw * k3 * 5 + 16, height: ch * k3, channels: 3, background: { r: 30, g: 30, b: 30 } } })
      .composite(tiles.map((t, q) => ({ input: t, left: q * (cw * k3 + 4), top: 0 }))).png().toFile(GUARD(path.join(outDir, `${E.id}-sheet.png`)))
  }
  fs.writeFileSync(GUARD(path.join(outDir, 'report.json')), JSON.stringify(report, null, 1))
  for (const r of report.expressions) {
    LOG(`  expr ${r.id.padEnd(10)} shift ${r.shift.tx},${r.shift.ty} (n ${r.shift.points}, gain ${r.shift.gain}, resid ${Object.entries(r.resid).map(([k, v]) => k + ':' + (v ? v.join('/') : '-') + `[${r.residN[k]}]`).join(' ')})  tone ${r.tone.offset.join(',')}`
      + (r.noseBase ? `  noseBase ink ${r.noseBase.inkPx} px ${r.noseBase.px} (full ${r.noseBase.fullPx})` : '')
      + `  patch ${r.patch.w}x${r.patch.h} @${r.patch.x0},${r.patch.y0}  outside-changed ${r.outsideChanged.full}/${r.outsideChanged.talk}  seam vis ${r.seam.meanVisible} (p95 ${r.seam.p95Visible}, raw ${r.seam.meanRaw})`
      + `  darkNearHair ${r.darkNearHair}` + (r.brows ? `  brows uncovered ${r.brows.uncovered}/${r.brows.neutralPx}` : ''))
  }
  for (const n of notes) LOG('  - ' + n)
  return report
}

/**
 * PER.browRoot (엄마's image-left brow): the art draws the brow on THROUGH the fringe, as a darker
 * see-through band over the strands, and its hair-coloured body runs a few px past the hair's outline.
 * The cutter's brow detector stops where the ink column joins the bangs, and the hair mask takes the
 * rest, so all of it was cut into front_hair — which is drawn over every expression patch. With an
 * expression on, the neutral `brows` layer fades out (`redrawn`) and that root stayed: a hard-edged
 * dark block at the brow root, cut straight down at the brow's end column (measured, all four).
 * Here it moves to `brows`, the only layer that fades with the brow: those pixels go into it at full
 * alpha exactly as drawn, and front_hair keeps nothing past the hair's drawn outline and, inside it,
 * the hair with the band divided out (it darkens what is under it, so per pixel; the strand gaps under
 * it take the band's factor from their row, the strand lines stay as drawn). Nothing is drawn
 * differently at rest. Computed
 * only from the closed frame and the hair mask, never from the textures it rewrites, so a --replay
 * over a package that already had it done writes the same pixels. Returns log lines.
 * Vola-live: this is browRoot v2 from the shared expressions.mjs d3278c47 (DESIGN §4.5 C1), not kai8's v1.
 */
async function browRootToBrows(sides, { B, hair, browBoxes, model, pkgDir }) {
  const frontL = model.layers.find(l => l.id === 'front_hair'), browsL = model.layers.find(l => l.id === 'brows')
  const lum = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) lum[i] = lumaAt(B, i * 4)
  const isHair = (x, y) => x >= 0 && y >= 0 && x < W && y < H && hair[idx(x, y)] === 1
  const pct = (a, q) => { const p = (a.length - 1) * q, lo = Math.floor(p), hi = Math.min(a.length - 1, lo + 1); return a[lo] + (a[hi] - a[lo]) * (p - lo) }
  const fh = await readLayer(pkgDir, frontL.texture, frontL), fhBuf = Buffer.from(fh.buf)
  const fAt = (x, y) => x >= frontL.x && y >= frontL.y && x < frontL.x + frontL.w && y < frontL.y + frontL.h ? ((y - frontL.y) * frontL.w + (x - frontL.x)) * 4 : -1
  const R = new Uint8Array(W * H), log = []
  for (const side of sides) {
    const b = browBoxes[side]
    if (!b) continue
    const dir = side === 0 ? -1 : 1, xEnd = dir < 0 ? b.x0 : b.x1     // the hair lies `dir` of the brow's end column
    /* 1. past the outline: the rows where the hair mask stops exactly at the brow's end column. The hair's
          edge there = the line between the edge rows just outside them, snapped to the darkest of 4 px
          (its drawn outline shows through the brow, and stays hair) */
    const cut = []
    for (let y = b.y0 - si(4); y <= b.y1 + si(4); y++) if (isHair(xEnd + dir, y) && !isHair(xEnd, y)) cut.push(y)
    if (!cut.length) { log.push(`brow root ${side}: the hair does not stop at the brow's end, nothing moved`); continue }
    const ya = cut[0], yb = cut[cut.length - 1]
    const edgeAt = y => { let x = xEnd - dir * 8; for (let k = 0; k < 48 && !isHair(x, y); k++) x += dir; return x }
    const ea = edgeAt(ya - 1), eb = edgeAt(yb + 1)
    const out = new Uint8Array(W * H), outline = []
    for (const y of cut) {
      const c0 = Math.round(ea + (eb - ea) * (y - (ya - 1)) / ((yb + 1) - (ya - 1)))
      let o = null
      for (let k = 2; k >= -1; k--) { const x = c0 + dir * k; if ((x - xEnd) * dir > 0 && isHair(x, y) && (o === null || lum[idx(x, y)] < lum[idx(o, y)])) o = x }
      if (o === null) continue
      outline.push(idx(o, y))
      for (let x = o - dir; x !== xEnd; x -= dir) if (isHair(x, y)) out[idx(x, y)] = 1
    }
    /* 2. the band, in a window 64 px into the hair from the brow's end: hair darker than the window's
          plain hair, in runs of >= 6 px along a row (it lies across the rows, the strands run down them),
          the part touching the root, grown 2 px for its soft edge and on along its fading tail */
    const wx0 = Math.max(0, dir < 0 ? xEnd - si(64) : xEnd + 1), wx1 = Math.min(W - 1, dir < 0 ? xEnd - 1 : xEnd + si(64))
    const wy0 = Math.max(0, b.y0 - si(12)), wy1 = Math.min(H - 1, b.y1 + si(28))
    const hw = new Uint8Array(W * H), lv = []
    for (let y = wy0; y <= wy1; y++) for (let x = wx0; x <= wx1; x++) { const i = idx(x, y); if (hair[i] && !out[i] && B[i * 4 + 3] >= 250) { hw[i] = 1; lv.push(lum[i]) } }
    const l75 = pct(lv.sort((p, q) => p - q), 0.75), ch = [[], [], []]
    for (let i = 0; i < W * H; i++) if (hw[i] && Math.abs(lum[i] - l75) <= 6) for (let c = 0; c < 3; c++) ch[c].push(B[i * 4 + c])
    const href = ch.map(a => pct(a.sort((p, q) => p - q), 0.5)), lref = 0.299 * href[0] + 0.587 * href[1] + 0.114 * href[2]
    const d = new Float32Array(W * H).fill(1)
    for (let i = 0; i < W * H; i++) if (hw[i]) d[i] = lum[i] / lref
    const thick = new Uint8Array(W * H)
    for (let y = wy0; y <= wy1; y++) for (let x = wx0; x <= wx1;) {
      if (!(hw[idx(x, y)] && d[idx(x, y)] < 0.86)) { x++; continue }
      let e = x
      while (e <= wx1 && hw[idx(e, y)] && d[idx(e, y)] < 0.86) e++
      if (e - x >= si(6)) for (let k = x; k < e; k++) thick[idx(k, y)] = 1
      x = e
    }
    const seed = dilateR(out, si(2))
    for (const y of cut) for (let k = 1; k <= 3; k++) seed[idx(xEnd + dir * k, y)] = 1
    const cc = labelCC(thick), keep = new Set()
    for (let i = 0; i < W * H; i++) if (seed[i] && cc.lab[i] >= 0) keep.add(cc.lab[i])
    let M = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) if (cc.lab[i] >= 0 && keep.has(cc.lab[i])) M[i] = 1
    const grow = (ok, nbs) => {
      const o = Uint8Array.from(M)
      for (let y = wy0; y <= wy1; y++) for (let x = wx0; x <= wx1; x++) {
        const i = idx(x, y)
        if (o[i] || !ok(i)) continue
        for (const [dx, dy] of nbs) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && M[idx(xx, yy)]) { o[i] = 1; break } }
      }
      M = o
    }
    const N8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
    for (let k = 0; k < sr(2); k++) grow(i => hw[i] && d[i] > 0.6 && d[i] < 0.93, N8)     // not into an outline beside it
    for (let k = 0; k < si(8); k++) grow(i => hw[i] && d[i] > 0.6 && d[i] < 0.9, [[-dir, 0], [-dir, -1], [0, -1]])   // away from the brow, downward
    // the light gaps between strands under it are never grown into: row holes up to 3 px wide
    for (let y = wy0; y <= wy1; y++) for (let x = wx0; x < wx1; x++) {
      if (!M[idx(x, y)] || M[idx(x + 1, y)]) continue
      let e = x + 1
      while (e <= wx1 && e - x - 1 < si(3) && !M[idx(e, y)] && hw[idx(e, y)]) e++
      if (e <= wx1 && M[idx(e, y)]) for (let k = x + 1; k < e; k++) M[idx(k, y)] = 1
    }
    for (const i of outline) M[i] = 0
    /* 3. the band's factor: its own darkening, except at a strand gap (lighter than its row's median by
          > 8): there, interpolated along the row from the nearest plain pixels; a strand line (darker by
          > 8) stays as drawn */
    const t = new Float32Array(W * H).fill(1), flag = new Uint8Array(W * H)
    for (let y = wy0; y <= wy1; y++) for (let x = wx0; x <= wx1; x++) {
      const i = idx(x, y)
      if (!M[i]) continue
      const nb = []
      for (let xx = Math.max(0, x - si(3)); xx <= Math.min(W - 1, x + si(3)); xx++) if (M[idx(xx, y)]) nb.push(lum[idx(xx, y)])
      const md = pct(nb.sort((p, q) => p - q), 0.5)
      if (lum[i] < md - 8 || (nb.length < 3 && d[i] < 0.6)) flag[i] = 2
      else if (lum[i] > md + 8 && lum[i] > lref + 8) flag[i] = 1
    }
    for (let y = wy0; y <= wy1; y++) {
      const row = [], good = []
      for (let x = wx0; x <= wx1; x++) if (M[idx(x, y)]) { row.push(x); if (!flag[idx(x, y)]) good.push(x) }
      for (const x of row) {
        const i = idx(x, y)
        if (flag[i] === 2) continue
        if (!flag[i]) { t[i] = d[i]; continue }
        let l = null, r = null
        for (const gx of good) { if (gx < x) l = gx; else if (gx > x && r === null) r = gx }
        t[i] = l !== null && r !== null ? d[idx(l, y)] + (d[idx(r, y)] - d[idx(l, y)]) * (x - l) / (r - l)
          : l !== null ? d[idx(l, y)] : r !== null ? d[idx(r, y)] : 1
      }
    }
    /* 4. front_hair: the hair without the band inside the outline, nothing past it; both go to brows */
    let nIn = 0, nOut = 0, notFront = 0
    for (let i = 0; i < W * H; i++) {
      if (!M[i] && !out[i]) continue
      const x = i % W, q = fAt(x, (i - x) / W)
      if (q < 0 || (!out[i] && fhBuf[q + 3] === 0)) { notFront++; continue }
      if (out[i]) { fhBuf[q] = fhBuf[q + 1] = fhBuf[q + 2] = fhBuf[q + 3] = 0; R[i] = 1; nOut++; continue }
      const tt = Math.min(1, Math.max(0.2, t[i])), o = i * 4
      const v = [0, 1, 2].map(c => Math.round(Math.min(255, B[o + c] / tt)))
      if (v[0] === B[o] && v[1] === B[o + 1] && v[2] === B[o + 2]) continue
      fhBuf[q] = v[0]; fhBuf[q + 1] = v[1]; fhBuf[q + 2] = v[2]; R[i] = 1; nIn++
    }
    log.push(`brow root ${side}: rows ${ya}-${yb} cut at x ${xEnd}; ${nOut} px past the hair outline cleared from front_hair, ${nIn} px of see-through band (plain hair ${href.map(Math.round).join(',')}) restored to hair under it; all ${nOut + nIn} now drawn by brows${notFront ? `; ${notFront} px skipped (not in front_hair)` : ''}`)
  }
  if (!R.some(Boolean)) return log
  await sharp(fhBuf, { raw: { width: frontL.w, height: frontL.h, channels: 4 } }).webp({ lossless: true, effort: 6 }).toFile(GUARD(path.join(pkgDir, frontL.texture)))
  /* brows: its own alpha plus R at full alpha, recut over the grown box with the 1 px transparent ring */
  const bl = await readLayer(pkgDir, browsL.texture, browsL), al = new Uint8Array(W * H)
  for (let j = 0; j < bl.h; j++) for (let i = 0; i < bl.w; i++) al[idx(bl.x + i, bl.y + j)] = bl.buf[(j * bl.w + i) * 4 + 3]
  for (let i = 0; i < W * H; i++) if (R[i]) al[i] = 255
  const bx = bboxOf(al)
  const x0 = Math.max(0, bx.x0 - 1), y0 = Math.max(0, bx.y0 - 1), x1 = Math.min(W - 1, bx.x1 + 1), y1 = Math.min(H - 1, bx.y1 + 1)
  const w = x1 - x0 + 1, h = y1 - y0 + 1, buf = Buffer.alloc(w * h * 4)
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = x0 + i, y = y0 + j, s = idx(x, y), dd = (j * w + i) * 4
    const ring = i === 0 || j === 0 || i === w - 1 || j === h - 1
    const old = !R[s] && x >= bl.x && y >= bl.y && x < bl.x + bl.w && y < bl.y + bl.h ? ((y - bl.y) * bl.w + (x - bl.x)) * 4 : -1
    const src = old >= 0 && bl.buf[old + 3] > 0 ? [bl.buf, old] : [B, s * 4]
    buf[dd] = src[0][src[1]]; buf[dd + 1] = src[0][src[1] + 1]; buf[dd + 2] = src[0][src[1] + 2]; buf[dd + 3] = ring ? 0 : al[s]
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).webp({ lossless: true, effort: 6 }).toFile(GUARD(path.join(pkgDir, browsL.texture)))
  log.push(`brows: box ${browsL.x},${browsL.y} ${browsL.w}x${browsL.h} -> ${x0},${y0} ${w}x${h}`)
  Object.assign(browsL, { x: x0, y: y0, w, h })
  return log
}

/**
 * The rest-pose composite of a model: eyes open, mouth frame 0, lids hidden. With `x` set, that
 * expression's patch is drawn after the mouth at full weight (its `talk` texture when talking, with
 * the mouth frame `x.mouth` drawn above it), and the neutral brows are dropped when it redraws them.
 */
async function compositeBase(model, pkgDir, x) {
  const canvas = Buffer.alloc(W * H * 4)
  const cache = (compositeBase.cache ||= new Map())
  const get = async l => {
    const k = pkgDir + '|' + l.texture
    if (!cache.has(k)) cache.set(k, await readLayer(pkgDir, l.texture, l))
    return cache.get(k)
  }
  const mouthL = model.layers.find(l => l.id === 'mouth')
  let deferred = null
  for (const l of model.layers) {
    if (l.role === 'expr') {
      if (x && l.expression === x.expr) { over(canvas, x.texture); if (x.talking && deferred === null) deferred = 'now' }
      if (deferred === 'now') { over(canvas, await readLayer(pkgDir, mouthL.frames[x.mouth], mouthL)); deferred = 'done' }
      continue
    }
    if (l.role === 'lid_L' || l.role === 'lid_R') continue
    if (l.id === 'brows' && x && x.hideBrows) continue
    if (l.id === 'mouth') {
      if (x && x.talking) continue          // drawn above the expression instead
      over(canvas, await readLayer(pkgDir, l.frames[0], l))
      continue
    }
    over(canvas, await get(l))
  }
  return canvas
}

/* Vola-live: the old `--replay` dev entry (argv-driven, writes next to its cache) is not ported here; `vola-live
 * replay` (Track B, dev only) owns that. finish() can be called directly with a cache's { frames, xform } and
 * { F: { closed }, g, model, textures, pkgDir, workDir, opts: { exprSpec, log, guard }, W, H, S }. */
