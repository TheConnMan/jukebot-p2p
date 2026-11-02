import {env, SELF, runInDurableObject} from 'cloudflare:test'
import {beforeEach, expect, test} from 'vitest'

const listing = {key: 'a'.repeat(32), lobby: 'b'.repeat(32), name: 'Friday focus', title: 'Low Tide Lights', count: 3}
const post = data => SELF.fetch('https://directory.test/rooms', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)})
const list = () => SELF.fetch('https://directory.test/rooms')
const object = () => env.DIRECTORY.get(env.DIRECTORY.idFromName('rooms'))

beforeEach(async () => {
  await runInDurableObject(object(), instance => instance.sql.exec('DELETE FROM rooms'))
})

test('create, safe list, heartbeat and secret-owned delete', async () => {
  expect((await post(listing)).status).toBe(201)
  const publicListing = {...listing}
  delete publicListing.key
  expect(await (await list()).json()).toEqual([publicListing])
  expect((await post({...listing, count: 12, title: 'Next song'})).status).toBe(200)
  expect((await (await list()).json())[0]).toEqual({...publicListing, count: 12, title: 'Next song'})
  expect((await post({...listing, key: 'wrong'.repeat(8)})).status).toBe(403)
  expect((await SELF.fetch('https://directory.test/rooms/' + 'wrong'.repeat(8), {method: 'DELETE'})).status).toBe(404)
  expect((await (await list()).json()).length).toBe(1)
  expect((await SELF.fetch('https://directory.test/rooms/' + listing.key, {method: 'DELETE'})).status).toBe(200)
  expect(await (await list()).json()).toEqual([])
})

test('heartbeats refresh expiry; listings expire at three minutes', async () => {
  await post(listing)
  await runInDurableObject(object(), instance => instance.sql.exec('UPDATE rooms SET seen = ?', Date.now() - 179000))
  expect((await (await list()).json()).length).toBe(1)
  await post(listing)
  await runInDurableObject(object(), instance => {
    expect(instance.sql.exec('SELECT seen FROM rooms').one().seen).toBeGreaterThan(Date.now() - 5000)
    instance.sql.exec('UPDATE rooms SET seen = ?', Date.now() - 180000)
  })
  expect(await (await list()).json()).toEqual([])
  expect((await post({...listing, key: 'c'.repeat(32)})).status).toBe(201)
})

test('reject malformed, oversized and out-of-range listings', async () => {
  for (const data of [null, {}, {...listing, key: 'short'}, {...listing, lobby: '../unsafe'}, {...listing, name: 'n'.repeat(81)}, {...listing, title: 't'.repeat(201)}, {...listing, name: 'bad\nname'}, {...listing, count: -1}, {...listing, count: 13}, {...listing, count: 1.5}, {...listing, count: '3'}]) {
    expect((await post(data)).status).toBe(400)
  }
  expect((await SELF.fetch('https://directory.test/rooms', {method: 'POST', body: '{'})).status).toBe(400)
  expect((await SELF.fetch('https://directory.test/rooms', {method: 'POST', body: 'x'.repeat(4097)})).status).toBe(413)
  expect((await post({...listing, count: 0, name: '', title: ''})).status).toBe(201)
  expect((await post({...listing, lobby: 'c'.repeat(32)})).status).toBe(409)
})

test('cap listings and reclaim expired space', async () => {
  for (let i = 0; i < 32; i++) {
    expect((await post({...listing, key: String(i).padStart(32, 'k'), lobby: String(i).padStart(32, 'l')})).status).toBe(201)
  }
  expect((await post(listing)).status).toBe(503)
  await runInDurableObject(object(), instance => instance.sql.exec('UPDATE rooms SET seen = 0'))
  expect((await post(listing)).status).toBe(201)
})

test('CORS works for extension fetches, preflight and errors', async () => {
  const preflight = await SELF.fetch('https://directory.test/rooms', {method: 'OPTIONS', headers: {Origin: 'chrome-extension://test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type'}})
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*')
  expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('DELETE')
  expect(preflight.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type')
  for (const response of [await list(), await post({}), await SELF.fetch('https://directory.test/missing'), await SELF.fetch('https://directory.test/rooms', {method: 'PUT'})]) {
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  }
})
