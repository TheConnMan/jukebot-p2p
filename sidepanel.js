import {GRID, QUICK} from './reactions.js'

const $ = id => document.getElementById(id)

const TYPING_EVERY = 2000

let status = null
let userId = null
let lastTyping = 0
let shownLog = ''
let shownQueue = ''
let shownKnocks = ''
let reactions = {}
let picking = null // {id, button} while the reaction picker is open

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
function person(name, id, self = id === userId) {
  return el('span', `who ${hue(id)}`, `${name || 'someone'}${self ? ' (you)' : ''}`)
}

// The service worker treats chat as read only while this document is visible
// and its window is focused. Reconnect if the worker restarts.
let panelPort = null

function connect() {
  panelPort = chrome.runtime.connect({name: 'sidepanel'})
  panelPort.onDisconnect.addListener(() => {
    panelPort = null
    setTimeout(connect, 1000)
  })
  reportWatch()
}

async function reportWatch() {
  const port = panelPort
  if (!port) return
  const win = await chrome.windows.getCurrent().catch(() => null)
  if (port !== panelPort) return
  try {
    port.postMessage({
      visible: document.visibilityState === 'visible',
      windowId: win?.id ?? null,
      focused: win?.focused === true,
      minimized: win?.state === 'minimized'
    })
  } catch {}
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

const SMILEY = 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Zm-3.5-7.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01'

function smiley() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  for (const [k, v] of Object.entries({d: SMILEY, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'})) path.setAttribute(k, v)
  svg.append(path)
  return svg
}

const react = (id, emoji) => offscreen({type: 'react', id, emoji})

// Chips under a message: emoji and count, yours highlighted, names on hover.
function chips(id) {
  const list = reactions[id] ?? []
  if (!list.length) return []
  const row = el('div', 'reactions')
  row.append(...list.map(({e, users}) => {
    const mine = users.some(u => u.u === userId)
    const chip = el('button', `chip${mine ? ' mine' : ''}`)
    chip.append(el('span', 'e', e), el('span', 'n', users.length))
    const names = users.map(u => (u.u === userId ? 'you' : u.name))
    chip.title = `${names.join(', ')} reacted with ${e}`
    chip.setAttribute('aria-label', `${e} ${users.length}, ${chip.title}${mine ? '. Click to remove yours' : ''}`)
    chip.setAttribute('aria-pressed', String(mine))
    chip.onclick = () => react(id, e)
    return chip
  }))
  return [row]
}

function addButton(id) {
  const button = el('button', 'react-add')
  button.type = 'button'
  button.dataset.id = id
  button.title = 'Add reaction'
  button.setAttribute('aria-label', 'Add reaction')
  button.append(smiley())
  button.onclick = () => (picking?.id === id ? closePicker() : openPicker(id, button))
  if (picking?.id === id) {
    button.classList.add('open')
    picking.button = button
  }
  return button
}

function renderLog(chat, inRoom) {
  const key = inRoom ? JSON.stringify([userId, chat.map(m => m.id), reactions]) : 'out'
  if (key === shownLog) return
  shownLog = key
  const log = $('log')
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40
  if (!inRoom || !chat.length) {
    log.replaceChildren(el('p', 'empty', inRoom ? 'No messages yet.' : 'Start or join a room from the toolbar button to chat.'))
    closePicker(false)
    return
  }
  log.replaceChildren(...chat.map(m => {
    if (m.kind === 'event') {
      // Lines that start with the actor's name show the name in their color.
      const div = el('div', 'msg event')
      if (m.name && m.text.startsWith(`${m.name} `)) div.append(person(m.name, m.by, m.self === true), m.text.slice(m.name.length))
      else div.append(m.text)
      return div
    }
    const div = el('div', `msg chat ${hue(m.by)}`)
    div.append(person(m.name, m.by, m.self === true), el('span', 'ts', time(m.ts)), el('div', 'text', m.text), ...chips(m.id), addButton(m.id))
    return div
  }))
  if (atBottom) log.scrollTop = log.scrollHeight
  if (picking && !chat.some(m => m.id === picking.id && m.kind !== 'event')) closePicker()
  else placePicker()
}

// One picker for the whole log, fixed to the viewport next to the button that
// opened it, so it stays open while the log redraws.
function buildPicker() {
  const pick = e => {
    const button = el('button', '', e)
    button.type = 'button'
    button.dataset.e = e
    button.title = e
    button.onclick = () => {
      const id = picking?.id
      closePicker(false)
      if (id) react(id, e)
    }
    return button
  }
  $('picker').querySelector('.quick').replaceChildren(...QUICK.map(pick))
  $('picker').querySelector('.grid').replaceChildren(...GRID.map(pick))
}

function openPicker(id, button) {
  closePicker(false)
  picking = {id, button}
  button.classList.add('open')
  const mine = new Set((reactions[id] ?? []).filter(r => r.users.some(u => u.u === userId)).map(r => r.e))
  for (const b of $('picker').querySelectorAll('button')) b.classList.toggle('mine', mine.has(b.dataset.e))
  $('picker').hidden = false
  placePicker()
  $('picker').querySelector('button').focus({preventScroll: true})
}

function placePicker() {
  if (!picking) return
  const picker = $('picker')
  const log = $('log').getBoundingClientRect()
  const at = picking.button.getBoundingClientRect()
  if (!picking.button.isConnected || at.bottom < log.top || at.top > log.bottom) return closePicker(false)
  const {offsetWidth: w, offsetHeight: h} = picker
  const left = Math.max(8, Math.min(at.right - w, innerWidth - w - 8))
  let top = at.bottom + 4
  if (top + h > innerHeight - 8) top = Math.max(8, at.top - h - 4)
  picker.style.left = `${left}px`
  picker.style.top = `${top}px`
}

function closePicker(refocus = true) {
  if (!picking) return
  const {button} = picking
  picking = null
  $('picker').hidden = true
  button.classList.remove('open')
  if (refocus && button.isConnected) button.focus({preventScroll: true})
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

function renderKnocks(knocks, count) {
  const key = JSON.stringify([knocks, count])
  if (key === shownKnocks) return
  shownKnocks = key
  $('knocks').replaceChildren(...knocks.map(knock => {
    const card = el('div', 'knock')
    card.dataset.id = knock.id
    const title = el('div')
    title.append(person(knock.name, knock.peerId, false), ' wants to join')
    const buttons = el('div', 'row')
    const admit = el('button', 'primary', 'Let in')
    admit.disabled = count >= 12
    admit.onclick = () => offscreen({type: 'answer', id: knock.id, accept: true})
    const decline = el('button', '', 'Decline')
    decline.onclick = () => offscreen({type: 'answer', id: knock.id, accept: false})
    buttons.append(admit, decline)
    card.append(title, el('div', 'meta', `Knocked from Public rooms · ${count}/12 here`), buttons)
    return card
  }))
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
  renderKnocks(inRoom ? status.knocks : [], (status?.peers ?? 0) + 1)
  renderQueue(inRoom ? status.state : null)
  reactions = inRoom ? status.reactions ?? {} : {}
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

buildPicker()
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && picking) {
    e.preventDefault()
    closePicker()
  }
})
document.addEventListener('pointerdown', e => {
  if (picking && !$('picker').contains(e.target) && !e.target.closest?.('.react-add')) closePicker(false)
})
$('log').addEventListener('scroll', placePicker)
addEventListener('resize', placePicker)

$('name').onchange = () => bg({type: 'setName', name: $('name').value})

for (const [id, key] of [['notify-chat', 'notifyChat'], ['notify-songs', 'notifySongs'], ['notify-people', 'notifyPeople'], ['sound-knock', 'soundKnock'], ['sound-ding', 'soundDing']]) {
  chrome.storage.local.get(key).then(stored => { $(id).checked = stored[key] !== false })
  $(id).onchange = () => chrome.storage.local.set({[key]: $(id).checked})
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'chat' || msg.type === 'typing' || msg.type === 'push' || msg.type === 'knocks') refresh()
  if (msg.type === 'typing') setTimeout(refresh, 4100)
})

// Keeps the "plays at" times and the playback clock current.
setInterval(() => { if (!document.hidden) refresh() }, 2000)

document.addEventListener('visibilitychange', () => reportWatch())
chrome.windows.onFocusChanged.addListener(() => reportWatch())

connect()
bg({type: 'profile'}).then(p => {
  userId = p.userId
  $('name').value = p.name
  refresh()
})
