import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { decodeVola } from '../src/vola/format.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assets = path.join(repo, 'assets', 'sample-boy')

test('the public sample files match the release hashes', async () => {
  const lines = (await readFile(path.join(assets, 'SHA256SUMS'), 'utf8')).trim().split(/\r?\n/)
  assert.equal(lines.length, 9)
  for (const line of lines) {
    const [, expected, relative] = /^([0-9a-f]{64})  (.+)$/.exec(line) ?? []
    assert.ok(relative, `bad hash line: ${line}`)
    const actual = createHash('sha256').update(await readFile(path.join(assets, relative))).digest('hex')
    assert.equal(actual, expected, relative)
  }
})

test('the original and seven prepared frames have the expected canvas', async () => {
  const original = await sharp(path.join(assets, 'original.png')).metadata()
  assert.deepEqual([original.width, original.height, original.channels], [1024, 1536, 3])
  for (const name of ['base', 'blink', 'open', 'smile', 'worried', 'surprised', 'excited']) {
    const info = await sharp(path.join(assets, 'frames', `${name}.png`)).metadata()
    assert.deepEqual([info.width, info.height, info.channels], [1152, 1536, 4], name)
  }
})

test('the bundled VOLA model is self-consistent and credits its author', async () => {
  const { manifest, rig, files } = decodeVola(await readFile(path.join(assets, 'sample-boy.vola')))
  assert.equal(manifest.name, 'Sample Boy')
  assert.deepEqual(manifest.canvas, [1152, 1536])
  assert.equal(manifest.entries.length, 44)
  assert.equal(rig.meta.author.name, 'volaven')
  assert.equal(rig.meta.license.id, 'CC-BY-4.0')
  assert.deepEqual(rig.expressions.map(e => e.id), ['smile', 'x_worried', 'surprised', 'x_excited'])
  assert.equal(rig.layers.length, 28)
  for (const side of ['L', 'R']) {
    const iris = rig.layers.find(layer => layer.id === `surprise_iris_${side}`)
    assert.ok(iris)
    assert.deepEqual([iris.w, iris.h, iris.clip], [37, 43, `surprise_eye_${side}`])
    assert.equal(iris.show?.surprised, 1)
    const { data, info } = await sharp(files.get(iris.texture)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    assert.deepEqual([info.width, info.height], [37, 43])
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      if (x < 6 || x >= 31 || y < 4 || y >= 39) assert.equal(data[(y * info.width + x) * 4 + 3], 0)
    }
  }
  assert.doesNotMatch(JSON.stringify(rig), /[A-Z]:\\|C:\/Users\/|github_pat_|ghp_/)
})

test('preview opens the bundled VOLA file', async () => {
  const html = await readFile(path.join(repo, 'examples', 'character-preview', 'index.html'), 'utf8')
  assert.match(html, /\.\.\/\.\.\/assets\/sample-boy\/sample-boy\.vola/)
  assert.doesNotMatch(html, /live2d-web|model3\.json|Cubism Core/)
})
