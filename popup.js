import {videoId as watchVid} from './youtube.js'

const $ = id => document.getElementById(id)
const HOSTS = ['www.youtube.com', 'music.youtube.com']

let tab = null
let status = null

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
  $('out').hidden = inRoom
  $('in').hidden = !inRoom
  const pill = $('pill')
  if (!inRoom) {
    pill.className = 'pill'
    pill.textContent = 'no room'
    const canStart = Boolean(watchVid(tab?.url))
    $('start').hidden = !canStart
    $('room-name').hidden = !canStart
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
  const r = await bg({type: 'join', roomId: newRoomId($('room-name').value), tabId: tab.id})
  if (r?.error) return showError(r.error)
  await chrome.tabs.sendMessage(tab.id, {type: 'start', roomId: r.roomId}).catch(() => showError('Reload the YouTube tab, then try again.'))
  setTimeout(refresh, 200)
}

$('join').onclick = async () => {
  const text = $('invite').value.trim()
  if (!text) return
  let url
  try {
    url = new URL(text)
    if (!HOSTS.includes(url.host) || !url.hash.includes('jukebot=')) return showError('That is not a JukeBot invite link.')
  } catch {
    // A bare room code: join from this tab if it is YouTube, else open YouTube Music.
    const here = watchVid(tab?.url) || HOSTS.includes(new URL(tab?.url ?? 'about:blank').host)
    url = new URL(here ? tab.url : 'https://music.youtube.com/')
    url.hash = `jukebot=${encodeURIComponent(text)}`
  }
  await chrome.tabs.update(tab.id, {url: url.href})
  window.close()
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

chrome.runtime.onMessage.addListener(msg => {
  if (msg.to === 'bg' && msg.type === 'push') refresh()
})

window.newRoomId = newRoomId

chrome.tabs.query({active: true, currentWindow: true}).then(([t]) => {
  tab = t
  return refresh()
})
