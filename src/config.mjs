/**
 * Path config and the write guard (DESIGN §6.3, §3.4 #1-2, §9 D1).   Owner after Step 0: Track B.
 *
 * Precedence for each path: CLI flag > environment variable > config file > ERROR.
 * There is no built-in default for any path (no E: default anywhere in the code).
 *
 *   key        flag (bin/vola-live.mjs)   env               config file key
 *   castRoot   --cast-root=<abs>          VOLA_CAST_ROOT    castRoot
 *   outRoot    --out-root=<abs>           VOLA_OUT          outRoot
 *   workRoot   --work-root=<abs>          VOLA_WORK         workRoot
 *   python     --python=<exe>             VOLA_PYTHON       python     (then LIVLIV_PYTHON, then the
 *                                                                       first of python, python3, py that runs)
 *   (file)     --config=<file>            VOLA_LIVE_CONFIG  -          default <repo>/vola-live.config.json
 *
 * Extra config-file key (Step 0 addition, optional): `readOnlyRoots: [abs, ...]`. Each is treated
 * like castRoot: out/work may not overlap it and guardWrite refuses paths inside it. Use it for the
 * rest of the famcoach tree (livliv-player, webapp), which is read-only too.
 *
 * Rules enforced here:
 *  - every path must be absolute (a relative flag would make the result depend on cwd, §1 I3);
 *  - outRoot and workRoot may not equal, lie inside, or contain castRoot or any readOnlyRoot.
 *    Comparison is done on real paths (junctions/symlinks resolved, case-insensitive on Windows),
 *    so a junction under _out that points into livliv-cast is refused too;
 *  - guardWrite() allows a write only inside outRoot or workRoot and never inside castRoot.
 *    The single exception is guardLockWrite() (B3): <repo>/profiles/<id>.lock.json, written by `lock`.
 *
 * Unknown keys in the config file are an error (strictness, §3.4 #3).
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { VolaError, EXIT } from './errors.mjs'

/** Repository root, from this file's location (never from cwd). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_CONFIG_FILE = path.join(REPO_ROOT, 'vola-live.config.json')

const PATH_KEYS = /** @type {const} */ (['castRoot', 'outRoot', 'workRoot'])
const FILE_KEYS = new Set([...PATH_KEYS, 'python', 'readOnlyRoots'])
const ENV_OF = { castRoot: 'VOLA_CAST_ROOT', outRoot: 'VOLA_OUT', workRoot: 'VOLA_WORK', python: 'VOLA_PYTHON' }
const FLAG_OF = { castRoot: '--cast-root', outRoot: '--out-root', workRoot: '--work-root', python: '--python', config: '--config' }
const PYTHON_FALLBACK = ['python', 'python3', 'py']

/**
 * @typedef {object} VolaConfig
 * @property {string} castRoot   absolute real path of livliv-cast (READ ONLY)
 * @property {string} outRoot    absolute real path; `build` writes <outRoot>/<id>/
 * @property {string} workRoot   absolute real path; repro, verify, lab, scratch
 * @property {string|null} python  command for Python (validate); null when none was found
 * @property {string[]} readOnlyRoots  castRoot first, then the config file's readOnlyRoots
 * @property {string|null} configFile  the config file that was read, or null
 * @property {Record<string, 'flag'|'env'|'file'|'fallback'|'probe'|'none'>} sources  where each value came from
 */

/**
 * Resolve the path config. Pure apart from reading the config file, resolving real paths and
 * (only when no python was given) probing for a Python executable.
 *
 * @param {{ flags?: { castRoot?: string, outRoot?: string, workRoot?: string, python?: string, config?: string },
 *           env?: Record<string, string|undefined> }} [args]
 *   flags: the parsed global CLI flags (camelCase). env: pass `process.env` from the CLI layer;
 *   nothing below bin/ reads process.env itself.
 * @returns {Readonly<VolaConfig>}
 * @throws {VolaError} exit 2 when a path is missing, relative, or overlaps castRoot / a read-only root
 */
