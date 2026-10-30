// Offscreen document: joins the Trystero room and keeps the shared room state.
//
// Room state is one small object every peer holds a copy of:
//   {v, title, duration, pos, playing, queue: [{qid, id, title, duration, by, name}], rev, by}
// Any change bumps rev and is broadcast whole. A peer adopts an incoming copy
// when its rev is higher (ties go to the higher peer id), so all peers converge
// on the last change without anyone being the host. `at` is when this machine
// last set pos, on this machine's clock; it never goes over the wire, so clock
// skew between friends does not matter.
//
// Chat is a list of {id, by, name, text, ts, kind?, tag?} entries. Messages and
// activity lines (kind 'event', made by whoever acted) are sent once, and a
// peer that joins late gets the recent history from everyone already there; ids
// dedupe the copies. Join and leave lines are made locally by each peer and
// marked `local`, so they are never sent as history.
//
// Everything from peers is untrusted: it is checked and trimmed before use.

import {joinRoom, selfId} from './vendor/trystero.js'
import {lookup, validId} from './youtube.js'

const APP_ID = 'jukebot-p2p'
const CHAT_KEEP = 200
const CHAT_HISTORY = 50
const QUEUE_MAX = 100
const TYPING_FOR = 4000
const SEEK_SETTLE = 1500

let room = null
let actions = null
let roomId = null
let tabId = null
let state = null
let chat = []
let profile = {userId: '', name: ''}
const members = new Map() // peerId -> {userId, name}
const typing = new Map() // peerId -> last ping time
let seekTimer = null

const position = s => s.pos + (s.playing ? (Date.now() - s.at) / 1000 : 0)
const newer = (a, b) => !b || a.rev > b.rev || (a.rev === b.rev && a.by > b.by)
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
const num = v => (Number.isFinite(v) && v >= 0 ? v : null)
const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const nameOf = peerId => members.get(peerId)?.name || 'someone'

function wire(s) {
  const {at, ...rest} = s
  return {...rest, pos: position(s)}
}

function cleanItem(item, i) {
  if (!validId(item?.id)) return null
  return {
    qid: str(item.qid, 40) || `${item.id}-${i}`,
    id: item.id,
    title: str(item.title, 200),
    duration: num(item.duration),
    by: str(item.by, 40),
    name: str(item.name, 40)
  }
}

function cleanState(s) {
  if (!validId(s?.v) || !Number.isInteger(s.rev) || typeof s.by !== 'string') return null
  return {
    v: s.v,
    title: str(s.title, 200),
    duration: num(s.duration),
    pos: num(s.pos) ?? 0,
    playing: s.playing === true,
    queue: (Array.isArray(s.queue) ? s.queue.slice(0, QUEUE_MAX) : []).map(cleanItem).filter(Boolean),
    rev: s.rev,
    by: s.by.slice(0, 40)
  }
}

function push() {
  chrome.runtime.sendMessage({to: 'bg', type: 'push', tabId, state, peers: members.size}).catch(() => {})
}

const nudge = type => chrome.runtime.sendMessage({to: 'chat', type}).catch(() => {})

