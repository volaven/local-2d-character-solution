import { readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import sharp from 'sharp'

const root = process.env.VOLA_CHARACTER_OUT_ROOT
if (!root || !isAbsolute(root)) throw Error('Set absolute VOLA_CHARACTER_OUT_ROOT')
const dir = join(root, 'separated_surprise_cleaniris_v3')
const model = JSON.parse(await readFile(join(dir, 'model.json'), 'utf8'))

for (const side of ['L', 'R']) {
  const eye = model.layers.find(layer => layer.id === `surprise_eye_${side}`)
  const iris = model.layers.find(layer => layer.id === `surprise_iris_${side}`)
  const neutralEye = model.layers.find(layer => layer.id === `eye_${side}`)
  if (!eye || !iris || !neutralEye) throw Error(`missing ${side} eye layer`)
  if (eye.show?.surprised !== 1 || iris.show?.surprised !== 1 || neutralEye.hide?.surprised !== 1)
    throw Error(`${side}: surprised and neutral eyes do not switch cleanly`)
  if (iris.w !== 37 || iris.h !== 43 || iris.clip !== eye.id)
    throw Error(`${side}: expected 37x43 iris clipped to ${eye.id}`)
  const { data, info } = await sharp(join(dir, iris.texture)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (info.width !== 37 || info.height !== 43) throw Error(`${side}: iris texture does not match its layer box`)
  let visibleCenter = false
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const alpha = data[(y * info.width + x) * 4 + 3]
    if (x < 6 || x >= 31 || y < 4 || y >= 39) {
      if (alpha !== 0) throw Error(`${side}: grey-edge risk at ${x},${y}`)
    } else if (alpha > 0) visibleCenter = true
  }
  if (!visibleCenter) throw Error(`${side}: iris is empty`)
  console.log(`${side}: 37x43 iris, transparent border 6x4, clip=${iris.clip}, expression switch OK`)
}