export function loadConfig({ flags = {}, env = {} } = {}) {
  const sources = {}
  const explicitFile = flags.config ?? env.VOLA_LIVE_CONFIG ?? null
  const file = explicitFile ?? DEFAULT_CONFIG_FILE
  if (explicitFile && !path.isAbsolute(explicitFile)) {
    throw usage(`config file must be an absolute path: ${explicitFile} (from ${flags.config ? FLAG_OF.config : 'VOLA_LIVE_CONFIG'})`)
  }
  let data = {}
  let configFile = null
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      throw usage(`cannot read config file ${file}: ${e.message}`)
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw usage(`config file ${file} must hold a JSON object`)
    const unknown = Object.keys(data).filter(k => !FILE_KEYS.has(k))
    if (unknown.length) throw usage(`config file ${file}: unknown key(s) ${unknown.join(', ')} (allowed: ${[...FILE_KEYS].join(', ')})`)
    configFile = file
  } else if (explicitFile) {
    throw usage(`config file not found: ${explicitFile}`)
  }

  const out = {}
  for (const key of PATH_KEYS) {
    let raw, from
    if (flags[key] != null) [raw, from] = [flags[key], 'flag']
    else if (env[ENV_OF[key]]) [raw, from] = [env[ENV_OF[key]], 'env']
    else if (data[key] != null) [raw, from] = [data[key], 'file']
    else {
      throw usage(`${key} is not set: pass ${FLAG_OF[key]}=<abs path>, set ${ENV_OF[key]}, or add "${key}" to ${configFile ?? DEFAULT_CONFIG_FILE} (see vola-live.config.example.json)`)
    }
    if (typeof raw !== 'string' || !raw.trim()) throw usage(`${key} (${from}) must be a non-empty string`)
    if (!path.isAbsolute(raw)) throw usage(`${key} must be an absolute path, got "${raw}" (from ${from})`)
    out[key] = realish(raw)
    sources[key] = from
  }

  let readOnlyExtra = []
  if (data.readOnlyRoots != null) {
    if (!Array.isArray(data.readOnlyRoots) || data.readOnlyRoots.some(p => typeof p !== 'string' || !path.isAbsolute(p))) {
      throw usage(`config file ${configFile}: readOnlyRoots must be an array of absolute paths`)
    }
    readOnlyExtra = data.readOnlyRoots.map(realish)
  }
  const readOnlyRoots = [out.castRoot, ...readOnlyExtra]

  // D1: Vola-live v1 never writes into livliv-cast (or any other read-only root).
  for (const key of ['outRoot', 'workRoot']) {
    for (const ro of readOnlyRoots) {
      const what = ro === out.castRoot ? 'castRoot' : `read-only root ${ro}`
      if (isInside(out[key], ro)) throw usage(`refused: ${key} ${out[key]} is inside (or equal to) ${what}. Vola-live never writes there (DESIGN §9 D1)`)
      if (isInside(ro, out[key])) throw usage(`refused: ${key} ${out[key]} contains ${what}; a write under ${key} could land in it`)
    }
  }

  let python
  if (flags.python != null) [python, sources.python] = [flags.python, 'flag']
  else if (env.VOLA_PYTHON) [python, sources.python] = [env.VOLA_PYTHON, 'env']
  else if (data.python != null) [python, sources.python] = [data.python, 'file']
  else if (env.LIVLIV_PYTHON) [python, sources.python] = [env.LIVLIV_PYTHON, 'fallback']
  else {
    python = PYTHON_FALLBACK.find(cmd => runs(cmd)) ?? null
    sources.python = python ? 'probe' : 'none'
  }
  if (python !== null && (typeof python !== 'string' || !python.trim())) throw usage('python must be a non-empty string')

  return Object.freeze({
    castRoot: out.castRoot,
    outRoot: out.outRoot,
    workRoot: out.workRoot,
    python,
    readOnlyRoots: Object.freeze(readOnlyRoots),
    configFile,
    sources: Object.freeze(sources),
  })
}

/**
 * castRoot-relative path -> absolute path, for READING inputs and shipped packages.
 * Profiles hold only castRoot-relative paths (§6.3); absolute paths and `..` segments are refused.
 *
 * @param {Pick<VolaConfig, 'castRoot'>} cfg
 * @param {string} rel  e.g. 'tools/livliv/_gen-sua2/sua2/base.png' ('/' or '\' separators)
 * @returns {string} absolute path under cfg.castRoot
 * @throws {VolaError} exit 2 for an absolute path or a path that leaves castRoot
 */
export function castPath(cfg, rel) {
  if (typeof rel !== 'string' || !rel) throw usage(`castPath: expected a castRoot-relative path, got ${JSON.stringify(rel)}`)
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || /^[\\/]/.test(rel)) {
    throw usage(`castPath: "${rel}" is absolute; profile paths are relative to castRoot (DESIGN §6.3)`)
  }
  const parts = rel.split(/[\\/]+/).filter(s => s !== '' && s !== '.')
  if (!parts.length || parts.includes('..')) throw usage(`castPath: "${rel}" must stay inside castRoot (no "..")`)
  return path.join(cfg.castRoot, ...parts)
}

