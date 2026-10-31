// Content script on youtube.com and music.youtube.com. Drives the page's own
// <video> element to match the room state, and reports what the local user does
// (play, pause, seek, pick another video) back to the room.

(() => {
  const TOLERANCE = 2 // seconds of drift allowed before seeking
  const KNOWN = 'jukebot.knownVid' // last video this tab agreed on with the room; survives reloads
  const FOLLOW = 'jukebot.followRoom' // joined from a page with no video: wait for the room's video, never seed or overwrite it
  const AUTOPLAY_WINDOW = 10000 // after an end the room moved on from, ignore the site's own autoplay for this long
  const SEED_AFTER = 8000 // no peer state by then: this tab is the room

  let inRoom = false
  let state = null // room state, with `at` on this machine's clock
  let aligned = false // local player has matched the room since the last video change
  let lastEnded = 0
  let endedVid = null
  let navAt = 0
  let seedTimer = null
  let roomId = null
  let followRoom = sessionStorage.getItem(FOLLOW) === '1'
  let generation = 0
  let joining = false
  let extensionSeek = false
  let mediaVid = null
  let mediaSrc = null

  const video = () => document.querySelector('video.html5-main-video') || document.querySelector('video')
  const currentVid = () => new URL(location.href).searchParams.get('v')
  const adShowing = () => document.querySelector('.ad-showing') != null
  const expected = s => s.pos + (s.playing ? (Date.now() - s.at) / 1000 : 0)
  const send = msg => chrome.runtime.sendMessage(msg).catch(() => undefined)
  const title = () => document.title.replace(/^\(\d+\)\s*/, '').replace(/\s+-\s+YouTube( Music)?$/, '')

  const mediaReady = () => {
    const el = video()
    return !adShowing() && el?.readyState >= 1 && mediaVid === currentVid() && mediaSrc === el.currentSrc
  }

  function snapshot() {
    const el = video()
    return {v: currentVid(), title: title(), pos: el?.currentTime ?? 0, playing: el ? !el.paused : false}
  }

  function enter(resetKnown) {
    inRoom = true
    aligned = false
    // A home-page join has no video of its own. Writing an empty known id would
    // make the next video look like this person's pick.
    if (followRoom) return
    if (resetKnown || !sessionStorage.getItem(KNOWN)) sessionStorage.setItem(KNOWN, currentVid() ?? '')
  }

  // `reason` labels a video change for the activity log: start, pick, advance.
  function publish(patch, reason) {
    state = {...state, ...patch, at: Date.now()}
    send({to: 'offscreen', type: 'update', roomId, patch, reason})
  }

  // Same patch "Start a room" publishes. `v` is the watch URL, which on an
  // invite is the video the link carries.
  function initialPatch() {
    const s = snapshot()
    return {v: s.v, title: s.title, duration: video()?.duration || null, pos: s.pos, playing: s.playing, queue: []}
  }

  function armSeed() {
    clearTimeout(seedTimer)
    seedTimer = setTimeout(seedIfAlone, SEED_AFTER)
  }

  // Nobody sent room state. Publish the start patch, but keep the local player
  // on whatever arrived in the meantime: a higher rev from a peer wins.
  function seedIfAlone() {
    seedTimer = null
    if (followRoom) return
    if (!inRoom || state?.v) return
    if (!mediaReady() || !currentVid()) return armSeed()
    const patch = initialPatch()
    const gen = generation
    send({to: 'offscreen', type: 'update', roomId, patch, reason: 'start'}).then(ok => {
      if (gen !== generation || ok !== true || state?.v) return
      state = {...patch, at: Date.now()}
      sessionStorage.setItem(KNOWN, patch.v)
      aligned = true
    })
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
    if (e.target !== video()) return
    if (e.type === 'loadedmetadata') {
      mediaVid = currentVid()
      mediaSrc = e.target.currentSrc
    }
    if (e.type === 'emptied') {
      mediaVid = mediaSrc = null
      extensionSeek = false
    }
    if (e.type === 'seeked' && extensionSeek) {
      extensionSeek = false
      return
    }
    if (inRoom && e.type === 'ended') {
      // Recorded even when the room already advanced past this video, so the
      // site's autoplay that follows is not mistaken for the user's pick.
      lastEnded = Date.now()
      endedVid = currentVid()
    }
    if (!['play', 'pause', 'seeked', 'ended'].includes(e.type)) return
    if (!inRoom || !state || !aligned || !mediaReady() || extensionSeek) return
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
      if (!followRoom && vid && vid !== known && !autoplay) {
        // The local user picked another video: the room follows.
        sessionStorage.setItem(KNOWN, vid)
        const el = video()
        publish({v: vid, pos: mediaReady() ? el.currentTime : 0, playing: true}, 'pick')
      } else if (followRoom || Date.now() - navAt > 5000) {
        navigate(state.v, expected(state))
      }
      return
    }
    if (followRoom) {
      followRoom = false
      sessionStorage.removeItem(FOLLOW)
    }
    sessionStorage.setItem(KNOWN, vid)
    const el = video()
    if (!mediaReady() || el.seeking) return
    const want = expected(state)
    let ok = true
    if (Math.abs(el.currentTime - want) > TOLERANCE && want < (el.duration || Infinity)) {
      extensionSeek = true
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
    // Durations come from the player, not from YouTube's pages.
    if (ok && state.duration == null && Number.isFinite(el.duration) && el.duration > 0) publish({duration: Math.round(el.duration)}, 'meta')
  }

  // Runs at document_start, before the first tick: YouTube Music rewrites the
  // URL and drops the invite's #jukebot= hash before the page settles. The
  // video in an invite link is whatever played when it was copied, never the
  // user's pick, so it is marked known and the room's current video wins.
  function joinFromHash() {
    const id = new URLSearchParams(location.hash.slice(1)).get('jukebot')
    if (!id) return false
    history.replaceState(history.state, '', location.href.split('#')[0])
    if (!confirm('Join this JukeBot room? This replaces your current room if you are in one.')) return false
    const gen = ++generation
    joining = true
    if (id !== roomId) {
      clearTimeout(seedTimer)
      state = null
      aligned = false
      inRoom = false
    }
    roomId = id
    if (currentVid()) {
      followRoom = false
      sessionStorage.removeItem(FOLLOW)
      sessionStorage.setItem(KNOWN, currentVid())
    } else {
      // Home page (or any URL with no video). The hash is already gone, and
      // YouTube Music may rewrite this URL, so the marker has to outlive both.
      followRoom = true
      sessionStorage.setItem(FOLLOW, '1')
      sessionStorage.removeItem(KNOWN)
    }
    send({to: 'bg', type: 'join', roomId: id}).then(r => {
      if (gen !== generation) return
      joining = false
      if (!r || r.error || r.roomId !== roomId) return
      enter(false)
      state ??= r.state
      if (!state?.v) armSeed()
    })
    return true
  }

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return false
    if (msg.type === 'state') {
      if (roomId && msg.roomId !== roomId) return false
      if (roomId !== msg.roomId) {
        generation++
        state = null
      }
      roomId = msg.roomId
      if (!inRoom) enter(false)
      if (msg.state?.v) clearTimeout(seedTimer)
      if (msg.state?.v !== state?.v) aligned = false
      state = msg.state
      if (!state?.v) armSeed()
    } else if (msg.type === 'left') {
      generation++
      roomId = null
      followRoom = false
      sessionStorage.removeItem(FOLLOW)
      joining = false
      clearTimeout(seedTimer)
      inRoom = false
      state = null
    } else if (msg.type === 'start') {
      // This tab just created the room: its current video seeds the state.
      generation++
      followRoom = false
      sessionStorage.removeItem(FOLLOW)
      roomId = msg.roomId
      state = null
      clearTimeout(seedTimer)
      enter(true)
      if (mediaReady()) seedIfAlone()
      else armSeed()
    }
    return false
  })

  for (const type of ['play', 'pause', 'seeked', 'ended', 'loadedmetadata', 'emptied']) document.addEventListener(type, onMedia, true)
  window.addEventListener('hashchange', joinFromHash)
  const hadInvite = joinFromHash()
  setInterval(tick, 500)

  if (!hadInvite) {
    const gen = generation
    send({to: 'offscreen', type: 'hello'}).then(r => {
      if (gen !== generation || joining || !r?.inRoom) return
      roomId = r.roomId
      enter(false)
      state ??= r.state
      if (!state?.v) armSeed()
    })
  }
})()
