/**
 * Expression tables that are ENGINE constants (DESIGN §3.3, §4.3, Appendix B).   Owner: Track A.
 *
 * Their key order is model.json bytes (`expressions[].label`, the layer labels), so they live here and
 * not in the profiles. A profile only names which EXTRA ids it wants (profile.expressions.extra) and
 * gives its own knobs (profile.expressions.per / perX); see docs/PROFILE-KEYS.md.
 *
 * Sources (legacy/, never run):
 *   BASE_EXPRESSIONS   shared tools/livliv/expressions.mjs 38-43 (= livliv-frozen-kai8 42-47, byte-equal)
 *   EXTRA_EXPRESSIONS  livliv-frozen-kai8 EXTRA.kai = iseul8 EXTRA.iseul = sua2x8 EXTRA.sua2 (one table, three copies)
 *   DEF                livliv-frozen-kai8 DEF + the livliv-frozen-nose additions (regHair*, residMinPts, nose*)
 */

/** the four expressions, in UI order; `src` is the frame's file name in a profile.expressions.frames dir */
export const BASE_EXPRESSIONS = Object.freeze([
  { id: 'smile',     src: 'smile',     hotkey: '1', label: { ko: '기쁨', en: 'Smile', ja: '笑顔', zh: '笑', 'zh-Hant': '笑' } },
  { id: 'x_worried', src: 'worried',   hotkey: '2', label: { ko: '고민', en: 'Worried' } },
  { id: 'surprised', src: 'surprised', hotkey: '3', label: { ko: '놀람', en: 'Surprised', ja: '驚き', zh: '惊讶', 'zh-Hant': '驚訝' } },
  { id: 'x_excited', src: 'excited',   hotkey: '4', label: { ko: '신남', en: 'Excited' } },
].map(deepFreeze))

/** more expressions, after the four, in the order a profile lists them (same ids / labels / hotkeys / frame
 *  names for every character that has them: 이슬, 카이, 수아2) */
export const EXTRA_EXPRESSIONS = Object.freeze({
  x_contempt: deepFreeze({ id: 'x_contempt', src: 'contempt', hotkey: '5', label: { ko: '경멸', en: 'Contempt' } }),
  x_hatred:   deepFreeze({ id: 'x_hatred',   src: 'hatred',   hotkey: '6', label: { ko: '증오', en: 'Hatred' } }),
  x_shock:    deepFreeze({ id: 'x_shock',    src: 'shock',    hotkey: '7', label: { ko: '충격', en: 'Shock' } }),
  x_moved:    deepFreeze({ id: 'x_moved',    src: 'moved',    hotkey: '8', label: { ko: '감동', en: 'Moved' } }),
})

/** the defaults every character's knobs are merged over: {...DEF, ...profile.expressions.per} (shallow) */
export const DEF = Object.freeze({ hairGap: 1, T: 16, ns: 22, minArea: 12, prox: 4, sil: 3, sigma: 5, rCore: 4,
  /* [regHair] registration point set: hair grown by regHairGrow px is left out. If that leaves fewer than
     regMinPts points the hair is kept but weighted regHairW instead, so a character whose head window is
     almost all hair still gets a fit (reported as the shift's `mode`). */
  regHairGrow: 2, regMinPts: 400, regHairW: 0.1,
  /* the per-quadrant residual is a diagnostic; with hair gone a quadrant holds far fewer points than the
     600 the all-points set had, so the bar to still report one is lower (counts come out in `residN`) */
  residMinPts: 150,
  /* [noseBase] px grown off the drawn stroke before the feather starts, the feather itself, and the
     dE bar the stroke is found at. noseNs is far below `ns` on purpose: the nostril mark is a faded
     dash, 4 px over dE 12 and none over 22 in 아빠's rest face, and `ns` would miss it entirely. */
  noseGrow: 3, noseFeather: 3, noseNs: 8 })

/** the list a profile's expressions resolve to: the four, then its extra ids in order */
export function expressionsOf(extra) {
  return [...BASE_EXPRESSIONS, ...(extra || []).map(id => {
    const e = EXTRA_EXPRESSIONS[id]
    if (!e) throw new Error(`unknown extra expression "${id}" (known: ${Object.keys(EXTRA_EXPRESSIONS).join(', ')})`)
    return e
  })]
}

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    for (const k of Object.keys(v)) deepFreeze(v[k])
    Object.freeze(v)
  }
  return v
}
