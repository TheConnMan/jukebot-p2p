// Offscreen document: joins the Trystero room and keeps the shared room state.
//
// Room state is one small object every peer holds a copy of:
//   {v, pos, playing, queue: [{id, title}], rev, by}
// Any change bumps rev and is broadcast whole. A peer adopts an incoming copy
// when its rev is higher (ties go to the higher peer id), so all peers converge
// on the last change without anyone being the host. `at` is when this machine
// last set pos, on this machine's clock; it never goes over the wire, so clock
// skew between friends does not matter.
//
// Chat is a list of {id, by, name, text, ts} messages. Each is sent once when said,
// and a peer that joins late gets the recent history from everyone already
// there; ids dedupe the copies.

import {joinRoom, selfId} from './vendor/trystero.js'

const APP_ID = 'jukebot-p2p'
const CHAT_KEEP = 200
const CHAT_HISTORY = 50

let room = null
let sendState = null
let roomId = null
let tabId = null
let state = null
let sendChat = null
let chat = []
const peers = new Set()

const position = s => s.pos + (s.playing ? (Date.now() - s.at) / 1000 : 0)
const newer = (a, b) => !b || a.rev > b.rev || (a.rev === b.rev && a.by > b.by)

function wire(s) {
  const {at, ...rest} = s
  return {...rest, pos: position(s)}
}

function push() {
  chrome.runtime.sendMessage({to: 'bg', type: 'push', tabId, state, peers: peers.size}).catch(() => {})
}

function join(id, tab) {
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
  const action = room.makeAction('state')
  sendState = (s, target) => action.send(wire(s), target ? {target} : undefined)
  action.onMessage = data => {
    if (!newer(data, state)) return
    state = {...data, at: Date.now()}
    push()
  }
  const chatAction = room.makeAction('chat')
  sendChat = (msgs, target) => chatAction.send(msgs, target ? {target} : undefined)
  chatAction.onMessage = addChat
  room.onPeerJoin = peerId => {
    peers.add(peerId)
    if (state) sendState(state, peerId)
    if (chat.length) sendChat(chat.slice(-CHAT_HISTORY), peerId)
    push()
  }
  room.onPeerLeave = peerId => {
    peers.delete(peerId)
    push()
  }
}

function leave() {
  room?.leave()
  room = sendState = sendChat = roomId = tabId = state = null
  chat = []
  peers.clear()
}

function update(patch) {
  state = {queue: [], ...state, ...patch, rev: (state?.rev ?? 0) + 1, by: selfId, at: Date.now()}
  sendState(state)
  push()
}

function addChat(msgs) {
  if (!Array.isArray(msgs)) return
  const seen = new Set(chat.map(m => m.id))
  for (const m of msgs) {
    if (typeof m?.id !== 'string' || typeof m.text !== 'string' || seen.has(m.id)) continue
    seen.add(m.id)
    chat.push({id: m.id, by: String(m.by ?? '').slice(0, 40), name: String(m.name ?? '').slice(0, 40), text: m.text.slice(0, 1000), ts: Number(m.ts) || Date.now()})
  }
  chat = chat.sort((a, b) => a.ts - b.ts).slice(-CHAT_KEEP)
  chrome.runtime.sendMessage({to: 'chat', type: 'chat'}).catch(() => {})
}

function say(by, name, text) {
  const m = {id: crypto.randomUUID(), by, name, text, ts: Date.now()}
  addChat([m])
  sendChat([m])
}

const status = () => ({roomId, tabId, state, peers: peers.size, selfId, chat})

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.to !== 'offscreen') return false
  const fromTab = sender.tab?.id
  switch (msg.type) {
    case 'join':
      join(msg.roomId, msg.tabId)
      reply(status())
      break
    case 'leave':
      leave()
      reply(true)
      break
    case 'status':
      reply(status())
      break
    case 'say':
      if (room && sender.origin === location.origin) say(String(msg.by).slice(0, 40), String(msg.name).slice(0, 40), String(msg.text).slice(0, 1000))
      reply(true)
      break
    case 'hello':
      reply({inRoom: room != null && fromTab === tabId, state})
      break
    case 'update':
      // From the room's tab, or from an extension page (the popup) for queue edits.
      if (room && (fromTab === tabId || sender.origin === location.origin)) update(msg.patch)
      reply(true)
      break
    default:
      return false
  }
  return false
})
