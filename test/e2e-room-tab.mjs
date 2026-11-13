// Joining from the popup, and where the side panel is enabled.
// No playback: YouTube can stop a headless player after a short time, and
// YouTube Music does not play headless at all.
//
//   CHROME=/usr/bin/google-chrome npm run test:e2e:room-tab
//
// From a tab that is not youtube.com or music.youtube.com, Join opens a new
// tab and leaves the original URL alone. From a YouTube tab, Join reuses it.
// chrome.sidePanel.getOptions is enabled on the room tab and not on another.

import puppeteer from 'puppeteer-core'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

const EXT = resolve(import.meta.dirname, '..')
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome'
const dirs = []
const browsers = []

async function launch() {
  const dir = mkdtempSync(join(process.env.E2E_TMPDIR ?? tmpdir(), 'jukebot-room-tab-'))
  dirs.push(dir)
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: dir,
    enableExtensions: [EXT],
    args: ['--mute-audio']
  })
  browsers.push(browser)
  const accept = page => page.on('dialog', dialog => dialog.accept().catch(() => {}))
  browser.on('targetcreated', async target => {
    const page = await target.page().catch(() => null)
    if (page) accept(page)
  })
  const page = (await browser.pages())[0] ?? (await browser.newPage())
  accept(page)
  return {browser, page}
}

async function serviceWorker(browser) {
  return browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://') && t.url().endsWith('/background.js'))
}

// Tabs and side panel options, read from the service worker.
async function snap(browser) {
  const sw = await serviceWorker(browser)
  const worker = await sw.worker()
  return worker.evaluate(async () => {
    const status = await chrome.runtime.sendMessage({to: 'offscreen', type: 'status'}).catch(() => null)
    const tabs = await chrome.tabs.query({})
    const listed = []
    for (const tab of tabs) {
      const opt = await chrome.sidePanel.getOptions({tabId: tab.id})
      listed.push({id: tab.id, url: tab.url, enabled: opt.enabled === true})
    }
    return {status, tabs: listed}
  })
}

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
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`FAIL ${label}: ${JSON.stringify(last)}`)
}

async function popup(browser) {
  const sw = await serviceWorker(browser)
  const id = new URL(sw.url()).host
  const page = await browser.newPage()
  await page.goto(`chrome-extension://${id}/popup.html`, {waitUntil: 'domcontentloaded'})
  return page
}

// Reload the popup while `active` is the front tab, so the popup records that
// tab the way it does when the toolbar opens it.
async function joinFrom(browser, active, code) {
  await active.bringToFront()
  const pop = await popup(browser)
  await active.bringToFront()
  await pop.reload({waitUntil: 'domcontentloaded', timeout: 15000})
  await pop.waitForSelector('#invite', {timeout: 15000})
  await pop.type('#invite', code)
  // Click without waiting on the popup: Join closes it.
  await pop.evaluate(() => document.querySelector('#join').click())
  return pop
}

const hostOf = url => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

async function main() {
  const {browser, page} = await launch()
  try {
    await page.goto('https://example.com/', {waitUntil: 'domcontentloaded'})
    const origin = page.url()
    const before = await snap(browser)
    // example.com is outside the extension's host permissions, so the tab list
    // has its id and no url. A YouTube navigation would fill the url in.
    const example = before.tabs.find(t => !t.url)
    if (!example) throw new Error(`FAIL example tab missing: ${JSON.stringify(before.tabs)}`)
    const code = `e2etab${Math.random().toString(16).slice(2, 10)}`
    await joinFrom(browser, page, code)
    let roomTabId
    const joined = await until('join from a non-YouTube tab opens another tab', async () => {
      const view = await snap(browser)
      const stayed = view.tabs.find(t => t.id === example.id)
      const room = view.tabs.find(t => t.id === view.status?.tabId)
      const ok = page.url() === origin && view.status?.roomId === code && stayed && !stayed.url && room && room.id !== example.id && hostOf(room.url) === 'music.youtube.com' && room.enabled === true && stayed.enabled === false
      return {ok, info: {page: page.url(), status: view.status && {roomId: view.status.roomId, tabId: view.status.tabId}, stayed, room}}
    })
    const roomTab = joined.info.room
    roomTabId = roomTab.id
    const after = await snap(browser)
    const exampleNow = after.tabs.find(t => t.id === example.id)
    const roomNow = after.tabs.find(t => t.id === roomTab.id)
    if (exampleNow.enabled !== false || roomNow.enabled !== true) {
      throw new Error(`FAIL side panel options: ${JSON.stringify(after.tabs)}`)
    }
    console.log('ok   side panel enabled only on the new room tab')

    const pop = await popup(browser)
    await pop.evaluate(() => chrome.runtime.sendMessage({to: 'bg', type: 'leave'}))
    await until('leaving the room enables the panel on other tabs again', async () => {
      const view = await snap(browser)
      const stayed = view.tabs.find(t => t.id === example.id)
      return {ok: !view.status?.roomId && stayed?.enabled === true, info: {roomId: view.status?.roomId, stayed}}
    })

    const youtube = await browser.newPage()
    await youtube.goto('https://www.youtube.com/', {waitUntil: 'domcontentloaded', timeout: 45000})
    const youtubeUrl = youtube.url()
    if (hostOf(youtubeUrl) !== 'www.youtube.com') throw new Error(`FAIL youtube tab is ${youtubeUrl}`)
    const ytBefore = await snap(browser)
    const ytTab = ytBefore.tabs.find(t => t.url === youtubeUrl)
    if (!ytTab) throw new Error(`FAIL youtube tab missing: ${JSON.stringify(ytBefore.tabs)}`)
    const count = ytBefore.tabs.length
    const code2 = `e2eyt${Math.random().toString(16).slice(2, 10)}`
    await joinFrom(browser, youtube, code2)
    await until('join from a YouTube tab reuses it', async () => {
      const view = await snap(browser)
      const same = view.tabs.find(t => t.id === ytTab.id)
      const exampleStill = view.tabs.find(t => t.id === example.id)
      const previous = view.tabs.find(t => t.id === roomTabId)
      const ok = view.status?.roomId === code2 && view.status?.tabId === ytTab.id && view.tabs.length === count &&
        hostOf(youtube.url()) === 'www.youtube.com' && page.url() === origin &&
        same?.enabled === true && exampleStill?.enabled === false && !exampleStill?.url && previous?.enabled === false
      return {ok, info: {tabId: view.status?.tabId, yt: youtube.url(), count: view.tabs.length, same, exampleStill, previous}}
    })
    console.log('PASS room tab and side panel')
  } finally {
    await Promise.all(browsers.map(b => b.close().catch(() => {})))
    for (const dir of dirs) rmSync(dir, {recursive: true, force: true})
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
