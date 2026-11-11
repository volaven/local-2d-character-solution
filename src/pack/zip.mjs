/**
 * The .livliv ZIP writer and an independent reader (DESIGN §6.9 pack, FORMAT.md §1).   Owner: Track B (B1).
 *
 * Portions adapted from livliv-player `scripts/pack-characters.mjs` (Apache-2.0, © 2026 LivLiv),
 * upstream commit 0f2c8871de375dfe4d239fab480e07f6d9b032dd. Modified by famcoach / Vola-live.
 * See third_party/livliv-player/LICENSE and NOTICE, and third_party/livliv-player/UPSTREAM.md.
 *
 * Changes from upstream (checked line by line against its 47 lines):
 *  - cover.webp is packed (upstream leaves the cover out); entry count = file count of the package;
 *  - junk (.DS_Store, Thumbs.db, dotfiles, __MACOSX), scratch (`_*` directories) and any JSON that is
 *    not model.json / keyforms.json at the package root are left out (contents());
 *  - every entry name is checked (badEntryName) before it is written;
 *  - a package that would need ZIP64 is refused;
 *  - a read-back verifier (readZip) that shares no code with the writer was added;
 *  - the caller validates the package before packing it (src/pack/pack.mjs);
 *  - the package directory is an argument (upstream walks its own characters/ folder).
 * Not changes: the fixed DOS date (0x21, time 0), model.json first, stored images, deflated
 * keyforms.json (level 9), version 20 and the UTF-8 flag are what upstream writes too.
 *
 * Ported from famcoach tools/livliv/pack.mjs 3a529571 (legacy/tools/livliv/pack.mjs.txt): the
 * functions below are unchanged except that they no longer import validate.mjs and the CLI is gone.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

/** what never belongs in a package: junk, scratch, and any JSON that is not part of the format */
export const JUNK = /^(?:__MACOSX|\.DS_Store|Thumbs\.db|\._.*|\..*)$/
const SCRATCH = /^_/
export const FORMAT_JSON = new Set(['model.json', 'keyforms.json'])
/** only keyforms.json is deflated (FORMAT.md §1: it shrinks about five times) */
export const DEFLATED = new Set(['keyforms.json'])

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, EOCD = 0x06054b50, ZIP64_LOCATOR = 0x07064b50
const UTF8_FLAG = 0x0800
/** 1980-01-01, so two builds of the same files give the same bytes */
const DOS_DATE = 0x21, DOS_TIME = 0

// ---------------------------------------------------------------------------- what goes in

/** A name a reader will accept: relative, '/'-separated, no '.' or '..' segment, no backslash. */
export function badEntryName(name) {
  if (!name) return 'is empty'
  if (name.startsWith('/')) return 'starts with "/"'
  if (name.includes('\\')) return 'contains a backslash'
  if (name.includes('\0')) return 'contains a NUL'
  if (Buffer.byteLength(name, 'utf8') > 255) return 'is longer than 255 bytes'
  for (const seg of name.split('/')) {
    if (seg === '') return 'has an empty segment'
    if (seg === '.' || seg === '..') return `has a "${seg}" segment`
  }
  return null
}

