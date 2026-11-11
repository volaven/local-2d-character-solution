/**
 * The human engine's profile keys (DESIGN Appendix A, docs/PROFILE-KEYS.md).   Owner: Track A.
 *
 * Every key the cutter reads from `cfg` (= profile.cut) and every knob expressions.mjs reads from `per`
 * (= {...DEF, ...profile.expressions.per, ...perX[e]}). A key missing from a profile means "the old
 * behaviour": each one is read only where it is set (the c959fc7d / kai8 / nose read sites).
 * `t` is the accepted shape: 'num' | 'int' | 'bool' | 'str' | 'obj' | 'arr' | 'any', or a list of those.
 */

/** profile.cut: the shared cutter's CFG keys, verbatim names (CFG[id] minus name / build / generatorName /
 *  noAuthor / profile / rig, which are profile.model / profile.repro) */
export const CUT_KEYS = Object.freeze({
  tolSkin:            { t: 'num', d: 'Lab dE tolerance of the skin mask against the sampled cheek colour' },
  tolHair:            { t: 'num', d: 'Lab dE tolerance of the hair mask against the sampled crown colour' },
  bust:               { t: 'num', d: 'rig.body.bust of the default rig (used when model.rig is null)' },
  browLayer:          { t: 'bool', d: 'cut a `brows` layer (false: brows stay in face/front_hair, anchors only)' },
  arms:               { t: 'bool', d: 'sua: free sleeves get arm chains (armChains)' },
  headScale:          { t: 'num', d: 'sua: head group rescale about the neck + reframe (expression frames get the same)' },
  creases:            { t: 'bool', d: 'sua: paint out cheek creases (eraseCreases)' },
  hairTune:           { t: 'obj', d: 'father: { tuning: {hair_front, hair_back}, backDepth } -> model.tuning, back_hair depth' },
  hairNear:           { t: 'num', d: 'hair must lie within this many px of the crown mass' },
  hairMaxY:           { t: ['num', 'arr'], d: 'no hair below this row (number) or a polyline [[x, y], ...]' },
  noRimClaim:         { t: 'bool', d: 'daeun: the rim ring is not claimed by the hair' },
  hairFillAbove:      { t: 'bool', d: 'fill hair holes above the hairMaxY line' },
  hairIncludeBoxes:   { t: 'arr', d: 'art-specific hair highlight boxes [x0,y0,x1,y1], in canvas coordinates' },
  frontHairAbove:     { t: 'int', d: 'include all detected hair above this canvas row in the front hair layer' },
  rangeCap:           { t: 'arr', d: 'iris walk caps [x, y] as a fraction of the sclera box' },
  eyeDiffT:           { t: 'num', d: 'eye change threshold (closed vs blink)' },
  eyeLargest:         { t: 'bool', d: 'keep the largest eye-change component only' },
  eyeNoHair:          { t: 'num', d: 'eye change blob kept off the hair by this many px' },
  backFillNoRim:      { t: 'bool', d: 'back_hair fill does not use the rim' },
  headCx:             { t: 'num', d: 'head ellipse centre x override' },
  headRx:             { t: 'num', d: 'head ellipse x radius override' },
  bodyUnderRim:       { t: 'bool', d: 'body continues under the face egg rim (chin line, neck shading)' },
  assemble:           { t: 'obj', d: 'three-frame sets: options for assembleStates, e.g. { eyeGrow: [x, y] }' },
  browBoxes:          { t: 'arr', d: 'brow boxes [[x0, y0, x1, y1], [..]] measured on the art (anchors / brows layer)' },
  earBox:             { t: 'arr', d: 'daeun: ear box [x0, y0, x1, y1]' },
  noIris:             { t: 'str', d: 'gaze off on both eyes; the string is the reason (logged). Truthy = no iris layers' },
  despeckle:          { t: 'bool', d: 'repaint pale matte specks on layer edges (not eyes / iris / mouth)' },
  avatarPad:          { t: 'num', d: 'avatar square from the whole hair mass + this pad' },
  eyeSkin:            { t: 'obj', d: '{ pad, core, sigma } of the eye-skin patch' },
  irisOpening:        { t: 'bool', d: 'sua2: find the opening and iris without the whites surrounding it' },
  irisRangeTemporal:  { t: 'bool', d: 'sua2: iris range[0] from the outward room' },
  armHands:           { t: 'obj', d: 'sua2: { inset } arm chains ending at the hands' },
  mouthClean:         { t: 'bool', d: 'clean the closed mouth line ends' },
  hairFillInk:        { t: 'bool', d: 'iseul: fill hair ink gaps' },
  hairClean:          { t: 'bool', d: '[hairClean] false opts this character out of the speck stage (see stages.specks)' },
  rimToHair:          { t: 'num', d: 'rim pixels within this many px of the hair go to the hair' },
  faceKeepSolid:      { t: 'bool', d: 'keep solid face pixels under the hair tips' },
  hairMinArea:        { t: 'num', d: 'minimum hair component area' },
  hairOutlineL:       { t: 'num', d: 'iseul: luma of the hair outline' },
  headSkinKeep:       { t: 'bool', d: 'keep skin pockets between strands' },
  eyeInEgg:           { t: 'bool', d: 'eye change limited to the face egg' },
  eyeHairIslands:     { t: 'num', d: 'hair islands under this area in the eye boxes are lash, not hair' },
  faceFrom:           { t: 'str', d: "'closed': cut the face from the rest frame" },
  mouthLargest:       { t: 'bool', d: 'kai: mouth change = largest component only' },
  browsOnFace:        { t: 'bool', d: 'kai: brows are drawn on the face layer' },
  faceOffFringe:      { t: 'bool', d: 'kai: no skin under the fringe tips' },
  earOwn:             { t: 'bool', d: '[earOwn] false opts this character out of the ear stage (see stages.ears)' },
})

