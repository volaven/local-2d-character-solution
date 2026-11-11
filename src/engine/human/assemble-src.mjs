/**
 * assemble-src.mjs — cut-human's four aligned states out of a THREE-frame generated set.
 *
 * The 2K generator ships `base` (eyes open, mouth closed), `blink` (eyes closed, mouth closed) and
 * `open` (eyes open, mouth open) — no `blink-open`. It also redraws the body in every frame (~0.95%
 * drift), so the frames are NOT byte-identical outside the eye and mouth windows the way the four
 * frames in livliv-cast/characters/ are. cut-human.mjs leans on that invariant everywhere (its
 * white-pocket repair writes one colour map into all four frames and expects them to stay
 * identical; every layer it cuts from a different state is registered only because the bodies
 * agree), so the states have to be re-assembled before anything is cut.
 *
 * This is livliv-cast/tools/assemble.mjs's method, ported and made resolution-aware. Read that
 * file's header for the reasoning; the short version:
 *
 *   canonical body   the medoid frame — the one that agrees best with the others over the head,
 *                    measured OUTSIDE the eye and mouth regions so the face states cannot bias it.
 *
 *   two patches      every state is (eyes open|closed) x (mouth open|closed), so any state is
 *                    canonical + at most an eye patch + a mouth patch. Neither seam goes near the
 *                    jaw, the hairline or the head outline, so a head-angle difference between
 *                    source frames stops mattering. `blink-open`, which the generator never drew,
 *                    is exactly canonical + the eye patch of `blink` + the mouth patch of `open`.
 *
 *   regions          located from paired differences, each isolating one variable:
 *                      eyes  = |base - blink|   (same mouth, differing eyes)
 *                      mouth = |base - open|    (same eyes, differing mouth)
 *                    With four frames assemble.mjs takes min() over two such pairs, which rejects
 *                    one-off redraw noise. Three frames give only one pair each, so that filter is
 *                    gone and the work is done by what remains: a blur to suppress the haze, a
 *                    threshold near the global peak, a concentration test on each blob, and the
 *                    anatomical prior (eyes first, mouth below them and within their x-span).
 *
 *   alignment        each patch is registered locally, over the structure AROUND it (brows, nose,
 *                    face contour) with the changing pixels excluded.
 *
 * Outside the patch masks the output is a byte-for-byte copy of the canonical frame, and that is
 * asserted before anything is returned.
 *
 * Every pixel constant here is written in BASE pixels (the 768x1024 art assemble.mjs was tuned on)
 * and scaled by S = W / 768.
 *
 * No display-panel path: that is ibi's, and ibi has its own tool (cut-ibi.mjs).
 */
import path from 'node:path'
import fs from 'node:fs'
import { sharp } from '../../runtime.mjs'   // Vola-live: was ../cut-lib.mjs (same cache(false)/concurrency(1) sharp)

const BASE_W = 768

/** the states cut-human.mjs wants */
export const STATES = ['closed', 'open', 'blink', 'blink-open']
const PROPS = {
  'closed': { eyes: 'open', mouth: 'closed' },
  'open': { eyes: 'open', mouth: 'open' },
  'blink': { eyes: 'closed', mouth: 'closed' },
  'blink-open': { eyes: 'closed', mouth: 'open' },
}
/** what a three-frame generated set ships */
export const SRC_FRAMES = ['base', 'blink', 'open']
const SRC_PROPS = {
  base: { eyes: 'open', mouth: 'closed' },
  blink: { eyes: 'closed', mouth: 'closed' },
  open: { eyes: 'open', mouth: 'open' },
}

/* the canvas and the scale, set once per call; every helper below reads them at call time */
let W = 768, H = 1024, S = 1
const sp = v => v * S                            // a length, float (gaussian sigmas, search spans)
const si = v => Math.round(v * S)                // a length, whole pixels
const sr = v => Math.max(1, Math.round(v * S))   // a filter radius, never below 1
const sa = v => v * S * S                        // a pixel-count area

const HEAD_FRAC = 0.40       // the head band, as a fraction of the figure's height
const ALIGN_STEP_BASE = 0.25

/* ---------------------------------------------------------------- pixels */

const writePng = (buf, file) =>
  sharp(Buffer.from(buf), { raw: { width: W, height: H, channels: 4 } }).png({ compressionLevel: 6 }).toFile(file)

