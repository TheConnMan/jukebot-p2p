// Which tab a room join should use, and which tabs show the side panel.
// The content script runs only on www.youtube.com and music.youtube.com, so
// only those tabs can play for a room.

export const ROOM_HOSTS = ['www.youtube.com', 'music.youtube.com']
export const PANEL_PATH = 'sidepanel.html'

export function roomHost(url) {
  try {
    const host = new URL(url).host
    return ROOM_HOSTS.includes(host) ? host : null
  } catch {
    return null
  }
}

// Invite link, pasted code, or Rejoin.
// `reuse` means the active tab is already on youtube.com or music.youtube.com
// and should be navigated. Otherwise the caller opens `url` in a new tab.
export function roomNavigation({tabUrl, text, rejoin = false} = {}) {
  const raw = String(text ?? '').trim()
  let url
  try {
    url = new URL(raw)
    if (!ROOM_HOSTS.includes(url.host) || !url.hash.includes('jukebot=')) return {error: 'That is not a JukeBot invite link.'}
  } catch {
    url = new URL(roomHost(tabUrl) ? tabUrl : 'https://music.youtube.com/')
    url.hash = `jukebot=${encodeURIComponent(raw)}${rejoin ? '&rejoin=1' : ''}`
  }
  return {url: url.href, reuse: roomHost(tabUrl) != null}
}

export function watchUrl(site, id, t) {
  if (!ROOM_HOSTS.includes(site)) return null
  const seconds = Math.floor(Number(t))
  if (!Number.isFinite(seconds)) return null
  return `https://${site}/watch?v=${encodeURIComponent(id)}&t=${seconds}s`
}

// Side panel options to apply, in order.
// Chrome uses options with no tabId as the default for every tab that has
// none of its own. A tabId overrides that default. While a room is open the
// default is off and only the room tab is on, so other tabs hide the panel
// and the room tab shows it again. With no room the default is on, so the
// panel stays reachable from any tab. Tabs that were given their own options
// stay in `pinned`: an override outlives the default, so the next change has
// to set those tabs again.
export function panelOptions({roomTabId = null, pinned = []} = {}) {
  const known = [...new Set(pinned.filter(id => Number.isInteger(id)))]
  if (roomTabId == null) {
    return {
      set: [
        {path: PANEL_PATH, enabled: true},
        ...known.map(tabId => ({tabId, path: PANEL_PATH, enabled: true}))
      ],
      pinned: known
    }
  }
  const next = known.includes(roomTabId) ? known : [...known, roomTabId]
  return {
    set: [
      {enabled: false},
      {tabId: roomTabId, path: PANEL_PATH, enabled: true},
      ...next.filter(id => id !== roomTabId).map(tabId => ({tabId, enabled: false}))
    ],
    pinned: next
  }
}