/** every file in the directory, kept or not, so pack can say what it left out */
export async function everything(dir, at = '') {
  const entries = await fsp.readdir(path.join(dir, at), { withFileTypes: true }).catch(() => [])
  const out = []
  for (const e of entries) {
    const rel = at ? `${at}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await everything(dir, rel)))
    else if (e.isFile()) out.push(rel)
  }
  return out.sort()
}

/** the package's files, as package-relative '/' paths, scratch and junk left out */
export async function contents(dir, at = '') {
  const entries = await fsp.readdir(path.join(dir, at), { withFileTypes: true }).catch(() => [])
  const out = []
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (JUNK.test(e.name)) continue
    if (e.isDirectory()) {
      if (SCRATCH.test(e.name)) continue // _work/ and anything like it is scratch, never the package
      out.push(...(await contents(dir, at ? `${at}/${e.name}` : e.name)))
      continue
    }
    if (!e.isFile()) continue
    const rel = at ? `${at}/${e.name}` : e.name
    // model.json and keyforms.json are the format's; any other .json is a build report or notes
    if (/\.json$/i.test(e.name) && !(at === '' && FORMAT_JSON.has(e.name))) continue
    out.push(rel)
  }
  return out
}

/** model.json first, then everything else in a stable order (FORMAT.md §1) */
export function order(names) {
  const rest = names.filter((n) => n !== 'model.json').sort()
  return names.includes('model.json') ? ['model.json', ...rest] : rest
}

// ---------------------------------------------------------------------------- the writer

/**
 * @param {{name: string, raw: Buffer}[]} files in the order they go in
 * @returns {{zip: Buffer, entries: {name, method, crc, csize, usize, offset}[]}}
 */
export function writeZip(files) {
  const local = [], central = [], entries = []
  let offset = 0
  for (const { name, raw } of files) {
    const why = badEntryName(name)
    if (why) throw new Error(`refusing to write the entry "${name}": it ${why}`)
    const deflate = DEFLATED.has(name)
    const data = deflate ? deflateRawSync(raw, { level: 9 }) : raw
    const method = deflate ? 8 : 0
    const file = Buffer.from(name, 'utf8'), crc = crc32(raw)

    const h = Buffer.alloc(30)
    h.writeUInt32LE(LOCAL, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(UTF8_FLAG, 6); h.writeUInt16LE(method, 8)
    h.writeUInt16LE(DOS_TIME, 10); h.writeUInt16LE(DOS_DATE, 12)
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(file.length, 26)

    const c = Buffer.alloc(46)
    c.writeUInt32LE(CENTRAL, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(UTF8_FLAG, 8); c.writeUInt16LE(method, 10)
    c.writeUInt16LE(DOS_TIME, 12); c.writeUInt16LE(DOS_DATE, 14)
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(file.length, 28)
    c.writeUInt32LE(offset, 42)

    local.push(h, file, data); central.push(c, file)
    entries.push({ name, method, crc, csize: data.length, usize: raw.length, offset })
    offset += 30 + file.length + data.length
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD, 0)
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  if (files.length > 0xffff || offset > 0xffffffff) throw new Error('the package would need ZIP64, which FORMAT.md §1 forbids')
  return { zip: Buffer.concat([...local, cd, end]), entries }
}

// ---------------------------------------------------------------------------- the reader, for checking

/**
 * A minimal PKWARE reader: it finds the end-of-central-directory record, walks the central
 * directory, then reads each entry through its own local header. It deliberately shares nothing
 * with the writer above, so that a mistake in the writer cannot be echoed back as agreement.
 * @returns {{entries: object[], comment: number, cdSize: number, cdOffset: number}}
 */
export function readZip(zip) {
  let eocd = -1
  for (let at = zip.length - 22; at >= 0 && at >= zip.length - 22 - 0xffff; at--) {
    if (zip.readUInt32LE(at) === EOCD) { eocd = at; break }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record')
  const disk = zip.readUInt16LE(eocd + 4), cdDisk = zip.readUInt16LE(eocd + 6)
  const onDisk = zip.readUInt16LE(eocd + 8), total = zip.readUInt16LE(eocd + 10)
  const cdSize = zip.readUInt32LE(eocd + 12), cdOffset = zip.readUInt32LE(eocd + 16)
  const comment = zip.readUInt16LE(eocd + 20)
  if (disk !== 0 || cdDisk !== 0) throw new Error('the archive claims to be split across disks')
  if (onDisk !== total) throw new Error(`the central directory counts disagree (${onDisk} on this disk, ${total} in all)`)
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('an end-of-central-directory field is the ZIP64 escape value')
  if (eocd + 22 + comment !== zip.length) throw new Error('there are bytes after the end-of-central-directory record')
  // A ZIP64 end record and its locator would sit between the central directory and the end record,
  // so no gap there means there is no ZIP64 anywhere (checking the whole file for the signatures
  // would false-positive on image bytes).
  if (cdOffset + cdSize !== eocd) throw new Error(`there are ${eocd - cdOffset - cdSize} bytes between the central directory and its end record (a ZIP64 record would sit there)`)
  if (eocd >= 20 && zip.readUInt32LE(eocd - 20) === ZIP64_LOCATOR) throw new Error('a ZIP64 locator is present')

  const entries = []
  let at = cdOffset
  for (let i = 0; i < total; i++) {
    if (zip.readUInt32LE(at) !== CENTRAL) throw new Error(`central directory entry ${i} has no signature`)
    const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10)
    const crc = zip.readUInt32LE(at + 16), csize = zip.readUInt32LE(at + 20), usize = zip.readUInt32LE(at + 24)
    const nameLen = zip.readUInt16LE(at + 28), extraLen = zip.readUInt16LE(at + 30), commentLen = zip.readUInt16LE(at + 32)
    const offset = zip.readUInt32LE(at + 42)
    const nameBytes = zip.subarray(at + 46, at + 46 + nameLen)
    const name = nameBytes.toString('utf8')
    if (!Buffer.from(name, 'utf8').equals(nameBytes)) throw new Error(`entry ${i}'s name is not valid UTF-8`)

    if (flags & 0x1) throw new Error(`"${name}" is encrypted`)
    if (flags & 0x8) throw new Error(`"${name}" uses a data descriptor, so its sizes are not in the header`)
    if (flags & 0x40) throw new Error(`"${name}" uses strong encryption`)
    if (!(flags & UTF8_FLAG)) throw new Error(`"${name}" does not set the UTF-8 name flag`)
    if (method !== 0 && method !== 8) throw new Error(`"${name}" uses compression method ${method}; only 0 (stored) and 8 (deflate) are allowed`)
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw new Error(`"${name}" needs ZIP64 fields`)

    // the local header, read independently
    if (zip.readUInt32LE(offset) !== LOCAL) throw new Error(`"${name}" has no local header at ${offset}`)
    const lFlags = zip.readUInt16LE(offset + 6), lMethod = zip.readUInt16LE(offset + 8)
    const lCrc = zip.readUInt32LE(offset + 14), lCsize = zip.readUInt32LE(offset + 18), lUsize = zip.readUInt32LE(offset + 22)
    const lNameLen = zip.readUInt16LE(offset + 26), lExtraLen = zip.readUInt16LE(offset + 28)
    const lName = zip.subarray(offset + 30, offset + 30 + lNameLen).toString('utf8')
    if (lName !== name) throw new Error(`the central directory says "${name}" but its local header says "${lName}"`)
    if (lFlags !== flags || lMethod !== method || lCrc !== crc || lCsize !== csize || lUsize !== usize) {
      throw new Error(`"${name}": the local header and the central directory disagree`)
    }
    const start = offset + 30 + lNameLen + lExtraLen
    const stored = zip.subarray(start, start + csize)
    const data = method === 8 ? inflateRawSync(stored) : Buffer.from(stored)
    if (data.length !== usize) throw new Error(`"${name}" unpacks to ${data.length} bytes, not the ${usize} its header gives`)
    if (crc32(data) !== crc) throw new Error(`"${name}" fails its CRC`)

    entries.push({ name, method, crc, csize, usize, offset, extraLen, commentLen, data })
    at += 46 + nameLen + extraLen + commentLen
  }
  if (at !== cdOffset + cdSize) throw new Error('the central directory is not the length its end record gives')
  return { entries, comment, cdSize, cdOffset }
}
