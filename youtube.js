// YouTube helpers shared by the service worker and the offscreen document.

const ID = /^[A-Za-z0-9_-]{11}$/

export const validId = id => typeof id === 'string' && ID.test(id)

// Video id from a youtube.com, music.youtube.com, m.youtube.com or youtu.be link.
export function videoId(link) {
  try {
    const u = new URL(link)
    const id = u.host === 'youtu.be' ? u.pathname.slice(1) : /(^|\.)youtube\.com$/.test(u.host) ? u.searchParams.get('v') : null
    return validId(id) ? id : null
  } catch {
    return null
  }
}

const cache = new Map()

// Best-effort {title, duration} for a video. The title comes from YouTube's
// public oEmbed endpoint; the duration stays null until a player in the room
// loads the video and reports it.
export function lookup(id) {
  if (!cache.has(id)) cache.set(id, fetchInfo(id))
  return cache.get(id)
}

async function fetchInfo(id) {
  const watch = `https://www.youtube.com/watch?v=${id}`
  const title = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`)
    .then(r => (r.ok ? r.json() : null))
    .then(j => (typeof j?.title === 'string' ? j.title.slice(0, 200) : null))
    .catch(() => null)
  return {title, duration: null}
}
