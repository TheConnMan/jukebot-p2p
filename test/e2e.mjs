// End-to-end check with two separate Chrome profiles on real YouTube.
// Profile A starts a room, profile B opens the invite link, and the test drives
// A and B's players like a user would, asserting the other side follows.
// Signaling goes over the public Nostr relays, as it does for real users.
//
//   CHROME=/usr/bin/google-chrome SITE=www.youtube.com npm run test:e2e
//
// SITE_B puts browser B on another site than A (for example A on
// www.youtube.com and B on music.youtube.com) by rewriting the invite host.

import puppeteer from 'puppeteer-core'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

const EXT = resolve(import.meta.dirname, '..')
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome'
const SITE = process.env.SITE ?? 'www.youtube.com'
const SITE_B = process.env.SITE_B ?? SITE
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const LONG = 'aqz-KE-bpKQ' // Big Buck Bunny, ~10 min
const SHORT = 'jNQXAC9IVRw' // Me at the zoo, 19 s
const NEXT = 'YE7VzlLtp-4' // Big Buck Bunny (Blender upload)

const dirs = []
const browsers = []
const acceptInvites = page => page.on('dialog', dialog => dialog.accept().catch(() => {}))

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
  acceptInvites(page)
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
    host: location.host,
    v: new URL(location.href).searchParams.get('v'),
    t: el?.currentTime ?? null,
    paused: el?.paused ?? null,
    ad: document.querySelector('.ad-showing') != null,
    ready: el?.readyState >= 2 && !el.seeking,
    error: el?.error?.message || document.querySelector('.ytp-error')?.textContent || null
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
  let consecutive = 0
  return until(label, async () => {
    const [pa, pb] = await Promise.all([player(a), player(b)])
    const matches = !pa.ad && !pb.ad && pa.ready && pb.ready && typeof pa.t === 'number' && typeof pb.t === 'number' && pa.v === pb.v && pa.paused === pb.paused && Math.abs(pa.t - pb.t) < 2.5 && extra(pa, pb)
    consecutive = matches ? consecutive + 1 : 0
    return {ok: consecutive >= 2, info: {a: pa, b: pb}}
  })
}

const bgCall = (pop, msg) => pop.evaluate(m => chrome.runtime.sendMessage({to: 'bg', ...m}), msg)
const offCall = (pop, msg) => pop.evaluate(m => chrome.runtime.sendMessage({to: 'offscreen', ...m}), msg)
const status = pop => bgCall(pop, {type: 'status'})
const chatOf = pop => status(pop).then(s => s.chat.filter(m => m.kind !== 'event').map(m => `${m.name}: ${m.text}`))
const eventsOf = pop => status(pop).then(s => s.chat.filter(m => m.kind === 'event').map(m => m.text))
const badgeOf = pop => pop.evaluate(() => chrome.action.getBadgeText({}))

