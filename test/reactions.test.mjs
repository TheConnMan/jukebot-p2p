import assert from 'node:assert/strict'
import test from 'node:test'
import {BATCH, EMOJI, EMOJI_PER_MESSAGE, GRID, PENDING_MESSAGES, QUICK, RECORDS_PER_MESSAGE, cleanRecord, merge, prune, snapshot, summarize, toggle} from '../reactions.js'

const alice = {userId: 'user-alice', name: 'alice'}
const bob = {userId: 'user-bob', name: 'bob'}
const rec = (over = {}) => ({id: 'm1', e: '👍', u: 'user-alice', name: 'alice', on: true, n: 10, ...over})
const view = store => summarize(store, [...store.keys()])

// Every order of a list, to check the merge does not depend on arrival order.
function* orders(list) {
  if (list.length <= 1) return yield list
  for (let i = 0; i < list.length; i++) for (const rest of orders([...list.slice(0, i), ...list.slice(i + 1)])) yield [list[i], ...rest]
}

test('the curated set has a quick row of six and a grid of about forty, with no repeats', () => {
  assert.equal(QUICK.length, 6)
  assert.ok(GRID.length >= 36 && GRID.length <= 48)
  assert.equal(new Set(EMOJI).size, EMOJI.length)
})

test('cleanRecord accepts only curated emoji and well formed fields', () => {
  assert.deepEqual(cleanRecord(rec()), rec())
  assert.equal(cleanRecord(rec({e: '🦄'})), null, 'emoji outside the curated set')
  assert.equal(cleanRecord(rec({e: '👍👍'})), null)
  assert.equal(cleanRecord(rec({e: '<img src=x>'})), null)
  assert.equal(cleanRecord(rec({id: ''})), null)
  assert.equal(cleanRecord(rec({id: 'x'.repeat(41)})), null)
  assert.equal(cleanRecord(rec({u: 42})), null)
  assert.equal(cleanRecord(rec({on: 'yes'})), null)
  assert.equal(cleanRecord(rec({n: -1})), null)
  assert.equal(cleanRecord(rec({n: 1.5})), null)
  assert.equal(cleanRecord(rec({n: 2 ** 60})), null)
  assert.equal(cleanRecord(null), null)
  assert.equal(cleanRecord(rec({name: 'n'.repeat(80)})).name.length, 40)
  assert.deepEqual(Object.keys(cleanRecord({...rec(), self: true, extra: 'x'})).sort(), ['e', 'id', 'n', 'name', 'on', 'u'])
})

test('peers converge whatever the order and however often records arrive', () => {
  const records = [
    rec({n: 1}),
    rec({n: 2, on: false}),
    rec({n: 3}),
    rec({u: 'user-bob', name: 'bob', n: 5}),
    rec({u: 'user-bob', name: 'bob', n: 5, on: false}), // same version, off wins
    rec({e: '🔥', n: 4})
  ]
  let expected = null
  for (const order of orders(records)) {
    const store = new Map()
    merge(store, order)
    merge(store, [...order].reverse()) // duplicates change nothing
    const got = JSON.stringify(view(store))
    expected ??= got
    assert.equal(got, expected)
  }
  assert.deepEqual(JSON.parse(expected), {m1: [{e: '👍', users: [{u: 'user-alice', name: 'alice'}]}, {e: '🔥', users: [{u: 'user-alice', name: 'alice'}]}]})
})

test('a duplicate record reports no change', () => {
  const store = new Map()
  assert.equal(merge(store, [rec()]), 1)
  assert.equal(merge(store, [rec()]), 0)
  assert.equal(merge(store, [rec({n: 9, on: false})]), 0, 'older record loses')
})

test('a live change only counts for the sender’s own userId', () => {
  const store = new Map()
  assert.equal(merge(store, [rec({u: 'user-bob'}), rec()], 'user-alice'), 1)
  assert.deepEqual(view(store).m1[0].users.map(u => u.u), ['user-alice'])
  assert.equal(merge(store, [rec({n: 11, on: false})], 'user-bob'), 0, 'bob cannot remove alice’s reaction')
  assert.equal(view(store).m1.length, 1)
})

