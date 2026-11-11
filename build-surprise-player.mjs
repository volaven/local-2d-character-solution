import {readFile,writeFile} from 'node:fs/promises'
const viewer = new URL('./examples/character-preview/', import.meta.url)
const sdk = 'node_modules/@livliv-dev/player/dist/'
let source = await readFile(new URL(sdk+'index.js', viewer),'utf8')
const marker = 'if(i===`mouth`&&n.frames.length>=3){t<S?w=n:x(n);continue}'
if (source.split(marker).length !== 2) throw Error('Unexpected LivLiv draw loop')
const gate = 'if((r.show?.surprised||r.hide?.surprised)&&(r.id.startsWith(`surprise_`)||/^(eye_|iris_)/.test(r.id))&&this.moodAlpha(r)<.5)continue;'
source = '/* LivLiv Player 0.3.0, Apache-2.0, © 2026 LivLiv. Modified by famcoach to switch expression-specific eye layers. See LICENSE and NOTICE. */\n' +
  source.replace(marker, gate+marker).replaceAll('from"./chunks/', 'from"./'+sdk+'chunks/')
await writeFile(new URL('player-surprise.js',viewer),source)
