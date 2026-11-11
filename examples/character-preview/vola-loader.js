// Browser adapter for VOLA Character v1. The renderer still receives its
// familiar layer model, while the file on disk has VOLA's own header and rig.
const MAGIC = 'VOLACHA1'
const decoder = new TextDecoder('utf-8', { fatal: true })

export function isVolaSource(source) {
  const name = source instanceof Blob ? source.name || '' : String(source)
  return /\.vola(?:[?#].*)?$/i.test(name)
}

export async function loadVola(player, source) {
  const blob = source instanceof Blob ? source : await fetch(source).then(response => {
    if (!response.ok) throw Error(`VOLA 파일 HTTP ${response.status}`)
    return response.blob()
  })
  const { manifest, files, rig } = await parseVola(blob)
  const model = { ...rig, format: 'livliv-model', version: 4 }
  files.delete('rig.json')
  files.set('model.json', new Blob([JSON.stringify(model)], { type: 'application/json' }))
  const info = await player.load(files)
  return { ...info, format: manifest.format, version: manifest.version }
}

export async function parseVola(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (bytes.length < 12 || decoder.decode(bytes.subarray(0, 8)) !== MAGIC)
    throw Error('VOLA 캐릭터 파일이 아닙니다')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerLength = view.getUint32(8, true)
  if (!headerLength || headerLength > 4 * 1024 * 1024 || 12 + headerLength > bytes.length)
    throw Error('VOLA 헤더 길이가 잘못되었습니다')
  const manifest = JSON.parse(decoder.decode(bytes.subarray(12, 12 + headerLength)))
  if (manifest.format !== 'vola-character' || manifest.version !== 1 || manifest.renderer !== 'layered-mesh-v1')
    throw Error('지원하지 않는 VOLA 캐릭터 형식입니다')
  if (!Array.isArray(manifest.entries)) throw Error('VOLA 파일 목록이 없습니다')
  const files = new Map()
  const base = 12 + headerLength
  let offset = 0
  for (const entry of manifest.entries) {
    if (typeof entry.path !== 'string' || entry.path.startsWith('/') || entry.path.includes('\\') ||
      entry.path.split('/').some(part => !part || part === '.' || part === '..') || files.has(entry.path) ||
      !Number.isSafeInteger(entry.offset) || entry.offset !== offset ||
      !Number.isSafeInteger(entry.length) || entry.length < 0 || base + offset + entry.length > bytes.length)
      throw Error('VOLA 파일 목록이 손상되었습니다')
    const raw = bytes.subarray(base + offset, base + offset + entry.length)
    const digest = await crypto.subtle.digest('SHA-256', raw)
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
    if (hash !== entry.sha256) throw Error(`VOLA 무결성 검사 실패: ${entry.path}`)
    files.set(entry.path, new Blob([raw]))
    offset += entry.length
  }
  if (base + offset !== bytes.length) throw Error('VOLA 파일 끝에 예상하지 못한 데이터가 있습니다')
  const rigFile = files.get('rig.json')
  if (!rigFile) throw Error('VOLA 리그가 없습니다')
  const rig = JSON.parse(await rigFile.text())
  if (rig.format !== 'vola-rig' || rig.version !== 1 || rig.name !== manifest.name ||
    JSON.stringify(rig.canvas) !== JSON.stringify(manifest.canvas))
    throw Error('VOLA 리그와 헤더가 일치하지 않습니다')
  return { manifest, files, rig }
}
