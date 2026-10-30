// End-to-end check with two separate Chrome profiles on real YouTube.
// Profile A starts a room, profile B opens the invite link, and the test drives
// A and B's players like a user would, asserting the other side follows.
// Signaling goes over the public Nostr relays, as it does for real users.
//
//   CHROME=/usr/bin/google-chrome SITE=www.youtube.com npm run test:e2e

import puppeteer from 'puppeteer-core'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

const EXT = resolve(import.meta.dirname, '..')
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome'
const SITE = process.env.SITE ?? 'www.youtube.com'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const LONG = 'aqz-KE-bpKQ' // Big Buck Bunny, ~10 min
const SHORT = 'jNQXAC9IVRw' // Me at the zoo, 19 s
const NEXT = 'YE7VzlLtp-4' // Big Buck Bunny (Blender upload)

const dirs = []
const browsers = []

async function launch() {
  const dir = mkdtempSync(join(tmpdir(), 'jukebot-e2e-'))
  dirs.push(dir)
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: dir,
    enableExtensions: [EXT],
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', `--user-agent=${UA}`]
  })
  browsers.push(browser)
  const page = (await browser.pages())[0] ?? (await browser.newPage())
  return {browser, page}
}

async function extensionPage(browser) {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('/background.js'))
  const id = new URL(sw.url()).host
  const page = await browser.newPage()
  await page.goto(`chrome-extension://${id}/popup.html`)
  return page
}

const player = page => page.evaluate(() => {
  const el = document.querySelector('video.html5-main-video') || document.querySelector('video')
  return {
    v: new URL(location.href).searchParams.get('v'),
    t: el?.currentTime ?? null,
    paused: el?.paused ?? null,
    ad: document.querySelector('.ad-showing') != null
  }
})

async function until(label, fn, timeout = 45000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      last = await fn()
      if (last?.ok) {
        console.log(`ok   ${label}`, JSON.stringify(last.info ?? ''))
        // Give the content scripts a beat to settle, as a person would before acting.
        await new Promise(r => setTimeout(r, 1500))
        return last
      }
    } catch (err) {
      last = {err: String(err)}
    }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`FAIL ${label}: ${JSON.stringify(last)}`)
}

async function inSync(label, a, b, extra = () => true) {
  return until(label, async () => {
    const [pa, pb] = await Promise.all([player(a), player(b)])
    const ok = typeof pa.t === 'number' && typeof pb.t === 'number' && pa.v === pb.v && pa.paused === pb.paused && Math.abs(pa.t - pb.t) < 2.5 && extra(pa, pb)
    return {ok, info: {a: pa, b: pb}}
  })
}

async function main() {
  const A = await launch()
  const B = await launch()

  await A.page.goto(`https://${SITE}/watch?v=${LONG}`)
  await until('A video plays', async () => {
    const p = await player(A.page)
    return {ok: p.v === LONG && p.t > 1 && !p.ad, info: p}
  }, 90000)

  const popA = await extensionPage(A.browser)
  const invite = await popA.evaluate(async site => {
    const [tab] = await chrome.tabs.query({url: `https://${site}/*`})
    const roomId = 'e2e' + Math.random().toString(16).slice(2)
    await chrome.runtime.sendMessage({to: 'bg', type: 'join', roomId, tabId: tab.id})
    await chrome.tabs.sendMessage(tab.id, {type: 'start'})
    await new Promise(r => setTimeout(r, 300))
    const s = await chrome.runtime.sendMessage({to: 'bg', type: 'status'})
    return `https://${site}/watch?v=${s.state.v}#jukebot=${s.roomId}`
  }, SITE)
  console.log('invite', invite)
  await popA.evaluate(() => chrome.runtime.sendMessage({to: 'offscreen', type: 'say', name: 'alice', text: 'said before B joined'}))

  // B opens the invite on a different video position; it should land on A's.
  await B.page.goto(invite)
  await inSync('B joins and matches A', A.page, B.page, pa => !pa.paused && pa.v === LONG)

  const popB = await extensionPage(B.browser)
  const chatOf = pop => pop.evaluate(() => chrome.runtime.sendMessage({to: 'bg', type: 'status'}).then(s => s.chat.map(m => `${m.name}: ${m.text}`)))
  await until('B gets chat history from before it joined', async () => {
    const chat = await chatOf(popB)
    return {ok: chat.includes('alice: said before B joined'), info: chat}
  })
  await popB.evaluate(() => chrome.runtime.sendMessage({to: 'offscreen', type: 'say', name: 'bob', text: 'hi <b>alice</b>'}))
  await until('A gets B chat message', async () => {
    const chat = await chatOf(popA)
    return {ok: chat.join('|') === 'alice: said before B joined|bob: hi <b>alice</b>', info: chat}
  })
  if (process.env.SHOT) {
    await popA.goto(popA.url().replace('popup.html', 'sidepanel.html'))
    await popA.setViewport({width: 360, height: 420})
    await new Promise(r => setTimeout(r, 500))
    await popA.screenshot({path: process.env.SHOT})
    await popA.goto(popA.url().replace('sidepanel.html', 'popup.html'))
  }

  await A.page.evaluate(() => document.querySelector('video').pause())
  await inSync('A pauses, B pauses', A.page, B.page, pa => pa.paused)

  await B.page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 200; v.play() })
  await inSync('B seeks to 200 and plays, A follows', A.page, B.page, pa => !pa.paused && pa.t > 195)

  await popB.evaluate(id => chrome.runtime.sendMessage({to: 'offscreen', type: 'update', patch: {queue: [{id, title: 'next'}]}}), NEXT)

  await A.page.goto(`https://${SITE}/watch?v=${SHORT}`)
  await inSync('A picks another video, B follows', A.page, B.page, pa => pa.v === SHORT && !pa.paused)

  await inSync('video ends, room advances to the shared queue', A.page, B.page, pa => pa.v === NEXT && !pa.paused)
  const queue = await popA.evaluate(() => chrome.runtime.sendMessage({to: 'bg', type: 'status'}).then(s => s.state.queue))
  if (queue.length) throw new Error(`FAIL queue not consumed: ${JSON.stringify(queue)}`)
  console.log('ok   queue consumed')
  console.log('PASS')
}

try {
  await main()
} finally {
  await Promise.all(browsers.map(b => b.close().catch(() => {})))
  for (const d of dirs) rmSync(d, {recursive: true, force: true})
}
