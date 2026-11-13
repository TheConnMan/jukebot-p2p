// Notifications and sounds, with no video playing.
//
//   CHROME=/usr/bin/google-chrome npm run test:e2e:sounds
//
// Profiles A and B join one room. A's side panel stays open. While that
// document is hidden, a chat message notifies and dings. While it is visible
// in the focused window, the same chat does not. A knock asks for the knock
// sound even while the panel is watched, and it still does when the people
// switch is off. Unchecking ding or knock sound stops that sound. The room
// is still connected after the offscreen audio silence window.

import puppeteer from 'puppeteer-core'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

const EXT = resolve(import.meta.dirname, '..')
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome'

const dirs = []
const browsers = []

async function launch() {
  const dir = mkdtempSync(join(process.env.E2E_TMPDIR ?? tmpdir(), 'jukebot-sound-'))
  dirs.push(dir)
  const browser = await puppeteer.launch({executablePath: CHROME, headless: true, userDataDir: dir, enableExtensions: [EXT], args: ['--mute-audio']})
  browsers.push(browser)
  browser.on('targetcreated', async target => {
    if (!target.url().startsWith('chrome-extension://') || !target.url().endsWith('/offscreen.html')) return
    const page = await target.page()
    page?.on('pageerror', error => console.error('offscreen error:', error.message))
  })
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://') && t.url().endsWith('/background.js'))
  const pop = await browser.newPage()
  await pop.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`)
  return {browser, pop}
}

const bgCall = (pop, msg) => pop.evaluate(m => chrome.runtime.sendMessage({to: 'bg', ...m}), msg)
const offCall = (pop, msg) => pop.evaluate(m => chrome.runtime.sendMessage({to: 'offscreen', ...m}), msg)
const status = pop => bgCall(pop, {type: 'status'})
const badgeOf = pop => pop.evaluate(() => chrome.action.getBadgeText({}))
const notesOf = pop => pop.evaluate(() => chrome.notifications.getAll())
const soundsOf = pop => pop.evaluate(() => chrome.storage.session.get('soundLog').then(s => s.soundLog ?? []))
const watchOf = pop => pop.evaluate(() => chrome.storage.session.get('watch').then(s => s.watch ?? null))

async function until(label, fn, timeout = 45000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      last = await fn()
      if (last?.ok) {
        console.log(`ok   ${label}`, JSON.stringify(last.info ?? ''))
        return last
      }
    } catch (err) {
      last = {err: String(err)}
    }
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`FAIL ${label}: ${JSON.stringify(last)}`)
}

function swTarget(browser) {
  const target = browser.targets().find(t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://') && t.url().endsWith('/background.js'))
  if (!target) throw new Error('extension service worker not found')
  return target
}

async function swEval(browser, fn) {
  const worker = await swTarget(browser).worker()
  if (!worker) throw new Error('extension service worker has no worker target')
  return worker.evaluate(fn)
}

const swSounds = browser => swEval(browser, () => globalThis.soundLog ?? [])

const played = (log, name) => log.filter(entry => entry.name === name && entry.played)
const clearNotes = pop => pop.evaluate(async () => {
  const all = await chrome.notifications.getAll()
  await Promise.all(Object.keys(all).map(id => chrome.notifications.clear(id)))
})

// The content script is the only sender allowed to seed room state. Run in its
// isolated world so the test does not need the YouTube player to start.
async function seedVideo(page, roomId) {
  const session = await page.createCDPSession()
  const contexts = []
  session.on('Runtime.executionContextCreated', ({context}) => {
    if (context.auxData?.type === 'isolated') contexts.push(context)
  })
  await session.send('Runtime.enable')
  const end = Date.now() + 10000
  let contextId = null
  while (!contextId && Date.now() < end) {
    for (const context of contexts) {
      const probe = await session.send('Runtime.evaluate', {contextId: context.id, expression: 'typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id', returnByValue: true}).catch(() => null)
      if (probe?.result?.value) contextId = context.id
    }
    if (!contextId) await new Promise(r => setTimeout(r, 200))
  }
  if (!contextId) throw new Error(`content script did not load (${contexts.length} isolated worlds)`)
  const expression = `chrome.runtime.sendMessage({to: 'offscreen', type: 'update', roomId: ${JSON.stringify(roomId)}, patch: {v: 'jNQXAC9IVRw', title: 'zoo', pos: 0, playing: false, queue: []}, reason: 'start'})`
  const res = await session.send('Runtime.evaluate', {expression, contextId, awaitPromise: true, returnByValue: true})
  await session.detach().catch(() => {})
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails))
  return res.result.value
}

async function setChecked(panel, id, checked) {
  await panel.evaluate((box, on) => {
    const el = document.getElementById(box)
    el.checked = on
    el.dispatchEvent(new Event('change'))
  }, id, checked)
}

async function main() {
  const A = await launch()
  const B = await launch()
  await bgCall(A.pop, {type: 'setName', name: 'alice'})
  await bgCall(B.pop, {type: 'setName', name: 'bob'})
  await A.pop.evaluate(() => chrome.storage.local.set({directoryUrl: 'http://127.0.0.1:9'}))
  await B.pop.evaluate(() => chrome.storage.local.set({directoryUrl: 'http://127.0.0.1:9'}))
  const roomId = `e2esound${Math.random().toString(16).slice(2)}`
  for (const who of [A, B]) {
    const tabId = await who.pop.evaluate(async () => (await chrome.tabs.getCurrent()).id)
    await bgCall(who.pop, {type: 'join', roomId, tabId})
  }
  await until('A and B connect', async () => {
    const [a, b] = await Promise.all([status(A.pop), status(B.pop)])
    return {ok: a?.peers === 1 && b?.peers === 1, info: [a?.peers, b?.peers]}
  })

  const panel = await A.browser.newPage()
  await panel.setViewport({width: 320, height: 640})
  await panel.goto(A.pop.url().replace('popup.html', 'sidepanel.html'))
  await until('sound checkboxes default on', () => panel.evaluate(() => {
    const knock = document.querySelector('#sound-knock')
    const ding = document.querySelector('#sound-ding')
    return {ok: knock?.checked === true && ding?.checked === true, info: {knock: knock?.checked, ding: ding?.checked}}
  }))
  await until('open visible panel is watched', async () => {
    const [watch, page] = await Promise.all([
      watchOf(A.pop),
      panel.evaluate(() => ({hidden: document.hidden, vis: document.visibilityState}))
    ])
    return {ok: watch?.open >= 1 && watch.watching === true && page.vis === 'visible', info: {watch, page}}
  })

  const cover = await A.browser.newPage()
  await cover.goto('about:blank')
  await until('open panel is hidden and not watched', async () => {
    const [watch, page] = await Promise.all([
      watchOf(A.pop),
      panel.evaluate(() => document.visibilityState)
    ])
    return {ok: page === 'hidden' && watch?.open >= 1 && watch.watching === false, info: {watch, page}}
  })

  await clearNotes(A.pop)
  const soundsBefore = await soundsOf(A.pop)
  await offCall(B.pop, {type: 'say', text: 'hidden panel ping'})
  await until('hidden panel gets a notification, unread badge and one ding', async () => {
    const [shown, badge, log, chat] = await Promise.all([notesOf(A.pop), badgeOf(A.pop), soundsOf(A.pop), status(A.pop)])
    const msg = chat?.chat?.find(m => m.text === 'hidden panel ping')
    const ding = played(log, 'ding')
    const swShown = await swEval(A.browser, () => chrome.notifications.getAll())
    return {
      ok: !!msg && `m-${msg.id}` in shown && `m-${msg.id}` in swShown && badge === '1' && ding.length === played(soundsBefore, 'ding').length + 1 && ding.at(-1).state === 'running' && !ding.at(-1).error,
      info: {badge, shown, swShown, ding: ding.at(-1), id: msg?.id}
    }
  })
  const workerLog = await swSounds(A.browser)
  const storedLog = await soundsOf(A.pop)
  const sameSound = (a, b) => a?.name === b?.name && a?.played === b?.played && a?.state === b?.state && a?.error === b?.error && a?.reason === b?.reason
  if (workerLog.length !== storedLog.length || workerLog.some((entry, i) => !sameSound(entry, storedLog[i]))) {
    throw new Error(`FAIL service worker sound log diverged: ${JSON.stringify({workerLog, storedLog})}`)
  }
  console.log('ok   service worker sound log matches', JSON.stringify(workerLog.at(-1)))

  await panel.bringToFront()
  await until('looking at the panel clears unread', async () => {
    const [watch, badge, page] = await Promise.all([
      watchOf(A.pop),
      badgeOf(A.pop),
      panel.evaluate(() => document.visibilityState)
    ])
    return {ok: page === 'visible' && watch?.watching === true && badge === '2', info: {watch, badge, page}}
  })

  await clearNotes(A.pop)
  const whileWatching = await soundsOf(A.pop)
  await offCall(B.pop, {type: 'say', text: 'while you look'})
  await until('watched panel receives the chat', async () => {
    const chat = await status(A.pop)
    return {ok: chat?.chat?.some(m => m.text === 'while you look'), info: chat?.chat?.map(m => m.text)}
  })
  await new Promise(r => setTimeout(r, 1500))
  const [shownWatching, badgeWatching, logWatching, chatWatching] = await Promise.all([notesOf(A.pop), badgeOf(A.pop), soundsOf(A.pop), status(A.pop)])
  const looked = chatWatching?.chat?.find(m => m.text === 'while you look')
  if ((looked && `m-${looked.id}` in shownWatching) || badgeWatching !== '2' || played(logWatching, 'ding').length !== played(whileWatching, 'ding').length) {
    throw new Error(`FAIL watched panel still notified: ${JSON.stringify({shownWatching, badgeWatching, id: looked?.id})}`)
  }
  console.log('ok   watched panel does not notify or ding')

  const yt = await A.browser.newPage()
  await yt.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', {waitUntil: 'domcontentloaded', timeout: 30000})
  await yt.bringToFront()
  const tabId = await A.pop.evaluate(async () => (await chrome.tabs.query({active: true, currentWindow: true}))[0].id)
  await bgCall(A.pop, {type: 'join', roomId, tabId})
  await seedVideo(yt, roomId)
  await until('room has a video so it can be listed', async () => {
    const s = await status(A.pop)
    return {ok: s?.state?.v === 'jNQXAC9IVRw', info: s?.state?.v}
  })
  if (!(await offCall(A.pop, {type: 'public', public: true}))) throw new Error('FAIL could not list the room')
  await until('lobby is up', async () => {
    const s = await status(A.pop)
    return {ok: s?.state?.public && typeof s.state.lobby === 'string', info: s?.state?.lobby}
  })
  const lobby = (await status(A.pop)).state.lobby
  await B.pop.evaluate(async lobbyId => {
    const {joinRoom} = await import('./vendor/trystero.js')
    const room = joinRoom({appId: 'jukebot-p2p', password: lobbyId, maxReceiveBytes: 4096}, lobbyId)
    const knock = room.makeAction('knock')
    const peers = () => Object.keys(room.getPeers?.() ?? {})
    window.knocker = {
      peers,
      send(name) {
        const next = crypto.randomUUID()
        const list = peers()
        for (const peerId of list) knock.send({id: next, name}, {target: peerId}).catch(() => {})
        return {id: next, peers: list.length}
      }
    }
  }, lobby)

  await until('knocker can see a lobby member', () => B.pop.evaluate(() => ({ok: window.knocker.peers().length > 0, info: window.knocker.peers()})))
  await panel.bringToFront()
  await until('panel is watched before the knock', async () => {
    const watch = await watchOf(A.pop)
    return {ok: watch?.open >= 1 && watch.watching === true, info: watch}
  })
  await clearNotes(A.pop)
  const beforeKnock = await soundsOf(A.pop)
  const first = await B.pop.evaluate(() => window.knocker.send('Sam Typed'))
  if (!first.peers) throw new Error(`FAIL first knock had no peers: ${JSON.stringify(first)}`)
  await until('knock sound plays while the panel is watched, with no ding and no notification', async () => {
    const [log, shown, knocks] = await Promise.all([soundsOf(A.pop), notesOf(A.pop), status(A.pop)])
    const knock = played(log, 'knock')
    const ding = played(log, 'ding')
    const note = (knocks?.knocks ?? []).some(item => `m-${item.id}` in shown)
    return {
      ok: (knocks?.knocks?.length ?? 0) >= 1 && knock.length === played(beforeKnock, 'knock').length + 1 && knock.at(-1).state === 'running' && !knock.at(-1).error && ding.length === played(beforeKnock, 'ding').length && !note,
      info: {knocks: knocks?.knocks, knock: knock.at(-1), shown}
    }
  })

  await cover.bringToFront()
  await until('panel hidden again', async () => {
    const watch = await watchOf(A.pop)
    return {ok: watch?.open >= 1 && watch.watching === false, info: watch}
  })
  await setChecked(panel, 'notify-people', false)
  await until('people switch stored off', async () => {
    const stored = await A.pop.evaluate(() => chrome.storage.local.get('notifyPeople'))
    return {ok: stored.notifyPeople === false, info: stored}
  })
  await clearNotes(A.pop)
  const beforeSecond = await soundsOf(A.pop)
  const second = await B.pop.evaluate(() => window.knocker.send('Sam Again'))
  if (!second.peers) throw new Error(`FAIL second knock had no peers: ${JSON.stringify(second)}`)
  await until('knock sound still plays when people notifications are off', async () => {
    const [log, shown] = await Promise.all([soundsOf(A.pop), notesOf(A.pop)])
    const knock = played(log, 'knock')
    const s = await status(A.pop)
    const note = (s?.knocks ?? []).some(item => `m-${item.id}` in shown)
    return {ok: knock.length === played(beforeSecond, 'knock').length + 1 && !note, info: {knock: knock.at(-1), knocks: s?.knocks, shown}}
  })

  await setChecked(panel, 'sound-knock', false)
  await until('knock sound switch stored off', async () => {
    const stored = await A.pop.evaluate(() => chrome.storage.local.get('soundKnock'))
    return {ok: stored.soundKnock === false, info: stored}
  })
  const beforeQuietKnock = await soundsOf(A.pop)
  const third = await B.pop.evaluate(() => window.knocker.send('Sam Silent'))
  if (!third.peers) throw new Error(`FAIL quiet knock had no peers: ${JSON.stringify(third)}`)
  await until('unchecked knock sound does not play', async () => {
    const log = await soundsOf(A.pop)
    const added = log.slice(beforeQuietKnock.length)
    return {ok: added.some(entry => entry.name === 'knock' && entry.played === false && entry.reason === 'off') && played(added, 'knock').length === 0, info: added}
  })

  await setChecked(panel, 'sound-ding', false)
  await until('ding switch stored off', async () => {
    const stored = await A.pop.evaluate(() => chrome.storage.local.get('soundDing'))
    return {ok: stored.soundDing === false, info: stored}
  })
  await clearNotes(A.pop)
  const beforeQuietDing = await soundsOf(A.pop)
  await offCall(B.pop, {type: 'say', text: 'no ding please'})
  await until('unchecked ding still notifies and does not play', async () => {
    const [shown, log, badge] = await Promise.all([notesOf(A.pop), soundsOf(A.pop), badgeOf(A.pop)])
    const s = await status(A.pop)
    const msg = s?.chat?.find(m => m.text === 'no ding please')
    const added = log.slice(beforeQuietDing.length)
    return {ok: !!msg && `m-${msg.id}` in shown && badge === '1' && added.some(entry => entry.name === 'ding' && entry.played === false && entry.reason === 'off') && played(added, 'ding').length === 0, info: {badge, added, id: msg?.id, shown}}
  })

  await new Promise(r => setTimeout(r, 32000))
  await until('room still connected after the audio silence window', async () => {
    const [a, b] = await Promise.all([status(A.pop), status(B.pop)])
    return {ok: a?.roomId === roomId && b?.roomId === roomId && a.peers === 1 && b.peers === 1, info: {a: a?.peers, b: b?.peers}}
  })
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
}).finally(async () => {
  for (const browser of browsers) await browser.close().catch(() => {})
  for (const dir of dirs) rmSync(dir, {recursive: true, force: true})
})