/**
 * Every write in Vola-live goes through this first (engine, pack, pad, lock, verify, lab).
 * Allowed: inside outRoot or workRoot (or equal to either). Refused: anything else, and always
 * anything inside castRoot or another read-only root, even if outRoot were somehow above it.
 *
 * @param {Pick<VolaConfig, 'outRoot'|'workRoot'|'readOnlyRoots'>} cfg
 * @param {string} abs  absolute path about to be written (file or directory)
 * @returns {string} the resolved real path (write to this)
 * @throws {VolaError} exit 2
 */
export function guardWrite(cfg, abs) {
  if (typeof abs !== 'string' || !path.isAbsolute(abs)) throw usage(`guardWrite: expected an absolute path, got ${JSON.stringify(abs)}`)
  const real = realish(abs)
  for (const ro of cfg.readOnlyRoots) {
    if (isInside(real, ro)) throw usage(`refused write inside read-only root ${ro}: ${real}`)
  }
  if (isInside(real, cfg.outRoot) || isInside(real, cfg.workRoot)) return real
  throw usage(`refused write outside outRoot/workRoot: ${real} (outRoot ${cfg.outRoot}, workRoot ${cfg.workRoot})`)
}

/** profiles/<id>.lock.json, the one file `lock` may write outside outRoot/workRoot (Track B, B3). */
const LOCK_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/
export function lockPath(id) {
  if (typeof id !== 'string' || !LOCK_ID_RE.test(id)) throw usage(`lockPath: bad profile id ${JSON.stringify(id)}`)
  return path.join(REPO_ROOT, 'profiles', `${id}.lock.json`)
}

/**
 * The narrow, explicit exception to guardWrite (B3): `vola-live lock <id>` writes
 * <repo>/profiles/<id>.lock.json, which is inside the repository, not outRoot/workRoot.
 * Allowed: exactly that path pattern (a direct child of <repo>/profiles named
 * `<id>.lock.json`, id like a profile id). Refused: any other path, and the pattern too if it
 * would resolve inside castRoot or a read-only root (a junction, say).
 *
 * @param {Pick<VolaConfig, 'readOnlyRoots'>} cfg
 * @param {string} abs
 * @returns {string} the resolved real path
 * @throws {VolaError} exit 2
 */
export function guardLockWrite(cfg, abs) {
  if (typeof abs !== 'string' || !path.isAbsolute(abs)) throw usage(`guardLockWrite: expected an absolute path, got ${JSON.stringify(abs)}`)
  const real = realish(abs)
  const dir = realish(path.join(REPO_ROOT, 'profiles'))
  const name = path.basename(real)
  const m = /^(.+)\.lock\.json$/.exec(name)
  const sameDir = isInside(path.dirname(real), dir) && isInside(dir, path.dirname(real))
  if (!sameDir || !m || !LOCK_ID_RE.test(m[1])) throw usage(`refused: lock files are only written as <repo>/profiles/<id>.lock.json, not ${real}`)
  for (const ro of cfg.readOnlyRoots) {
    if (isInside(real, ro)) throw usage(`refused write inside read-only root ${ro}: ${real}`)
  }
  return real
}

/**
 * true when `child` equals `parent` or lies below it. Both should already be absolute;
 * comparison is case-insensitive on Windows.
 */
export function isInside(child, parent) {
  const fold = s => (process.platform === 'win32' ? path.resolve(s).toLowerCase() : path.resolve(s))
  const rel = path.relative(fold(parent), fold(child))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

/**
 * Absolute path with every existing prefix resolved through realpath (junctions, symlinks,
 * canonical case). The not-yet-existing tail is appended as written.
 */
export function realish(abs) {
  let cur = path.resolve(abs)
  const tail = []
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur)
      return tail.length ? path.join(real, ...tail.reverse()) : real
    } catch {
      const up = path.dirname(cur)
      if (up === cur) return path.resolve(abs)
      tail.push(path.basename(cur))
      cur = up
    }
  }
}

function runs(cmd) {
  try {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    return r.status === 0
  } catch {
    return false
  }
}

function usage(msg) {
  return new VolaError(EXIT.USAGE, msg)
}
