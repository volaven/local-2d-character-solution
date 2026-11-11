import { startLipSync } from './node_modules/@livliv-dev/player/dist/voice.js'
import { parseVoiceTags, suggestVoiceTags } from './voice-tags.js'

export function attachAudioDialogue(player, stopText, setExpression) {
  const input = document.querySelector('#voice-file')
  const play = document.querySelector('#voice-play')
  const stopButton = document.querySelector('#voice-stop')
  const status = document.querySelector('#voice-status')
  const tags = document.querySelector('#voice-tags')
  const analyze = document.querySelector('#voice-analyze')
  const analysisStatus = document.querySelector('#voice-analysis-status')
  let fileVersion = 0
  let current = null

  function stop(message = '') {
    const session = current
    current = null
    if (session) {
      session.audio.pause()
      session.sync?.stop()
      session.audio.removeAttribute('src')
      session.audio.load()
      URL.revokeObjectURL(session.url)
    }
    stopButton.disabled = true
    status.textContent = message
  }

  player.use({
    order: 9,
    update(frame) {
      if (!current) return
      frame.params.mouthOpen = 0
      const { audio, cues } = current
      while (cues[current.next]?.time <= audio.currentTime && !audio.paused) {
        const cue = cues[current.next++]
        if ('expression' in cue) setExpression(cue.expression)
        if ('gaze' in cue) current.gaze = cue.gaze
      }
      if (current.gaze !== undefined) frame.params.eyeBallX = current.gaze
    },
  })

  input.onchange = () => {
    stop()
    fileVersion++
    tags.value = ''
    analysisStatus.textContent = ''
    play.disabled = !input.files.length
    analyze.disabled = play.disabled
  }
  analyze.onclick = async () => {
    const file = input.files[0]
    if (!file) return
    const version = fileVersion
    const draft = tags.value
    analyze.disabled = true
    analysisStatus.textContent = '음성을 분석하고 있습니다.'
    let context
    try {
      context = new AudioContext()
      const decoded = await context.decodeAudioData(await file.arrayBuffer())
      const result = suggestVoiceTags(decoded)
      if (version !== fileVersion) return
      if (tags.value !== draft) {
        analysisStatus.textContent = '편집 중인 태그를 유지했습니다.'
        return
      }
      tags.value = result
      analysisStatus.textContent = result ? '태그 초안을 만들었습니다.' : '분석할 만큼 뚜렷한 소리를 찾지 못했습니다.'
    } catch {
      if (version === fileVersion) analysisStatus.textContent = '이 파일의 음성을 분석할 수 없습니다.'
    } finally {
      if (context) await context.close()
      if (version === fileVersion) analyze.disabled = false
    }
  }
  stopButton.onclick = () => stop('음성 정지됨')
  play.onclick = async () => {
    const file = input.files[0]
    if (!file) return
    let cues
    try {
      cues = parseVoiceTags(tags.value)
    } catch (error) {
      status.textContent = error.message
      return
    }
    stopText()
    stop()
    const url = URL.createObjectURL(file)
    const audio = new Audio(url)
    const session = { audio, url, cues, next: 0 }
    current = session
    stopButton.disabled = false
    status.textContent = '음성 준비 중'
    audio.onended = () => {
      if (current === session) stop('음성 재생 완료')
    }
    audio.onerror = () => {
      if (current === session) stop('이 음성 파일을 재생할 수 없습니다.')
    }
    try {
      const sync = await startLipSync(player, audio, { motion: 0 })
      if (current !== session) {
        sync.stop()
        return
      }
      session.sync = sync
      await audio.play()
      if (current === session) status.textContent = '음성 립싱크 재생 중'
    } catch {
      if (current === session) stop('음성 재생 실패. 파일 형식을 확인하고 다시 시도해 주세요.')
    }
  }
  return { stop }
}
