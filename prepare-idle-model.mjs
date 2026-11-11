import sharp from 'sharp'
import { cp, readFile, writeFile, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const out = process.env.VOLA_CHARACTER_OUT_ROOT
if (!out || !isAbsolute(out))
  throw Error('Set absolute VOLA_CHARACTER_OUT_ROOT path')
const destination = join(out, 'separated_idle_cleaneyes')
await cp(join(out, 'separated_character'), destination, { recursive: true })
const modelPath = join(destination, 'model.json')
const model = JSON.parse(await readFile(modelPath, 'utf8'))

// Keep brows and mouth in each expression. The eye rig supplies the eyes.
for (const layer of model.layers.filter(layer => layer.role === 'expr')) {
  const keepMouthOnly = ['x_worried', 'surprised'].includes(layer.expression)
  for (const key of ['texture', 'talk']) {
    if (!layer[key]) continue
    const file = join(destination, layer[key])
    const { data, info } = await sharp(await readFile(file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const X = x + layer.x
        const Y = y + layer.y
        const distance = Math.min(
          Math.hypot((X - 496) / 70, (Y - 387) / 41),
          Math.hypot((X - 670) / 70, (Y - 384) / 41),
        )
        const alpha = keepMouthOnly
          ? Math.max(0, Math.min(1, (Y - 466) / 21))
          : Math.max(0, Math.min(1, (distance - 1) / 0.19))
        data[(y * info.width + x) * 4 + 3] *= alpha
      }
    }
    const replacement = layer[key].replace('.webp', '_idle.webp')
    await writeFile(join(destination, replacement), await sharp(data, { raw: info }).webp({ lossless: true }).toBuffer())
    await unlink(file)
    layer[key] = replacement
  }
}
await unlink(modelPath)
await writeFile(modelPath, JSON.stringify(model, null, 2) + '\n')
