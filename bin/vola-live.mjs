#!/usr/bin/env node
/**
 * vola-live CLI entry (DESIGN §6.2): strict argument parser and command registry.
 * Owner after Step 0: Track B.
 *
 * Grammar (strict, §3.4 #3):
 *   vola-live <command> [positionals...] [--flag] [--name=value] ...
 *   - options are `--name` (boolean) or `--name=value` (value options). `--name value` is not
 *     accepted, so a value can never be mistaken for a positional or vice versa;
 *   - an unknown or misspelt option, a value on a boolean, a missing value, a repeated option,
 *     a wrong positional count, an unknown command: exit 2 with a "did you mean" hint;
 *   - global options (every command): --cast-root= --out-root= --work-root= --config= --python=
 *     (src/config.mjs) and --help / -h.
 *
 * Exit codes (src/errors.mjs): 0 ok, 1 mismatch/validation, 2 usage, 3 input drift, 4 env mismatch.
 *
 * Command modules live in src/commands/<name>.mjs and export
 *   spec = { name, summary, usage, positionals: { names, min, max }, options: { [name]: OptionDef },
 *            config: 'required'|'optional'|'none', extraOptions?: true, check?(args) }
 *   run({ args, cfg, cfgError, env, log }) -> exit code (number) or undefined (= 0)
 * They must not do work at import time (the registry imports one module per invocation).
 *
 * This file and src/commands/ are the only places that read process.argv / process.env
 * (passed down as `env`); everything below gets values through arguments (§6.4).
 */
import { EXIT, VolaError } from '../src/errors.mjs'

export const COMMANDS = Object.freeze(['build', 'validate', 'pack', 'export', 'pad', 'inputs'])

/**
 * @typedef {object} OptionDef
 * @property {'boolean'|'string'|'number'|'numbers'} type   numbers = comma-separated list of numbers
 * @property {string} [arg]      placeholder for help, e.g. 'ISO'
 * @property {string} [desc]
 * @property {boolean} [hidden]  internal (e.g. build --child); accepted, not shown in help
 * @property {boolean} [dev]     development-only (build); the command's check() decides what it conflicts with
 */

/** @type {Record<string, OptionDef>} */
export const GLOBAL_OPTIONS = Object.freeze({
  'cast-root': { type: 'string', arg: 'abs', desc: 'castRoot (livliv-cast, read-only); else VOLA_CAST_ROOT, else config file' },
  'out-root': { type: 'string', arg: 'abs', desc: 'outRoot; else VOLA_OUT, else config file' },
  'work-root': { type: 'string', arg: 'abs', desc: 'workRoot; else VOLA_WORK, else config file' },
  config: { type: 'string', arg: 'file', desc: 'config file; else VOLA_LIVE_CONFIG, else <repo>/vola-live.config.json' },
  python: { type: 'string', arg: 'exe', desc: 'Python for schema validation; else VOLA_PYTHON, config, LIVLIV_PYTHON, python/python3/py' },
  help: { type: 'boolean', desc: 'show help' },
})
const CONFIG_FLAG_KEYS = ['castRoot', 'outRoot', 'workRoot', 'config', 'python']

/**
 * Parse one command's arguments. Pure; throws VolaError(2) on any violation.
 * @param {string[]} argv  arguments after the command name
 * @param {{ name: string, options: Record<string, OptionDef>, positionals: { names: string[], min: number, max: number }, extraOptions?: boolean }} spec
 * @returns {{ opts: Record<string, unknown>, pos: string[], extra: string[] }}
 *   opts keys are camelCase (--tol-hair -> tolHair); extra holds unknown --options only when
 *   spec.extraOptions is true (lab: check-specific flags, validated by the command itself)
 */
