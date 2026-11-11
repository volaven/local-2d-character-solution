// Prepare an independent input set with reference artwork under the glasses.
// The 1024x1536 image data keeps the existing external alpha and framing.
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const castRoot = process.env.VOLA_CAST_ROOT;
const cleanRoot = process.env.VOLA_CLEAN_ROOT;
if (!castRoot || !path.isAbsolute(castRoot) || !cleanRoot || !path.isAbsolute(cleanRoot))
  throw Error('Set absolute VOLA_CAST_ROOT and VOLA_CLEAN_ROOT paths');
const refs = Object.fromEntries(['base','blink','open','smile','worried','surprised','excited']
  .map(name => [name, path.join(cleanRoot, name+'.png')]));
const inputRoot=path.join(castRoot,'input');
const exprRoot=path.join(castRoot,'expressions');
for(const [name,file] of Object.entries(refs)) {
  if (!file) throw Error(`Missing reference for ${name}`);
  const isExpr=['smile','worried','surprised','excited'].includes(name);
  const src=path.join(isExpr?exprRoot:inputRoot,'original_character',name+'.png');
  const dst=path.join(isExpr?exprRoot:inputRoot,'separated_character');
  await mkdir(dst,{recursive:true});
  const original=await sharp(src).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const nakedMeta = await sharp(file).metadata();
  if (nakedMeta.width !== 1024 || nakedMeta.height !== 1536 || !nakedMeta.hasAlpha)
    throw Error(`Expected transparent 1024x1536 clean frame: ${file}`);
  const naked=await sharp(file).ensureAlpha().extend({left:64,right:64,top:0,bottom:0,background:{r:0,g:0,b:0,alpha:0}}).raw().toBuffer({resolveWithObject:true});
  if(original.info.width!==1152||original.info.height!==1536||naked.info.width!==1152||naked.info.height!==1536) throw Error(`Invalid dimensions ${name}`);
  const d=original.data, n=naked.data, w=1152;
  // Local head/face region is reconstructed from the matching expression's
  // no-glasses reference. The outer margin is blended to the supplied artwork.
  // The face silhouette and its original alpha remain untouched.
  for(let y=285;y<495;y++) for(let x=370;x<800;x++){
    const edge=Math.min((x-370)/14,(799-x)/14,(y-285)/14,(494-y)/14,1);
    const t=Math.max(0,edge), i=(y*w+x)*4;
    for(let c=0;c<3;c++) d[i+c]=Math.round(d[i+c]*(1-t)+n[i+c]*t);
  }
  await sharp(d,{raw:{width:1152,height:1536,channels:4}}).png().toFile(path.join(dst,name+'.png'));
  console.log(name+' prepared');
}