function inkOf(buf) {
  const v = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) {
    const o = i * 4, a = buf[o + 3] / 255
    v[i] = (255 - (0.299 * buf[o] + 0.587 * buf[o + 1] + 0.114 * buf[o + 2])) * a
  }
  return v
}
function bboxOfBuf(buf) {
  let y0 = H, y1 = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (buf[(y * W + x) * 4 + 3] > 16) { if (y < y0) y0 = y; if (y > y1) y1 = y; break }
  return { y0, y1 }
}
/** the full alpha bounding box, on the same alpha > 16 test cut-human.mjs uses */
export function bboxOfAlpha(buf, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (buf[(y * w + x) * 4 + 3] > 16) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
  }
  if (x1 < 0) throw new Error('the frame is fully transparent')
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/**
 * Resample through `dst = s * src + t` (continuous coordinates, pixel i spanning [i, i+1)),
 * bilinear over premultiplied alpha, zero-padded outside the source.
 *
 * Zero-padded, not clamped: with s > 1 and a translation, part of the destination maps outside the
 * source, and clamping there would smear the border texel across the canvas.
 */
function resample(buf, s, tx, ty) {
  if (s === 1 && tx === 0 && ty === 0) return buf
  const out = Buffer.alloc(W * H * 4)
  const tap = (xx, yy) => (xx < 0 || yy < 0 || xx >= W || yy >= H) ? null : (yy * W + xx) * 4
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5 - tx) / s - 0.5, v = (y + 0.5 - ty) / s - 0.5
      const x0 = Math.floor(u), y0 = Math.floor(v)
      const fx = u - x0, fy = v - y0
      let r = 0, g = 0, b = 0, a = 0
      for (let k = 0; k < 4; k++) {
        const o = tap(x0 + (k & 1), y0 + (k >> 1))
        if (o === null) continue
        const wgt = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy)
        if (wgt <= 0) continue
        const al = buf[o + 3] / 255
        r += buf[o] * al * wgt; g += buf[o + 1] * al * wgt; b += buf[o + 2] * al * wgt; a += buf[o + 3] * wgt
      }
      const o = (y * W + x) * 4
      const al = a / 255
      out[o] = al > 0.002 ? Math.min(255, Math.round(r / al)) : 0
      out[o + 1] = al > 0.002 ? Math.min(255, Math.round(g / al)) : 0
      out[o + 2] = al > 0.002 ? Math.min(255, Math.round(b / al)) : 0
      out[o + 3] = Math.round(a)
    }
  }
  return out
}

/**
 * Put a generated set into the framing the shipped packages already use.
 *
 * The frames in livliv-cast/characters/ were rescaled and repositioned when the cast was built
 * (tools/build.mjs, ~0.90x plus offsets); the generated frames follow the approved reference pack
 * instead. Cut as they arrive, a character would change size and position on screen. So fit ONE
 * uniform scale + translation per character, from the reference frame's alpha box onto the target
 * box, and put all of that character's frames through the same transform — they stay mutually
 * registered, which is what the patch assembly afterwards depends on.
 *
 * A box has four degrees of freedom and a uniform similarity has three, so the scale is the
 * least-squares fit over the two dimensions. The translation then matches the box centres in x,
 * and in y matches the BOTTOM whenever the target reaches the canvas edge: the player reads
 * `cutBottom = anchors.bottom_y >= canvas[1] - 4` and warps the body differently either way, so a
 * figure that is cut at the frame today has to stay cut at the frame (SPEC §9a).
 *
 * @param target the box to land on, in canvas coordinates
 */