function join(id, tab, who) {
  if (who) profile = who
  if (room && id === roomId) {
    tabId = tab
    return
  }
  leave()
  roomId = id
  tabId = tab
  // The room id doubles as the password, so signaling data on the public
  // relays is encrypted with a secret only invite holders know.
  room = joinRoom({appId: APP_ID, password: id}, id)
  const make = name => room.makeAction(name)
  actions = {state: make('state'), chat: make('chat'), history: make('history'), hello: make('hello'), typing: make('typing')}

  actions.state.onMessage = data => {
    const s = cleanState(data)
    if (!s || !newer(s, state)) return
    state = {...s, at: Date.now()}
    push()
  }
  actions.chat.onMessage = (msgs, {peerId}) => {
    typing.delete(peerId)
    addChat(msgs, true)
  }
  actions.history.onMessage = msgs => addChat(msgs, false)
  actions.hello.onMessage = (data, {peerId}) => {
    const who = {userId: str(data?.userId, 40), name: str(data?.name, 40) || 'someone'}
    const before = members.get(peerId)
    members.set(peerId, who)
    if (!before) note(who, 'joined', 'join')
    else if (before.name !== who.name) note(who, `${before.name} is now ${who.name}`, 'rename')
    push()
  }
  actions.typing.onMessage = (_, {peerId}) => {
    typing.set(peerId, Date.now())
    nudge('typing')
  }
  room.onPeerJoin = peerId => {
    actions.hello.send(profile, {target: peerId})
    if (state) actions.state.send(wire(state), {target: peerId})
    const history = chat.filter(m => !m.local).slice(-CHAT_HISTORY)
    if (history.length) actions.history.send(history, {target: peerId})
  }
  room.onPeerLeave = peerId => {
    note(members.get(peerId) ?? {userId: '', name: 'someone'}, 'left', 'leave')
    members.delete(peerId)
    typing.delete(peerId)
    push()
  }
}

function leave() {
  room?.leave()
  room = actions = roomId = tabId = state = null
  chat = []
  members.clear()
  typing.clear()
  clearTimeout(seekTimer)
}

function addChat(msgs, live) {
  if (!Array.isArray(msgs)) return
  const seen = new Set(chat.map(m => m.id))
  const added = []
  for (const m of msgs.slice(0, CHAT_KEEP)) {
    if (typeof m?.id !== 'string' || typeof m.text !== 'string' || seen.has(m.id)) continue
    seen.add(m.id)
    const entry = {id: m.id.slice(0, 40), by: str(m.by, 40), name: str(m.name, 40), text: m.text.slice(0, 1000), ts: num(m.ts) ?? Date.now()}
    if (m.kind === 'event') Object.assign(entry, {kind: 'event', tag: str(m.tag, 10)})
    if (m.local === true) entry.local = true
    chat.push(entry)
    added.push(entry)
  }
  chat = chat.sort((a, b) => a.ts - b.ts).slice(-CHAT_KEEP)
  if (live && added.length) chrome.runtime.sendMessage({to: 'bg', type: 'incoming', messages: added}).catch(() => {})
  nudge('chat')
}

function entry(text, extra) {
  return {id: crypto.randomUUID(), by: profile.userId, name: profile.name, text, ts: Date.now(), ...extra}
}

function say(text) {
  const m = entry(text)
  addChat([m], false)
  actions.chat.send([m])
}

// An activity line everyone sees, including people who join later.
function event(text, tag) {
  if (!actions) return
  const m = entry(text, {kind: 'event', tag})
  addChat([m], false)
  actions.chat.send([m])
}

// A line about `who` that only this peer sees (joins, leaves and renames, which
// each peer notices itself). Also goes to the service worker for notifications.
function note(who, what, tag) {
  const text = tag === 'rename' ? what : `${who.name} ${what}`
  const m = {...entry(text, {kind: 'event', tag, local: true}), by: who.userId, name: who.name}
  addChat([m], false)
  chrome.runtime.sendMessage({to: 'bg', type: 'incoming', messages: [m]}).catch(() => {})
}

function titled(id, title) {
  if (title) return Promise.resolve(title)
  return lookup(id).then(info => info.title || id)
}

// Describe a local change for the activity log. `reason` says where a video
// change came from: start, pick (navigated), advance (queue on end), skip.
function describe(old, next, reason) {
  const who = profile.name || 'someone'
  if (!old || next.v !== old.v) {
    const verb = {start: `${who} started the room with`, skip: `${who} skipped to`, advance: 'Now playing'}[reason] ?? `${who} started`
    titled(next.v, next.title).then(t => event(`${verb} ${t}`, 'play'))
  } else if (next.playing !== old.playing) {
    event(`${who} ${next.playing ? 'resumed' : 'paused'}`, next.playing ? 'resume' : 'pause')
  } else if (Math.abs(next.pos - position(old)) > 2) {
    clearTimeout(seekTimer)
    seekTimer = setTimeout(() => state && event(`${who} jumped to ${clock(position(state))}`, 'seek'), SEEK_SETTLE)
  }
  if (!old) return
  const before = new Set(old.queue.map(q => q.qid))
  const after = new Set(next.queue.map(q => q.qid))
  for (const q of next.queue) if (!before.has(q.qid)) event(`${who} added ${q.title || q.id}`, 'add')
  for (const q of old.queue) {
    if (after.has(q.qid) || (q.id === next.v && (reason === 'advance' || reason === 'skip'))) continue
    event(`${who} removed ${q.title || q.id}`, 'remove')
  }
}

