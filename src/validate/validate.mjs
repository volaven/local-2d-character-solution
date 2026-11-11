/**
 * Validate a native format-4 package folder (DESIGN §6.9 validate).   Owner: Track B (B2).
 *
 * Port of famcoach tools/livliv/validate.mjs 415a7eae (legacy/tools/livliv/validate.mjs.txt).
 * The checks, their order and their messages are unchanged. Plumbing changes only:
 *  - no import-time work: the package directory, the Python command and the schema path are
 *    arguments (the old LIVLIV_PACKAGES env read and the webapp sharp loader are gone);
 *  - sharp comes from src/runtime.mjs; the schema is the vendored
 *    third_party/livliv-player/schema/livliv-model-v4.json (caa739d6, unmodified);
 *  - Python is the one src/config.mjs resolved (cfg.python); it is still run with -I;
 *  - printResult() became formatResult() (lines returned, nothing printed); the CLI is
 *    src/commands/validate.mjs. The one message that named "livliv-cast/livliv/" (a package that is
 *    not a directory) now says only "is not a directory"; every other message is verbatim.
 *
 * Two layers of checking:
 *  1. model.json against the 2020-12 schema, through Python jsonschema 4.26 (Draft202012Validator).
 *  2. FORMAT.md §8, the writer rules a schema cannot express: unique ids and hotkeys, references
 *     that resolve, frames/visemes, image sizes on disk, boxes inside the canvas, files present,
 *     an empty `requires`, and unreferenced textures.
 * Errors fail a package. Warnings never do.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { sharp } from '../runtime.mjs'
import { REPO_ROOT } from '../config.mjs'

export const SCHEMA = path.join(REPO_ROOT, 'third_party', 'livliv-player', 'schema', 'livliv-model-v4.json')

/** FORMAT.md Appendix A. Anything else must start with x_ (FORMAT.md §8.8) */
const STANDARD_EXPRESSIONS = new Set([
  'smile', 'shy', 'angry', 'sad', 'surprised', 'puffed', 'tongue_out', 'laugh', 'smirk', 'starry_eyes', 'raised_brow',
])
const MOUTH_VISEMES = ['closed', 'half', 'open']
/** the single-image fields of a layer; `frames` is an array of them */
const IMAGE_FIELDS = ['texture', 'mask', 'talk', 'brow_tex']
/** what never belongs in a package (so neither validate nor pack looks at it) */
const JUNK = /^(?:__MACOSX|\.DS_Store|Thumbs\.db|\._.*|\..*)$/

// ---------------------------------------------------------------------------- the 2020-12 schema

/** jsonschema 4.26 (Draft202012Validator), every error as a JSON pointer. Paths go in as argv,
 *  nothing is interpolated. Unchanged from validate.mjs 415a7eae. */
