const vowels = [
  [0.88, 0], [0.56, 0.75], [0.82, 0], [0.53, 0.75],
  [0.72, 0], [0.52, 0.75], [0.68, 0], [0.51, 0.75],
  [0.54, -1], [0.78, -0.35], [0.55, 0.35], [0.48, -0.45], [0.51, -1],
  [0.48, -1], [0.65, -0.45], [0.52, 0.35], [0.46, -0.45], [0.44, -1],
  [0.32, 0.15], [0.38, 0.55], [0.43, 1],
]

const expressions = new Map([
  ['기본', null], ['기쁨', 'smile'], ['걱정', 'x_worried'],
  ['놀람', 'surprised'], ['신남', 'x_excited'],
])
const gazes = new Map([['왼쪽', -0.8], ['정면', 0], ['오른쪽', 0.8]])

export function dialogueCues(text) {
  const tokens = text.normalize('NFC').trim().split(/(\[(?:기본|기쁨|걱정|놀람|신남|왼쪽|정면|오른쪽)\])/u)
  return tokens.flatMap(token => {
    const label = token.slice(1, -1)
    if (token.startsWith('[') && token.endsWith(']') && expressions.has(label)) {
      return [{ duration: 0, expression: expressions.get(label) }]
    }
    if (token.startsWith('[') && token.endsWith(']') && gazes.has(label)) {
      return [{ duration: 0, gaze: gazes.get(label) }]
    }
    return Array.from(token, syllableCue)
  })
}

function syllableCue(char) {
    if (/[.!?。！？\n]/u.test(char)) return { duration: 0.34, open: 0, vowel: 0 }
    if (/[,;:，、…]/u.test(char)) return { duration: 0.19, open: 0, vowel: 0 }
    if (/\s/u.test(char)) return { duration: 0.07, open: 0, vowel: 0 }
    const syllable = char.codePointAt(0) - 0xac00
    if (syllable >= 0 && syllable < 11172) {
      const [open, vowel] = vowels[Math.floor(syllable / 28) % 21]
      return { duration: syllable % 28 ? 0.185 : 0.155, open, vowel }
    }
    return /[\p{L}\p{N}]/u.test(char)
      ? { duration: 0.145, open: 0.58, vowel: 0 }
      : { duration: 0.05, open: 0, vowel: 0 }
}

export function attachDialogue(player, setExpression, root = document, onStart = () => {}) {
  const input = root.querySelector('#dialogue')
  const status = root.querySelector('#dialogue-status')
  const play = root.querySelector('#dialogue-play')
  const repeatPlay = root.querySelector('#dialogue-repeat')
  const stop = root.querySelector('#dialogue-stop')
  let cues = []
  let index = 0
  let elapsed = 0
  let repeating = false
  let gaze = null

  function finish(message) {
    cues = []
    gaze = null
    repeating = false
    stop.disabled = true
    status.textContent = message
  }

  function start(repeat) {
    cues = dialogueCues(input.value)
    index = 0
    elapsed = 0
    gaze = null
    repeating = repeat
    if (!cues.some(cue => cue.open)) {
      finish('재생할 대사를 입력해 주세요.')
      return
    }
    onStart()
    if (repeating) cues.push({ duration: 0.45, open: 0, vowel: 0 })
    stop.disabled = false
    status.textContent = repeating ? '무음 반복 재생 중' : '무음 재생 중'
  }
  play.onclick = () => start(false)
  repeatPlay.onclick = () => start(true)
  stop.onclick = () => finish('정지됨')
  function insertMarker(label) {
    const marker = `[${label}]`
    if (input.value.length - (input.selectionEnd - input.selectionStart) + marker.length > input.maxLength) {
      status.textContent = '대사 길이 제한에 도달했습니다.'
      return
    }
    input.setRangeText(marker, input.selectionStart, input.selectionEnd, 'end')
    input.focus()
  }
  root.querySelector('#insert-expression').onclick = () =>
    insertMarker(root.querySelector('#dialogue-expression').value)
  root.querySelector('#insert-gaze').onclick = () =>
    insertMarker(root.querySelector('#dialogue-gaze').value)

  player.use({
    update(frame) {
      if (!cues.length) return
      elapsed += frame.dt
      while (cues[index] && elapsed >= cues[index].duration) {
        if ('expression' in cues[index]) setExpression(cues[index].expression)
        if ('gaze' in cues[index]) gaze = cues[index].gaze
        elapsed -= cues[index].duration
        index++
        if (index === cues.length && repeating) {
          index = 0
          elapsed = 0
          gaze = null
        }
      }
      const cue = cues[index]
      if (!cue) {
        finish('재생 완료')
        return
      }
      const envelope = Math.max(0, Math.min(1, elapsed / 0.043, (cue.duration - elapsed) / 0.052))
      frame.params.mouthOpen = cue.open * envelope
      frame.params.vowel = cue.vowel
      if (gaze !== null) frame.params.eyeBallX = gaze
    },
  })
  return { stop: () => finish('') }
}
