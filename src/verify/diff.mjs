/**
 * Package comparison: per-file sha256 + structural model.json diff (DESIGN §6.2 `diff`, §6.7 step 4).
 * Owner: Track B (B4). Read only. Re-implements the session scratch tool cmp-pkg.mjs (§4.7).
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { everything } from '../pack/zip.mjs'

/**
 * sha256 of every file in a package folder, keyed by package-relative '/' path, keys sorted.
 * Every file counts (also ones pack would leave out), so a stray file in a build is reported.
 * @param {string} dir
 * @returns {Promise<Record<string, string>>}
 */
export async function fileShas(dir) {
  const out = {}
  for (const rel of await everything(dir)) out[rel] = sha256(fs.readFileSync(path.join(dir, ...rel.split('/'))))
  return out
}

/**
 * @param {Record<string, string>} want  e.g. lock.outputs
 * @param {Record<string, string>} got   fileShas(built)
 * @returns {{ ok: boolean, same: string[], different: string[], missing: string[], extra: string[] }}
 *   missing = in want, not in got; extra = in got, not in want
 */
export function compareFiles(want, got) {
  const same = [], different = [], missing = [], extra = []
  for (const rel of Object.keys(want).sort()) {
    if (!Object.hasOwn(got, rel)) missing.push(rel)
    else if (got[rel] === want[rel]) same.push(rel)
    else different.push(rel)
  }
  for (const rel of Object.keys(got).sort()) if (!Object.hasOwn(want, rel)) extra.push(rel)
  return { ok: !different.length && !missing.length && !extra.length, same, different, missing, extra }
}

/**
 * Structural diff of two parsed model.json values. Reports value differences, missing/extra keys and
 * object key ORDER differences (key order is model.json bytes). Arrays compare by index.
 * @param {unknown} a  e.g. the golden model
 * @param {unknown} b  e.g. the built model
 * @param {{ maskCreated?: boolean, limit?: number }} [opts]
 * @returns {{ path: string, kind: 'value'|'missing'|'extra'|'type'|'order'|'length', a?: unknown, b?: unknown }[]}
 */
export function modelDiff(a, b, { maskCreated = false, limit = 200 } = {}) {
  const out = []
  const push = (d) => { if (out.length < limit) out.push(d) }
  const walk = (x, y, at) => {
    if (out.length >= limit) return
    if (maskCreated && at === '/meta/created') return
    const tx = kind(x), ty = kind(y)
    if (tx !== ty) return push({ path: at || '/', kind: 'type', a: short(x), b: short(y) })
    if (tx === 'array') {
      if (x.length !== y.length) push({ path: at || '/', kind: 'length', a: x.length, b: y.length })
      for (let i = 0; i < Math.min(x.length, y.length); i++) walk(x[i], y[i], `${at}/${i}`)
      return
    }
    if (tx === 'object') {
      const kx = Object.keys(x), ky = Object.keys(y)
      for (const k of kx) if (!Object.hasOwn(y, k)) push({ path: `${at}/${esc(k)}`, kind: 'missing', a: short(x[k]) })
      for (const k of ky) if (!Object.hasOwn(x, k)) push({ path: `${at}/${esc(k)}`, kind: 'extra', b: short(y[k]) })
      const common = kx.filter((k) => Object.hasOwn(y, k))
      const commonB = ky.filter((k) => Object.hasOwn(x, k))
      if (common.join('\0') !== commonB.join('\0')) push({ path: at || '/', kind: 'order', a: common, b: commonB })
      for (const k of common) walk(x[k], y[k], `${at}/${esc(k)}`)
      return
    }
    if (!Object.is(x, y)) push({ path: at || '/', kind: 'value', a: x, b: y })
  }
  walk(a, b, '')
  return out
}

/**
 * Compare two package folders.
 * @param {string} dirA
 * @param {string} dirB
 * @param {{ maskCreated?: boolean }} [opts]
 * @returns {Promise<{ files: ReturnType<typeof compareFiles>, model: ReturnType<typeof modelDiff>|null, modelBytesEqual: boolean|null, ok: boolean }>}
 */
export async function diffDirs(dirA, dirB, { maskCreated = false } = {}) {
  const files = compareFiles(await fileShas(dirA), await fileShas(dirB))
  const ma = readJson(path.join(dirA, 'model.json')), mb = readJson(path.join(dirB, 'model.json'))
  let model = null, modelBytesEqual = null
  if (ma.ok && mb.ok) {
    modelBytesEqual = ma.raw.equals(mb.raw)
    model = modelBytesEqual ? [] : modelDiff(ma.value, mb.value, { maskCreated })
  }
  const filesOk = maskCreated
    ? !files.missing.length && !files.extra.length && files.different.every((f) => f === 'model.json') && (model?.length ?? 1) === 0
    : files.ok
  return { files, model, modelBytesEqual, ok: filesOk }
}

/** Human-readable lines for a diffDirs / compareFiles + modelDiff result. */
export function formatDiff({ files, model }, { labelA = 'A', labelB = 'B', max = 40 } = {}) {
  const lines = []
  lines.push(`  files: ${files.same.length} same, ${files.different.length} different, ${files.missing.length} only in ${labelA}, ${files.extra.length} only in ${labelB}`)
  for (const f of files.different.slice(0, max)) lines.push(`    DIFFERENT  ${f}`)
  for (const f of files.missing.slice(0, max)) lines.push(`    ONLY IN ${labelA}  ${f}`)
  for (const f of files.extra.slice(0, max)) lines.push(`    ONLY IN ${labelB}  ${f}`)
  if (model && model.length) {
    lines.push(`  model.json: ${model.length}${model.length >= 200 ? '+' : ''} structural difference(s)`)
    for (const d of model.slice(0, max)) {
      const a = 'a' in d ? JSON.stringify(d.a) : '', b = 'b' in d ? JSON.stringify(d.b) : ''
      lines.push(`    ${d.kind.padEnd(7)} ${d.path}${a ? `  ${labelA}=${clip(a)}` : ''}${b ? `  ${labelB}=${clip(b)}` : ''}`)
    }
  }
  return lines
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file)
    return { ok: true, raw, value: JSON.parse(raw.toString('utf8')) }
  } catch {
    return { ok: false }
  }
}
const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1')
const short = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? `[array ${v.length}]` : `{${Object.keys(v).slice(0, 6).join(',')}}`) : v)
const clip = (s) => (s.length > 80 ? `${s.slice(0, 77)}...` : s)
export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}
