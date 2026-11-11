/**
 * vola-live inputs <id> (DESIGN §6.2).   Owner: Track B (B3).
 * Lists inputsOf(profile, cfg) with sha256 and compares them with profiles/<id>.lock.json.
 * Exit: 0 same as the lock (or no lock yet), 3 INPUT DRIFT, 1 an input cannot be read.
 */
import { EXIT } from '../errors.mjs'

export const spec = {
  name: 'inputs',
  summary: 'list the input files of <id> and compare them with the lock',
  usage: 'vola-live inputs <id> [--json]',
  positionals: { names: ['id'], min: 1, max: 1 },
  options: {
    json: { type: 'boolean', desc: 'print the list as JSON' },
  },
  config: 'required',
}

export async function run({ args, cfg, log }) {
  const { loadProfile } = await import('../profile.mjs')
  const { hashInputs, compareInputs, inputsSha256 } = await import('../inputs.mjs')
  const { readLock } = await import('../verify/golden.mjs')
  const id = args.pos[0]
  const { profile } = await loadProfile(id)
  const now = await hashInputs(profile, cfg)
  const lock = readLock(id)
  const cmp = lock ? compareInputs(now, lock.inputs) : null
  const missing = now.filter((i) => i.sha256 === null)
  const code = missing.length ? EXIT.FAIL : cmp && !cmp.ok ? EXIT.INPUT_DRIFT : EXIT.OK
  if (args.opts.json) {
    log(JSON.stringify({ id, inputs: now, inputsSha256: inputsSha256(now), lock: lock ? (cmp.ok ? 'same' : 'drift') : 'none', drift: cmp?.drift ?? [] }, null, 2))
    return code
  }
  const byRel = new Map((cmp?.drift ?? []).map((d) => [d.rel, d]))
  log(`${id}: ${now.length} input(s), castRoot ${cfg.castRoot}`)
  for (const i of now) {
    const d = byRel.get(i.rel)
    const verdict = i.sha256 === null ? 'MISSING' : !lock ? '' : d ? `DRIFT (${d.why})` : 'locked'
    log(`  ${(i.sha256 ?? '-'.repeat(12)).slice(0, 12)}  ${i.role.padEnd(20)} ${i.rel}  ${verdict}`)
  }
  for (const d of cmp?.drift ?? []) if (!now.some((i) => i.rel === d.rel)) log(`  ${d.lock.slice(0, 12)}  ${d.role.padEnd(20)} ${d.rel}  DRIFT (${d.why})`)
  log(`inputsSha256 ${inputsSha256(now)}`)
  log(!lock ? `no profiles/${id}.lock.json yet (vola-live lock ${id} --from-shipped)` : cmp.ok ? 'same as the lock' : `INPUT DRIFT: ${cmp.drift.length} difference(s) from profiles/${id}.lock.json`)
  return code
}