const PY_SCHEMA_CHECK = `
import json, re, sys
from datetime import datetime
from jsonschema import Draft202012Validator, FormatChecker

schema_path, instance_path = sys.argv[1], sys.argv[2]

def out(o):
    sys.stdout.write(json.dumps(o))
    raise SystemExit(0)

try:
    schema = json.load(open(schema_path, encoding='utf-8'))
except Exception as e:
    out({'fatal': 'the schema could not be read: %s' % e})
try:
    instance = json.load(open(instance_path, encoding='utf-8'))
except Exception as e:
    out({'fatal': 'model.json is not valid JSON: %s' % e})

# 2020-12 treats "format" as an annotation, and this jsonschema has no date-time/uri checker
# installed (rfc3339-validator / rfc3987 are not present), so assert the two the schema uses.
fc = FormatChecker()

@fc.checks('date-time', raises=ValueError)
def _date_time(v):
    if not isinstance(v, str):
        return True
    s = v
    if s.endswith('Z') or s.endswith('z'):
        s = s[:-1] + '+00:00'
    datetime.fromisoformat(s)
    return True

@fc.checks('uri')
def _uri(v):
    if not isinstance(v, str):
        return True
    return re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', v) is not None

try:
    Draft202012Validator.check_schema(schema)
except Exception as e:
    out({'fatal': 'the schema itself is not valid 2020-12: %s' % e})

validator = Draft202012Validator(schema, format_checker=fc)

def pointer(parts):
    s = ''
    for p in parts:
        s += '/' + str(p).replace('~', '~0').replace('/', '~1')
    return s

LIMIT = 400
errors = []

def walk(e, depth):
    if len(errors) >= LIMIT:
        return
    errors.append({
        'pointer': pointer(e.absolute_path),
        'keyword': str(e.validator),
        'schema': pointer(e.absolute_schema_path),
        'message': e.message.replace('\\n', ' '),
    })
    # oneOf / anyOf / allOf say only "is not valid under any of the given schemas"; the sub-errors
    # under .context are the ones that name the real problem, so report them too.
    if e.context and depth < 3:
        for sub in e.context:
            walk(sub, depth + 1)

for e in sorted(validator.iter_errors(instance), key=lambda e: [str(p) for p in e.absolute_path]):
    walk(e, 0)

out({'errors': errors, 'truncated': len(errors) >= LIMIT})
`

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 64 << 20, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

const pythonOk = new Map()
/** does `python` import jsonschema? (-I so nothing beside a model.json is importable); cached */
async function hasJsonschema(python) {
  if (!pythonOk.has(python)) {
    const { error, stdout } = await run(python, ['-I', '-c', 'import jsonschema,sys;sys.stdout.write(jsonschema.__name__)'])
    pythonOk.set(python, !error && stdout.includes('jsonschema'))
  }
  return pythonOk.get(python)
}

/**
 * @param {string} modelPath
 * @param {{ python: string|null, schema?: string }} opts
 * @returns {Promise<{errors: {pointer: string, keyword: string, schema: string, message: string}[], truncated?: boolean, fatal?: string}>}
 */
export async function checkSchema(modelPath, { python, schema = SCHEMA }) {
  if (!python) return { fatal: 'no python was configured (pass --python=, set VOLA_PYTHON, or "python" in the config file)', errors: [] }
  if (!(await hasJsonschema(python))) return { fatal: `${python} cannot import jsonschema (pip install -r requirements.txt)`, errors: [] }
  const { error, stdout, stderr } = await run(python, ['-I', '-c', PY_SCHEMA_CHECK, schema, modelPath])
  if (error && !stdout.trim()) return { fatal: `the schema check did not run: ${(stderr.trim() || error.message).split('\n').slice(-3).join(' ')}`, errors: [] }
  try {
    const parsed = JSON.parse(stdout)
    return { errors: parsed.errors ?? [], truncated: parsed.truncated, fatal: parsed.fatal }
  } catch {
    return { fatal: `the schema check wrote something unreadable: ${stdout.slice(0, 200)}`, errors: [] }
  }
}

// ---------------------------------------------------------------------------- files on disk

/** readdir, cached per package, so the case of every path can be checked exactly */
function makeDirReader() {
  const cache = new Map()
  return async (abs) => {
    if (!cache.has(abs)) cache.set(abs, await fsp.readdir(abs, { withFileTypes: true }).catch(() => null))
    return cache.get(abs)
  }
}

/** Resolve a package-relative path, segment by segment, against the real spelling on disk: Windows
 *  and macOS would happily open textures/Face.webp for "textures/face.webp", a ZIP and a web server
 *  would not. */