export function fitFraming(frames, target, dims, refKey, mode = 'scale') {
  W = dims.W; H = dims.H; S = W / BASE_W
  const keys = Object.keys(frames)
  const ref = bboxOfAlpha(frames[refKey ?? keys[0]], W, H)

  const cutAtBottom = target.y1 >= H - 1 - 2
  let s, tx, ty
  if (mode === 'translate') {
    /* Slide, never scale. Scaling to fill the old framing resamples the art — which defeats the
     * point when the art was chosen for its linework. A whole-pixel translation is lossless:
     * shiftRGBA returns the buffer untouched when tx and ty are integers... it does not, so the
     * integer case is short-circuited below. The figure then reads a little smaller than the
     * framing it replaces, which is the trade. */
    s = 1
    tx = Math.round((target.x0 + target.x1) / 2 - (ref.x0 + ref.x1) / 2)
    ty = cutAtBottom ? Math.round(target.y1 - ref.y1) : Math.round((target.y0 + target.y1) / 2 - (ref.y0 + ref.y1) / 2)
  } else {
    s = (ref.w * target.w + ref.h * target.h) / (ref.w * ref.w + ref.h * ref.h)
    tx = (target.x0 + target.x1 + 1) / 2 - s * (ref.x0 + ref.x1 + 1) / 2
    ty = cutAtBottom
      ? (target.y1 + 1) - s * (ref.y1 + 1)
      : (target.y0 + target.y1 + 1) / 2 - s * (ref.y0 + ref.y1 + 1) / 2
  }

  const out = {}
  const whole = s === 1 && Number.isInteger(tx) && Number.isInteger(ty)
  for (const k of keys) out[k] = whole ? shiftWhole(frames[k], tx, ty) : resample(frames[k], s, tx, ty)
  const got = bboxOfAlpha(out[refKey ?? keys[0]], W, H)
  const warn = []
  if (cutAtBottom && got.y1 < H - 1 - 4) warn.push(`the figure now stops at y ${got.y1} of ${H}, so the player would no longer treat it as cut at the frame`)
  if (got.y0 < 0 || got.x0 < 0 || got.x1 > W - 1) warn.push('the fitted figure runs off the canvas')
  return {
    frames: out,
    info: { s, tx, ty, cutAtBottom, ref, target, got, warn, identity: s === 1 && tx === 0 && ty === 0 },
  }
}

/** a whole-pixel move: every pixel is copied, nothing is interpolated, nothing is softened */
function shiftWhole(buf, tx, ty) {
  if (tx === 0 && ty === 0) return buf
  const out = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) {
    const sy = y - ty
    if (sy < 0 || sy >= H) continue
    for (let x = 0; x < W; x++) {
      const sx = x - tx
      if (sx < 0 || sx >= W) continue
      const o = (y * W + x) * 4, q = (sy * W + sx) * 4
      // RGB under zero alpha is meaningless and the resampling path writes 0 there; match it, or
      // every later diff counts the background's leftover colour as a difference
      const a2 = buf[q + 3]
      out[o] = a2 ? buf[q] : 0; out[o + 1] = a2 ? buf[q + 1] : 0; out[o + 2] = a2 ? buf[q + 2] : 0; out[o + 3] = a2
    }
  }
  return out
}

/** bilinear sample of a buffer, shifted by (tx, ty), composited through premultiplied alpha */
function shiftRGBA(buf, tx, ty) {
  if (tx === 0 && ty === 0) return buf
  const out = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sxf = x - tx, syf = y - ty
      const x0 = Math.floor(sxf), y0 = Math.floor(syf)
      const fx = sxf - x0, fy = syf - y0
      let r = 0, g = 0, b = 0, a = 0
      for (let k = 0; k < 4; k++) {
        const xx = Math.min(W - 1, Math.max(0, x0 + (k & 1)))
        const yy = Math.min(H - 1, Math.max(0, y0 + (k >> 1)))
        const wgt = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy)
        if (wgt <= 0) continue
        const o = (yy * W + xx) * 4, al = buf[o + 3] / 255
        r += buf[o] * al * wgt; g += buf[o + 1] * al * wgt; b += buf[o + 2] * al * wgt; a += buf[o + 3] * wgt
      }
      const o = (y * W + x) * 4
      const al = a / 255
      out[o] = al > 0.002 ? Math.min(255, Math.round(r / al)) : 0
      out[o + 1] = al > 0.002 ? Math.min(255, Math.round(g / al)) : 0
      out[o + 2] = al > 0.002 ? Math.min(255, Math.round(b / al)) : 0
      out[o + 3] = Math.round(a)
    }
  }
  return out
}

/* --------------------------------------------------------------- regions */