export function parseArgs(argv, spec) {
  const defs = { ...GLOBAL_OPTIONS, ...spec.options }
  const opts = {}
  const pos = []
  const extra = []
  for (const a of argv) {
    if (a === '-h') { opts.help = true; continue }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq)
      const value = eq < 0 ? null : a.slice(eq + 1)
      const def = Object.hasOwn(defs, name) ? defs[name] : null
      if (!def) {
        if (spec.extraOptions && name) { extra.push(a); continue }
        throw usage(`${spec.name}: unknown option ${name ? `--${name}` : '--'}${hint(name, visibleNames(defs).map(n => `--${n}`), `--${name}`)}`)
      }
      const key = camel(name)
      if (Object.hasOwn(opts, key)) throw usage(`${spec.name}: --${name} given twice`)
      if (def.type === 'boolean') {
        if (value !== null) throw usage(`${spec.name}: --${name} takes no value (got --${name}=${value})`)
        opts[key] = true
      } else {
        if (value === null || value === '') throw usage(`${spec.name}: --${name} needs a value: --${name}=<${def.arg ?? def.type}>`)
        opts[key] = convert(spec.name, name, def, value)
      }
    } else if (a.startsWith('-') && a.length > 1) {
      throw usage(`${spec.name}: unknown option ${a} (options are --name or --name=value)`)
    } else {
      pos.push(a)
    }
  }
  if (!opts.help) {
    const { min, max, names } = spec.positionals
    if (pos.length < min || pos.length > max) {
      const want = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min}-${max}`
      throw usage(`${spec.name}: expected ${want} argument(s) <${names.join('> <')}>, got ${pos.length}${pos.length ? ` (${pos.join(' ')})` : ''}`)
    }
  }
  return { opts, pos, extra }
}

/**
 * Run one CLI invocation. Returns the exit code; throws VolaError for usage/config/etc.
 * @param {string[]} argv  process.argv.slice(2)
 * @param {{ env?: Record<string, string|undefined>, log?: (s: string) => void }} [io]
 */
export async function main(argv, { env = process.env, log = s => console.log(s) } = {}) {
  const [cmd, ...rest] = argv
  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    await printUsage(log)
    return cmd === undefined ? EXIT.USAGE : EXIT.OK
  }
  if (!COMMANDS.includes(cmd)) throw usage(`unknown command "${cmd}"${hint(cmd, COMMANDS, cmd)}. Commands: ${COMMANDS.join(', ')}`)
  const mod = await import(`../src/commands/${cmd}.mjs`)
  const spec = mod.spec
  const args = parseArgs(rest, spec)
  if (args.opts.help) {
    printCommand(spec, log)
    return EXIT.OK
  }
  spec.check?.(args)

  let cfg = null
  let cfgError = null
  if (spec.config !== 'none') {
    const { loadConfig } = await import('../src/config.mjs')
    const flags = Object.fromEntries(CONFIG_FLAG_KEYS.filter(k => args.opts[k] !== undefined).map(k => [k, args.opts[k]]))
    try {
      cfg = loadConfig({ flags, env })
    } catch (e) {
      if (spec.config === 'optional' && e instanceof VolaError) cfgError = e
      else throw e
    }
  }
  const code = await mod.run({ args, cfg, cfgError, env, log })
  return code ?? EXIT.OK
}

async function printUsage(log) {
  log('vola-live <command> [args] [--options]')
  log('')
  for (const name of COMMANDS) {
    const { spec } = await import(`../src/commands/${name}.mjs`)
    log(`  ${spec.usage}`)
    log(`      ${spec.summary}`)
  }
  log('')
  log('global: --cast-root=<abs> --out-root=<abs> --work-root=<abs> --config=<file> --python=<exe>')
  log('exit:   0 ok, 1 mismatch/validation, 2 usage, 3 input drift, 4 environment mismatch')
}

function printCommand(spec, log) {
  log(`usage: ${spec.usage}`)
  log(`  ${spec.summary}`)
  const rows = Object.entries({ ...spec.options, ...GLOBAL_OPTIONS }).filter(([, d]) => !d.hidden)
  for (const [name, d] of rows) {
    const flag = d.type === 'boolean' ? `--${name}` : `--${name}=<${d.arg ?? d.type}>`
    log(`  ${flag.padEnd(28)} ${d.dev ? '[dev] ' : ''}${d.desc ?? ''}`)
  }
  if (spec.extraOptions) log('  (check-specific --options are passed through to the command, which rejects unknown ones)')
}

function convert(cmd, name, def, value) {
  if (def.type === 'string') return value
  if (def.type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) throw usage(`${cmd}: --${name}=${value} is not a number`)
    return n
  }
  if (def.type === 'numbers') {
    const list = value.split(',').map(Number)
    if (!list.length || list.some(n => !Number.isFinite(n))) throw usage(`${cmd}: --${name}=${value} must be comma-separated numbers`)
    return list
  }
  throw new Error(`bad option type ${def.type} for --${name}`)
}

function visibleNames(defs) {
  return Object.keys(defs).filter(n => !defs[n].hidden)
}

const camel = s => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())

/** " (did you mean X?)" when a candidate is close enough, else "". */
function hint(input, candidates, display) {
  if (!input) return ''
  const best = candidates
    .map(c => ({ c, d: distance(display.toLowerCase(), c.toLowerCase()) }))
    .sort((a, b) => a.d - b.d)[0]
  const limit = Math.max(2, Math.floor(display.length / 3))
  const prefix = candidates.find(c => c.startsWith(display) || display.startsWith(c))
  if (best && best.d <= limit) return ` (did you mean ${best.c}?)`
  if (prefix) return ` (did you mean ${prefix}?)`
  return ''
}

function distance(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

function usage(msg) {
  return new VolaError(EXIT.USAGE, msg)
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (e) {
    if (e instanceof VolaError) {
      console.error(`vola-live: ${e.message}`)
      process.exitCode = e.exitCode
    } else {
      console.error(e?.stack ?? String(e))
      process.exitCode = EXIT.FAIL
    }
  }
}
