// Runs content.js against a fake YouTube page: fake location, player, storage,
// timers and extension messaging, with time advanced by hand.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../content.js', import.meta.url), 'utf8')
const A = 'AAAAAAAAAAA'
const B = 'BBBBBBBBBBB'
const ORIGIN = 'https://music.youtube.com'

function page(roomState) {
  let now = 1_700_000_000_000
  const timers = []
  const listeners = {}
  const messageListeners = []
  const sent = []
  const assigned = []
  const store = new Map()
  const video = {readyState: 4, currentSrc: 'blob:song', currentTime: 0, paused: false, ended: false, seeking: false, duration: 200, play: async () => {}, pause() {}}
  const location = {href: `${ORIGIN}/watch?v=${A}`, origin: ORIGIN, hash: '', assign: url => assigned.push(url)}
  class FakeDate extends Date {
    static now() {
      return now
    }
  }
  const addTimer = (fn, ms, every) => timers.push({fn, at: now + ms, every}) - 1
  const context = {
    URL,
    URLSearchParams,
    Date: FakeDate,
    location,
    history: {state: null, replaceState() {}},
    sessionStorage: {getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k)},
    document: {title: 'Song - YouTube Music', querySelector: sel => (sel === '.ad-showing' ? null : video), addEventListener: (type, fn) => (listeners[type] = fn)},
    window: {addEventListener() {}},
    confirm: () => true,
    setTimeout: (fn, ms) => addTimer(fn, ms, 0),
    setInterval: (fn, ms) => addTimer(fn, ms, ms),
    clearTimeout: id => id != null && timers[id] && (timers[id].fn = null),
    chrome: {
      runtime: {
        getURL: path => `chrome-extension://jukebot/${path}`,
        onMessage: {addListener: fn => messageListeners.push(fn)},
        sendMessage: async msg => {
          sent.push(msg)
          if (msg.type === 'hello') return {inRoom: true, roomId: 'room', state: roomState}
          return true
        },
      },
    },
  }
  vm.runInNewContext(SOURCE, context)

  const flush = () => new Promise(resolve => setImmediate(resolve))
  return {
    video,
    location,
    sent,
    assigned,
    async advance(ms) {
      const end = now + ms
      for (;;) {
        const due = timers.filter(t => t.fn && t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        now = due.at
        const fn = due.fn
        if (due.every) due.at += due.every
        else due.fn = null
        fn()
        await flush()
      }
      now = end
    },
    media: type => listeners[type]({type, target: video}),
    roomMessage: state => messageListeners.forEach(fn => fn({type: 'state', roomId: 'room', state}, {url: 'chrome-extension://jukebot/offscreen.html'})),
    browse: path => (location.href = `${ORIGIN}${path}`),
    flush,
    clock: () => now,
  }
}

async function inRoomOnA(queue = []) {
  const state = {v: A, title: 'Song A', duration: 200, pos: 0, playing: true, queue, at: 1_700_000_000_000}
  const p = page(state)
  await p.flush()
  p.media('loadedmetadata')
  await p.advance(2000)
  assert.deepEqual(p.assigned, [], 'in sync on the watch page')
  return {p, state}
}

test('browsing to Home while the room plays this tab’s video stays on Home (issue #7)', async () => {
  const {p} = await inRoomOnA()
  p.browse('/')
  await p.advance(60000)
  p.browse('/search?q=songs')
  await p.advance(60000)
  assert.deepEqual(p.assigned, [])
})

test('when the room moves on during browsing, the tab is sent there once, and a cancelled prompt is not repeated', async () => {
  const {p, state} = await inRoomOnA()
  p.browse('/')
  await p.advance(5000)
  p.roomMessage({...state, v: B, title: 'Song B', pos: 0, at: p.clock()})
  // The navigation never happens, as when the person cancels the leave-site prompt.
  await p.advance(60000)
  assert.equal(p.assigned.length, 1)
  assert.match(p.assigned[0], new RegExp(`/watch\\?v=${B}&`))
})

test('the room’s video ending in the player bar while browsing advances the queue', async () => {
  const {p} = await inRoomOnA([{id: B, title: 'Song B', duration: 180}])
  p.browse('/')
  await p.advance(200000)
  p.video.ended = true
  p.media('ended')
  const advance = p.sent.find(m => m.type === 'update' && m.reason === 'advance')
  assert.equal(advance?.patch.v, B)
})

test('the player bar ending while browsing does not advance a room that was paused or seeked back', async () => {
  const {p, state} = await inRoomOnA([{id: B, title: 'Song B', duration: 180}])
  p.browse('/')
  await p.advance(1000)
  p.roomMessage({...state, pos: 10, playing: false, at: p.clock()})
  await p.advance(1000)
  p.video.ended = true
  p.media('ended')
  p.roomMessage({...state, pos: 10, playing: true, at: p.clock()})
  p.media('ended')
  assert.equal(p.sent.find(m => m.reason === 'advance'), undefined)
})

test('a watch page for a video the room left is still sent to the room’s video', async () => {
  const {p, state} = await inRoomOnA()
  p.roomMessage({...state, v: B, title: 'Song B', pos: 0, at: p.clock()})
  await p.advance(1000)
  assert.equal(p.assigned.length, 1)
  assert.match(p.assigned[0], new RegExp(`/watch\\?v=${B}&`))
})
