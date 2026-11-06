import assert from 'node:assert/strict'
import test from 'node:test'
import {REMEMBER_FOR, REMEMBER_MAX, codeFor, prune, remember, roomAction} from '../remembered.js'

const lobby = id => id.padEnd(24, 'x')
const now = 1_700_000_000_000

test('remember stores a lobby and its room code, newest first', () => {
  const first = remember([], {lobby: lobby('a'), code: 'room-a'}, now)
  const both = remember(first, {lobby: lobby('b'), code: 'room-b'}, now + 1)
  assert.deepEqual(both.map(entry => entry.code), ['room-b', 'room-a'])
  assert.equal(codeFor(both, lobby('a'), now + 1), 'room-a')
  assert.equal(codeFor(both, lobby('missing'), now + 1), null)
})

test('a repeat lobby replaces the code and counts as newest', () => {
  const first = remember([], {lobby: lobby('a'), code: 'old-code'}, now)
  const next = remember(first, {lobby: lobby('a'), code: 'new-code'}, now + 5)
  assert.equal(next.length, 1)
  assert.equal(codeFor(next, lobby('a'), now + 5), 'new-code')
})

test('invalid lobby or code is not stored', () => {
  assert.deepEqual(remember([], {lobby: 'short', code: 'room-a'}, now), [])
  assert.deepEqual(remember([], {lobby: lobby('a'), code: 'bad code'}, now), [])
  assert.equal(codeFor([{lobby: 'nope', code: 'room-a', at: now}], 'nope', now), null)
})

test('entries older than 30 days drop, and only the newest 50 stay', () => {
  const stale = remember([], {lobby: lobby('old'), code: 'gone'}, now - REMEMBER_FOR - 1)
  assert.deepEqual(prune(stale, now), [])
  let list = []
  for (let i = 0; i < REMEMBER_MAX + 3; i++) list = remember(list, {lobby: lobby(String(i)), code: `c${i}`}, now + i)
  const at = now + REMEMBER_MAX + 3
  assert.equal(list.length, REMEMBER_MAX)
  assert.equal(codeFor(list, lobby('0'), at), null)
  assert.equal(codeFor(list, lobby(String(REMEMBER_MAX + 2)), at), `c${REMEMBER_MAX + 2}`)
})

test('Rejoin only when the lobby matches and the room is not full', () => {
  const list = remember([], {lobby: lobby('a'), code: 'room-a'}, now)
  assert.equal(roomAction(3, codeFor(list, lobby('a'), now)), 'Rejoin')
  assert.equal(roomAction(12, codeFor(list, lobby('a'), now)), 'Full')
  assert.equal(roomAction(3, codeFor(list, lobby('other'), now)), 'Knock')
  assert.equal(roomAction(0, null), 'Knock')
})
