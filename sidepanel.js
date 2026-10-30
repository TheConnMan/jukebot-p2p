const $ = id => document.getElementById(id)

let status = null
let userId = null // stable per profile, so your own messages stay yours across rejoins

const time = ts => new Date(ts).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})

async function refresh() {
  status = await chrome.runtime.sendMessage({to: 'bg', type: 'status'})
  const inRoom = Boolean(status?.roomId)
  const pill = $('pill')
  pill.className = !inRoom ? 'pill' : status.peers ? 'pill ok' : 'pill live'
  pill.textContent = !inRoom ? 'no room' : status.peers ? `${status.peers + 1} listening` : 'waiting for friends'
  $('text').disabled = $('send').disabled = !inRoom

  const log = $('log')
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40
  const chat = status?.chat ?? []
  if (!inRoom || !chat.length) {
    const p = document.createElement('p')
    p.className = 'empty'
    p.textContent = inRoom ? 'No messages yet.' : 'Start or join a room from the toolbar button to chat.'
    log.replaceChildren(p)
    return
  }
  log.replaceChildren(...chat.map(m => {
    const div = document.createElement('div')
    div.className = 'msg'
    const who = document.createElement('span')
    who.className = m.by === userId ? 'who self' : 'who'
    who.textContent = m.name || 'someone'
    const ts = document.createElement('span')
    ts.className = 'ts'
    ts.textContent = time(m.ts)
    const text = document.createElement('div')
    text.textContent = m.text
    div.append(who, ts, text)
    return div
  }))
  if (atBottom) log.scrollTop = log.scrollHeight
}

$('form').onsubmit = async e => {
  e.preventDefault()
  const text = $('text').value.trim()
  if (!text) return
  $('text').value = ''
  await chrome.runtime.sendMessage({to: 'offscreen', type: 'say', by: userId, name: $('name').value.trim(), text})
}

$('name').onchange = () => chrome.storage.local.set({name: $('name').value.trim()})

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'chat' || msg.type === 'push') refresh()
})

chrome.storage.local.get(['name', 'userId']).then(stored => {
  const name = stored.name || `friend-${Math.random().toString(16).slice(2, 6)}`
  userId = stored.userId || crypto.randomUUID()
  chrome.storage.local.set({name, userId})
  $('name').value = name
  refresh()
})
