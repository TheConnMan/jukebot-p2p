// Drives the lobby knock handler with a fake Trystero room. Time is real.
// An ignored knock adds nothing: no chat line, no sound, no knocks notify.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../public-rooms.js', import.meta.url), 'utf8')
  .replace(
    `import {joinRoom, selfId} from './vendor/trystero.js'
import {directory} from './directory.js'
import {validId} from './youtube.js'`,
    'const {joinRoom, selfId, directory, validId} = globalThis.__deps'
  )
  .replace('export class PublicRooms', 'class PublicRooms')
  + '\nglobalThis.PublicRooms = PublicRooms\n'

const LOBBY = 'a'.repeat(24)
const id = n => `k${String(n).padStart(23, '0')}`

function room({leader = false} = {}) {
  const sent = []
  const lines = []
  let lobby = null
  const selfId = leader ? '0-self' : 'z-self'
  const context = {
    Map, Date, Promise, JSON, Math, Number, String, Object, Array, RegExp, Error, Symbol,
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    __deps: {
      selfId,
      directory: () => Promise.resolve(),
      validId: () => true,
      joinRoom() {
        const actions = {}
        lobby = {
          makeAction(name) {
            const action = {onMessage: null, send: () => Promise.resolve()}
            actions[name] = action
            return action
          },
          leave() {},
        }
        return lobby
      },
    },
    chrome: {
      runtime: {
        sendMessage(msg) {
          sent.push(structuredClone(msg))
          return Promise.resolve()
        },
      },
    },
  }
  vm.runInNewContext(source, context)
  const rooms = new context.PublicRooms(
    () => ({
      roomId: 'room',
      state: {public: true, lobby: LOBBY, key: 'b'.repeat(24), name: 'Friday'},
      peers: leader ? [] : ['0-peer'],
      profile: {name: 'Me', userId: 'u1'},
    }),
    () => {},
    () => {},
    (text, actor, tag) => lines.push({text, actor, tag}),
    async () => 'www.youtube.com'
  )
  rooms.broadcast = () => {}
  rooms.sync()
  const knock = (n, peerId, name = 'Sam') => rooms.knockAction.onMessage({id: id(n), name}, {peerId})
  return {rooms, sent, lines, knock, lobby}
}

const incoming = sent => sent.filter(msg => msg.type === 'incoming')
const sounds = sent => sent.filter(msg => msg.type === 'sound' && msg.name === 'knock')

test('a knock posts one chat line and plays the knock sound', () => {
  const {knock, sent, rooms} = room()
  knock(1, 'peer-a', 'Sam')
  assert.equal(rooms.knocks.size, 1)
  assert.deepEqual(incoming(sent).map(msg => msg.messages[0].text), ['Sam wants to join'])
  assert.equal(incoming(sent)[0].messages[0].tag, 'knock')
  assert.equal(incoming(sent)[0].messages[0].id, id(1))
  assert.equal(sounds(sent).length, 1)
  assert.equal(sent.filter(msg => msg.type === 'knocks').length, 1)
})

test('a second open knock from the same lobby peer is ignored', () => {
  const {knock, sent, rooms} = room()
  knock(1, 'peer-a', 'Sam')
  const before = sent.length
  knock(2, 'peer-a', 'Sam Again')
  assert.equal(sent.length, before)
  assert.equal(rooms.knocks.size, 1)
  assert.equal([...rooms.knocks.keys()][0], id(1))
  knock(3, 'peer-b', 'Robin')
  assert.equal(rooms.knocks.size, 2)
  assert.deepEqual(incoming(sent).map(msg => msg.messages[0].text), ['Sam wants to join', 'Robin wants to join'])
  assert.equal(sounds(sent).length, 2)
})

test('a sixth open knock is ignored', () => {
  const {knock, sent, rooms} = room()
  for (let n = 1; n <= 5; n++) knock(n, `peer-${n}`, `Person ${n}`)
  assert.equal(rooms.knocks.size, 5)
  assert.equal(incoming(sent).length, 5)
  assert.equal(sounds(sent).length, 5)
  const before = sent.length
  knock(6, 'peer-6', 'Extra')
  assert.equal(sent.length, before)
  assert.equal(rooms.knocks.size, 5)
  assert.equal(rooms.knocks.has(id(6)), false)
})

test('an expired knock does not keep its peer or its cap slot', () => {
  const {knock, sent, rooms, lines} = room({leader: true})
  for (let n = 1; n <= 5; n++) knock(n, `peer-${n}`, `Person ${n}`)
  rooms.knocks.get(id(1)).until = Date.now() - 1
  knock(6, 'peer-1', 'Sam')
  assert.equal(rooms.knocks.has(id(6)), true)
  assert.equal(incoming(sent).at(-1).messages[0].text, 'Sam wants to join')
  assert.equal(sounds(sent).length, 6)
  const before = sent.length
  knock(7, 'peer-7', 'Extra')
  assert.equal(sent.length, before)
  rooms.expire()
  assert.deepEqual(lines.map(line => line.text), ['Missed knock: Person 1 wanted to join'])
  assert.equal(rooms.knocks.has(id(1)), false)
  assert.equal(rooms.knocks.has(id(6)), true)
})
