import { cp, mkdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cast = path.join(repo, '_work', 'sample-cast')
const work = path.join(repo, '_work', 'sample-build')
const out = path.join(repo, '_out', 'sample')
const frames = path.join(repo, 'assets', 'sample-boy', 'frames')
const env = {
  ...process.env,
  VOLA_CAST_ROOT: cast,
  VOLA_WORK: work,
  VOLA_OUT: out,
  VOLA_CHARACTER_OUT_ROOT: out,
  VOLA_SURPRISE_DONOR_DIR: path.join(out, 'surprise_eyes'),
  VOLA_SURPRISE_ART: path.join(cast, 'expressions', 'separated_character', 'surprised.png'),
}

function run(...args) {
  const result = spawnSync(process.execPath, args, { cwd: repo, env, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`${args.join(' ')} exited ${result.status}`)
}

// These destinations are fixed descendants of this repository; source assets are never changed.
await rm(cast, { recursive: true, force: true })
await rm(work, { recursive: true, force: true })
await rm(out, { recursive: true, force: true })
const input = path.join(cast, 'input', 'separated_character')
const expressions = path.join(cast, 'expressions', 'separated_character')
const donorInput = path.join(cast, 'input', 'surprise_eyes')
await Promise.all([mkdir(input, { recursive: true }), mkdir(expressions, { recursive: true }), mkdir(donorInput, { recursive: true })])
for (const name of ['base', 'blink', 'open']) await cp(path.join(frames, `${name}.png`), path.join(input, `${name}.png`))
for (const name of ['smile', 'worried', 'surprised', 'excited']) await cp(path.join(frames, `${name}.png`), path.join(expressions, `${name}.png`))

run('bin/vola-live.mjs', 'build', 'separated_character')
run('attach-clean-glasses.mjs')
run('prepare-idle-model.mjs')
await cp(path.join(expressions, 'surprised.png'), path.join(donorInput, 'base.png'))
await cp(path.join(input, 'blink.png'), path.join(donorInput, 'blink.png'))
await cp(path.join(input, 'open.png'), path.join(donorInput, 'open.png'))
run('bin/vola-live.mjs', 'build', 'surprise_eyes', '--no-expr')
run('merge-surprise-rig.mjs')
run('bin/vola-live.mjs', 'validate', 'separated_surprise_cleaniris_v3')
run('bin/vola-live.mjs', 'pack', 'separated_surprise_cleaniris_v3')
run('bin/vola-live.mjs', 'export', 'separated_surprise_cleaniris_v3')
run('qa-surprise-iris.mjs')
console.log(`Rebuilt sample: ${path.join(out, 'separated_surprise_cleaniris_v3.vola')}`)
