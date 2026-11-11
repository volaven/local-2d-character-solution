const expressions = new Map([
  ['기본', null], ['기쁨', 'smile'], ['걱정', 'x_worried'],
  ['놀람', 'surprised'], ['신남', 'x_excited'],
])
const gazes = new Map([['왼쪽', -.65], ['정면', 0], ['오른쪽', .65]])

export function suggestVoiceTags(buffer) {
  const hop = Math.round(buffer.sampleRate * .1)
  const channels = Array.from({length: buffer.numberOfChannels}, (_, i) => buffer.getChannelData(i))
  const levels = []
  for (let start = 0; start < buffer.length; start += hop) {
    const end = Math.min(start + hop, buffer.length)
    let energy = 0
    for (const channel of channels) {
      for (let i = start; i < end; i++) energy += channel[i] ** 2
    }
    levels.push(Math.sqrt(energy / ((end - start) * channels.length)))
  }
  const sorted = levels.slice().sort((a, b) => a - b)
  const reference = sorted[Math.floor((sorted.length - 1) * .9)] || sorted.at(-1) || 0
  if (reference < .0001) return ''
  const threshold = Math.max(.0001, reference * .13)
  const tags = ['0.00 [기본][정면]']
  let last = -20
  let side = 0
  let previous = '기본'
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] < threshold) continue
    const afterPause = i >= 4 && levels.slice(i - 4, i).every(level => level < threshold)
    if (i - last < (afterPause ? 7 : 20)) continue
    const segment = levels.slice(i, i + 12)
    const voiced = segment.filter(level => level >= threshold)
    const mean = voiced.reduce((sum, value) => sum + value, 0) / voiced.length
    const expression = afterPause && levels[i] > reference * 1.4 ? '놀람'
      : mean > reference * .85 && voiced.length >= 8 ? '신남'
      : mean > reference * .5 ? '기쁨' : '기본'
    const gaze = afterPause ? (side++ % 2 ? '오른쪽' : '왼쪽') : '정면'
    if (!afterPause && expression === previous && i > 0 && !/\[(?:왼쪽|오른쪽)\]$/.test(tags.at(-1))) continue
    tags.push(`${(i * hop / buffer.sampleRate).toFixed(2)} [${expression}][${gaze}]`)
    previous = expression
    last = i
  }
  return tags.join('\n')
}

export function parseVoiceTags(text) {
  return text.split(/\r?\n/).flatMap((raw, index) => {
    if (!raw.trim()) return []
    const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*((?:\[[^\]]+\]\s*)+)$/u)
    if (!match || !Number.isFinite(Number(match[1]))) throw new Error(`${index + 1}번째 줄의 시간과 태그를 확인해 주세요.`)
    const cue = { time: Number(match[1]) }
    for (const [, label] of match[2].matchAll(/\[([^\]]+)\]/gu)) {
      if (expressions.has(label)) cue.expression = expressions.get(label)
      else if (gazes.has(label)) cue.gaze = gazes.get(label)
      else throw new Error(`${index + 1}번째 줄의 [${label}] 태그를 확인해 주세요.`)
    }
    return [cue]
  }).sort((a, b) => a.time - b.time)
}
