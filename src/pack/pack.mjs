/**
 * packDir: one package folder -> one .livliv (DESIGN §6.9).   Owner: Track B (B1).
 *
 * The zip bytes depend only on the files (src/pack/zip.mjs: fixed date, fixed order), so
 * zipDir(dir) in memory gives the same bytes as the .livliv that pack writes. verify (§6.7 step 5)
 * and lock use zipDir without writing anything.
 *
 * Port of packPackage() in famcoach tools/livliv/pack.mjs 3a529571; the checks are the same.
 * Differences: the directory and the zip path are arguments, the write goes through guardWrite,
 * validation is src/validate/validate.mjs with an explicit python, nothing is printed here.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { guardWrite } from '../config.mjs'
import { contents, everything, order, writeZip, readZip, badEntryName, DEFLATED, FORMAT_JSON } from './zip.mjs'

/**
 * The files that go in, in zip order, with their bytes.
 * @param {string} dir absolute package folder
 * @returns {Promise<{ names: string[], files: {name: string, raw: Buffer}[], skipped: string[], problems: string[] }>}
 */
export async function collect(dir) {
  const problems = []
  const names = order(await contents(dir))
  if (!names.length || names[0] !== 'model.json') problems.push(`${dir} has no model.json to put first`)
  const kept = new Set(names)
  const skipped = (await everything(dir)).filter((f) => !kept.has(f))
  const files = []
  for (const name of names) files.push({ name, raw: await fsp.readFile(path.join(dir, ...name.split('/'))) })
  const seen = new Set()
  for (const { name } of files) {
    if (seen.has(name)) problems.push(`"${name}" would go in twice`)
    seen.add(name)
  }
  return { names, files, skipped, problems }
}

/**
 * Zip a package folder in memory and check the result with the independent reader.
 * @param {string} dir
 * @returns {Promise<{ zip: Buffer, sha256: string, entries: object[], files: {name, raw}[], skipped: string[] }>}
 * @throws {Error} when there is no model.json, a name is bad, or the read-back disagrees
 */
export async function zipDir(dir) {
  const { files, skipped, problems } = await collect(dir)
  if (problems.length) throw new Error(problems.join('; '))
  const { zip, entries } = writeZip(files)
  checkZip(zip, files)
  return { zip, sha256: sha256(zip), entries, files, skipped }
}

/**
 * The read-back check pack.mjs did after writing (same rules, same messages).
 * @param {Buffer} zip
 * @param {{name: string, raw: Buffer}[]} files what was meant to go in, in order
 * @throws {Error}
 */
export function checkZip(zip, files) {
  const read = readZip(zip)
  if (read.entries.length !== files.length) throw new Error(`${read.entries.length} entries came back, ${files.length} went in`)
  if (read.comment !== 0) throw new Error('the archive has a comment')
  read.entries.forEach((e, i) => {
    const want = files[i]
    if (e.name !== want.name) throw new Error(`entry ${i} is "${e.name}", not "${want.name}": the order is wrong`)
    const why = badEntryName(e.name)
    if (why) throw new Error(`entry ${i} "${e.name}" ${why}`)
    const method = DEFLATED.has(e.name) ? 8 : 0
    if (e.method !== method) throw new Error(`"${e.name}" was stored with method ${e.method}, not ${method}`)
    if (e.extraLen || e.commentLen) throw new Error(`"${e.name}" carries an extra field or a comment`)
    if (!e.data.equals(want.raw)) throw new Error(`"${e.name}" does not come back as the file on disk`)
  })
  if (read.entries[0].name !== 'model.json') throw new Error('model.json is not the first entry')
  if (read.entries[0].method !== 0) throw new Error('model.json is not stored uncompressed')
}

/**
 * Validate, zip, write, read back. Refuses (ok: false) a package with validation errors.
 * @param {string} dir      absolute package folder
 * @param {string} zipPath  absolute .livliv path; must pass guardWrite (outRoot/workRoot only)
 * @param {{ cfg: object, validation: { errors: object[], model?: object } }} opts
 *   validation: the result of validatePackage(dir, ...) (src/validate/validate.mjs), run by the caller
 * @returns {Promise<{ ok: boolean, file?: string, bytes?: number, sha256?: string, entries?: object[], skipped?: string[], problems: string[], warnings: string[] }>}
 */
export async function packDir(dir, zipPath, { cfg, validation }) {
  const problems = [], warnings = []
  if (!validation) throw new Error('packDir: validation result required (validate before packing, DESIGN §7)')
  if (validation.errors.length) {
    problems.push(`${dir} has ${validation.errors.length} validation error${validation.errors.length > 1 ? 's' : ''}: not packed`)
    return { ok: false, problems, warnings }
  }
  let z
  try {
    z = await zipDir(dir)
  } catch (e) {
    problems.push(e.message)
    return { ok: false, problems, warnings }
  }
  const file = guardWrite(cfg, zipPath)
  fs.mkdirSync(guardWrite(cfg, path.dirname(file)), { recursive: true })
  await fsp.writeFile(file, z.zip)
  const back = await fsp.readFile(file)
  try {
    if (!back.equals(z.zip)) throw new Error('the file on disk is not the bytes that were written')
    checkZip(back, z.files)
  } catch (e) {
    problems.push(`${path.basename(file)} failed its own check: ${e.message}`)
    return { ok: false, file, bytes: z.zip.length, problems, warnings }
  }
  for (const { name } of z.files) {
    if (name === 'model.json' || name.startsWith('textures/') || FORMAT_JSON.has(name)) continue
    const listed = Object.values(validation.model?.files ?? {}).includes(name)
    if (!listed) warnings.push(`"${name}" went in but model.json's files does not list it (FORMAT.md §4: readers will not look for it)`)
  }
  return { ok: true, file, bytes: z.zip.length, sha256: z.sha256, entries: z.entries, skipped: z.skipped, problems, warnings }
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}
