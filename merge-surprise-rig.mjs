import sharp from 'sharp'
import { cp, readFile, writeFile, copyFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
const out = process.env.VOLA_CHARACTER_OUT_ROOT
const donor = process.env.VOLA_SURPRISE_DONOR_DIR
const art = process.env.VOLA_SURPRISE_ART
if (![out, donor, art].every(value => value && isAbsolute(value)))
  throw Error('Set absolute VOLA_CHARACTER_OUT_ROOT, VOLA_SURPRISE_DONOR_DIR, VOLA_SURPRISE_ART paths')
const dest = join(out, 'separated_surprise_cleaniris_v3')
// The startled pose uses its own iris art. Keep its aspect ratio: the added
// eye white, not a stretched pupil, should make the expression read as surprise.
const surpriseIrisScale = 0.72
await cp(join(out, 'separated_idle_cleaneyes'), dest, {recursive:true})
const modelFile = join(dest, 'model.json')
const model = JSON.parse(await readFile(modelFile, 'utf8'))
model.name = 'Sample Boy'
model.meta.author = { name: 'volaven', url: 'https://github.com/volaven' }
model.meta.license = {
  id: 'CC-BY-4.0',
  url: 'https://creativecommons.org/licenses/by/4.0/',
  text: 'Sample Boy original art, expression frames, and character model by volaven. The art was adapted into expression frames and a layered rig.',
}
const alternate = JSON.parse(await readFile(join(donor, 'model.json'), 'utf8'))
const isEye = layer => /^(eye_[LR](?:_skin|_closed)?|iris_[LR])$/.test(layer.id)
const switchByMood = { surprised: 1 }
const additions = []
for (const layer of alternate.layers.filter(layer => isEye(layer))) {
  const copy = {...layer, id: 'surprise_' + layer.id, show: switchByMood}
  if (copy.clip) copy.clip = 'surprise_' + copy.clip
  for (const key of ['texture','mask']) {
    if (!copy[key]) continue
    const file = copy[key]
    copy[key] = file.replace('textures/', 'textures/surprise_')
    await copyFile(join(donor, file), join(dest, copy[key]))
  }
  if (layer.id.startsWith('iris_')) {
    const width = Math.round(copy.w * surpriseIrisScale)
    const height = Math.round(copy.h * surpriseIrisScale)
    const file = join(dest, copy.texture)
    const resized = await sharp(await readFile(file))
      .modulate({ saturation: 1.22, brightness: 1.05 })
      .resize(width, height)
      .webp({ lossless: true }).toBuffer()
    // At rest the oval touches the texture edge. LivLiv's moving iris mesh
    // samples that edge and stretches its dark pixels into a grey bar. A fully
    // transparent border keeps the mesh's out-of-bounds sampling invisible.
    const padX = 6, padY = 4
    const padded = await sharp(resized).extend({left:padX,right:padX,top:padY,bottom:padY,
      background:{r:0,g:0,b:0,alpha:0}}).webp({lossless:true}).toBuffer()
    await writeFile(file,padded)
    copy.x += Math.round((copy.w-width)/2) - padX
    copy.y += Math.round((copy.h-height)/2) - padY
    copy.w = width + padX*2
    copy.h = height + padY*2
  }
  additions.push(copy)
}
const browBox = {left: 415, top: 276, width: 335, height: 80}
const {data, info} = await sharp(art).extract(browBox).ensureAlpha().raw().toBuffer({resolveWithObject:true})
for (let y=0; y<info.height; y++) {
  for (let x=0; x<info.width; x++) {
    const opacity = Math.min(1, x / 15, (info.width - 1 - x) / 15, y / 10, (info.height - 1 - y) / 9)
    data[(y * info.width + x) * 4 + 3] *= opacity
  }
}
const browTexture = 'textures/surprise_brow_pose.webp'
await sharp(data,{raw:info}).webp({lossless:true}).toFile(join(dest,browTexture))
const browLayer = { id:'surprise_brow_pose', texture:browTexture, group:'head',
  x:browBox.left, y:browBox.top, w:browBox.width, h:browBox.height, show:switchByMood }
for (const layer of model.layers.filter(isEye)) layer.hide = switchByMood
model.layers.splice(model.layers.findIndex(l=>l.id==='mouth'),0,...additions)
model.layers.splice(model.layers.findIndex(l=>l.id==='glasses'),0,browLayer)
await writeFile(modelFile, JSON.stringify(model,null,2)+'\n')
