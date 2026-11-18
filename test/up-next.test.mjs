import test from 'node:test'
import assert from 'node:assert/strict'
import {SHORT_PX, collapsed, resized, toggled, labels} from '../up-next.js'

test('short panels collapse, tall ones do not', () => {
  assert.equal(resized({short: false, manual: null}, 745).short, true)
  assert.equal(collapsed(resized({short: false, manual: null}, 745)), true)
  assert.equal(collapsed(resized({short: true, manual: null}, SHORT_PX)), false)
})

test('a manual choice wins until the threshold is crossed', () => {
  let s = resized({short: false, manual: null}, 745)
  s = toggled(s)
  assert.equal(collapsed(s), false)
  assert.equal(resized(s, 700), s)
  assert.equal(collapsed(resized(s, 900)), false)
  s = toggled(resized(s, 900))
  assert.equal(collapsed(s), true)
  assert.equal(resized(s, 1000), s)
  assert.equal(resized(s, 600).manual, null)
  assert.equal(collapsed(resized(s, 600)), true)
})

test('labels', () => {
  const on = {short: true, manual: null}
  assert.deepEqual(labels(on, 6), {toggle: 'Show all (6)', more: '+5 more'})
  assert.deepEqual(labels(on, 1), {toggle: 'Expand', more: ''})
  assert.deepEqual(labels({short: false, manual: null}, 6), {toggle: 'Collapse', more: ''})
})
