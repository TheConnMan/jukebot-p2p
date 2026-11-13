import assert from 'node:assert/strict'
import test from 'node:test'
import {anyWatching, applyFocus, applyWatch, delivery, dingFor, incomingParts, isWatching, noticesFor, soundOn, startedWatching} from '../notify.js'

const watching = {visible: true, focused: true, minimized: false, windowId: 1}
const hidden = {visible: false, focused: true, minimized: false, windowId: 1}
const away = {visible: true, focused: false, minimized: false, windowId: 1}
const minimized = {visible: true, focused: true, minimized: true, windowId: 1}

const chat = (text = 'hi') => ({id: 'c1', kind: undefined, text, name: 'bob'})
const song = () => ({id: 's1', kind: 'event', tag: 'play', text: 'bob started'})
const knock = () => ({id: 'k1', kind: 'event', tag: 'knock', text: 'Sam wants to join'})
const pause = () => ({id: 'p1', kind: 'event', tag: 'pause', text: 'bob paused'})

test('a panel is watched only when it is visible in the focused window', () => {
  assert.equal(isWatching(watching), true)
  assert.equal(isWatching(hidden), false)
  assert.equal(isWatching(away), false)
  assert.equal(isWatching(minimized), false)
  assert.equal(isWatching({visible: true, focused: true, minimized: false}), true)
  assert.equal(isWatching(null), false)
  assert.equal(isWatching({}), false)
})

test('any open panel that is watched suppresses, and a hidden one does not', () => {
  assert.equal(anyWatching([hidden, watching]), true)
  assert.equal(anyWatching([hidden, away, minimized]), false)
  assert.equal(anyWatching([]), false)
  assert.equal(startedWatching([hidden], [hidden, watching]), true)
  assert.equal(startedWatching([watching], [watching]), false)
  assert.equal(startedWatching([watching], [hidden]), false)
})

test('watch reports and window focus updates keep only real fields', () => {
  const next = applyWatch({visible: false, windowId: null, focused: false, minimized: false}, {
    visible: true, windowId: 7, focused: true, minimized: false, extra: true
  })
  assert.deepEqual(next, {visible: true, windowId: 7, focused: true, minimized: false})
  assert.equal(isWatching(next), true)
  const junk = applyWatch(next, {visible: 'yes', focused: 1, windowId: 1.5})
  assert.deepEqual(junk, next)
  assert.deepEqual(applyFocus(next, {id: 7, focused: false, state: 'normal'}), {...next, focused: false})
  assert.deepEqual(applyFocus(next, {id: 7, focused: true, state: 'minimized'}).minimized, true)
  assert.equal(applyFocus(next, {id: 9, focused: false, state: 'minimized'}), next)
  assert.equal(applyFocus(next, null), next)
})

test('notices follow the three switches and ignore other activity', () => {
  const parts = incomingParts([chat(), song(), knock(), pause(), {id: 'j', kind: 'event', tag: 'join', text: 'joined'}])
  assert.equal(parts.chats.length, 1)
  assert.equal(parts.songs.length, 1)
  assert.equal(parts.people.length, 2)
  assert.equal(noticesFor(parts, {}).length, 4)
  assert.deepEqual(noticesFor(parts, {notifyChat: false, notifySongs: false, notifyPeople: false}), [])
  assert.deepEqual(noticesFor(parts, {notifyPeople: false}).map(m => m.id), ['c1', 's1'])
  assert.equal(incomingParts(null).chats.length, 0)
})

test('a batch dings once for anything that is not a knock', () => {
  assert.equal(dingFor([chat(), chat(), song()]), true)
  assert.equal(dingFor([knock(), knock()]), false)
  assert.equal(dingFor([knock(), chat()]), true)
  assert.equal(dingFor([]), false)
  const many = delivery([chat('a'), chat('b'), chat('c'), chat('d'), chat('e')], {}, [])
  assert.equal(many.unread, 5)
  assert.equal(many.notices.length, 5)
  assert.equal(many.sound, 'ding')
})

test('watching suppresses chat, songs and people, and a hidden panel does not', () => {
  const messages = [chat(), song(), knock()]
  assert.deepEqual(delivery(messages, {}, [watching]), {unread: 0, notices: [], sound: null})
  const shown = delivery(messages, {}, [hidden])
  assert.equal(shown.unread, 1)
  assert.equal(shown.notices.length, 3)
  assert.equal(shown.sound, 'ding')
  const knocks = delivery([knock(), knock()], {}, [away])
  assert.equal(knocks.unread, 0)
  assert.equal(knocks.notices.length, 2)
  assert.equal(knocks.sound, null)
})

test('the knock sound switch is independent of the people switch and defaults on', () => {
  assert.equal(soundOn({}, 'knock'), true)
  assert.equal(soundOn({}, 'ding'), true)
  assert.equal(soundOn({soundKnock: false}, 'knock'), false)
  assert.equal(soundOn({soundDing: false, soundKnock: true}, 'ding'), false)
  assert.equal(soundOn({soundKnock: false}, 'ding'), true)
  assert.equal(soundOn({notifyPeople: false}, 'knock'), true)
  const quietPeople = delivery([knock()], {notifyPeople: false}, [])
  assert.equal(quietPeople.notices.length, 0)
  assert.equal(quietPeople.sound, null)
  assert.equal(soundOn({notifyPeople: false}, 'knock'), true)
})
