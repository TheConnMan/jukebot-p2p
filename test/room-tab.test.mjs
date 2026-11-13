import assert from 'node:assert/strict'
import test from 'node:test'
import {panelOptions, roomHost, roomNavigation, watchUrl} from '../room-tab.js'

const WATCH = 'https://www.youtube.com/watch?v=abcdefghijk'
const MUSIC = 'https://music.youtube.com/watch?v=abcdefghijk'

test('only youtube.com and music.youtube.com count as the room site', () => {
  assert.equal(roomHost(WATCH), 'www.youtube.com')
  assert.equal(roomHost('https://music.youtube.com/'), 'music.youtube.com')
  assert.equal(roomHost('https://m.youtube.com/watch?v=abcdefghijk'), null)
  assert.equal(roomHost('https://youtu.be/abcdefghijk'), null)
  assert.equal(roomHost('https://example.com/'), null)
  assert.equal(roomHost('not a url'), null)
  assert.equal(roomHost(undefined), null)
})

test('a code from another site opens music.youtube.com in a new tab', () => {
  const nav = roomNavigation({tabUrl: 'https://example.com/article', text: 'friday-jams'})
  assert.deepEqual(nav, {url: 'https://music.youtube.com/#jukebot=friday-jams', reuse: false})
})

test('a code from a YouTube tab reuses that tab', () => {
  const nav = roomNavigation({tabUrl: WATCH, text: 'friday-jams'})
  assert.equal(nav.reuse, true)
  assert.equal(nav.url, `${WATCH}#jukebot=friday-jams`)
  const music = roomNavigation({tabUrl: MUSIC, text: 'friday-jams', rejoin: true})
  assert.equal(music.reuse, true)
  assert.equal(music.url, `${MUSIC}#jukebot=friday-jams&rejoin=1`)
})

test('a code from the YouTube home page still reuses that tab', () => {
  const nav = roomNavigation({tabUrl: 'https://www.youtube.com/feed/library', text: 'room'})
  assert.equal(nav.reuse, true)
  assert.equal(nav.url, 'https://www.youtube.com/feed/library#jukebot=room')
})

test('mobile and youtu.be links are not reused', () => {
  const mobile = roomNavigation({tabUrl: 'https://m.youtube.com/watch?v=abcdefghijk', text: 'room'})
  assert.equal(mobile.reuse, false)
  assert.equal(mobile.url, 'https://music.youtube.com/#jukebot=room')
  const short = roomNavigation({tabUrl: 'https://youtu.be/abcdefghijk', text: 'room'})
  assert.equal(short.reuse, false)
})

test('an invite link is opened as given, and only a YouTube tab is reused', () => {
  const link = 'https://www.youtube.com/#jukebot=friday-jams'
  assert.deepEqual(roomNavigation({tabUrl: 'https://example.com/', text: link}), {url: link, reuse: false})
  assert.deepEqual(roomNavigation({tabUrl: MUSIC, text: link}), {url: link, reuse: true})
  assert.deepEqual(roomNavigation({tabUrl: WATCH, text: 'https://evil.example/#jukebot=friday-jams'}), {error: 'That is not a JukeBot invite link.'})
  assert.equal(roomNavigation({tabUrl: WATCH, text: 'https://www.youtube.com/watch?v=abcdefghijk'}).error, 'That is not a JukeBot invite link.')
})

test('admission watch urls stay on the room site', () => {
  assert.equal(watchUrl('www.youtube.com', 'abcdefghijk', 12.8), 'https://www.youtube.com/watch?v=abcdefghijk&t=12s')
  assert.equal(watchUrl('music.youtube.com', 'abcdefghijk', 0), 'https://music.youtube.com/watch?v=abcdefghijk&t=0s')
  assert.equal(watchUrl('m.youtube.com', 'abcdefghijk', 1), null)
  assert.equal(watchUrl('www.youtube.com', 'abcdefghijk', 'nope'), null)
})

test('the side panel default is on when no room is joined', () => {
  const none = panelOptions()
  assert.deepEqual(none.set, [{path: 'sidepanel.html', enabled: true}])
  assert.deepEqual(none.pinned, [])
  const again = panelOptions({pinned: [4, 9]})
  assert.deepEqual(again.set, [
    {path: 'sidepanel.html', enabled: true},
    {tabId: 4, path: 'sidepanel.html', enabled: true},
    {tabId: 9, path: 'sidepanel.html', enabled: true}
  ])
  assert.deepEqual(again.pinned, [4, 9])
})

test('a room enables the panel only on its tab and remembers that tab', () => {
  const first = panelOptions({roomTabId: 7})
  assert.deepEqual(first.set, [
    {enabled: false},
    {tabId: 7, path: 'sidepanel.html', enabled: true}
  ])
  assert.deepEqual(first.pinned, [7])
  const moved = panelOptions({roomTabId: 8, pinned: first.pinned})
  assert.deepEqual(moved.set, [
    {enabled: false},
    {tabId: 8, path: 'sidepanel.html', enabled: true},
    {tabId: 7, enabled: false}
  ])
  assert.deepEqual(moved.pinned, [7, 8])
  const same = panelOptions({roomTabId: 8, pinned: moved.pinned})
  assert.deepEqual(same.pinned, [7, 8])
  assert.equal(same.set.some(options => options.tabId === 8 && options.enabled === false), false)
})

test('panel planning does not change the caller list', () => {
  const pinned = [3]
  panelOptions({roomTabId: 4, pinned})
  assert.deepEqual(pinned, [3])
})
