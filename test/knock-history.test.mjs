import assert from 'node:assert/strict'
import test from 'node:test'

globalThis.chrome = {runtime: {sendMessage: () => Promise.resolve()}}
const {PublicRooms} = await import('../public-rooms.js')
const {selfId} = await import('../vendor/trystero.js')

function setup(peers = []) {
  const lines = []
  const profile = {name: 'Me', userId: 'u1'}
  const rooms = new PublicRooms(() => ({roomId: 'r', state: {public: true}, profile, peers}), () => {}, () => {}, (text, actor, tag) => lines.push({text, actor, tag}), () => {})
  rooms.broadcast = () => {}
  rooms.replyAction = {send: () => Promise.resolve()}
  clearInterval(rooms.heartbeat)
  clearInterval(rooms.sweep)
  return {rooms, lines, profile}
}

const knock = (id, until) => ({id, peerId: 'p', name: 'Sam', until})
const ID = 'a'.repeat(24)

test('a declined knock leaves one line naming the decliner', () => {
  const {rooms, lines, profile} = setup()
  rooms.knocks.set(ID, knock(ID, Date.now() + 1000))
  rooms.decide({id: ID, accept: false}, profile)
  assert.deepEqual(lines.map(l => l.text), ['Me declined Sam'])
})

test('an admitted knock still leaves one line', () => {
  const {rooms, lines, profile} = setup()
  rooms.knocks.set(ID, knock(ID, Date.now() + 1000))
  rooms.decide({id: ID, accept: true}, profile)
  assert.deepEqual(lines.map(l => l.text), ['Me let Sam in'])
})

test('an unanswered knock leaves a missed line once, from the leader', () => {
  const {rooms, lines} = setup()
  rooms.knocks.set(ID, knock(ID, Date.now() - 1))
  rooms.expire()
  rooms.expire()
  assert.equal(lines.length, 1)
  assert.equal(lines[0].text, 'Missed knock: Sam wanted to join')
  assert.equal(lines[0].tag, 'missed')
  assert.equal(rooms.knocks.size, 0)
})

test('a member who is not the leader writes nothing', () => {
  const {rooms, lines} = setup(['0'])
  assert.notEqual(rooms.leader(), selfId)
  rooms.knocks.set(ID, knock(ID, Date.now() - 1))
  rooms.expire()
  assert.equal(lines.length, 0)
  assert.equal(rooms.knocks.size, 0)
})

test('a live knock is not missed', () => {
  const {rooms, lines} = setup()
  rooms.knocks.set(ID, knock(ID, Date.now() + 5000))
  rooms.expire()
  assert.equal(lines.length, 0)
})