/** separable box blur, run three times to approximate a gaussian */
function blurF32(src, radius) {
  let a = Float32Array.from(src), b = new Float32Array(W * H)
  const n = 2 * radius + 1
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < H; y++) {
      let acc = 0
      for (let x = -radius; x <= radius; x++) acc += a[y * W + Math.min(W - 1, Math.max(0, x))]
      for (let x = 0; x < W; x++) {
        b[y * W + x] = acc / n
        acc -= a[y * W + Math.min(W - 1, Math.max(0, x - radius))]
        acc += a[y * W + Math.min(W - 1, Math.max(0, x + radius + 1))]
      }
    }
    for (let x = 0; x < W; x++) {
      let acc = 0
      for (let y = -radius; y <= radius; y++) acc += b[Math.min(H - 1, Math.max(0, y)) * W + x]
      for (let y = 0; y < H; y++) {
        a[y * W + x] = acc / n
        acc -= b[Math.min(H - 1, Math.max(0, y - radius)) * W + x]
        acc += b[Math.min(H - 1, Math.max(0, y + radius + 1)) * W + x]
      }
    }
  }
  return a
}

/**
 * Where a paired difference says a feature is.
 *
 * The raw difference is hazy across the whole head, because the generator redrew every frame. The
 * real eye / mouth change is the CONCENTRATED part, so blur to suppress the haze, keep only blobs
 * near the global peak, and take their union — two blobs for the eyes, one for the mouth.
 */
function regionFrom(D, band, label, win = null) {
  const wx0 = win ? Math.max(0, win.x0) : 0, wx1 = win ? Math.min(W, win.x1) : W
  const wy0 = Math.max(band.y0, win ? win.y0 : band.y0), wy1 = Math.min(band.y1, win ? win.y1 : band.y1)
  const B = blurF32(D, sr(5))
  let peak = 0
  for (let y = wy0; y < wy1; y++) for (let x = wx0; x < wx1; x++) peak = Math.max(peak, B[y * W + x])
  if (peak <= 0) throw new Error(`${label}: no change at all`)

  const thr = 0.42 * peak
  const seen = new Uint8Array(W * H)
  const blobs = []
  const stack = []
  for (let y = wy0; y < wy1; y++) {
    for (let x = wx0; x < wx1; x++) {
      const i0 = y * W + x
      if (seen[i0] || B[i0] < thr) continue
      let bx0 = x, bx1 = x, by0 = y, by1 = y, area = 0, top = 0
      seen[i0] = 1; stack.push(i0)
      while (stack.length) {
        const i = stack.pop()
        const px = i % W, py = (i - px) / W
        area++
        top = Math.max(top, B[i])
        if (px < bx0) bx0 = px; if (px > bx1) bx1 = px
        if (py < by0) by0 = py; if (py > by1) by1 = py
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx, ny = py + dy
          if (nx < wx0 || ny < wy0 || nx >= wx1 || ny >= wy1) continue
          const ni = ny * W + nx
          if (seen[ni] || B[ni] < thr) continue
          seen[ni] = 1; stack.push(ni)
        }
      }
      blobs.push({ bx0, bx1, by0, by1, area, top })
    }
  }
  const keep = blobs.filter(b => b.area >= sa(40) && b.top >= 0.55 * peak)
  if (!keep.length) throw new Error(`${label}: no concentrated change found`)
  const x0 = Math.min(...keep.map(b => b.bx0)), x1 = Math.max(...keep.map(b => b.bx1))
  const y0 = Math.min(...keep.map(b => b.by0)), y1 = Math.max(...keep.map(b => b.by1))
  const MARGIN = si(14)
  return {
    cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
    rx: (x1 - x0) / 2 + MARGIN, ry: (y1 - y0) / 2 + MARGIN,
    blobs: keep.length, peak, thr, box: { x0, y0, x1, y1 },
  }
}

/**
 * Distance from every pixel to the nearest pixel outside the character (chamfer, two passes).
 * `solid` is the alpha every frame SHARES, so a patch kept inside it is inside the silhouette of
 * the canonical and of every donor at once.
 */
