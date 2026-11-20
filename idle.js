// Idle sharing: how long a machine may sit idle before this browser calls
// itself idle, and when a whole room counts as idle. No DOM and no extension
// APIs, so the service worker, the offscreen document, the side panel and the
// unit tests all load it.
//
// chrome.idle clamps its threshold to 15 seconds through 4 hours (14400), so
// the choices stay inside that range.

export const IDLE_DEFAULT = 2 * 60 * 60
export const IDLE_CHOICES = [
  [30 * 60, '30 minutes'],
  [60 * 60, '1 hour'],
  [2 * 60 * 60, '2 hours'],
  [4 * 60 * 60, '4 hours'],
  [0, 'Never']
]

// The stored setting in seconds: 0 turns idle tracking off, anything that is
// not one of the choices falls back to the default.
export function idleSeconds(stored) {
  return IDLE_CHOICES.some(([seconds]) => seconds === stored) ? stored : IDLE_DEFAULT
}

// chrome.idle states that count as idle.
export const isIdle = state => state === 'idle' || state === 'locked'

export const hasCap = (data, cap) => Array.isArray(data?.caps) && data.caps.includes(cap)

// The room is idle when this browser and every connected peer are idle. A peer
// that never said it is idle (older version, or active) counts as active.
export function roomIdle(selfIdle, peerIds, idlePeers) {
  return selfIdle && peerIds.every(peerId => idlePeers.has(peerId))
}
