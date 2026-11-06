import {videoId as watchVid} from './youtube.js'
import {directory} from './directory.js'
import {codeFor, roomAction} from './remembered.js'

const $ = id => document.getElementById(id)
const HOSTS = ['www.youtube.com', 'music.youtube.com']

let tab = null
let status = null
let roomsLoaded = false

const bg = msg => chrome.runtime.sendMessage({to: 'bg', ...msg})

function hex(bytes) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('')
}

// A name becomes `<slug>-<12 hex>`. Blank, or a name with no letters or digits, stays fully random.
function newRoomId(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/^-+|-+$/g, '')
  if (!slug) return hex(12)
  return `${slug}-${hex(6)}`
}

function showError(text) {
  $('error').textContent = text
  $('error').hidden = !text
}

async function render() {
  const inRoom = Boolean(status?.roomId)
  const knocking = status?.knocking
  const waiting = !inRoom && ['waiting', 'joining'].includes(knocking?.phase)
  const declined = !inRoom && knocking?.phase === 'failed'
  $('waiting').hidden = !waiting
  $('declined').hidden = !declined
  $('out').hidden = inRoom || waiting || declined
  $('in').hidden = !inRoom
  const pill = $('pill')
  if (!inRoom) {
    pill.className = 'pill'
    pill.textContent = waiting ? 'knocking' : 'no room'
    pill.className = waiting ? 'pill live' : 'pill'
    if (waiting) {
      $('waiting-room').textContent = `Waiting for someone in ${knocking.name} to let you in.`
      $('waiting-name').textContent = `${knocking.count} people are here. They see your name: ${knocking.visitorName}.`
    }
    if (!waiting && !declined && !roomsLoaded) loadRooms()
    const canStart = Boolean(watchVid(tab?.url))
    $('start').hidden = !canStart
    $('room-name').hidden = $('start-public').hidden = !canStart
    $('start-hint').hidden = canStart
    return
  }
  const {state, peers, roomId, tabId} = status
  pill.className = peers ? 'pill ok' : 'pill live'
  pill.textContent = peers ? `${peers + 1} listening` : state ? 'waiting for friends' : 'connecting'
  const roomTab = await chrome.tabs.get(tabId).catch(() => null)
  const host = roomTab ? new URL(roomTab.url).host : 'music.youtube.com'
  $('link').value = `https://${host}/#jukebot=${roomId}`
  $('where').textContent = tabId === tab?.id ? 'This tab plays for the room.' : `The room plays in another tab: ${roomTab?.title ?? 'closed'}`
  $('public').checked = state?.public === true
  $('public').disabled = !state
  $('public-label').textContent = state?.public ? 'Listed' : 'Private'
  $('public-note').textContent = state?.public
    ? `Listed in Public rooms. People must knock to join. ${peers + 1}/12 here. Invite links still work without a knock.`
    : 'Private. Only people with an invite link or room code can join.'
  const queue = state?.queue ?? []
  $('queue').replaceChildren(...queue.map((item, i) => {
    const li = document.createElement('li')
    const num = document.createElement('span')
    num.className = 'num'
    num.textContent = i + 1
    num.style.flex = '0 0 auto'
    const name = document.createElement('span')
    name.textContent = item.title || item.id
    name.title = item.name ? `${item.title || item.id} (added by ${item.name})` : item.title || item.id
    const x = document.createElement('button')
    x.className = 'x'
    x.textContent = 'remove'
    x.onclick = () => chrome.runtime.sendMessage({to: 'offscreen', type: 'remove', qid: item.qid})
    li.append(num, name)
    if (item.name) li.append(Object.assign(document.createElement('span'), {className: 'by', textContent: item.name}))
    li.append(x)
    return li
  }))
  $('queue-empty').hidden = queue.length > 0
  $('add').hidden = !state || !watchVid(tab?.url)
  $('skip').disabled = queue.length === 0
}

async function refresh() {
  status = await bg({type: 'status'})
  await render()
}

$('start').onclick = async () => {
  const r = await bg({type: 'join', roomId: newRoomId($('room-name').value), tabId: tab.id, settings: {public: $('list-publicly').checked, name: $('room-name').value.trim()}})
  if (r?.error) return showError(r.error)
  // A tab opened before the extension was installed or updated has no content
  // script, so nothing would ever put its video in the room. Do not leave an
  // empty room behind with an invite link that leads nowhere.
  const started = await chrome.tabs.sendMessage(tab.id, {type: 'start', roomId: r.roomId}).then(() => true, () => false)
  if (!started) {
    await bg({type: 'leave'})
    showError('Reload the YouTube tab, then try again.')
  }
  setTimeout(refresh, 200)
}