function distanceToEdge(solid) {
  // seed only from the EXTERIOR, found by flooding in from the border, so one antialiasing speck
  // inside the body cannot count as an edge and collapse a patch nowhere near the outline
  const outside = new Uint8Array(W * H)
  const q = new Int32Array(W * H)
  let qh = 0, qt = 0
  const push = i => { if (!outside[i] && solid[i] < 128) { outside[i] = 1; q[qt++] = i } }
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x) }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1) }
  while (qh < qt) {
    const i = q[qh++], x = i % W, y = (i - x) / W
    if (x > 0) push(i - 1)
    if (x < W - 1) push(i + 1)
    if (y > 0) push(i - W)
    if (y < H - 1) push(i + W)
  }
  const BIG = 1e6
  const d = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) d[i] = outside[i] ? 0 : BIG
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    if (y > 0) d[i] = Math.min(d[i], d[i - W] + 1)
    if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1)
    if (y > 0 && x > 0) d[i] = Math.min(d[i], d[i - W - 1] + 1.414)
    if (y > 0 && x < W - 1) d[i] = Math.min(d[i], d[i - W + 1] + 1.414)
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x
    if (y < H - 1) d[i] = Math.min(d[i], d[i + W] + 1)
    if (x < W - 1) d[i] = Math.min(d[i], d[i + 1] + 1)
    if (y < H - 1 && x < W - 1) d[i] = Math.min(d[i], d[i + W + 1] + 1.414)
    if (y < H - 1 && x > 0) d[i] = Math.min(d[i], d[i + W - 1] + 1.414)
  }
  return d
}

/** feathered 0..1 mask for an ellipse */
async function featherMask({ cx, cy, rx, ry }) {
  const m = Buffer.alloc(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry
      if (dx * dx + dy * dy <= 1) m[y * W + x] = 255
    }
  }
  const soft = await sharp(m, { raw: { width: W, height: H, channels: 1 } })
    .blur(sp(5)).toColourspace('b-w').raw().toBuffer()
  const stride = soft.length / (W * H)
  const out = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) out[i] = soft[i * stride] / 255
  return out
}

/** how close the mask's support comes to the silhouette edge; small = the seam risks the outline */
function clearance(mask, dist) {
  let worst = Infinity
  for (let i = 0; i < W * H; i++) if (mask[i] > 0.004) worst = Math.min(worst, dist[i])
  return worst === Infinity ? 999 : worst
}

/**
 * The feathered ellipse, tapered to zero as it approaches the character's outline. Tapering keeps
 * the patch full size where there is room and fades it only where an edge is near, so the seam can
 * never cross the outline. `clipped` reports how much coverage that cost.
 */
async function safeMask(region, dist, minClear = si(10)) {
  const ell = await featherMask(region)
  const mask = new Float32Array(W * H)
  let want = 0, got = 0
  for (let i = 0; i < W * H; i++) {
    if (ell[i] <= 0) continue
    const t = Math.min(1, Math.max(0, (dist[i] - sp(2)) / (minClear - sp(2))))
    mask[i] = ell[i] * t * t * (3 - 2 * t)        // smoothstep
    want += ell[i]
    got += mask[i]
  }
  return { mask, clear: clearance(mask, dist), region, clipped: want ? 1 - got / want : 0 }
}

/* ------------------------------------------------------------- alignment */

function at(v, x, y) {
  if (x < 0 || y < 0 || x > W - 1 || y > H - 1) return 0
  const x0 = Math.floor(x), y0 = Math.floor(y)
  const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1)
  const fx = x - x0, fy = y - y0
  return v[y0 * W + x0] * (1 - fx) * (1 - fy) + v[y0 * W + x1] * fx * (1 - fy)
    + v[y1 * W + x0] * (1 - fx) * fy + v[y1 * W + x1] * fx * fy
}

/**
 * The shift that registers a donor's local anatomy onto the canonical's, over a box around the
 * patch with the CHANGING pixels excluded (matching open eyes to closed eyes would be meaningless).
 * The search span and step both scale, so the sample count — and the cost — stay the same.
 */
