// Emoji reactions on chat messages: the curated emoji set and the merge rules.
// No DOM and no extension APIs, so the offscreen document, the side panel and
// the unit tests all load it.
//
// A reaction record is {id, e, u, name, on, n}: message id, emoji, the
// reacting userId, their display name, whether the reaction is on, and a
// version. There is one record per (message, emoji, user). Only that user's
// browser writes it, and each write sets n to the larger of the clock and the
// last known n plus one. A record replaces the stored one when its n is
// higher; on a tie, off beats on and then the larger name wins. Records are
// never deleted while their message is kept (removing a reaction stores
// on: false), so peers that see the same records in any order, any number of
// times, end up with the same reactions.

export const QUICK = ['👍', '❤️', '😂', '🔥', '😮', '😢']
export const GRID = [
  '😀', '😄', '😁', '😅', '🤣', '😊', '😍', '🥰',
  '😎', '🤩', '🥳', '🤔', '😬', '😭', '😡', '🤯',
  '😱', '🙄', '👏', '🙌', '🙏', '💪', '👎', '👌',
  '✌️', '🤘', '👀', '💯', '✨', '🎉', '🎶', '🎸',
  '🎧', '🥁', '🎤', '💃', '🕺', '💀', '🍿', '☕'
]
export const EMOJI = [...QUICK, ...GRID]

const ALLOWED = new Set(EMOJI)
const ORDER = new Map(EMOJI.map((e, i) => [e, i]))

export const RECORDS_PER_MESSAGE = 100 // on and off records together
export const EMOJI_PER_MESSAGE = 20
export const PENDING_MESSAGES = 50 // reactions held for messages not seen yet
export const BATCH = 200 // records per wire message

const text = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null)

export function cleanRecord(r) {
  const id = text(r?.id, 40)
  const u = text(r?.u, 40)
  if (!id || !u || !ALLOWED.has(r.e) || typeof r.on !== 'boolean' || !Number.isSafeInteger(r.n) || r.n < 0) return null
  return {id, e: r.e, u, name: typeof r.name === 'string' ? r.name.slice(0, 40) : '', on: r.on, n: r.n}
}

// Whether record a replaces record b for the same (message, emoji, user).
export function wins(a, b) {
  if (a.n !== b.n) return a.n > b.n
  if (a.on !== b.on) return !a.on
  return a.name > b.name
}

const keyOf = r => `${r.e}\n${r.u}`

// Merge untrusted records into store (Map of message id to Map of key to
// record). With `from`, only records by that userId are taken (a live change
// must come from the person it is about). Returns how many records changed.
export function merge(store, list, from = null) {
  if (!Array.isArray(list)) return 0
  let changed = 0
  for (const raw of list.slice(0, BATCH)) {
    const r = cleanRecord(raw)
    if (!r || (from != null && r.u !== from)) continue
    let per = store.get(r.id)
    const had = per?.get(keyOf(r))
    if (had) {
      if (!wins(r, had)) continue
    } else {
      if (per && per.size >= RECORDS_PER_MESSAGE) continue
      if (per && ![...per.values()].some(x => x.e === r.e) && new Set([...per.values()].map(x => x.e)).size >= EMOJI_PER_MESSAGE) continue
      if (!per) store.set(r.id, (per = new Map()))
    }
    per.set(keyOf(r), r)
    changed++
  }
  return changed
}

// Flip this user's reaction. Returns the record to send, or null when the
// emoji is not allowed or the message is at its cap.
export function toggle(store, id, e, who, now = Date.now()) {
  const had = store.get(id)?.get(`${e}\n${who?.userId}`)
  const r = {id, e, u: who?.userId, name: who?.name ?? '', on: !had?.on, n: Math.max(now, (had?.n ?? 0) + 1)}
  return merge(store, [r]) ? store.get(id).get(keyOf(r)) : null
}

// Every record kept for these message ids, ready to send in BATCH-size pieces.
export function snapshot(store, ids) {
  const out = []
  for (const id of ids) for (const r of store.get(id)?.values() ?? []) out.push(r)
  const batches = []
  for (let i = 0; i < out.length; i += BATCH) batches.push(out.slice(i, i + BATCH))
  return batches
}

// Drop reactions on activity lines and on messages that left the chat log,
// keeping the newest PENDING_MESSAGES ids that have not arrived yet.
export function prune(store, chat, pending = PENDING_MESSAGES) {
  const kinds = new Map(chat.map(m => [m.id, m.kind === 'event' ? 'event' : 'message']))
  const waiting = []
  for (const id of store.keys()) {
    const kind = kinds.get(id)
    if (kind === 'event') store.delete(id)
    else if (!kind) waiting.push(id)
  }
  for (const id of waiting.slice(0, Math.max(0, waiting.length - pending))) store.delete(id)
}

// What the side panel draws: per message id, the emoji that are on, in the
// order they were first added, each with who added them (oldest first).
export function summarize(store, ids, nameFor = () => '') {
  const out = {}
  for (const id of ids) {
    const groups = new Map()
    for (const r of store.get(id)?.values() ?? []) {
      if (!r.on) continue
      if (!groups.has(r.e)) groups.set(r.e, [])
      groups.get(r.e).push(r)
    }
    if (!groups.size) continue
    const first = list => Math.min(...list.map(r => r.n))
    out[id] = [...groups]
      .sort(([ea, a], [eb, b]) => first(a) - first(b) || ORDER.get(ea) - ORDER.get(eb))
      .map(([e, list]) => ({
        e,
        users: list.sort((a, b) => a.n - b.n || (a.u < b.u ? -1 : 1)).map(r => ({u: r.u, name: nameFor(r.u) || r.name || 'someone'}))
      }))
  }
  return out
}