async function hasEvent(label, pop, match) {
  return until(label, async () => {
    const events = await eventsOf(pop)
    return {ok: events.some(t => match.test(t)), info: events.slice(-4)}
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
  const popB = await extensionPage(B.browser)
  await bgCall(popA, {type: 'setName', name: 'alice'})
  await bgCall(popB, {type: 'setName', name: 'bob'})
  const invite = await popA.evaluate(async site => {
    const [tab] = await chrome.tabs.query({url: `https://${site}/*`})
    const roomId = newRoomId('Friday Jams!')
    await chrome.runtime.sendMessage({to: 'bg', type: 'join', roomId, tabId: tab.id})
    await chrome.tabs.sendMessage(tab.id, {type: 'start', roomId})
    await new Promise(r => setTimeout(r, 300))
    const s = await chrome.runtime.sendMessage({to: 'bg', type: 'status'})
    return `https://${site}/#jukebot=${s.roomId}`
  }, SITE)
  console.log('invite', invite)
  const vanity = new URL(invite).hash.slice('#jukebot='.length)
  if (!/^friday-jams-[0-9a-f]{12}$/.test(vanity)) throw new Error(`FAIL vanity room code: ${vanity}`)
  console.log('ok   vanity room code', vanity)
  await hasEvent('start event', popA, /^alice started the room with .+/)
  await offCall(popA, {type: 'say', text: 'said before B joined'})

  // B opens the invite on a different video position; it should land on A's.
  // Player tabs go to the front: Chrome defers media in background tabs.
  const inviteB = invite.replace(`https://${SITE}/`, `https://${SITE_B}/`)
  await B.page.bringToFront()
  B.page.removeAllListeners('dialog')
  B.page.on('dialog', dialog => dialog.dismiss().catch(() => {}))
  await B.page.goto(inviteB)
  await new Promise(r => setTimeout(r, 1000))
  if ((await status(popB))?.roomId) throw new Error('FAIL dismissed invite joined a room')
  console.log('ok   dismissed invite does not join')
  B.page.removeAllListeners('dialog')
  acceptInvites(B.page)
  await B.page.goto(inviteB)
  await A.page.bringToFront()
  await inSync('B joins and matches A', A.page, B.page, (pa, pb) => !pa.paused && pa.v === LONG && pb.host === SITE_B)

  await until('names exchanged', async () => {
    const [a, b] = await Promise.all([status(popA), status(popB)])
    const names = s => s.members.map(m => m.name).sort().join()
    return {ok: names(a) === 'alice,bob' && names(b) === 'alice,bob', info: [names(a), names(b)]}
  })
  await hasEvent('A sees bob joined', popA, /^bob joined$/)

  await until('B gets chat history from before it joined', async () => {
    const chat = await chatOf(popB)
    return {ok: chat.includes('alice: said before B joined'), info: chat}
  })
  await hasEvent('B gets activity history from before it joined', popB, /^alice started the room with/)
  // Backfilled history is quiet: no unread count and no notifications for it.
  const backfill = (await status(popB)).chat.filter(m => !m.local).map(m => m.id)
  await until('backfill stays silent on B', async () => {
    const [badge, shown] = await Promise.all([badgeOf(popB), popB.evaluate(() => chrome.notifications.getAll())])
    const loud = backfill.filter(id => `m-${id}` in shown)
    return {ok: badge === '2' && loud.length === 0, info: {badge, loud}}
  })
  {
    const panel = await B.browser.newPage()
    await panel.goto(popB.url().replace('popup.html', 'sidepanel.html'))
    await until('backfilled event renders as an event line on B', () => panel.evaluate(() => {
      const lines = [...document.querySelectorAll('.msg.event')].map(m => m.textContent)
      return {ok: lines.some(t => t.startsWith('alice started the room with')) && !document.querySelector('.msg.event .ts'), info: lines}
    }))
    await panel.close()
    await B.page.bringToFront()
  }

  const switchedRoom = 'e2eswitch' + Math.random().toString(16).slice(2)
  await B.page.goto(`https://${SITE_B}/watch?v=${NEXT}#jukebot=${switchedRoom}`)
  await until('new empty invite clears the previous room and seeds its own video', async () => {
    const s = await status(popB)
    return {ok: s.roomId === switchedRoom && s.state?.v === NEXT && s.state.queue.length === 0 && s.peers === 0, info: {roomId: s.roomId, state: s.state}}
  }, 30000)

  await B.page.goto(inviteB)
  await inSync('B returns to the original room after switching', A.page, B.page, pa => pa.v === LONG && !pa.paused)

  await offCall(popB, {type: 'say', text: 'hi <b>alice</b>\nsecond line'})
  await until('A gets B chat message', async () => {
    const chat = await chatOf(popA)
    return {ok: chat.join('|') === 'alice: said before B joined|bob: hi <b>alice</b>\nsecond line', info: chat}
  })
  await until('A badge shows 1 unread', async () => {
    const text = await badgeOf(popA)
    return {ok: text === '1', info: text}
  })
  await popA.evaluate(() => { window.port = chrome.runtime.connect({name: 'sidepanel'}) })
  await new Promise(r => setTimeout(r, 300))
  if (await badgeOf(popA) !== '1') throw new Error('FAIL popup port impersonated side panel')
  await popA.evaluate(() => window.port.disconnect())
  console.log('ok   popup port cannot impersonate side panel')
  const readPanel = await A.browser.newPage()
  await readPanel.goto(popA.url().replace('popup.html', 'sidepanel.html'))
  await until('A badge resets to the listener count when the side panel opens', async () => {
    const text = await badgeOf(popA)
    return {ok: text === '2', info: text}
  })
  await readPanel.close()

  const beforeAttack = await status(popA)
  await popB.evaluate(async ({roomId, state, userId}) => {
    const {joinRoom} = await import('./vendor/trystero.js')
    window.attack = joinRoom({appId: 'jukebot-p2p', password: roomId, maxReceiveBytes: 256 * 1024}, roomId)
    const forgedState = window.attack.makeAction('state')
    const forgedChat = window.attack.makeAction('chat')
    window.attack.onPeerJoin = async peerId => {
      await forgedState.send({...state, rev: 1e100, by: '\uffff'}, {target: peerId})
      await forgedState.send({...state, rev: state.rev + 1001, by: '\uffff'}, {target: peerId})
      await forgedChat.send([{id: 'forged-' + roomId, by: userId, name: 'impostor', text: 'copied identity', ts: 1e100, self: true}], {target: peerId})
    }
  }, {roomId: beforeAttack.roomId, state: beforeAttack.state, userId: beforeAttack.members[0].userId})
  await until('first live chat from a peer is delivered immediately', async () => {
    const s = await status(popA)
    const m = s.chat.find(m => m.text === 'copied identity')
    return {ok: m && m.ts <= Date.now() && !m.self && await badgeOf(popA) === '1', info: m}
  })
  if ((await status(popA)).state.rev >= beforeAttack.state.rev + 1000) throw new Error('FAIL forged revision accepted')
  console.log('ok   forged high revisions rejected')
  const spoofPanel = await A.browser.newPage()
  await spoofPanel.goto(popA.url().replace('popup.html', 'sidepanel.html'))
  await until('copied identity is not marked as you', () => spoofPanel.evaluate(() => {
    const row = [...document.querySelectorAll('.msg')].find(m => m.textContent.includes('copied identity'))
    return {ok: row && !row.textContent.includes('(you)'), info: row?.textContent}
  }))
  await spoofPanel.close()
  await popB.evaluate(() => window.attack.leave())

  await offCall(popB, {type: 'typing'})
  await until('A sees bob typing', async () => {
    const s = await status(popA)
    return {ok: s.typing.some(t => t.name === 'bob'), info: s.typing}
  })

  const realmId = pop => pop.evaluate(async () => (await import('./vendor/trystero.js')).selfId)
  const [realmA, realmB, offA, offB] = await Promise.all([realmId(popA), realmId(popB), status(popA), status(popB)])
  const tie = [
    {pop: popB, id: realmB, victim: popA, victimId: offA.selfId, page: A.page},
    {pop: popA, id: realmA, victim: popB, victimId: offB.selfId, page: B.page}
  ].find(c => c.id > c.victimId)
  if (!tie) console.log('skip same-rev queue tie (no higher peer id)')
  else {
    const added = await bgCall(tie.victim, {type: 'add', url: `https://youtu.be/${SHORT}`})
    if (!added?.ok) throw new Error(`FAIL tie add: ${JSON.stringify(added)}`)
    const queued = await until('tie victim queued a song', async () => {
      const q = (await status(tie.victim)).state?.queue ?? []
      return {ok: q.some(item => item.id === SHORT), info: q}
    })
    const item = queued.info.find(entry => entry.id === SHORT)
    const snap = await status(tie.victim)
    const live = await player(tie.page)
    await tie.pop.evaluate(async ({roomId, state, peerTarget}) => {
      const {joinRoom} = await import('./vendor/trystero.js')
      const attack = joinRoom({appId: 'jukebot-p2p', password: roomId, maxReceiveBytes: 256 * 1024}, roomId)
      const forged = attack.makeAction('state')
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('tie peer did not join')), 20000)
        attack.onPeerJoin = peerId => {
          if (peerId !== peerTarget) return
          forged.send(state, {target: peerId}).then(() => {
            clearTimeout(timer)
            attack.leave()
            resolve()
          }, reject)
        }
      })
    }, {
      roomId: snap.roomId,
      peerTarget: snap.selfId,
      state: {...snap.state, pos: live.t ?? snap.state.pos, queue: (snap.state.queue ?? []).filter(entry => entry.qid !== item.qid)}
    })
    await until('same-rev tie keeps the local queue add', async () => {
      const s = await status(tie.victim)
      const q = s.state?.queue ?? []
      return {ok: s.state?.rev > snap.state.rev && q.some(entry => entry.qid === item.qid), info: {rev: s.state?.rev, q}}
    })
    await offCall(tie.victim, {type: 'remove', qid: item.qid})
    await until('tie check queue cleared', async () => {
      const [a, b] = await Promise.all([status(popA), status(popB)])
      return {ok: !(a.state?.queue.length) && !(b.state?.queue.length), info: [a.state?.queue, b.state?.queue]}
    })
  }

  await A.page.evaluate(() => (document.querySelector('video.html5-main-video') || document.querySelector('video')).pause())
  await inSync('A pauses, B pauses', A.page, B.page, pa => pa.paused)
  await hasEvent('B sees alice paused', popB, /^alice paused$/)

  await B.page.evaluate(() => { const v = document.querySelector('video.html5-main-video') || document.querySelector('video'); v.currentTime = 200; v.play() })
  await inSync('B seeks to 200 and plays, A follows', A.page, B.page, pa => !pa.paused && pa.t > 195)
  await hasEvent('A sees bob resumed', popA, /^bob resumed$/)

  // The same path the right-click menu and the side panel's link box use.
  const added = await bgCall(popB, {type: 'add', url: `https://youtu.be/${NEXT}`})
  if (!added?.ok) throw new Error(`FAIL add: ${JSON.stringify(added)}`)
  const item = (await until('queue add resolves a real title', async () => {
    const q = (await status(popA)).state?.queue ?? []
    return {ok: q.length === 1 && q[0].id === NEXT && q[0].title && q[0].title !== NEXT && q[0].name === 'bob', info: q}
  })).info[0]
  console.log(`info duration ${item.duration ?? 'unknown'}`)
  await hasEvent('A sees bob added it', popA, /^bob added .+/)

  if (process.env.SHOT) {
    const panel = await A.browser.newPage()
    await panel.setViewport({width: 360, height: 640})
    await panel.goto(popA.url().replace('popup.html', 'sidepanel.html'))
    await offCall(popB, {type: 'typing'})
    await panel.evaluate(() => {
      const box = document.getElementById('text')
      box.value = 'a draft that wraps onto\nseveral lines\nso the box grows'
      box.dispatchEvent(new Event('input'))
    })
    await new Promise(r => setTimeout(r, 1200))
    await panel.screenshot({path: process.env.SHOT})
    await popA.setViewport({width: 340, height: 520})
    await popA.reload()
    await new Promise(r => setTimeout(r, 800))
    await popA.screenshot({path: process.env.SHOT.replace(/\.png$/, '-popup.png')})
    await panel.close()
  }

  const beforeSkip = (await eventsOf(popB)).length
  await offCall(popA, {type: 'skip'})
  await inSync('skip moves both to the queued video', A.page, B.page, pa => pa.v === NEXT && !pa.paused)
  await hasEvent('B sees alice skipped', popB, /^alice skipped to .+/)
  await new Promise(r => setTimeout(r, 3000))
  const afterSkip = (await eventsOf(popB)).slice(beforeSkip)
  if (afterSkip.length !== 1) throw new Error(`FAIL skip should log exactly one line: ${JSON.stringify(afterSkip)}`)
  console.log('ok   skip logs exactly one line')

  await bgCall(popB, {type: 'add', url: `https://${SITE}/watch?v=${LONG}`})
  await until('second queue add lands', async () => {
    const q = (await status(popA)).state?.queue ?? []
    return {ok: q.length === 1 && q[0].id === LONG, info: q}
  })

  await A.page.goto(`https://${SITE}/watch?v=${SHORT}`)
  await inSync('A picks another video, B follows', A.page, B.page, pa => pa.v === SHORT && !pa.paused)
  await hasEvent('B sees alice started it', popB, /^alice started .+/)

  await inSync('video ends, room advances to the shared queue', A.page, B.page, pa => pa.v === LONG && !pa.paused)
  const queue = (await status(popA)).state.queue
  if (queue.length) throw new Error(`FAIL queue not consumed: ${JSON.stringify(queue)}`)
  console.log('ok   queue consumed')
  await hasEvent('now playing line', popA, /^Now playing .+/)

  // Locally created message IDs survive leaving, rejoining and reloading.
  const ownMessage = async () => {
    const panel = await B.browser.newPage()
    await panel.goto(popB.url().replace('popup.html', 'sidepanel.html'))
    const r = await until('B side panel marks its own earlier message as own', () => panel.evaluate(() => {
      const own = [...document.querySelectorAll('.msg:not(.event)')].map(m => m.textContent)
      return {ok: own.some(t => t.includes('bob (you)') && t.includes('hi <b>alice</b>')), info: own}
    }))
    await panel.close()
    await B.page.bringToFront()
    return r
  }

  // Move the room off the invite's video, then reopen that old invite three
  // ways. The link's video must never be taken as B's pick.
  await A.page.goto(`https://${SITE}/watch?v=${NEXT}`)
  await inSync('room moves off the invite video', A.page, B.page, pa => pa.v === NEXT && !pa.paused)
  const mark = (await eventsOf(popA)).length
  const onRoomVideo = label => inSync(label, A.page, B.page, (pa, pb) => pa.v === NEXT && pb.v === NEXT && !pa.paused)

  await B.page.goto(inviteB)
  await new Promise(r => setTimeout(r, 4000))
  await onRoomVideo('old invite in the room tab keeps the room on its video')

  await bgCall(popB, {type: 'leave'})
  await hasEvent('A sees bob left after B leaves', popA, /^bob left$/)
  await B.page.goto(inviteB)
  await until('B rejoins and gets history', async () => {
    const chat = await chatOf(popB)
    return {ok: chat.includes('bob: hi <b>alice</b>\nsecond line'), info: chat}
  })
  await onRoomVideo('old invite after leaving keeps the room on its video')
  await ownMessage()

  const oldTab = B.page
  B.page = await B.browser.newPage()
  acceptInvites(B.page)
  await B.page.goto(inviteB)
  await new Promise(r => setTimeout(r, 4000))
  await onRoomVideo('old invite in a new tab keeps the room on its video')
  if ((await status(popB)).tabId === undefined) throw new Error('FAIL no room tab')
  await oldTab.close()

  const hijack = (await eventsOf(popA)).slice(mark).filter(t => /^bob started/.test(t))
  if (hijack.length) throw new Error(`FAIL old invite changed the room: ${JSON.stringify(hijack)}`)
  console.log('ok   no started line from old invites')

  await B.page.reload()
  await inSync('B reloads and stays in sync', A.page, B.page, pa => !pa.paused && pa.v === NEXT)
  await ownMessage()

  await bgCall(popB, {type: 'leave'})
  await until('A shows bob joined then left', async () => {
    const events = await eventsOf(popA)
    return {ok: events.filter(t => t === 'bob joined').length >= 2 && events.filter(t => t === 'bob left').length >= 2, info: events.slice(-4)}
  })

  // A starts a room and leaves. B is alone with the invite and must seed it.
  // A then rejoins from a different video and must follow B, not its own tab.
  await bgCall(popA, {type: 'leave'})
  await A.page.goto(`https://${SITE}/watch?v=${LONG}`)
  await until('A video plays again', async () => {
    const p = await player(A.page)
    return {ok: p.v === LONG && p.t > 1 && !p.ad, info: p}
  }, 90000)
  const inviteAlone = await popA.evaluate(async site => {
    const [tab] = await chrome.tabs.query({url: `https://${site}/*`})
    const roomId = 'e2ealone' + Math.random().toString(16).slice(2)
    await chrome.runtime.sendMessage({to: 'bg', type: 'join', roomId, tabId: tab.id})
    await chrome.tabs.sendMessage(tab.id, {type: 'start', roomId})
    await new Promise(r => setTimeout(r, 300))
    const s = await chrome.runtime.sendMessage({to: 'bg', type: 'status'})
    return `https://${site}/watch?v=${s.state.v}#jukebot=${s.roomId}`
  }, SITE)
  const aloneVid = new URL(inviteAlone).searchParams.get('v')
  await bgCall(popA, {type: 'leave'})
  await A.page.goto(`https://${SITE}/watch?v=${SHORT}`)
  const inviteAloneB = inviteAlone.replace(`https://${SITE}/`, `https://${SITE_B}/`)
  await B.page.bringToFront()
  await B.page.goto(inviteAloneB)
  await until('B alone seeds the invite', async () => {
    const [s, p] = await Promise.all([status(popB), player(B.page)])
    return {ok: s.state?.v === aloneVid && s.peers === 0 && p.v === aloneVid && p.paused === false, info: {state: s.state && {v: s.state.v, rev: s.state.rev, peers: s.peers}, p}}
  }, 20000)
  await A.page.bringToFront()
  await A.page.goto(inviteAlone)
  await inSync('A rejoins the seeded room on B\'s video', A.page, B.page, (pa, pb) => pa.v === aloneVid && pb.v === aloneVid && pa.v !== SHORT)
  const [seedA, seedB] = await Promise.all([status(popA), status(popB)])
  if (seedA.state?.v !== aloneVid || seedB.state?.v !== aloneVid) {
    throw new Error(`FAIL rejoin reset the room: ${JSON.stringify({a: seedA.state?.v, b: seedB.state?.v})}`)
  }
  console.log('ok   rejoin keeps the seeded video')

  console.log('PASS')
}

try {
  await main()
} finally {
  await Promise.all(browsers.map(b => b.close().catch(() => {})))
  for (const d of dirs) rmSync(d, {recursive: true, force: true})
}