function localShift(canonInk, donorInk, region, D, canon) {
  const span = sp(3), step = sp(ALIGN_STEP_BASE)
  const { cx, cy, rx, ry, thr } = region
  const x0 = Math.max(2, Math.round(cx - 1.9 * rx)), x1 = Math.min(W - 2, Math.round(cx + 1.9 * rx))
  const y0 = Math.max(2, Math.round(cy - 1.9 * ry)), y1 = Math.min(H - 2, Math.round(cy + 1.9 * ry))
  const pts = []
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x
      if (D[i] > 0.12 * thr / 0.25) continue          // skip what the face state changes
      if (canon[i * 4 + 3] < 200) continue
      pts.push(i)
    }
  }
  if (pts.length < sa(200)) return { tx: 0, ty: 0, n: pts.length, gain: 0 }
  const score = (tx, ty) => {
    let s = 0
    for (const i of pts) {
      const x = i % W, y = (i - x) / W
      s += Math.abs(canonInk[i] - at(donorInk, x - tx, y - ty))
    }
    return s
  }
  const e0 = score(0, 0)
  let best = { tx: 0, ty: 0, e: e0 }
  for (let ty = -span; ty <= span + 1e-9; ty += step) {
    for (let tx = -span; tx <= span + 1e-9; tx += step) {
      const e = score(tx, ty)
      if (e < best.e) best = { tx, ty, e }
    }
  }
  return { tx: best.tx, ty: best.ty, n: pts.length, gain: 1 - best.e / e0 }
}

/* ------------------------------------------------------------ compositing */

/** out = base, then each patch lerped in through its mask; byte-identical where m == 0 */
function compose(base, patches) {
  const out = Buffer.from(base)
  for (const { mask, buf } of patches) {
    for (let i = 0; i < W * H; i++) {
      const m = mask[i]
      if (m <= 0) continue
      const o = i * 4
      const aB = out[o + 3] / 255, aS = buf[o + 3] / 255
      const aO = aB * (1 - m) + aS * m
      if (aO <= 0) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; continue }
      for (let c = 0; c < 3; c++) {
        out[o + c] = Math.min(255, Math.round((out[o + c] * aB * (1 - m) + buf[o + c] * aS * m) / aO))
      }
      out[o + 3] = Math.round(aO * 255)
    }
  }
  return out
}

/* ------------------------------------------------------------------ main */

/**
 * @param frames  { base, blink, open } full-canvas RGBA buffers, all W x H
 * @param dims    { W, H } the canvas the frames are in
 * @param workDir where to drop the assembled states and the mask overlays for inspection
 * @returns { states: { closed, open, blink, blinkOpen }, regions: { eyeR, mouthR }, info, files }
 */
