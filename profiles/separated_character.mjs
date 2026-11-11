/* Working profile for the user's original, bespectacled character.
 * This is an initial fitting; visual review and tuning remain necessary. */
import { defineProfile } from '../src/profile.mjs'

export default defineProfile({
  id: 'separated_character',
  cutter: 'human',
  engineLevel: 1,
  source: { set: 'input', canon: 'base', refit: null, regions: null },
  stages: { ears: true, specks: false },
  lattice: true,
  cut: {
    tolSkin: 7, tolHair: 25, bust: 0, browLayer: false,
    hairMaxY: 640, hairFillAbove: true, hairIncludeBoxes: [[200, 0, 520, 205], [200, 206, 440, 335]], frontHairAbove: 335,
    faceFrom: 'closed', faceKeepSolid: true, bodyUnderRim: true,
    faceOffFringe: true, headSkinKeep: true, hairMinArea: 0,
    eyeInEgg: true, eyeLargest: true, eyeSkin: { pad: 4, core: 1, sigma: 2 },
    mouthLargest: true, mouthClean: true, hairClean: false,
  },
  model: {
    name: 'Sample Boy',
    author: 'volaven',
    profile: { id: 'anime_half', facing: 'front', glasses: true },
    rig: null,
  },
  expressions: {
    frames: ['expressions/separated_character'],
    extra: [],
    regHair: false,
    per: { hairGap: 3, ownEyes: 6, eyeHairL: 0, topPad: 8, holeMax: 10 },
    perX: {
      smile: { suppress: { smile: [[280, 185, 510, 232]] }, suppressWhole: true, suppressFill: 'base', suppressFeather: 4 },
      x_worried: { suppress: { x_worried: [[280, 185, 510, 232]] }, suppressWhole: true, suppressFill: 'base', suppressFeather: 4 },
      surprised: { suppress: { surprised: [[280, 185, 510, 232]] }, suppressWhole: true, suppressFill: 'base', suppressFeather: 4 },
      x_excited: { suppress: { x_excited: [[280, 185, 510, 232], [280, 390, 510, 450, 'face']] }, suppressWhole: true, suppressFill: 'base', suppressFeather: 4 },
    },
  },
  history: ['Initial character fit; requires visual quality review.'],
})