test('toggle adds, removes and adds again, beating any version it has seen', () => {
  const store = new Map()
  const on = toggle(store, 'm1', '😂', alice, 1000)
  assert.deepEqual(on, {id: 'm1', e: '😂', u: 'user-alice', name: 'alice', on: true, n: 1000})
  const off = toggle(store, 'm1', '😂', alice, 1000)
  assert.equal(off.on, false)
  assert.equal(off.n, 1001, 'a slow clock still moves the version forward')
  assert.deepEqual(view(store), {})
  merge(store, [rec({e: '😂', n: 5000})]) // a copy from another device with a fast clock
  const again = toggle(store, 'm1', '😂', alice, 2000)
  assert.equal(again.on, false)
  assert.equal(again.n, 5001)
  // A peer that only ever saw the first "on" ends up where this one is.
  const other = new Map()
  merge(other, [again, on])
  assert.deepEqual(view(other), view(store))
})

test('toggle refuses emoji outside the set and a missing userId', () => {
  const store = new Map()
  assert.equal(toggle(store, 'm1', '🦄', alice), null)
  assert.equal(toggle(store, 'm1', '👍', {userId: '', name: 'x'}), null)
  assert.equal(store.size, 0)
})

test('a message keeps at most the capped number of emoji and records', () => {
  const store = new Map()
  merge(store, EMOJI.map((e, i) => rec({e, n: i + 1})))
  assert.equal(view(store).m1.length, EMOJI_PER_MESSAGE)
  // A known emoji still takes new people up to the record cap.
  for (let i = 0; i < RECORDS_PER_MESSAGE * 2; i += BATCH) {
    merge(store, Array.from({length: BATCH}, (_, j) => rec({u: `user-${i + j}`, n: 1})))
  }
  assert.equal(store.get('m1').size, RECORDS_PER_MESSAGE)
  // Existing records can still change at the cap.
  assert.equal(merge(store, [rec({e: EMOJI[0], n: 99, on: false})]), 1)
})

test('one wire message is read up to BATCH records', () => {
  const store = new Map()
  const list = Array.from({length: BATCH + 50}, (_, i) => rec({id: `m${i % 60}`, u: `user-${i}`}))
  assert.equal(merge(store, list), BATCH)
  assert.equal(merge(store, 'not a list'), 0)
})

test('snapshot sends every record, tombstones included, in batches', () => {
  const store = new Map()
  for (let i = 0; i < 3; i++) merge(store, Array.from({length: 100}, (_, j) => rec({id: `m${i}`, u: `user-${j}`, on: j % 2 === 0})))
  const batches = snapshot(store, ['m0', 'm1', 'm2', 'missing'])
  assert.deepEqual(batches.map(b => b.length), [BATCH, 100])
  const copy = new Map()
  for (const b of batches) merge(copy, b)
  assert.deepEqual(view(copy), view(store))
  assert.equal(snapshot(store, ['m1']).flat().filter(r => !r.on).length, 50)
})

test('prune drops reactions on activity lines and old messages, and bounds unseen ids', () => {
  const store = new Map()
  merge(store, [rec({id: 'chat'}), rec({id: 'event'})])
  for (let i = 0; i < PENDING_MESSAGES + 5; i++) merge(store, [rec({id: `later-${i}`})])
  prune(store, [{id: 'chat'}, {id: 'event', kind: 'event'}])
  assert.ok(store.has('chat'))
  assert.ok(!store.has('event'))
  assert.equal(store.size, 1 + PENDING_MESSAGES)
  assert.ok(!store.has('later-0'), 'oldest unseen id goes first')
  assert.ok(store.has(`later-${PENDING_MESSAGES + 4}`))
})

test('summarize orders emoji by first reaction, people oldest first, and prefers current names', () => {
  const store = new Map()
  merge(store, [
    rec({e: '🔥', u: 'user-bob', name: 'bob', n: 3}),
    rec({e: '👍', u: 'user-bob', name: 'bob', n: 1}),
    rec({e: '👍', n: 2}),
    rec({e: '😢', n: 4, on: false})
  ])
  const names = {'user-alice': 'Alice Renamed'}
  assert.deepEqual(summarize(store, ['m1', 'other'], u => names[u]), {
    m1: [
      {e: '👍', users: [{u: 'user-bob', name: 'bob'}, {u: 'user-alice', name: 'Alice Renamed'}]},
      {e: '🔥', users: [{u: 'user-bob', name: 'bob'}]}
    ]
  })
})

test('a record with an empty name shows as someone', () => {
  const store = new Map()
  toggle(store, 'm1', '👍', {userId: bob.userId, name: ''}, 1)
  assert.equal(summarize(store, ['m1']).m1[0].users[0].name, 'someone')
})
