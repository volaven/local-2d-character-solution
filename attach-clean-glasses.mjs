// Attach a continuous frame as a head-group layer to the no-glasses source build.
// The ring curves are traced from the user's original at its native canvas size.
import sharp from 'sharp';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
if (!process.env.VOLA_CHARACTER_OUT_ROOT || !path.isAbsolute(process.env.VOLA_CHARACTER_OUT_ROOT))
  throw Error('Set absolute VOLA_CHARACTER_OUT_ROOT path');
const dir=path.join(process.env.VOLA_CHARACTER_OUT_ROOT,'separated_character');
const ringL='M429 390 C429 358 455 343 494 342 C530 342 557 359 560 389 C561 430 541 455 495 457 C454 457 431 433 429 399 Z';
const ringR='M612 386 C613 355 637 339 674 338 C712 338 736 353 738 384 C739 427 719 453 675 455 C640 455 613 429 612 394 Z';
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1152" height="1536">
<defs><linearGradient id="metal" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#667184"/><stop offset=".35" stop-color="#465568"/><stop offset=".7" stop-color="#2e3b4c"/><stop offset="1" stop-color="#77818c"/></linearGradient></defs>
<!-- temples, nose bridge and adjustable pads -->
<path d="M407 392 Q417 389 430 391 M738 388 Q746 385 754 388" fill="none" stroke="#20232c" stroke-width="8" stroke-linecap="round"/>
<path d="M407 391 Q417 389 429 391 M739 387 Q747 385 754 388" fill="none" stroke="#4c515c" stroke-width="4" stroke-linecap="round"/>
<path d="M558 392 Q583 375 614 387" fill="none" stroke="#20232d" stroke-width="9"/>
<path d="M558 390 Q583 376 614 386" fill="none" stroke="#46505d" stroke-width="5.5"/>
<path d="M557 389 Q583 378 614 385" fill="none" stroke="#9ba0a5" stroke-width=".65" opacity=".8"/>
<ellipse cx="550" cy="412" rx="4.4" ry="10" transform="rotate(19 550 412)" fill="#bfc1bc" fill-opacity=".45" stroke="#697078" stroke-width=".9"/>
<ellipse cx="620" cy="411" rx="4.4" ry="10" transform="rotate(-19 620 411)" fill="#bfc1bc" fill-opacity=".45" stroke="#697078" stroke-width=".9"/>
<!-- thin dark rims with continuous reflective centers -->
<path d="${ringL} ${ringR}" fill="none" stroke="#20242b" stroke-width="2.5" stroke-linejoin="round"/>
<path d="${ringL} ${ringR}" fill="none" stroke="#878a8b" stroke-width=".65" stroke-linejoin="round"/>
</svg>`;
const box={left:395,top:325,width:375,height:145};
await sharp(Buffer.from(svg)).extract(box).webp({lossless:true}).toFile(path.join(dir,'textures/glasses.webp'));
const file=path.join(dir,'model.json'), model=JSON.parse(await readFile(file,'utf8'));
model.layers=model.layers.filter(l=>l.id!=='glasses');
model.layers.push({id:'glasses',label:{ko:'안경',en:'Glasses'},texture:'textures/glasses.webp',x:box.left,y:box.top,w:box.width,h:box.height,group:'head',depth:0});
await writeFile(file,JSON.stringify(model,null,2)+'\n');
console.log('glasses layer attached to '+dir);
