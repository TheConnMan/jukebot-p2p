const $ = id => document.getElementById(id)
const HOSTS = ['www.youtube.com', 'music.youtube.com']

let tab = null
let status = null

const bg = msg => chrome.runtime.sendMessage({to: 'bg', ...msg})
const watchVid = url => {
  try {
    const u = new URL(url)
    return HOSTS.includes(u.host) ? u.searchParams.get('v') : null
  } catch {
    return null
  }
}

function newRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
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
    $('start-hint').hidden = canStart
    return
  }
  const {state, peers, roomId, tabId} = status
  pill.className = peers ? 'pill ok' : 'pill live'
  pill.textContent = peers ? `${peers + 1} listening` : state ? 'waiting for friends' : 'connecting'
  const roomTab = await chrome.tabs.get(tabId).catch(() => null)
  const host = roomTab ? new URL(roomTab.url).host : 'music.youtube.com'
  $('link').value = state?.v ? `https://${host}/watch?v=${state.v}#jukebot=${roomId}` : roomId
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
    name.title = item.title || item.id
    const x = document.createElement('button')
    x.className = 'x'
    x.textContent = 'remove'
    x.onclick = () => setQueue(queue.filter((_, j) => j !== i))
    li.append(num, name, x)
    return li
  }))
  $('queue-empty').hidden = queue.length > 0
  $('add').hidden = !state || !watchVid(tab?.url)
}

async function refresh() {
  status = await bg({type: 'status'})
  await render()
}

function setQueue(queue) {
  chrome.runtime.sendMessage({to: 'offscreen', type: 'update', patch: {queue}})
}

$('start').onclick = async () => {
  const r = await bg({type: 'join', roomId: newRoomId(), tabId: tab.id})
  if (r?.error) return showError(r.error)
  await chrome.tabs.sendMessage(tab.id, {type: 'start'}).catch(() => showError('Reload the YouTube tab, then try again.'))
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
  const snap = await chrome.tabs.sendMessage(tab.id, {type: 'snapshot'}).catch(() => null)
  if (!snap?.v) return showError('Could not read the video in this tab.')
  setQueue([...(status.state?.queue ?? []), {id: snap.v, title: snap.title}])
}

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

chrome.tabs.query({active: true, currentWindow: true}).then(([t]) => {
  tab = t
  return refresh()
})
