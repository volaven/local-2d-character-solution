// Add transparent canvas margins only; no resampling of artwork.
import sharp from 'sharp'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
const src = process.env.VOLA_GLASSES_ROOT
const castRoot = process.env.VOLA_CAST_ROOT
if (![src, castRoot].every(value => value && path.isAbsolute(value)))
  throw Error('Set absolute VOLA_GLASSES_ROOT and VOLA_CAST_ROOT paths')
const dst = path.join(castRoot, 'input/original_character')
const exprDst = path.join(castRoot, 'expressions/original_character')
await Promise.all([mkdir(dst, {recursive:true}), mkdir(exprDst, {recursive:true})])
const names = ['base', 'blink', 'open']
const expressions = ['smile', 'worried', 'surprised', 'excited']
for (const name of names) {
  const file = path.join(src, name + '.png')
  const meta = await sharp(file).metadata()
  if (meta.width !== 1024 || meta.height !== 1536 || !meta.hasAlpha) throw Error(`Unexpected input dimensions or no alpha: ${name}`)
  await sharp(file).extend({ left: 64, right: 64, top: 0, bottom: 0, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(path.join(dst, name + '.png'))
  console.log(`${name}: 1152x1536`)
}
for (const name of expressions) {
  const file = path.join(src, name + '.png')
  const meta = await sharp(file).metadata()
  if (meta.width !== 1024 || meta.height !== 1536 || !meta.hasAlpha) throw Error(`Unexpected input dimensions or no alpha: ${name}`)
  await sharp(file).extend({ left: 64, right: 64, top: 0, bottom: 0, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(path.join(exprDst, name + '.png'))
  console.log(`${name}: 1152x1536`)
}
