import {joinRoom, selfId} from './vendor/trystero.js'
import {directory} from './directory.js'

const LIMIT = 12
const KNOCK_FOR = 2 * 60 * 1000
const code = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{24,80}$/.test(value)
const text = value => typeof value === 'string' ? value.slice(0, 40) : 'someone'
const notify = () => chrome.runtime.sendMessage({to: 'chat', type: 'knocks'}).catch(() => {})

function lobbyRoom(id) {
  return joinRoom({appId: 'jukebot-p2p', password: id, maxReceiveBytes: 4096}, id)
}

export class PublicRooms {
  constructor(current, answer, admitted, activity) {
    this.current = current
    this.sendAnswer = answer
    this.admitted = admitted
    this.activity = activity
    this.lobby = null
    this.listing = null
    this.knocks = new Map()
    this.settled = new Map()
    this.admissions = new Map()
    this.visitor = null
    this.requests = Promise.resolve()
    this.heartbeat = setInterval(() => this.publish(true), 60000)
    this.sweep = setInterval(() => {
      for (const [id, knock] of this.knocks) if (knock.until <= Date.now()) this.knocks.delete(id)
      for (const [id, until] of this.settled) if (until <= Date.now()) this.settled.delete(id)
      notify()
    }, 10000)
  }

  request(path, options) {
    this.requests = this.requests.then(() => directory(path, options)).catch(() => {})
    return this.requests
  }

  leader() {
    return [selfId, ...this.current().peers].sort()[0]
  }

  sync() {
    const {state} = this.current()
    if (!state?.public) {
      this.stop(true)
      return
    }
    if (this.listing?.lobby !== state.lobby) {
      this.stop(true)
      this.listing = {lobby: state.lobby, key: state.key}
      this.lobby = lobbyRoom(state.lobby)
      this.knockAction = this.lobby.makeAction('knock')
      this.replyAction = this.lobby.makeAction('reply')
      this.knockAction.onMessage = (data, {peerId}) => {
        if (!code(data?.id) || this.settled.has(data.id) || this.knocks.has(data.id)) return
        const knock = {id: data.id, peerId, name: text(data.name), until: Date.now() + KNOCK_FOR}
        this.knocks.set(knock.id, knock)
        notify()
        chrome.runtime.sendMessage({to: 'bg', type: 'incoming', messages: [{id: knock.id, text: `${knock.name} wants to join`, kind: 'event', tag: 'knock'}]}).catch(() => {})
      }
      this.lobby.onPeerLeave = peerId => {
        for (const [id, knock] of this.knocks) if (knock.peerId === peerId) this.knocks.delete(id)
        notify()
      }
    }
    this.publish()
  }

  publish(force = false) {
    const {state, peers} = this.current()
    if (!this.listing || !state?.public || this.leader() !== selfId) {
      this.sent = ''
      return
    }
    const data = {key: state.key, lobby: state.lobby, name: state.name || 'Unnamed room', title: state.title, count: Math.min(LIMIT, peers.length + 1)}
    const signature = JSON.stringify(data)
    if (!force && signature === this.sent) return
    this.sent = signature
    this.request('/rooms', {method: 'POST', body: signature})
  }

  stop(remove) {
    const listing = this.listing
    this.listing = null
    this.sent = ''
    this.lobby?.leave()
    this.lobby = null
    this.knocks.clear()
    this.settled.clear()
    this.admissions.clear()
    if (listing) {
      notify()
      if (remove) return this.request(`/rooms/${listing.key}`, {method: 'DELETE'})
    }
    return this.requests
  }

  full() {
    const peers = this.current().peers
    for (const [peerId, until] of this.admissions) if (peers.includes(peerId) || until <= Date.now()) this.admissions.delete(peerId)
    return peers.length + 1 + this.admissions.size >= LIMIT
  }

  answer(id, accept) {
    if (!this.current().state?.public || !this.knocks.has(id)) return false
    if (accept && this.full()) return false
    this.sendAnswer({id, accept: accept === true}, this.leader())
    return true
  }

  decide(data, actor) {
    if (this.leader() !== selfId || !this.current().state?.public) return
    const knock = this.knocks.get(data?.id)
    if (!knock || knock.until <= Date.now() || this.settled.has(knock.id)) return
    if (data.accept && this.full()) return
    const decision = {id: knock.id, accept: data.accept === true, name: knock.name, actor}
    this.resolve({...decision, peerId: knock.peerId})
    this.broadcast({...decision, peerId: knock.peerId})
    this.replyAction.send({id: knock.id, code: decision.accept ? this.current().roomId : null}, {target: knock.peerId}).catch(() => {})
    if (decision.accept) this.activity(`${actor.name} let ${knock.name} in`, actor)
  }

  resolve(data) {
    if (!code(data?.id)) return
    this.settled.set(data.id, Date.now() + KNOCK_FOR)
    if (data.accept) this.admissions.set(data.peerId, Date.now() + KNOCK_FOR)
    this.knocks.delete(data.id)
    notify()
  }

  cancel() {
    clearTimeout(this.visitorTimer)
    this.visitorRoom?.leave()
    this.visitorRoom = null
    this.visitor = null
    notify()
  }

  knock(listing, profile, tabId) {
    if (!code(listing?.lobby) || typeof listing.name !== 'string' || !Number.isInteger(listing.count) || listing.count < 0 || listing.count >= LIMIT) return false
    this.cancel()
    const id = crypto.randomUUID()
    this.visitor = {id, name: listing.name.slice(0, 80), count: listing.count, visitorName: profile.name, tabId, phase: 'waiting'}
    this.visitorRoom = lobbyRoom(listing.lobby)
    const knock = this.visitorRoom.makeAction('knock')
    const reply = this.visitorRoom.makeAction('reply')
    this.visitorRoom.onPeerJoin = peerId => knock.send({id, name: profile.name}, {target: peerId}).catch(() => {})
    reply.onMessage = data => {
      if (this.visitor?.id !== id || this.visitor.phase !== 'waiting' || data?.id !== id) return
      const valid = typeof data.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(data.code)
      this.finishKnock(valid ? 'joining' : 'failed')
      if (valid) this.admitted(data.code, tabId)
    }
    this.visitorTimer = setTimeout(() => this.finishKnock('failed'), KNOCK_FOR)
    notify()
    return true
  }

  finishKnock(phase) {
    clearTimeout(this.visitorTimer)
    this.visitorRoom?.leave()
    this.visitorRoom = null
    if (this.visitor) this.visitor.phase = phase
    notify()
  }
}
