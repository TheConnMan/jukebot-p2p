// When to notify, count unread chat, and which sound a batch earns.
// No DOM and no extension APIs, so the service worker and the unit tests
// both load it.

export const SONG_TAGS = ['add', 'play']
export const PEOPLE_TAGS = ['join', 'leave', 'rename', 'knock']

const SOUND_KEYS = {knock: 'soundKnock', ding: 'soundDing'}

// A panel is being watched only when its document is visible and its window
// is the focused one. A minimized window is not being watched.
export function isWatching(panel) {
  return Boolean(panel?.visible && panel?.focused && !panel?.minimized)
}

export function anyWatching(panels) {
  for (const panel of panels ?? []) if (isWatching(panel)) return true
  return false
}

export function startedWatching(before, after) {
  return !anyWatching(before) && anyWatching(after)
}

export function applyWatch(info, msg) {
  const next = {...info}
  if (typeof msg?.visible === 'boolean') next.visible = msg.visible
  if (Number.isInteger(msg?.windowId)) next.windowId = msg.windowId
  if (typeof msg?.focused === 'boolean') next.focused = msg.focused
  if (typeof msg?.minimized === 'boolean') next.minimized = msg.minimized
  return next
}

// Refresh focused and minimized from a chrome.windows.Window of this panel.
export function applyFocus(info, win) {
  if (!win || win.id !== info?.windowId) return info
  return {...info, focused: win.focused === true, minimized: win.state === 'minimized'}
}

export function incomingParts(messages) {
  const list = Array.isArray(messages) ? messages : []
  return {
    chats: list.filter(m => m?.kind !== 'event'),
    songs: list.filter(m => m?.kind === 'event' && SONG_TAGS.includes(m.tag)),
    people: list.filter(m => m?.kind === 'event' && PEOPLE_TAGS.includes(m.tag))
  }
}

// Missing switches stay on. A stored false is the only off.
export function noticesFor(parts, prefs) {
  return [
    ...(prefs?.notifyChat !== false ? parts.chats : []),
    ...(prefs?.notifySongs !== false ? parts.songs : []),
    ...(prefs?.notifyPeople !== false ? parts.people : [])
  ]
}

// One ding for the batch when it shows anything that is not a knock.
// A knock-only batch stays quiet here. The knock sound is requested apart
// from notifications, including while the panel is watched.
export function dingFor(notices) {
  return notices.some(m => m?.tag !== 'knock')
}

export function soundOn(stored, name) {
  const key = SOUND_KEYS[name]
  return key != null && stored?.[key] !== false
}

// What incoming() should do for this batch. While someone is watching,
// chat counts as read and nothing is shown. sound is 'ding' or null, once
// for the whole batch.
export function delivery(messages, prefs, panels) {
  if (anyWatching(panels)) return {unread: 0, notices: [], sound: null}
  const parts = incomingParts(messages)
  const notices = noticesFor(parts, prefs)
  return {unread: parts.chats.length, notices, sound: notices.length && dingFor(notices) ? 'ding' : null}
}