export async function assembleStates(id, frames, dims, workDir, opts = {}) {
  W = dims.W; H = dims.H; S = W / BASE_W
  for (const k of SRC_FRAMES) if (!frames[k]) throw new Error(`${id}: the source set is missing ${k}.png`)

  const ink = {}
  for (const k of SRC_FRAMES) ink[k] = inkOf(frames[k])

  const bb = bboxOfBuf(frames.base)
  const band = { y0: bb.y0, y1: Math.round(bb.y0 + HEAD_FRAC * (bb.y1 - bb.y0 + 1)) }

  // one pair each: there is no second pair to take min() against
  const Deyes = new Float32Array(W * H), Dmouth = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) {
    Deyes[i] = Math.abs(ink.base[i] - ink.blink[i])
    Dmouth[i] = Math.abs(ink.base[i] - ink.open[i])
  }
  const solid = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) solid[i] = Math.min(...SRC_FRAMES.map(k => frames[k][i * 4 + 3]))
  const dist = distanceToEdge(solid)

  // the eyes first, then the mouth below them and inside their x-span: a cheap anatomical prior
  // that stops the mouth region wandering onto the chin or the collar
  let eyeFound = regionFrom(Deyes, band, `${id} eyes`)
  const mouthFound = regionFrom(Dmouth, band, `${id} mouth`, {
    x0: Math.round(eyeFound.cx - 2.0 * eyeFound.rx),
    x1: Math.round(eyeFound.cx + 2.0 * eyeFound.rx),
    y0: Math.round(eyeFound.box.y1 - si(8)), y1: band.y1,
  })
  if (eyeFound.box.y1 > mouthFound.box.y0) {
    const reach = Math.max(si(60), 7 * (mouthFound.box.y1 - mouthFound.box.y0))
    eyeFound = regionFrom(Deyes, band, `${id} eyes`, {
      x0: 0, x1: W,
      y0: Math.max(band.y0, mouthFound.box.y0 - reach), y1: mouthFound.box.y0,
    })
  }
  /* opts.eyeGrow = [drx, dry] base px (daeun): her open eye's outer lash flick reaches past the
   * found region, so the patch's feather mixed a ghost of it into the closed eye. Unset = unchanged. */
  if (opts.eyeGrow) { eyeFound.rx += si(opts.eyeGrow[0]); eyeFound.ry += si(opts.eyeGrow[1]) }
  const eyeSafe = await safeMask(eyeFound, dist)
  const mouthSafe = await safeMask(mouthFound, dist)
  const eyeR = eyeSafe.region, mouthR = mouthSafe.region
  const eyeMask = eyeSafe.mask, mouthMask = mouthSafe.mask

  // medoid: which frame agrees best with the others over the head, OUTSIDE the two regions?
  const outside = []
  for (let y = band.y0; y < band.y1; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (eyeMask[i] > 0.004 || mouthMask[i] > 0.004) continue
      outside.push(i)
    }
  }
  if (outside.length < sa(2000)) {
    throw new Error(`${id}: the patch masks swallowed the head band (${outside.length} px left) — the regions are wrong`)
  }
  const pairCost = (a, b) => {
    let d = 0, s = 0
    for (const i of outside) { d += Math.abs(ink[a][i] - ink[b][i]); s += ink[a][i] }
    return s ? d / s : 0
  }
  const scores = SRC_FRAMES.map(k => ({
    frame: k,
    score: SRC_FRAMES.filter(t => t !== k).reduce((acc, t) => acc + pairCost(k, t), 0) / (SRC_FRAMES.length - 1),
  })).sort((p, q) => p.score - q.score)
  /* The medoid elects whichever frame agrees best with the others — which is wrong when the set
   * is one piece of approved art plus two generations of it: the two generations agree with each
   * other more closely than either agrees with the art, so the art loses and the shipped body
   * becomes generated. `canon` pins it when the caller knows which frame is authoritative. */
  let canon = scores[0].frame
  if (opts.canon) {
    if (!SRC_FRAMES.includes(opts.canon)) throw new Error(`${id}: canon must be one of ${SRC_FRAMES.join(', ')}`)
    canon = opts.canon
  }
  const rank = scores.map(r => r.frame)

  // donors: among the frames that have the needed state, the one that agrees best with the canonical
  const donorFor = (kind, want) =>
    rank.find(k => k !== canon && SRC_PROPS[k][kind] === want)
    ?? SRC_FRAMES.find(k => SRC_PROPS[k][kind] === want)

  const canonBuf = frames[canon], canonInk = ink[canon]

  fs.mkdirSync(workDir, { recursive: true })
  const maskPng = async (mask, name) => {
    const m = Buffer.alloc(W * H)
    for (let i = 0; i < W * H; i++) m[i] = Math.round(mask[i] * 255)
    await sharp(m, { raw: { width: W, height: H, channels: 1 } }).png().toFile(path.join(workDir, `patch-${name}.png`))
  }
  await maskPng(eyeMask, 'eyes')
  await maskPng(mouthMask, 'mouth')
  {
    const ov = Buffer.from(canonBuf)
    for (let i = 0; i < W * H; i++) {
      const o = i * 4
      if (eyeMask[i] > 0.004) ov[o] = Math.min(255, ov[o] + Math.round(110 * eyeMask[i]))
      if (mouthMask[i] > 0.004) ov[o + 1] = Math.min(255, ov[o + 1] + Math.round(110 * mouthMask[i]))
    }
    await writePng(ov, path.join(workDir, 'patch-overlay.png'))
  }

  const states = {}, files = {}, rows = []
  for (const target of STATES) {
    const patches = []
    const note = []
    for (const [kind, region, mask, D] of [['eyes', eyeR, eyeMask, Deyes], ['mouth', mouthR, mouthMask, Dmouth]]) {
      if (SRC_PROPS[canon][kind] === PROPS[target][kind]) { note.push(`${kind}:canonical`); continue }
      const donor = donorFor(kind, PROPS[target][kind])
      const sh = localShift(canonInk, ink[donor], region, D, canonBuf)
      patches.push({ mask, buf: shiftRGBA(frames[donor], sh.tx, sh.ty) })
      note.push(`${kind}<-${donor} @(${sh.tx >= 0 ? '+' : ''}${sh.tx.toFixed(2)},${sh.ty >= 0 ? '+' : ''}${sh.ty.toFixed(2)})`)
    }
    const outBuf = patches.length ? compose(canonBuf, patches) : Buffer.from(canonBuf)
    states[target] = outBuf
    files[target] = path.join(workDir, `${target}.png`)
    await writePng(outBuf, files[target])
    rows.push({ target, note: note.join('  '), patches: patches.length })
  }

  /* ---- verification: outside the union of the two masks every state must be byte-identical to
   * the canonical, which is the invariant the whole of cut-human.mjs rests on. */
  const union = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) union[i] = Math.max(eyeMask[i], mouthMask[i])
  const yCut = Math.min(H - 1, mouthFound.box.y1 + si(24))
  const checks = []
  for (const target of STATES) {
    const got = states[target]
    let outDiff = 0, inDiff = 0
    for (let i = 0; i < W * H; i++) {
      const o = i * 4
      let d = 0
      for (let c = 0; c < 4; c++) d += Math.abs(got[o + c] - canonBuf[o + c])
      if (union[i] <= 0) outDiff += d
      else inDiff += d
    }
    const gi = inkOf(got)
    let bd = 0, bs = 0
    for (let y = yCut; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x
      bd += Math.abs(gi[i] - canonInk[i]); bs += canonInk[i]
    }
    checks.push({ target, outsideBytesDiff: outDiff, insideBytesDiff: inDiff, bodyMismatch: bs ? bd / bs : 0 })
  }
  const broke = checks.filter(c => c.outsideBytesDiff !== 0)
  if (broke.length) {
    throw new Error(`${id}: ${broke.map(c => c.target).join(', ')} differ from the canonical body outside the patch masks `
      + `(${broke.map(c => c.outsideBytesDiff).join(', ')} bytes) — the four states would not be registered`)
  }

  /* the drift the source frames arrived with, for the record: how far apart the raw bodies are
   * below the shoulder line before any of this runs */
  const rawDrift = SRC_FRAMES.filter(k => k !== canon).map(k => {
    let d = 0, s = 0
    for (let y = yCut; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x
      d += Math.abs(ink[k][i] - canonInk[i]); s += canonInk[i]
    }
    return { frame: k, mismatch: s ? d / s : 0 }
  })

  const info = {
    canon, pinned: !!opts.canon, rank, scores, rows, checks, rawDrift,
    eyeR, mouthR,
    eyeClear: eyeSafe.clear, mouthClear: mouthSafe.clear,
    eyeClipped: eyeSafe.clipped, mouthClipped: mouthSafe.clipped,
    eyeFound, mouthFound, band, yCut,
  }
  return {
    states: { closed: states.closed, open: states.open, blink: states.blink, blinkOpen: states['blink-open'] },
    regions: { eyeR, mouthR },
    files, info,
  }
}

