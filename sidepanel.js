const $ = id => document.getElementById(id)

const TYPING_EVERY = 2000

let status = null
let userId = null
let lastTyping = 0
let shownLog = ''
let shownQueue = ''

const bg = msg => chrome.runtime.sendMessage({to: 'bg', ...msg})
const offscreen = msg => chrome.runtime.sendMessage({to: 'offscreen', ...msg})
const time = ts => new Date(ts).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const known = n => Number.isFinite(n) && n > 0
const position = s => s.pos + (s.playing ? (Date.now() - s.at) / 1000 : 0)

// A stable palette slot (u0 to u7 in the CSS) per userId.
function hue(id) {
  let h = 0
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return `u${h % 8}`
}

// A person's name in their color, marked when it is you.
function person(name, id) {
  const self = id === userId
  return el('span', `who ${hue(id)}`, `${name || 'someone'}${self ? ' (you)' : ''}`)
}

// While this port is open the service worker treats chat as read and holds
// back desktop notifications. Reconnect if the worker restarts.
function connect() {
  chrome.runtime.connect({name: 'sidepanel'}).onDisconnect.addListener(() => setTimeout(connect, 1000))
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function renderLog(chat, inRoom) {
  const key = inRoom ? chat.map(m => m.id).join() : 'out'
  if (key === shownLog) return
  shownLog = key
  const log = $('log')
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40
  if (!inRoom || !chat.length) {
    log.replaceChildren(el('p', 'empty', inRoom ? 'No messages yet.' : 'Start or join a room from the toolbar button to chat.'))
    return
  }
  log.replaceChildren(...chat.map(m => {
    if (m.kind === 'event') {
      // Lines that start with the actor's name show the name in their color.
      const div = el('div', 'msg event')
      if (m.name && m.text.startsWith(`${m.name} `)) div.append(person(m.name, m.by), m.text.slice(m.name.length))
      else div.append(m.text)
      div.append(el('span', 'ts', time(m.ts)))
      return div
    }
    const div = el('div', `msg ${hue(m.by)}${m.by === userId ? ' self' : ''}`)
    div.append(person(m.name, m.by), el('span', 'ts', time(m.ts)), el('div', 'text', m.text))
    return div
  }))
  if (atBottom) log.scrollTop = log.scrollHeight
}

// Rough wall-clock start for each queued video, from the current position and
// known durations. Unknown once any earlier duration is unknown or playback is paused.
function startTimes(state) {
  let left = state.playing && known(state.duration) ? state.duration - position(state) : null
  return state.queue.map(q => {
    const at = left == null ? null : Date.now() + left * 1000
    left = left != null && known(q.duration) ? left + q.duration : null
    return at
  })
}

function renderQueue(state) {
  const queue = state?.queue ?? []
  const starts = state ? startTimes(state) : []
  const key = JSON.stringify([queue, starts.map(t => t && time(t))])
  if (key === shownQueue) return
  shownQueue = key
  $('queue').replaceChildren(...queue.map((q, i) => {
    const li = el('li')
    const body = el('div', 'body')
    const name = el('div', 'one', q.title || q.id)
    name.title = q.title || q.id
    const meta = el('div', 'meta')
    if (q.name) meta.append('added by ', person(q.name, q.by))
    const rest = [known(q.duration) && clock(q.duration), starts[i] && `~${time(starts[i])}`].filter(Boolean).join(' · ')
    if (rest) meta.append(q.name ? ` · ${rest}` : rest)
    body.append(name, meta)
    const x = el('button', 'x', 'remove')
    x.onclick = () => offscreen({type: 'remove', qid: q.qid})
    li.append(el('span', 'num', i + 1), body, x)
    return li
  }))
  $('queue-empty').hidden = queue.length > 0
  $('skip').disabled = queue.length === 0
}

async function refresh() {
  status = await bg({type: 'status'})
  const inRoom = Boolean(status?.roomId)
  const pill = $('pill')
  pill.className = !inRoom ? 'pill' : status.peers ? 'pill ok' : 'pill live'
  pill.textContent = !inRoom ? 'no room' : status.peers ? `${status.peers + 1} listening` : 'waiting for friends'
  $('text').disabled = $('send').disabled = !inRoom
  $('here').hidden = $('up').hidden = !inRoom
  if (inRoom) {
    const here = status.members.flatMap((m, i) => [i ? ', ' : '', person(m.name, m.userId)])
    $('here').replaceChildren('Here: ', ...here)
    const s = status.state
    $('now-title').textContent = s?.v ? `Now: ${s.title || s.v}` : 'Now: waiting for the room'
    $('now-clock').textContent = !s?.v ? '' : `${known(s.duration) ? `${clock(position(s))} / ${clock(s.duration)}` : ''}${s.playing ? '' : ' paused'}`.trim()
  }
  renderQueue(inRoom ? status.state : null)
  renderLog(status?.chat ?? [], inRoom)
  const typing = inRoom ? status.typing : []
  $('typing').replaceChildren(...(typing.length ? [...typing.flatMap((t, i) => [i ? ', ' : '', person(t.name, t.userId)]), ` ${typing.length > 1 ? 'are' : 'is'} typing…`] : []))
}

function showError(text) {
  $('error').textContent = text
  $('error').hidden = !text
}

// The draft grows with its text up to the CSS max-height, then scrolls.
function fit() {
  const box = $('text')
  box.style.height = 'auto'
  box.style.height = `${box.scrollHeight + 2}px`
  box.style.overflowY = box.scrollHeight > box.clientHeight ? 'auto' : 'hidden'
}

$('form').onsubmit = async e => {
  e.preventDefault()
  const text = $('text').value.trim()
  if (!text) return
  $('text').value = ''
  fit()
  lastTyping = 0
  await offscreen({type: 'say', text})
}

$('text').onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    $('form').requestSubmit()
  }
}

$('text').oninput = () => {
  fit()
  if (!$('text').value || Date.now() - lastTyping < TYPING_EVERY) return
  lastTyping = Date.now()
  offscreen({type: 'typing'})
}

$('add-form').onsubmit = async e => {
  e.preventDefault()
  const url = $('link').value.trim()
  if (!url) return
  const r = await bg({type: 'add', url})
  showError(r?.error ?? '')
  if (!r?.error) $('link').value = ''
}

$('skip').onclick = () => offscreen({type: 'skip'})

$('name').onchange = () => bg({type: 'setName', name: $('name').value})

for (const [id, key] of [['notify-chat', 'notifyChat'], ['notify-songs', 'notifySongs'], ['notify-people', 'notifyPeople']]) {
  chrome.storage.local.get(key).then(stored => { $(id).checked = stored[key] !== false })
  $(id).onchange = () => chrome.storage.local.set({[key]: $(id).checked})
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'chat' || msg.type === 'typing' || msg.type === 'push') refresh()
  if (msg.type === 'typing') setTimeout(refresh, 4100)
})

// Keeps the "plays at" times and the playback clock current.
setInterval(() => { if (!document.hidden) refresh() }, 2000)

connect()
bg({type: 'profile'}).then(p => {
  userId = p.userId
  $('name').value = p.name
  refresh()
})
