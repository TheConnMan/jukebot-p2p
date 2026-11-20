import assert from 'node:assert/strict'
import test from 'node:test'
import {IDLE_CHOICES, IDLE_DEFAULT, hasCap, idleSeconds, isIdle, roomIdle} from '../idle.js'

test('idleSeconds keeps a known choice, including off, and defaults anything else', () => {
  for (const [seconds] of IDLE_CHOICES) assert.equal(idleSeconds(seconds), seconds)
  assert.equal(idleSeconds(0), 0)
  assert.equal(idleSeconds(undefined), IDLE_DEFAULT)
  assert.equal(idleSeconds(null), IDLE_DEFAULT)
  assert.equal(idleSeconds('7200'), IDLE_DEFAULT)
  assert.equal(idleSeconds(1234), IDLE_DEFAULT)
  assert.equal(idleSeconds(-1), IDLE_DEFAULT)
  assert.equal(IDLE_DEFAULT, 2 * 60 * 60)
})

test('every choice is within what chrome.idle accepts', () => {
  for (const [seconds] of IDLE_CHOICES) {
    if (seconds === 0) continue
    assert.ok(seconds >= 15 && seconds <= 4 * 60 * 60, `${seconds} seconds`)
  }
})

test('idle and locked count as idle, active does not', () => {
  assert.equal(isIdle('idle'), true)
  assert.equal(isIdle('locked'), true)
  assert.equal(isIdle('active'), false)
  assert.equal(isIdle(undefined), false)
})

test('hasCap reads the hello caps list and nothing else', () => {
  assert.equal(hasCap({caps: ['react', 'idle']}, 'idle'), true)
  assert.equal(hasCap({caps: ['react']}, 'idle'), false)
  assert.equal(hasCap({caps: 'idle'}, 'idle'), false)
  assert.equal(hasCap({}, 'idle'), false)
  assert.equal(hasCap(null, 'idle'), false)
})

test('the room is idle only when self and every peer are idle', () => {
  assert.equal(roomIdle(true, [], new Set()), true, 'alone and idle')
  assert.equal(roomIdle(false, [], new Set()), false, 'alone and active')
  assert.equal(roomIdle(true, ['a', 'b'], new Set(['a', 'b'])), true)
  assert.equal(roomIdle(true, ['a', 'b'], new Set(['a'])), false, 'one peer active')
  assert.equal(roomIdle(false, ['a'], new Set(['a'])), false, 'self active')
})

test('a peer that never reported idle, such as an older version, counts as active', () => {
  assert.equal(roomIdle(true, ['old'], new Set()), false)
  assert.equal(roomIdle(true, ['a', 'old'], new Set(['a'])), false)
})

test('a peer that left no longer holds the room active, and a stale idle entry is ignored', () => {
  assert.equal(roomIdle(true, ['a'], new Set(['a', 'gone'])), true)
  assert.equal(roomIdle(true, [], new Set(['gone'])), true)
})
