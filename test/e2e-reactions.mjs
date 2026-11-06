// Chat reactions end to end, with no video playing, so it runs where YouTube
// will not play in headless Chrome. Signaling goes over the public Nostr
// relays, as it does for real users.
//
//   CHROME=/usr/bin/google-chrome npm run test:e2e:reactions
//
// Profiles A and B join one room, chat, react to each other's messages and
// remove a reaction; a forged reaction for someone else is dropped; reactions
// add no unread count or notification; profile C joins later and gets the
// reactions with the history. With E2E_OLD_EXT set to an unpacked older build
// (for example the v0.5.3 tag), profile O runs it in the same room and must
// keep chatting normally while the others react. E2E_ARTIFACTS saves side
// panel screenshots with reactions and with the picker open.

import puppeteer from 'puppeteer-core'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

const EXT = resolve(import.meta.dirname, '..')
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome'
const OLD = process.env.E2E_OLD_EXT
const ARTIFACTS = process.env.E2E_ARTIFACTS

const dirs = []
const browsers = []

async function launch(ext = EXT) {
  const dir = mkdtempSync(join(process.env.E2E_TMPDIR ?? tmpdir(), 'jukebot-react-'))
  dirs.push(dir)
  const browser = await puppeteer.launch({executablePath: CHROME, headless: true, userDataDir: dir, enableExtensions: [ext], args: ['--mute-audio']})
  browsers.push(browser)
  browser.on('targetcreated', async target => {
    if (!target.url().endsWith('/offscreen.html')) return
    const page = await target.page()
    page?.on('pageerror', error => console.error('offscreen error:', error.message))
  })
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('/background.js'))
  const pop = await browser.newPage()
  await pop.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`)
  return {browser, pop}
}

const bgCall = (pop, msg) => pop.evaluate(m => chrome.runtime.sendMessage({to: 'bg', ...m}), msg)
const offCall = (pop, msg) => pop.evaluate(m => chrome.runtime.sendMessage({to: 'offscreen', ...m}), msg)
const status = pop => bgCall(pop, {type: 'status'})
const badgeOf = pop => pop.evaluate(() => chrome.action.getBadgeText({}))
const notified = pop => pop.evaluate(() => chrome.notifications.getAll()).then(Object.keys)

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
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`FAIL ${label}: ${JSON.stringify(last)}`)
}

// Reactions on one message as "emoji:name+name" strings, for comparing peers.
const shown = (s, id) => (s.reactions?.[id] ?? []).map(r => `${r.e}:${r.users.map(u => u.name).join('+')}`).join(' ')
const idOf = (s, text) => s.chat.find(m => m.text === text)?.id

async function enter(who, roomId) {
  const tabId = await who.pop.evaluate(async () => (await chrome.tabs.getCurrent()).id)
  await bgCall(who.pop, {type: 'join', roomId, tabId})
}

async function main() {
  const A = await launch()
  const B = await launch()
  const O = OLD ? await launch(resolve(OLD)) : null
  await bgCall(A.pop, {type: 'setName', name: 'alice'})
  await bgCall(B.pop, {type: 'setName', name: 'bob'})
  if (O) await bgCall(O.pop, {type: 'setName', name: 'olga'})
  const roomId = `e2ereact${Math.random().toString(16).slice(2)}`
  const peers = O ? 2 : 1
  for (const p of [A, B, O].filter(Boolean)) await enter(p, roomId)
  await until('A, B (and the older build) connect', async () => {
    const all = await Promise.all([A, B, O].filter(Boolean).map(p => status(p.pop)))
    return {ok: all.every(s => s.peers === peers && s.members.every(m => m.name !== 'someone')), info: all.map(s => s.members.map(m => m.name).join())}
  })

  await offCall(A.pop, {type: 'say', text: 'alice says hi'})
  await offCall(B.pop, {type: 'say', text: 'bob says hi'})
  await until('both messages reach A', async () => {
    const s = await status(A.pop)
    return {ok: idOf(s, 'alice says hi') && idOf(s, 'bob says hi'), info: s.chat.length}
  })
  const sA = await status(A.pop)
  const aliceMsg = idOf(sA, 'alice says hi')
  const bobMsg = idOf(sA, 'bob says hi')
  const eventId = sA.chat.find(m => m.kind === 'event')?.id

  // No side panel is open, so anything counted as unread would show here.
  const badgeBefore = await badgeOf(A.pop)
  const notesBefore = await notified(A.pop)

  if (!(await offCall(A.pop, {type: 'react', id: bobMsg, emoji: '👍'}))) throw new Error('FAIL A could not react')
  await offCall(B.pop, {type: 'react', id: aliceMsg, emoji: '❤️'})
  await offCall(B.pop, {type: 'react', id: aliceMsg, emoji: '👍'})
  await offCall(B.pop, {type: 'react', id: bobMsg, emoji: '👍'})
  const want = {[aliceMsg]: '❤️:bob 👍:bob', [bobMsg]: '👍:alice+bob'}
  await until('A and B see the same reactions', async () => {
    const [a, b] = await Promise.all([status(A.pop), status(B.pop)])
    const ok = Object.entries(want).every(([id, text]) => shown(a, id) === text && shown(b, id) === text)
    return {ok, info: {a: [shown(a, aliceMsg), shown(a, bobMsg)], b: [shown(b, aliceMsg), shown(b, bobMsg)]}}
  })

  if (await offCall(A.pop, {type: 'react', id: bobMsg, emoji: '🦄'})) throw new Error('FAIL emoji outside the set accepted')
  if (eventId && (await offCall(A.pop, {type: 'react', id: eventId, emoji: '👍'}))) throw new Error('FAIL reaction on an activity line accepted')
  console.log('ok   emoji outside the set and activity lines are refused')

  await new Promise(r => setTimeout(r, 1500))
  const [badgeAfter, notesAfter] = await Promise.all([badgeOf(A.pop), notified(A.pop)])
  if (badgeAfter !== badgeBefore) throw new Error(`FAIL reactions changed A's badge: ${badgeBefore} -> ${badgeAfter}`)
  const fresh = notesAfter.filter(n => !notesBefore.includes(n))
  if (fresh.length) throw new Error(`FAIL reactions notified A: ${fresh}`)
  console.log('ok   reactions add no unread count and no notification', JSON.stringify({badgeAfter}))

  await offCall(B.pop, {type: 'react', id: bobMsg, emoji: '👍'})
  await until('B takes back its thumbs up on both peers', async () => {
    const [a, b] = await Promise.all([status(A.pop), status(B.pop)])
    return {ok: shown(a, bobMsg) === '👍:alice' && shown(b, bobMsg) === '👍:alice', info: [shown(a, bobMsg), shown(b, bobMsg)]}
  })

  // A forged peer that claims reactions support tries to remove alice's
  // reaction and add one in her name. Neither may land.
  const aliceId = sA.members[0].userId
  await B.pop.evaluate(async ({roomId, aliceId, bobMsg, aliceMsg}) => {
    const {joinRoom} = await import('./vendor/trystero.js')
    const room = joinRoom({appId: 'jukebot-p2p', password: roomId, maxReceiveBytes: 256 * 1024}, roomId)
    const hello = room.makeAction('hello')
    const react = room.makeAction('react')
    room.onPeerJoin = async peerId => {
      await hello.send({userId: 'mallory', name: 'mallory', caps: ['react']}, {target: peerId})
      await react.send([
        {id: bobMsg, e: '👍', u: aliceId, name: 'alice', on: false, n: Date.now() + 1e9},
        {id: aliceMsg, e: '😢', u: aliceId, name: 'alice', on: true, n: Date.now()},
        {id: aliceMsg, e: '🦄', u: 'mallory', name: 'mallory', on: true, n: Date.now()},
        {id: aliceMsg, e: '🔥', u: 'mallory', name: 'mallory', on: true, n: Date.now()}
      ], {target: peerId})
    }
    window.forger = room
  }, {roomId, aliceId, bobMsg, aliceMsg})
  await until('the forger only adds its own allowed emoji on A', async () => {
    const a = await status(A.pop)
    return {ok: shown(a, aliceMsg) === '❤️:bob 👍:bob 🔥:mallory' && shown(a, bobMsg) === '👍:alice', info: [shown(a, aliceMsg), shown(a, bobMsg)]}
  })
  await B.pop.evaluate(() => window.forger.leave())
  await offCall(A.pop, {type: 'react', id: aliceMsg, emoji: '😂'})

  if (O) {
    // Enough reactions that an older peer which buffered them would hit its
    // per-peer limit and start dropping chat.
    for (let i = 0; i < 70; i++) await offCall(B.pop, {type: 'react', id: aliceMsg, emoji: '🎉'})
    await offCall(B.pop, {type: 'say', text: 'bob after reactions'})
    await offCall(O.pop, {type: 'say', text: 'olga on the old build'})
    await until('the older build still gets chat and its chat still arrives', async () => {
      const [o, a, b] = await Promise.all([status(O.pop), status(A.pop), status(B.pop)])
      const texts = s => s.chat.map(m => m.text)
      const ok = texts(o).includes('bob after reactions') && texts(o).includes('alice says hi') && texts(a).includes('olga on the old build') && texts(b).includes('olga on the old build') && o.peers === 2
      return {ok, info: {o: texts(o).filter(t => !/joined|left/.test(t)), peers: o.peers}}
    })
    const o = await status(O.pop)
    if (o.chat.some(m => m.text.includes('🎉'))) throw new Error('FAIL reactions leaked into the older build as chat')
    console.log('ok   older build sees no reaction traffic as chat')
  }

  await until('A and B agree before C joins', async () => {
    const [a, b] = await Promise.all([status(A.pop), status(B.pop)])
    return {ok: shown(a, aliceMsg) === shown(b, aliceMsg) && shown(a, aliceMsg).includes('😂:alice') && shown(a, bobMsg) === shown(b, bobMsg), info: [shown(a, aliceMsg), shown(a, bobMsg)]}
  })

  const C = await launch()
  await bgCall(C.pop, {type: 'setName', name: 'carol'})
  await enter(C, roomId)
  await until('C, joining later, gets the reactions with the history', async () => {
    const [a, c] = await Promise.all([status(A.pop), status(C.pop)])
    const ok = idOf(c, 'alice says hi') && shown(c, aliceMsg) === shown(a, aliceMsg) && shown(c, bobMsg) === '👍:alice'
    return {ok, info: {c: [shown(c, aliceMsg), shown(c, bobMsg)], a: shown(a, aliceMsg)}}
  })
  await offCall(C.pop, {type: 'react', id: bobMsg, emoji: '👍'})
  await until('C’s reaction reaches A and B', async () => {
    const [a, b] = await Promise.all([status(A.pop), status(B.pop)])
    return {ok: shown(a, bobMsg) === '👍:alice+carol' && shown(b, bobMsg) === '👍:alice+carol', info: [shown(a, bobMsg), shown(b, bobMsg)]}
  })

  // The side panel draws the chips, and the picker opens from the hover button.
  const panel = await A.browser.newPage()
  await panel.setViewport({width: 360, height: 640})
  await panel.goto(A.pop.url().replace('popup.html', 'sidepanel.html'))
  await until('A side panel shows chips with your own highlighted', () => panel.evaluate(id => {
    const add = document.querySelector(`.react-add[data-id="${id}"]`)
    const row = add?.closest('.msg')
    const chips = [...(row?.querySelectorAll('.chip') ?? [])].map(c => `${c.textContent}${c.classList.contains('mine') ? '*' : ''}|${c.title}`)
    return {ok: chips.includes('👍2*|you, carol reacted with 👍'), info: chips}
  }, bobMsg))
  if (ARTIFACTS) await panel.screenshot({path: join(ARTIFACTS, 'reactions.png')})
  await panel.mouse.move(5, 5)
  const hidden = await panel.$eval(`.react-add[data-id="${bobMsg}"]`, b => getComputedStyle(b).visibility)
  await panel.hover(`.react-add[data-id="${bobMsg}"]`)
  const visible = await panel.$eval(`.react-add[data-id="${bobMsg}"]`, b => getComputedStyle(b).visibility)
  if (hidden !== 'hidden' || visible !== 'visible') throw new Error(`FAIL add button visibility ${hidden} -> ${visible}`)
  console.log('ok   add button appears on hover only')
  await panel.click(`.react-add[data-id="${bobMsg}"]`)
  const box = await panel.$eval('#picker', p => {
    const r = p.getBoundingClientRect()
    return {hidden: p.hidden, left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: innerWidth, h: innerHeight, quick: p.querySelectorAll('.quick button').length, grid: p.querySelectorAll('.grid button').length}
  })
  if (box.hidden || box.left < 0 || box.right > box.w || box.top < 0 || box.bottom > box.h) throw new Error(`FAIL picker off screen: ${JSON.stringify(box)}`)
  console.log('ok   picker opens inside the panel', JSON.stringify(box))
  if (ARTIFACTS) await panel.screenshot({path: join(ARTIFACTS, 'reactions-picker.png')})
  await panel.keyboard.press('Escape')
  if (!(await panel.$eval('#picker', p => p.hidden))) throw new Error('FAIL Escape did not close the picker')
  await panel.click(`.react-add[data-id="${bobMsg}"]`)
  await panel.mouse.click(5, 5)
  if (!(await panel.$eval('#picker', p => p.hidden))) throw new Error('FAIL outside click did not close the picker')
  await panel.click(`.react-add[data-id="${bobMsg}"]`)
  await panel.click('#picker .quick button:nth-child(4)')
  if (!(await panel.$eval('#picker', p => p.hidden))) throw new Error('FAIL picking did not close the picker')
  console.log('ok   picker closes on Escape, outside click and pick')
  await until('picking from the panel reaches B', async () => {
    const b = await status(B.pop)
    return {ok: shown(b, bobMsg) === '👍:alice+carol 🔥:alice', info: shown(b, bobMsg)}
  })
  await panel.evaluate(id => [...document.querySelector(`.react-add[data-id="${id}"]`).closest('.msg').querySelectorAll('.chip')].find(c => c.textContent.startsWith('🔥')).click(), bobMsg)
  await until('clicking your own chip removes it everywhere', async () => {
    const b = await status(B.pop)
    return {ok: shown(b, bobMsg) === '👍:alice+carol', info: shown(b, bobMsg)}
  })
  console.log('PASS')
}

try {
  await main()
} finally {
  await Promise.all(browsers.map(b => b.close().catch(() => {})))
  for (const d of dirs) rmSync(d, {recursive: true, force: true})
}
