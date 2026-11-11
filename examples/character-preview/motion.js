// Small, optional motions layered on the official player's manual parameters.
// A player driver adds offsets to each frame without changing slider values.
export function attachMotions(player, root = document) {
  const breathToggle = root.querySelector('#breath-motion')
  const expressionToggle = root.querySelector('#expression-motion')
  const blinkToggle = root.querySelector('#blink-motion')
  let untilBlink = 3 + Math.random() * 3
  let cameraY = 0
  let expression = null
  const current = { breath: 0, angleX: 0, angleY: 0, angleZ: 0, bodyX: 0, bodyZ: 0 }

  player.use({
    update(frame) {
      const t = frame.time
      const s = (period, phase = 0) => Math.sin((t * 2 * Math.PI) / period + phase)
      const target = { breath: 0, angleX: 0, angleY: 0, angleZ: 0, bodyX: 0, bodyZ: 0 }
      if (breathToggle.checked) {
        const phase = t % 4.6
        const progress = phase < 1.85 ? phase / 1.85 : (4.6 - phase) / 2.75
        target.breath = 0.86 * (0.5 - 0.5 * Math.cos(Math.PI * progress))
      }
      if (blinkToggle.checked) {
        untilBlink -= frame.dt
        if (untilBlink < -0.19) untilBlink = 3 + Math.random() * 3
        if (untilBlink <= 0) {
          const elapsed = -untilBlink
          const closure = Math.max(0, Math.min(1, elapsed / 0.065, (0.19 - elapsed) / 0.105))
          frame.add({
            eyeLOpen: -closure * frame.params.eyeLOpen,
            eyeROpen: -closure * frame.params.eyeROpen,
          })
        }
      }
      if (expressionToggle.checked) {
        switch (expression) {
          case 'smile':
            Object.assign(target, { angleX: 0.8 * s(4.8), angleY: -0.6 + 0.4 * s(4.1), angleZ: 1.1 + 0.7 * s(4.8), bodyZ: 0.3 * s(4.8) })
            break
          case 'x_worried':
            Object.assign(target, { angleX: 0.6 * s(5.4), angleY: -1.0 + 0.3 * s(4.4), angleZ: -1.2 + 0.5 * s(5.4), bodyZ: -0.2 * s(5.4) })
            break
          case 'surprised':
            Object.assign(target, { angleY: 1.4 + 0.5 * s(3.8), angleZ: 0.45 * s(4.6), bodyX: -0.25 * s(3.8) })
            break
          case 'x_excited':
            Object.assign(target, { angleX: 1.4 * s(2.5), angleY: 0.6 + 1.0 * s(2.5, Math.PI / 2), angleZ: 1.3 * s(2.5), bodyZ: 0.5 * s(2.5) })
            break
        }
      }
      // Ease both selection changes and toggles; avoid a visible jump on click.
      const blend = 1 - Math.exp(-Math.max(0, frame.dt) * 5)
      for (const key of Object.keys(current)) current[key] += (target[key] - current[key]) * blend
      player.view.y = cameraY + 0.011 * current.breath
      frame.add(current)
    },
  })
  return {
    setCameraY(y) { cameraY = y },
    setExpression(id) { expression = id },
    // Useful for verifying the independent controls without changing pose.
    getState() { return { expression, breathEnabled: breathToggle.checked, expressionEnabled: expressionToggle.checked, offsets: { ...current } } },
  }
}
