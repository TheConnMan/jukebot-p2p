// Content script on youtube.com and music.youtube.com. Drives the page's own
// <video> element to match the room state, and reports what the local user does
// (play, pause, seek, pick another video) back to the room.

(() => {
  const TOLERANCE = 2 // seconds of drift allowed before seeking
  const KNOWN = 'jukebot.knownVid' // last video this tab agreed on with the room; survives reloads
  const AUTOPLAY_WINDOW = 10000 // after an end the room moved on from, ignore the site's own autoplay for this long

  let inRoom = false
  let state = null // room state, with `at` on this machine's clock
  let aligned = false // local player has matched the room since the last video change
  let lastEnded = 0
  let endedVid = null
  let navAt = 0

  const video = () => document.querySelector('video.html5-main-video') || document.querySelector('video')
  const currentVid = () => new URL(location.href).searchParams.get('v')
  const adShowing = () => document.querySelector('.ad-showing') != null
  const expected = s => s.pos + (s.playing ? (Date.now() - s.at) / 1000 : 0)
  const send = msg => chrome.runtime.sendMessage(msg).catch(() => undefined)
  const title = () => document.title.replace(/^\(\d+\)\s*/, '').replace(/\s+-\s+YouTube( Music)?$/, '')

  function snapshot() {
    const el = video()
    return {v: currentVid(), title: title(), pos: el?.currentTime ?? 0, playing: el ? !el.paused : false}
  }

  function enter(resetKnown) {
    inRoom = true
    aligned = false
    if (resetKnown || !sessionStorage.getItem(KNOWN)) sessionStorage.setItem(KNOWN, currentVid() ?? '')
  }

  // `reason` labels a video change for the activity log: start, pick, advance.
  function publish(patch, reason) {
    state = {...state, ...patch, at: Date.now()}
    send({to: 'offscreen', type: 'update', patch, reason})
  }

  function navigate(v, t) {
    navAt = Date.now()
    sessionStorage.setItem(KNOWN, v)
    location.assign(`${location.origin}/watch?v=${encodeURIComponent(v)}&t=${Math.floor(t)}s`)
  }

  function onEnded() {
    const [next, ...rest] = state.queue ?? []
    if (next) publish({v: next.id, title: next.title, duration: next.duration, pos: 0, playing: true, queue: rest}, 'advance')
  }

  function onMedia(e) {
    if (inRoom && e.type === 'ended') {
      // Recorded even when the room already advanced past this video, so the
      // site's autoplay that follows is not mistaken for the user's pick.
      lastEnded = Date.now()
      endedVid = currentVid()
    }
    if (!inRoom || !state || !aligned || adShowing()) return
    const el = e.target
    if (el !== video() || currentVid() !== state.v) return
    if (e.type === 'ended') return onEnded()
    if (el.ended) return // the pause that comes with reaching the end
    const playing = !el.paused
    const drift = Math.abs(el.currentTime - expected(state))
    if (playing !== state.playing || (e.type === 'seeked' && drift > TOLERANCE)) {
      publish({pos: el.currentTime, playing})
    }
  }

  function tick() {
    if (!inRoom || !state?.v || adShowing()) return
    const vid = currentVid()
    if (vid !== state.v) {
      aligned = false
      const known = sessionStorage.getItem(KNOWN)
      const autoplay = Date.now() - lastEnded < AUTOPLAY_WINDOW && state.v !== endedVid
      if (vid && vid !== known && !autoplay) {
        // The local user picked another video: the room follows.
        sessionStorage.setItem(KNOWN, vid)
        const el = video()
        publish({v: vid, pos: el?.currentTime ?? 0, playing: true}, 'pick')
      } else if (Date.now() - navAt > 5000) {
        navigate(state.v, expected(state))
      }
      return
    }
    sessionStorage.setItem(KNOWN, vid)
    const el = video()
    if (!el || el.readyState < 1) return
    const want = expected(state)
    let ok = true
    if (Math.abs(el.currentTime - want) > TOLERANCE && want < (el.duration || Infinity)) {
      el.currentTime = want
      ok = false
    }
    if (state.playing && el.paused && !el.ended) {
      el.play().catch(() => {})
      ok = false
    } else if (!state.playing && !el.paused) {
      el.pause()
      ok = false
    }
    if (ok) aligned = true
  }

  // Runs at document_start, before the first tick: YouTube Music rewrites the
  // URL and drops the invite's #jukebot= hash before the page settles. The
  // video in an invite link is whatever played when it was copied, never the
  // user's pick, so it is marked known and the room's current video wins.
  function joinFromHash() {
    const id = new URLSearchParams(location.hash.slice(1)).get('jukebot')
    if (!id) return
    sessionStorage.setItem(KNOWN, currentVid() ?? '')
    history.replaceState(history.state, '', location.href.split('#')[0])
    send({to: 'bg', type: 'join', roomId: id}).then(r => {
      if (r && !r.error) enter(false)
    })
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'state') {
      if (!inRoom) enter(false)
      if (msg.state?.v !== state?.v) aligned = false
      state = msg.state
    } else if (msg.type === 'left') {
      inRoom = false
      state = null
    } else if (msg.type === 'start') {
      // This tab just created the room: its current video seeds the state.
      enter(true)
      const s = snapshot()
      publish({v: s.v, title: s.title, duration: video()?.duration || null, pos: s.pos, playing: s.playing, queue: []}, 'start')
      aligned = true
    } else if (msg.type === 'snapshot') {
      reply(snapshot())
    }
    return false
  })

  for (const type of ['play', 'pause', 'seeked', 'ended']) document.addEventListener(type, onMedia, true)
  window.addEventListener('hashchange', joinFromHash)
  joinFromHash()
  setInterval(tick, 500)

  send({to: 'offscreen', type: 'hello'}).then(r => {
    if (r?.inRoom) {
      enter(false)
      state ??= r.state
    }
  })
})()