async function findExact(readDir, root, rel) {
  const parts = rel.split('/')
  let at = root
  for (let i = 0; i < parts.length; i++) {
    const entries = await readDir(at)
    if (!entries) return { ok: false, why: `${parts.slice(0, i).join('/') || '.'} is not a directory` }
    const hit = entries.find((e) => e.name === parts[i])
    if (!hit) {
      const other = entries.find((e) => e.name.toLowerCase() === parts[i].toLowerCase())
      return {
        ok: false,
        why: other
          ? `is not in the package — the file on disk is "${parts.slice(0, i).concat(other.name).join('/')}"; the spelling must match`
          : 'is not in the package',
      }
    }
    const last = i === parts.length - 1
    if (!last && !hit.isDirectory()) return { ok: false, why: `${parts.slice(0, i + 1).join('/')} is not a directory` }
    if (last && !hit.isFile()) return { ok: false, why: 'is not a file' }
    at = path.join(at, parts[i])
  }
  return { ok: true, abs: at }
}

/** every file under dir, as package-relative '/' paths, junk left out */
async function listFiles(dir, at = '') {
  const here = path.join(dir, at)
  const entries = await fsp.readdir(here, { withFileTypes: true }).catch(() => [])
  const out = []
  for (const e of entries) {
    if (JUNK.test(e.name)) continue
    const rel = at ? `${at}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await listFiles(dir, rel)))
    else if (e.isFile()) out.push(rel)
  }
  return out.sort()
}

/** lossless? a WebP is lossless when its image data is a VP8L chunk; PNG always is */
async function isLossless(abs) {
  if (/\.png$/i.test(abs)) return true
  const fh = await fsp.open(abs, 'r').catch(() => null)
  if (!fh) return null
  try {
    const { buffer, bytesRead } = await fh.read({ buffer: Buffer.alloc(64 << 10), position: 0 })
    if (bytesRead < 16 || buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WEBP') return null
    const tag = buffer.toString('latin1', 12, 16)
    if (tag === 'VP8L') return true
    if (tag === 'VP8 ') return false
    if (tag !== 'VP8X') return null
    // extended: walk the chunks for VP8L (lossless) or VP8 (lossy)
    for (let at = 12; at + 8 <= bytesRead; ) {
      const name = buffer.toString('latin1', at, at + 4)
      const size = buffer.readUInt32LE(at + 4)
      if (name === 'VP8L') return true
      if (name === 'VP8 ') return false
      at += 8 + size + (size & 1)
    }
    return null
  } finally {
    await fh.close()
  }
}

/** decode one image: its real pixel size, and what its alpha looks like */
async function readImage(abs) {
  const { data, info } = await sharp(abs).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let partial = 0, above = 0
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    if (a === 255 || a === 0) continue
    partial++
    if (data[i] > a || data[i + 1] > a || data[i + 2] > a) above++
  }
  return { w: info.width, h: info.height, partial, above, lossless: await isLossless(abs) }
}

// ---------------------------------------------------------------------------- one package

/**
 * @param {string} dir  absolute package folder (holds model.json); read only
 * @param {{ python: string|null, schema?: string }} opts  python: cfg.python
 * @returns {Promise<{id, dir, model, errors: {rule: string, where: string, msg: string}[], warnings: {rule, where, msg}[], stats: object, images?: Map}>}
 *   id = the folder's basename
 */
export async function validatePackage(dir, { python, schema = SCHEMA } = {}) {
  const id = path.basename(dir)
  const errors = [], warnings = []
  const err = (rule, where, msg) => errors.push({ rule, where, msg })
  const warn = (rule, where, msg) => warnings.push({ rule, where, msg })
  const stats = { layers: 0, expressions: 0, images: 0, files: 0, bytes: 0 }
  const readDir = makeDirReader()

  const stat = await fsp.stat(dir).catch(() => null)
  if (!stat?.isDirectory()) {
    err('package', id, 'is not a directory')
    return { id, dir, model: null, errors, warnings, stats }
  }

  const modelPath = path.join(dir, 'model.json')
  let raw
  try {
    raw = await fsp.readFile(modelPath, 'utf8')
  } catch {
    err('package', 'model.json', 'is missing')
    return { id, dir, model: null, errors, warnings, stats }
  }
  let model = null
  try {
    model = JSON.parse(raw)
  } catch (e) {
    err('json', 'model.json', `is not valid JSON: ${e.message}`)
    return { id, dir, model: null, errors, warnings, stats }
  }

  // 1 ------------------------------------------------------------------ the schema
  const schemaResult = await checkSchema(modelPath, { python, schema })
  if (schemaResult.fatal) err('schema', 'model.json', schemaResult.fatal)
  for (const e of schemaResult.errors) err('schema', e.pointer || '/', `${e.message} (${e.keyword})`)
  if (schemaResult.truncated) warn('schema', 'model.json', 'more than 400 schema violations: the rest were left out')

  // 2 ------------------------------------------------------------------ FORMAT.md §8
  const layers = Array.isArray(model.layers) ? model.layers : []
  const expressions = Array.isArray(model.expressions) ? model.expressions : []
  const chains = Array.isArray(model.rig?.chains) ? model.rig.chains : []
  stats.layers = layers.length
  stats.expressions = expressions.length
  const at = (i) => `/layers/${i}`

  // §8.1 unique layer ids, expression ids, hotkeys
  const seenLayer = new Map()
  layers.forEach((l, i) => {
    const lid = l?.id
    if (typeof lid !== 'string') return
    if (seenLayer.has(lid)) err('§8.1', at(i), `layer id "${lid}" is already used by /layers/${seenLayer.get(lid)}`)
    else seenLayer.set(lid, i)
  })
  const exprIds = new Set()
  const seenExpr = new Map(), seenHotkey = new Map()
  expressions.forEach((x, i) => {
    const xid = x?.id
    if (typeof xid !== 'string') return
    exprIds.add(xid)
    if (seenExpr.has(xid)) err('§8.1', `/expressions/${i}`, `expression id "${xid}" is already used by /expressions/${seenExpr.get(xid)}`)
    else seenExpr.set(xid, i)
    if (!STANDARD_EXPRESSIONS.has(xid) && !xid.startsWith('x_')) {
      warn('§8.8', `/expressions/${i}`, `"${xid}" is not a standard id (FORMAT.md Appendix A), so it should be written as "x_${xid}"`)
    }
    if (x.hotkey == null) return
    if (seenHotkey.has(x.hotkey)) err('§8.1', `/expressions/${i}`, `hotkey "${x.hotkey}" is already used by /expressions/${seenHotkey.get(x.hotkey)}`)
    else seenHotkey.set(x.hotkey, i)
  })

  // §8.2 clip names a layer; bones name chains
  const chainIds = new Set(chains.map((c) => c?.id).filter((s) => typeof s === 'string'))
  layers.forEach((l, i) => {
    if (typeof l?.clip === 'string' && !seenLayer.has(l.clip)) err('§8.2', at(i), `clip "${l.clip}" is not a layer id`)
    if (Array.isArray(l?.bones)) {
      for (const b of l.bones) if (!chainIds.has(b)) err('§8.2', at(i), `bones names "${b}", which is not a chain in rig.chains`)
      const dupes = l.bones.filter((b, k) => l.bones.indexOf(b) !== k)
      if (dupes.length) warn('§8.5', at(i), `bones names ${[...new Set(dupes)].map((d) => `"${d}"`).join(', ')} more than once (the player counts a chain once per layer)`)
    }
  })

  // §8.3 every expression reference is a declared expression id
  const expectExpr = (where, field, value) => {
    if (!exprIds.has(value)) err('§8.3', where, `${field} names expression "${value}", which is not in expressions`)
  }
  layers.forEach((l, i) => {
    if (typeof l?.expression === 'string') expectExpr(at(i), 'expression', l.expression)
    for (const field of ['blush', 'show', 'hide']) {
      const o = l?.[field]
      if (o && typeof o === 'object') for (const k of Object.keys(o)) expectExpr(at(i), `${field}.${k}`, k)
    }
  })
  chains.forEach((c, i) => {
    if (c?.bias && typeof c.bias === 'object') {
      for (const k of Object.keys(c.bias)) expectExpr(`/rig/chains/${i}`, `bias.${k}`, k)
    }
  })

  // §8.4 frames/visemes
  layers.forEach((l, i) => {
    const frames = l?.frames, visemes = l?.visemes
    if (Array.isArray(frames) && Array.isArray(visemes) && frames.length !== visemes.length) {
      err('§8.4', at(i), `frames has ${frames.length} entries and visemes has ${visemes.length}`)
    }
    if (Array.isArray(visemes) && !Array.isArray(frames)) warn('§8.4', at(i), 'has visemes but no frames')
    if (l?.role === 'mouth') {
      const have = new Set(Array.isArray(visemes) ? visemes : [])
      const missing = MOUTH_VISEMES.filter((v) => !have.has(v))
      if (missing.length) err('§8.4', at(i), `role "mouth" is missing the viseme${missing.length > 1 ? 's' : ''} ${missing.join(', ')} (closed, half and open are the minimum)`)
    }
  })

  // §8.6 boxes inside the canvas
  const canvas = Array.isArray(model.canvas) && model.canvas.length >= 2 && model.canvas.every((n) => typeof n === 'number') ? model.canvas : null
  if (canvas) {
    layers.forEach((l, i) => {
      const { x, y, w, h } = l ?? {}
      if (![x, y, w, h].every((n) => typeof n === 'number')) return
      if (x < 0 || y < 0 || x + w > canvas[0] || y + h > canvas[1]) {
        err('§8.6', at(i), `the box [${x}, ${y}, ${w}x${h}] reaches ${x + w}, ${y + h}, outside the ${canvas[0]}x${canvas[1]} canvas`)
      }
    })
  }

  // §8.5 and §8.7 every image and listed file is in the package, every image is its layer's size
  /** @type {Map<string, {w,h,partial,above,lossless}|{error:string}>} */
  const images = new Map()
  const referenced = new Set()
  const image = async (rel) => {
    if (images.has(rel)) return images.get(rel)
    const found = await findExact(readDir, dir, rel)
    let info
    if (!found.ok) info = { error: found.why }
    else {
      try {
        info = await readImage(found.abs)
        info.bytes = (await fsp.stat(found.abs)).size
      } catch (e) {
        info = { error: `could not be decoded: ${e.message}` }
      }
    }
    images.set(rel, info)
    return info
  }

  for (let i = 0; i < layers.length; i++) {
    const l = layers[i]
    if (!l || typeof l !== 'object') continue
    const paths = []
    for (const f of IMAGE_FIELDS) if (typeof l[f] === 'string') paths.push([f, l[f]])
    if (Array.isArray(l.frames)) l.frames.forEach((p, k) => { if (typeof p === 'string') paths.push([`frames/${k}`, p]) })
    for (const [field, rel] of paths) {
      referenced.add(rel)
      const info = await image(rel)
      if (info.error) { err('§8.5', at(i), `${field} "${rel}" ${info.error}`); continue }
      if (typeof l.w === 'number' && typeof l.h === 'number' && (info.w !== l.w || info.h !== l.h)) {
        err('§8.5', at(i), `${field} "${rel}" is ${info.w}x${info.h}, but the layer box is ${l.w}x${l.h}`)
      }
      if (field === 'mask' && info.lossless === false) {
        warn('§7', at(i), `mask "${rel}" is lossy WebP; FORMAT.md §7 says a mask must be lossless`)
      } else if (info.lossless === false) {
        warn('§7', at(i), `${field} "${rel}" is lossy WebP (SPEC.md §1 asks for lossless everywhere, to keep alpha clean)`)
      }
    }
  }
  // Straight (not premultiplied) alpha, as far as a decoded image can tell: premultiplying can never
  // leave a colour channel above the alpha, so a pixel above it proves the alpha is straight. The
  // count goes in the summary; only an image with many partly transparent pixels and none above its
  // alpha is suspicious enough to warn about, and even that never fails the package.
  stats.alpha = { partial: 0, above: 0 }
  for (const [rel, info] of images) {
    if (info.error) continue
    stats.alpha.partial += info.partial
    stats.alpha.above += info.above
    if (!info.above && info.partial >= 256) {
      warn('alpha', rel, `none of its ${info.partial} partly transparent pixels has a colour channel above its alpha: the alpha may be premultiplied`)
    }
  }
  stats.images = images.size
  stats.bytes = [...images.values()].reduce((n, i) => n + (i.bytes ?? 0), 0)

  // §8.5 files
  const files = model.files && typeof model.files === 'object' ? model.files : {}
  for (const [key, rel] of Object.entries(files)) {
    if (typeof rel !== 'string') continue
    const found = await findExact(readDir, dir, rel)
    if (!found.ok) err('§8.5', `/files/${key}`, `"${rel}" ${found.why}`)
    stats.files++
  }

  // §8.7 requires
  if (model.requires === undefined) warn('§8.7', '/requires', 'is missing; FORMAT.md §2 says to write [] in 4.0')
  else if (!Array.isArray(model.requires)) err('§8.7', '/requires', 'is not an array')
  else if (model.requires.length) err('§8.7', '/requires', `names ${model.requires.map((r) => `"${r}"`).join(', ')}; no feature is defined in 4.0, so it must be []`)

  // 9 ------------------------------------------------------------------ unreferenced textures
  const onDisk = await listFiles(dir)
  const listed = new Set([...Object.values(files).filter((v) => typeof v === 'string'), 'model.json'])
  for (const rel of onDisk) {
    if (!rel.startsWith('textures/')) continue
    if (!referenced.has(rel)) warn('§4', rel, 'is in textures/ but no layer references it')
  }
  for (const rel of onDisk) {
    if (rel.startsWith('textures/') || listed.has(rel)) continue
    if (rel === 'keyforms.json') continue
    warn('§4', rel, 'is in the package but is not model.json, a texture, or a file listed in files (pack.mjs will leave it out if it looks like scratch)')
  }

  return { id, dir, model, errors, warnings, stats, images }
}

// ---------------------------------------------------------------------------- the report

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** printResult() of validate.mjs, as lines. */
export function formatResult(result) {
  const { id, errors, warnings, stats, model } = result
  const lines = [`${id}  ${errors.length ? 'FAILED' : 'ok'}`]
  if (model) {
    const canvas = Array.isArray(model.canvas) ? model.canvas.join('x') : '?'
    const size = stats.bytes >= 1e6 ? `${(stats.bytes / 1e6).toFixed(2)} MB` : `${Math.round(stats.bytes / 1e3)} kB`
    lines.push(`  ${plural(stats.layers, 'layer')}, ${plural(stats.expressions, 'expression')}, ${plural(stats.images, 'image')}` +
      `${stats.files ? `, ${plural(stats.files, 'listed file')}` : ''}, canvas ${canvas}, ${size} of images`)
    if (stats.alpha?.partial) {
      lines.push(`  alpha: ${stats.alpha.above.toLocaleString('en')} of ${stats.alpha.partial.toLocaleString('en')} partly transparent pixels` +
        ` have a colour channel above their alpha, which only straight (non-premultiplied) alpha can`)
    }
  }
  for (const e of errors) lines.push(`  error  ${e.rule.padEnd(6)} ${e.where}: ${e.msg}`)
  for (const w of warnings) lines.push(`  warn   ${w.rule.padEnd(6)} ${w.where}: ${w.msg}`)
  lines.push(`  ${errors.length ? `${plural(errors.length, 'error')}, ` : ''}${plural(warnings.length, 'warning')}`)
  return lines
}

/** A warning as one stable string (lock.validate.warnings, verify step 6). */
export function warningKey(w) {
  return `${w.rule} ${w.where}: ${w.msg}`
}