/** profile.model */
export const MODEL_KEYS = Object.freeze(['name', 'author', 'profile', 'rig'])

/** profile.source, by kind */
export const SOURCE_KEYS = Object.freeze({
  four: ['set', 'states', 'refit', 'regions'],
  three: ['set', 'canon', 'refit', 'regions'],
})

/** expression knobs: DEF keys (tables.mjs) */
export const DEF_KEYS = Object.freeze(['hairGap', 'T', 'ns', 'minArea', 'prox', 'sil', 'sigma', 'rCore',
  'regHairGrow', 'regMinPts', 'regHairW', 'residMinPts', 'noseGrow', 'noseFeather', 'noseNs'])

/** expression knobs read once per character, BEFORE the per-expression loop: only profile.expressions.per may set them
 *  (in perX they would do nothing, so they are refused there) */
export const PER_ZONE_KEYS = Object.freeze({
  noBrows:      { t: 'bool', d: 'patch starts just above the eyes (brows stay as drawn in front_hair)' },
  browRoot:     { t: 'arr', d: 'mother: brows (0 = image-left) whose root ink was cut into front_hair; moved to brows (v2)' },
  fringe:       { t: 'str', d: "'below': the patch starts under the fringe" },
  ownEyes:      { t: 'num', d: 'the patch also owns both eye boxes grown by m px' },
  eyeHairGap:   { t: 'num', d: 'with ownEyes: px kept clear of dark hair (default 1)' },
  eyeHairL:     { t: 'num', d: 'with ownEyes: luma below which a hair pixel is dark hair (default 150)' },
  topPad:       { t: 'num', d: 'with noBrows: the zone and the owned eye boxes start n px higher' },
  holeMax:      { t: 'num', d: 'kai: enclosed non-hair specks <= n px are left to the base' },
  hairGap:      { t: 'num', d: 'px kept clear of the hair (DEF 1)' },
  sil:          { t: 'num', d: 'px kept off the silhouette (DEF 3)' },
})

/** expression knobs read inside the per-expression loop: per or perX */
export const PER_LOOP_KEYS = Object.freeze({
  T:                { t: 'num', d: 'talk cut threshold (DEF 16)' },
  ns:               { t: 'num', d: 'drawn-vs-skin dE bar (DEF 22)' },
  minArea:          { t: 'num', d: 'feature component floor (DEF 12)' },
  prox:             { t: 'num', d: 'new/gone feature distance (DEF 4)' },
  sigma:            { t: 'num', d: 'feather (DEF 5)' },
  rCore:            { t: 'num', d: 'opaque core around features (DEF 4)' },
  residMinPts:      { t: 'num', d: 'residual diagnostic floor (DEF 150)' },
  suppress:         { t: 'obj', d: '{ <expr>: row | [[x0, y0, x1, y1(, "face")], ...] } drawn ink there becomes skin' },
  suppressWhole:    { t: 'bool', d: 'every pixel of the suppress boxes is replaced' },
  suppressFill:     { t: 'str', d: "'base' | 'frame' | 'skin' fill of suppressed pixels" },
  suppressFeather:  { t: 'num', d: "with suppressFill 'base' and box form: ramp over f px inside each box edge" },
  talkBox:          { t: 'arr', d: 'extra boxes unioned into the talk mouth zone' },
  strandAA:         { t: 'num', d: 'iseul: dark patch ink within w px of strand rims is anti-aliased' },
  noseBase:         { t: 'obj', d: 'father/mother: { <expr>: [[x0, y0, x1, y1], ...] } the base nose blended into the patch' },
  noseGrow:         { t: 'num', d: 'noseBase grow (DEF 3)' },
  noseFeather:      { t: 'num', d: 'noseBase feather (DEF 3)' },
  noseNs:           { t: 'num', d: 'noseBase stroke dE bar (DEF 8)' },
  suppressInk:      { t: 'arr', d: 'boxes: grey / lavender-white ink painted out (5th value = own grow)' },
  suppressInkGrow:  { t: 'num', d: 'suppressInk grow (default 1)' },
  suppressInkFill:  { t: 'str', d: "'skin' (default) | 'all'" },
  suppressInkAll:   { t: 'arr', d: "boxes: suppressInk with the 'all' fill" },
  suppressShade:    { t: 'arr', d: 'boxes: every pixel painted out (skin fill)' },
  shadeLift:        { t: 'arr', d: 'boxes: shading lifted to the light skin around' },
  shadeLiftL:       { t: 'num', d: 'shadeLift source L* floor (default 84)' },
  shadeLiftFeather: { t: 'num', d: 'shadeLift feather px' },
  blushFeat:        { t: 'num', d: 'the frame blush (G drop >= d) counts as a feature' },
  talkZone:         { t: 'arr', d: 'the talk cut looks only inside [x0, y0, x1, y1]' },
})

/** read before the loop as well (registration); profile.expressions.per only */
export const PER_REG_KEYS = Object.freeze(['regHairGrow', 'regMinPts', 'regHairW'])

export function typeOk(v, t) {
  const ts = Array.isArray(t) ? t : [t]
  return ts.some(k => k === 'any'
    || (k === 'num' && typeof v === 'number' && Number.isFinite(v))
    || (k === 'int' && Number.isInteger(v))
    || (k === 'bool' && typeof v === 'boolean')
    || (k === 'str' && typeof v === 'string')
    || (k === 'arr' && Array.isArray(v))
    || (k === 'obj' && v !== null && typeof v === 'object' && !Array.isArray(v)))
}
