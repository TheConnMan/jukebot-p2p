// Offscreen document: joins the Trystero room and keeps the shared room state.
//
// Room state is one small object every peer holds a copy of:
//   {v, pos, playing, queue: [{id, title}], rev, by}
// Any change bumps rev and is broadcast whole. A peer adopts an incoming copy
// when its rev is higher (ties go to the higher peer id), so all peers converge
// on the last change without anyone being the host. `at` is when this machine
// last set pos, on this machine's clock; it never goes over the wire, so clock
// skew between friends does not matter.

import {joinRoom, selfId} from './vendor/trystero.js'

const APP_ID = 'jukebot-p2p'

let room = null
let sendState = null
let roomId = null
let tabId = null
let state = null
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
  room.onPeerJoin = peerId => {
    peers.add(peerId)
    if (state) sendState(state, peerId)
    push()
  }
  room.onPeerLeave = peerId => {
    peers.delete(peerId)
    push()
  }
}

function leave() {
  room?.leave()
  room = sendState = roomId = tabId = state = null
  peers.clear()
}

function update(patch) {
  state = {queue: [], ...state, ...patch, rev: (state?.rev ?? 0) + 1, by: selfId, at: Date.now()}
  sendState(state)
  push()
}

const status = () => ({roomId, tabId, state, peers: peers.size, selfId})

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
