// Service worker: owns the offscreen document (which holds the WebRTC room,
// since service workers have no RTCPeerConnection) and relays room state from
// it to the one tab that is playing for the room. Also owns the profile (name
// and userId), the right-click "Add to JukeBot queue" menu, the unread badge
// and desktop notifications.

import {videoId} from './youtube.js'

const AMBER = '#efb146'
const RED = '#fb794a'
const SONG_TAGS = ['add', 'play']
const PEOPLE_TAGS = ['join', 'leave']

let creating = null
const panels = new Set() // open side panel ports; while any is open, chat counts as read

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return
  creating ??= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WEB_RTC'],
    justification: 'Keep the peer-to-peer listening room connected.'
  }).finally(() => { creating = null })
  await creating
}

const toOffscreen = msg => chrome.runtime.sendMessage({to: 'offscreen', ...msg})

async function profile() {
  const stored = await chrome.storage.local.get(['name', 'userId'])
  const p = {name: stored.name || `friend-${Math.random().toString(16).slice(2, 6)}`, userId: stored.userId || crypto.randomUUID()}
  if (p.name !== stored.name || p.userId !== stored.userId) await chrome.storage.local.set(p)
  return p
}

async function setName(name) {
  const p = {...(await profile()), name: String(name).trim().slice(0, 40) || 'someone'}
  await chrome.storage.local.set({name: p.name})
  if (await chrome.offscreen.hasDocument()) await toOffscreen({type: 'profile', ...p})
  return p
}

async function status() {
  if (!(await chrome.offscreen.hasDocument())) return null
  return toOffscreen({type: 'status'})
}

async function join(roomId, tabId) {
  await ensureOffscreen()
  await chrome.storage.session.set({unread: 0})
  return toOffscreen({type: 'join', roomId, tabId, profile: await profile()})
}

async function leave() {
  const s = await status()
  if (!s) return
  await toOffscreen({type: 'leave'})
  await chrome.offscreen.closeDocument()
  await chrome.storage.session.set({unread: 0, peers: null})
  await badge()
  chrome.runtime.sendMessage({to: 'chat', type: 'chat'}).catch(() => {})
  if (s.tabId != null) chrome.tabs.sendMessage(s.tabId, {type: 'left'}).catch(() => {})
}

async function add(link) {
  const id = videoId(link)
  if (!id) return {error: 'That is not a YouTube video link.'}
  if (!(await chrome.offscreen.hasDocument())) return {error: 'Start or join a room first.'}
  const ok = await toOffscreen({type: 'add', id})
  return ok ? {ok} : {error: 'Start or join a room first.'}
}

async function badge() {
  const {unread = 0, peers = null} = await chrome.storage.session.get(['unread', 'peers'])
  if (unread > 0) {
    chrome.action.setBadgeBackgroundColor({color: RED})
    chrome.action.setBadgeText({text: String(Math.min(unread, 99))})
  } else {
    chrome.action.setBadgeBackgroundColor({color: AMBER})
    chrome.action.setBadgeText({text: peers == null ? '' : String(peers + 1)})
  }
}

async function push({tabId, state, peers}) {
  chrome.tabs.sendMessage(tabId, {type: 'state', state}).catch(() => {})
  await chrome.storage.session.set({peers})
  await badge()
}

async function incoming(messages) {
  if (panels.size) return
  const chats = messages.filter(m => m.kind !== 'event')
  const songs = messages.filter(m => m.kind === 'event' && SONG_TAGS.includes(m.tag))
  const people = messages.filter(m => m.kind === 'event' && PEOPLE_TAGS.includes(m.tag))
  const {unread = 0} = await chrome.storage.session.get('unread')
  if (chats.length) await chrome.storage.session.set({unread: unread + chats.length})
  await badge()
  const {notifyChat = true, notifySongs = true, notifyPeople = true} = await chrome.storage.local.get(['notifyChat', 'notifySongs', 'notifyPeople'])
  const show = (title, message) => chrome.notifications.create({type: 'basic', iconUrl: 'icon128.png', title, message}).catch(() => {})
  if (notifyChat) for (const m of chats) show(m.name || 'someone', m.text)
  if (notifySongs) for (const m of songs) show('JukeBot', m.text)
  if (notifyPeople) for (const m of people) show('JukeBot', m.text)
}

async function markRead() {
  await chrome.storage.session.set({unread: 0})
  await badge()
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.to !== 'bg') return false
  if (msg.type === 'push') {
    push(msg)
    return false
  }
  if (msg.type === 'incoming') {
    incoming(msg.messages)
    return false
  }
  const tabId = msg.tabId ?? sender.tab?.id
  const work = {
    join: () => join(msg.roomId, tabId),
    leave,
    status,
    profile,
    setName: () => setName(msg.name),
    add: () => add(msg.url)
  }[msg.type]
  if (!work) return false
  work().then(reply, err => reply({error: String(err)}))
  return true
})

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'sidepanel') return
  panels.add(port)
  markRead()
  port.onDisconnect.addListener(() => panels.delete(port))
})

chrome.tabs.onRemoved.addListener(async tabId => {
  const s = await status()
  if (s?.tabId === tabId) leave()
})

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'add-link',
      title: 'Add to JukeBot queue',
      contexts: ['link'],
      targetUrlPatterns: ['https://www.youtube.com/watch*', 'https://music.youtube.com/watch*', 'https://m.youtube.com/watch*', 'https://youtu.be/*']
    })
    chrome.contextMenus.create({
      id: 'add-page',
      title: 'Add this video to JukeBot queue',
      contexts: ['page', 'video'],
      documentUrlPatterns: ['https://www.youtube.com/watch*', 'https://music.youtube.com/watch*']
    })
  })
})

chrome.contextMenus.onClicked.addListener(async info => {
  const r = await add(info.linkUrl ?? info.pageUrl)
  if (r.error) chrome.notifications.create({type: 'basic', iconUrl: 'icon128.png', title: 'JukeBot', message: r.error}).catch(() => {})
})

chrome.notifications.onClicked.addListener(async id => {
  chrome.notifications.clear(id)
  const s = await status()
  if (s?.tabId == null) return
  const tab = await chrome.tabs.update(s.tabId, {active: true}).catch(() => null)
  if (tab) chrome.windows.update(tab.windowId, {focused: true})
})
