/** VOLA Character v1: deterministic, versioned container for a layered character. */
import { createHash } from 'node:crypto'
import { collect } from '../pack/pack.mjs'
import { badEntryName } from '../pack/zip.mjs'

export const MAGIC = Buffer.from('VOLACHA1', 'ascii')
const MAX_MANIFEST = 4 * 1024 * 1024
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export async function fromPackageDir(dir) {
  const { files, problems, skipped } = await collect(dir)
  if (problems.length) throw Error(problems.join('; '))
  const modelFile = files.find(f => f.name === 'model.json')
  const model = JSON.parse(modelFile.raw.toString('utf8'))
  if (model.format !== 'livliv-model' || model.version !== 4)
    throw Error('VOLA v1 export needs a validated livliv-model v4 source folder')
  const rig = { ...model, format: 'vola-rig', version: 1 }
  const payload = [
    { name: 'rig.json', raw: Buffer.from(JSON.stringify(rig) + '\n') },
    ...files.filter(f => f.name !== 'model.json').map(f => ({ name: f.name, raw: f.raw })),
  ]
  const { buffer, manifest } = encodeVola({ name: model.name, canvas: model.canvas, files: payload })
  return { buffer, manifest, skipped }
}

export function encodeVola({ name, canvas, files }) {
  if (!Array.isArray(canvas) || canvas.length !== 2 || !canvas.every(n => Number.isSafeInteger(n) && n > 0))
    throw Error('VOLA: invalid canvas')
  const seen = new Set()
  let offset = 0
  const entries = files.map(({ name: file, raw }) => {
    if (typeof file !== 'string' || badEntryName(file)) throw Error(`VOLA: invalid entry ${file}`)
    if (seen.has(file)) throw Error(`VOLA: duplicate entry ${file}`)
    seen.add(file)
    if (!Buffer.isBuffer(raw)) throw Error(`VOLA: ${file} is not a Buffer`)
    const entry = { path: file, offset, length: raw.length, sha256: sha256(raw) }
    offset += raw.length
    return entry
  })
  if (!seen.has('rig.json')) throw Error('VOLA: missing rig.json')
  const manifest = { format: 'vola-character', version: 1, renderer: 'layered-mesh-v1', name, canvas, entries }
  const header = Buffer.from(JSON.stringify(manifest) + '\n')
  if (header.length > MAX_MANIFEST) throw Error('VOLA: manifest too large')
  const prefix = Buffer.alloc(12)
  MAGIC.copy(prefix)
  prefix.writeUInt32LE(header.length, 8)
  return { buffer: Buffer.concat([prefix, header, ...files.map(f => f.raw)]), manifest }
}

export function decodeVola(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer)
  if (buffer.length < 12 || !buffer.subarray(0, 8).equals(MAGIC)) throw Error('not a VOLA character file')
  const headerLength = buffer.readUInt32LE(8)
  if (!headerLength || headerLength > MAX_MANIFEST || 12 + headerLength > buffer.length)
    throw Error('VOLA: invalid manifest length')
  const manifest = JSON.parse(buffer.subarray(12, 12 + headerLength).toString('utf8'))
  if (manifest.format !== 'vola-character' || manifest.version !== 1 || manifest.renderer !== 'layered-mesh-v1')
    throw Error('VOLA: unsupported character format, version or renderer')
  if (!Array.isArray(manifest.entries)) throw Error('VOLA: missing entries')
  const files = new Map()
  let offset = 0
  const base = 12 + headerLength
  for (const entry of manifest.entries) {
    if (typeof entry.path !== 'string' || badEntryName(entry.path) || files.has(entry.path))
      throw Error('VOLA: invalid or duplicate entry path')
    if (!Number.isSafeInteger(entry.offset) || entry.offset !== offset || !Number.isSafeInteger(entry.length) || entry.length < 0)
      throw Error(`VOLA: invalid offset or length for ${entry.path}`)
    const raw = buffer.subarray(base + offset, base + offset + entry.length)
    if (raw.length !== entry.length || sha256(raw) !== entry.sha256)
      throw Error(`VOLA: ${entry.path} failed its integrity check`)
    files.set(entry.path, raw)
    offset += entry.length
  }
  if (base + offset !== buffer.length) throw Error('VOLA: trailing data')
  const rigBytes = files.get('rig.json')
  if (!rigBytes) throw Error('VOLA: missing rig.json')
  const rig = JSON.parse(rigBytes.toString('utf8'))
  if (rig.format !== 'vola-rig' || rig.version !== 1) throw Error('VOLA: invalid rig')
  if (rig.name !== manifest.name || JSON.stringify(rig.canvas) !== JSON.stringify(manifest.canvas))
    throw Error('VOLA: manifest and rig disagree')
  return { manifest, rig, files }
}