/** one block of console output describing what the assembly did */
export function printAssembly(id, info) {
  console.log(`  assembled from 3 frames — canonical body: ${info.canon}${info.pinned ? ' (PINNED)' : ''}  (agreement, lower is better: `
    + info.scores.map(r => `${r.frame} ${(r.score * 100).toFixed(2)}%`).join(', ') + ')')
  console.log(`  raw source drift below y ${info.yCut}: `
    + info.rawDrift.map(r => `${r.frame} ${(r.mismatch * 100).toFixed(2)}%`).join(', '))
  const fmt = (name, r, found, clear, clipped) =>
    `  ${name} centre (${r.cx.toFixed(0)}, ${r.cy.toFixed(0)})  radii ${r.rx.toFixed(0)} x ${r.ry.toFixed(0)}`
    + `  feature box ${found.box.x1 - found.box.x0}x${found.box.y1 - found.box.y0} (${found.blobs} blobs)`
    + `  clearance ${clear.toFixed(1)}px  clipped ${(clipped * 100).toFixed(1)}%`
  console.log(fmt('eye  ', info.eyeR, info.eyeFound, info.eyeClear, info.eyeClipped))
  console.log(fmt('mouth', info.mouthR, info.mouthFound, info.mouthClear, info.mouthClipped))
  for (const r of info.rows) console.log(`    ${r.target.padEnd(11)} ${r.note}`)
  for (const c of info.checks) {
    console.log(`    ${c.target.padEnd(11)} outside-mask byte diff ${String(c.outsideBytesDiff).padStart(8)}`
      + `   body mismatch ${(c.bodyMismatch * 100).toFixed(3)}%`)
  }
}