function update(patch, reason) {
  const old = state
  const fresh = patch.v && patch.v !== old?.v
  if (fresh && !('title' in patch)) Object.assign(patch, {title: '', duration: null})
  // A patch without pos (queue or title edits) keeps playback where it is.
  const pos = 'pos' in patch ? patch.pos : old ? position(old) : 0
  state = {queue: [], ...state, ...patch, pos, rev: (state?.rev ?? 0) + 1, by: selfId, at: Date.now()}
  actions.state.send(wire(state))
  push()
  if (reason !== 'meta') describe(old, state, reason)
  if (fresh && (!state.title || state.duration == null)) fillMeta(state.v)
}

async function fillMeta(v) {
  const info = await lookup(v)
  if (state?.v !== v) return
  const patch = {}
  if (!state.title && info.title) patch.title = info.title
  if (state.duration == null && info.duration) patch.duration = info.duration
  if (Object.keys(patch).length) update(patch, 'meta')
}

function skip() {
  const [next, ...rest] = state?.queue ?? []
  if (next) update({v: next.id, title: next.title, duration: next.duration, pos: 0, playing: true, queue: rest}, 'skip')
}

async function add(id) {
  const info = await lookup(id)
  if (!state) return
  const item = {qid: crypto.randomUUID(), id, title: info.title || '', duration: info.duration, by: profile.userId, name: profile.name}
  update({queue: [...state.queue, item].slice(0, QUEUE_MAX)})
}

function remove(qid) {
  if (state) update({queue: state.queue.filter(q => q.qid !== qid)})
}

function status() {
  const now = Date.now()
  return {
    roomId,
    tabId,
    state,
    peers: members.size,
    selfId,
    chat,
    members: [{...profile, self: true}, ...members.values()],
    typing: [...typing].filter(([, t]) => now - t < TYPING_FOR).map(([peerId]) => ({name: nameOf(peerId), userId: members.get(peerId)?.userId ?? ''}))
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.to !== 'offscreen') return false
  const fromTab = sender.tab?.id
  // Extension pages and the service worker; content scripts report the page's URL.
  const fromExtension = (sender.url ?? '').startsWith(`${location.origin}/`)
  switch (msg.type) {
    case 'join':
      join(msg.roomId, msg.tabId, msg.profile)
      reply(status())
      break
    case 'leave':
      leave()
      reply(true)
      break
    case 'status':
      reply(status())
      break
    case 'profile':
      if (fromExtension) {
        profile = {userId: str(msg.userId, 40), name: str(msg.name, 40)}
        actions?.hello.send(profile)
      }
      reply(true)
      break
    case 'say':
      if (room && fromExtension) say(String(msg.text).slice(0, 1000))
      reply(true)
      break
    case 'typing':
      if (room && fromExtension) actions.typing.send(1)
      reply(true)
      break
    case 'skip':
      if (room && fromExtension) skip()
      reply(true)
      break
    case 'add':
      if (room && fromExtension && validId(msg.id)) {
        add(msg.id).then(() => reply(true))
        return true
      }
      reply(false)
      break
    case 'remove':
      if (room && fromExtension) remove(msg.qid)
      reply(true)
      break
    case 'hello':
      reply({inRoom: room != null && fromTab === tabId, state})
      break
    case 'update':
      // From the room's tab, or from an extension page.
      if (room && (fromTab === tabId || fromExtension)) update(msg.patch, msg.reason)
      reply(true)
      break
    default:
      return false
  }
  return false
})
