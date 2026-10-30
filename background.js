// Service worker: owns the offscreen document (which holds the WebRTC room,
// since service workers have no RTCPeerConnection) and relays room state from
// it to the one tab that is playing for the room.

let creating = null

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

async function status() {
  if (!(await chrome.offscreen.hasDocument())) return null
  return toOffscreen({type: 'status'})
}

async function join(roomId, tabId) {
  await ensureOffscreen()
  return toOffscreen({type: 'join', roomId, tabId})
}

async function leave() {
  const s = await status()
  if (!s) return
  await toOffscreen({type: 'leave'})
  await chrome.offscreen.closeDocument()
  chrome.action.setBadgeText({text: ''})
  if (s.tabId != null) chrome.tabs.sendMessage(s.tabId, {type: 'left'}).catch(() => {})
}

function push({tabId, state, peers}) {
  chrome.tabs.sendMessage(tabId, {type: 'state', state}).catch(() => {})
  chrome.action.setBadgeBackgroundColor({color: '#efb146'})
  chrome.action.setBadgeText({text: String(peers + 1)})
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.to !== 'bg') return false
  if (msg.type === 'push') {
    push(msg)
    return false
  }
  const tabId = msg.tabId ?? sender.tab?.id
  const work = {
    join: () => join(msg.roomId, tabId),
    leave,
    status
  }[msg.type]
  if (!work) return false
  work().then(reply, err => reply({error: String(err)}))
  return true
})

chrome.tabs.onRemoved.addListener(async tabId => {
  const s = await status()
  if (s?.tabId === tabId) leave()
})
