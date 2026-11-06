// Public rooms this browser has been in. The lobby id is what the directory
// lists; the code is the room secret an invite link carries.

const DAY = 24 * 60 * 60 * 1000
export const REMEMBER_FOR = 30 * DAY
export const REMEMBER_MAX = 50

const lobbyOk = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{24,80}$/.test(value)
const codeOk = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)

export function prune(list, now = Date.now()) {
  if (!Array.isArray(list)) return []
  return list
    .filter(entry => lobbyOk(entry?.lobby) && codeOk(entry?.code) && Number.isFinite(entry.at) && now - entry.at <= REMEMBER_FOR && entry.at <= now)
    .sort((a, b) => b.at - a.at)
    .slice(0, REMEMBER_MAX)
    .map(entry => ({lobby: entry.lobby, code: entry.code, at: entry.at}))
}

// Newest first. A repeat lobby replaces its older code and moves to the front.
export function remember(list, entry, now = Date.now()) {
  const kept = prune(list, now).filter(item => item.lobby !== entry?.lobby)
  if (!lobbyOk(entry?.lobby) || !codeOk(entry?.code)) return kept
  return [{lobby: entry.lobby, code: entry.code, at: now}, ...kept].slice(0, REMEMBER_MAX)
}

export function codeFor(list, lobby, now = Date.now()) {
  if (!lobbyOk(lobby)) return null
  return prune(list, now).find(entry => entry.lobby === lobby)?.code ?? null
}

// Full still wins over a remembered code. Strangers knock.
export function roomAction(count, code) {
  if (count >= 12) return 'Full'
  if (code) return 'Rejoin'
  return 'Knock'
}