// Invite link, pasted code, and Rejoin all open the same hash. The content
// script joins and, once the room sends its video, opens that video.
async function openRoom(text) {
  let url
  try {
    url = new URL(text)
    if (!HOSTS.includes(url.host) || !url.hash.includes('jukebot=')) return showError('That is not a JukeBot invite link.')
  } catch {
    const here = watchVid(tab?.url) || HOSTS.includes(new URL(tab?.url ?? 'about:blank').host)
    url = new URL(here ? tab.url : 'https://music.youtube.com/')
    url.hash = `jukebot=${encodeURIComponent(text)}`
  }
  await chrome.tabs.update(tab.id, {url: url.href})
  window.close()
}

$('join').onclick = () => {
  const text = $('invite').value.trim()
  if (text) openRoom(text)
}

$('copy').onclick = async () => {
  await navigator.clipboard.writeText($('link').value)
  $('copy').textContent = 'Copied'
}

$('add').onclick = async () => {
  const r = await bg({type: 'add', url: tab.url})
  showError(r?.error ?? '')
}

$('skip').onclick = () => chrome.runtime.sendMessage({to: 'offscreen', type: 'skip'})

$('chat').onclick = async () => {
  await chrome.sidePanel.open({windowId: tab.windowId})
  window.close()
}

$('leave').onclick = async () => {
  await bg({type: 'leave'})
  await refresh()
}

// Knock needs a name the members can read, and a full room never takes one.
function syncKnock() {
  const named = $('my-name').value.trim() !== ''
  for (const button of document.querySelectorAll('#rooms button.knock')) button.disabled = button.dataset.full === 'true' || !named
}

async function loadRooms() {
  roomsLoaded = true
  $('refresh-rooms').disabled = true
  try {
    const rooms = await directory('/rooms')
    const {rememberedRooms = []} = await chrome.storage.local.get('rememberedRooms')
    $('rooms').replaceChildren(...rooms.map(room => {
      const li = document.createElement('li')
      li.className = 'room-row'
      const body = document.createElement('div')
      body.className = 'room'
      const name = document.createElement('div')
      name.className = 'one'
      name.textContent = room.name
      const title = document.createElement('div')
      title.className = 'one np'
      title.textContent = `Now: ${room.title || 'waiting for a song'}`
      body.append(name, title)
      const count = document.createElement('span')
      count.className = `count${room.count >= 12 ? ' full' : ''}`
      count.textContent = `${room.count}/12`
      const code = codeFor(rememberedRooms, room.lobby)
      const action = roomAction(room.count, code)
      const button = document.createElement('button')
      button.className = action === 'Rejoin' ? 'rejoin' : 'knock'
      button.textContent = action
      button.dataset.full = room.count >= 12
      button.onclick = async () => {
        if (action === 'Full') return
        if (action === 'Rejoin') {
          await chrome.storage.session.set({rejoinRoom: code})
          await openRoom(code)
          return
        }
        await bg({type: 'setName', name: $('my-name').value})
        const ok = await bg({type: 'knock', listing: room, tabId: tab.id})
        if (ok !== true) showError(ok?.error || 'Unable to knock. Refresh and try again.')
        await refresh()
      }
      li.append(body, count, button)
      return li
    }))
    syncKnock()
    $('rooms-note').textContent = rooms.length ? 'Someone in the room lets you in. Updated just now.' : 'No public rooms right now. Start one above.'
  } catch (error) {
    $('rooms-note').textContent = error.message
  } finally {
    $('refresh-rooms').disabled = false
  }
}

$('refresh-rooms').onclick = loadRooms
$('my-name').oninput = syncKnock
$('my-name').onchange = () => {
  if ($('my-name').value.trim()) bg({type: 'setName', name: $('my-name').value})
}
$('public').onchange = async () => {
  await chrome.runtime.sendMessage({to: 'offscreen', type: 'public', public: $('public').checked})
  await refresh()
}
for (const id of ['cancel-knock', 'back-rooms']) $(id).onclick = async () => {
  await chrome.runtime.sendMessage({to: 'offscreen', type: 'cancelKnock'})
  roomsLoaded = false
  await refresh()
}

async function showRejoinError() {
  const {rejoinError} = await chrome.storage.session.get('rejoinError')
  if (!rejoinError) return
  await chrome.storage.session.remove('rejoinError')
  showError(rejoinError)
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.to === 'popup' && msg.type === 'rejoinError') showRejoinError()
  if ((msg.to === 'bg' && msg.type === 'push') || msg.type === 'knocks') refresh()
})

window.newRoomId = newRoomId

Promise.all([chrome.tabs.query({active: true, currentWindow: true}), bg({type: 'profile'})]).then(([[t], profile]) => {
  tab = t
  $('my-name').value = profile?.name ?? ''
  showRejoinError()
  return refresh()
})
