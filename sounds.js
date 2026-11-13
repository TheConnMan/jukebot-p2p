// Notification sounds for the offscreen document. Web Audio only, no files.
// The service worker asks for these. A knock is three short low thumps.
// A ding is one soft bell with a decay.

let ctx
let master

function audio() {
  if (!ctx || ctx.state === 'closed') {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.gain.value = 0.4
    master.connect(ctx.destination)
  }
  return ctx
}

function env(context, peak, attack, release, when) {
  const gain = context.createGain()
  gain.gain.setValueAtTime(0.0001, when)
  gain.gain.exponentialRampToValueAtTime(peak, when + attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, when + attack + release)
  return gain
}

function thump(context, when) {
  const osc = context.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(150, when)
  osc.frequency.exponentialRampToValueAtTime(55, when + 0.09)
  const gain = env(context, 0.22, 0.006, 0.1, when)
  osc.connect(gain).connect(master)
  osc.start(when)
  osc.stop(when + 0.14)

  const noise = context.createBufferSource()
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * 0.04), context.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length)
  noise.buffer = buffer
  const filter = context.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 240
  const noiseGain = env(context, 0.14, 0.002, 0.035, when)
  noise.connect(filter).connect(noiseGain).connect(master)
  noise.start(when)
  noise.stop(when + 0.05)
}

function bell(context, when) {
  const partials = [{freq: 880, peak: 0.16, release: 0.55}, {freq: 1320, peak: 0.05, release: 0.32}]
  for (const partial of partials) {
    const osc = context.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(partial.freq, when)
    const gain = env(context, partial.peak, 0.012, partial.release, when)
    osc.connect(gain).connect(master)
    osc.start(when)
    osc.stop(when + partial.release + 0.02)
  }
}

export async function play(name) {
  const context = audio()
  try {
    if (context.state === 'suspended') await context.resume()
  } catch (err) {
    return {name, state: context.state, error: String(err)}
  }
  if (context.state !== 'running') return {name, state: context.state, error: 'not-running'}
  const when = context.currentTime + 0.02
  if (name === 'knock') {
    thump(context, when)
    thump(context, when + 0.17)
    thump(context, when + 0.36)
  } else if (name === 'ding') {
    bell(context, when)
  } else {
    return {name, state: context.state, error: 'unknown'}
  }
  return {name, state: context.state, error: null}
}
