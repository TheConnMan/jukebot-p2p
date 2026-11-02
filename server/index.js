import {DurableObject} from 'cloudflare:workers'

const TTL = 3 * 60 * 1000
const MAX_ROOMS = 32
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store'
}
const json = (body, status = 200) => Response.json(body, {status, headers: CORS})
const code = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{24,80}$/.test(value)
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec('CREATE TABLE IF NOT EXISTS rooms (key TEXT PRIMARY KEY, lobby TEXT UNIQUE NOT NULL, name TEXT NOT NULL, title TEXT NOT NULL, count INTEGER NOT NULL, seen INTEGER NOT NULL)')
  }

  async fetch(request) {
    const path = new URL(request.url).pathname
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: CORS})
    if (path !== '/rooms' && !/^\/rooms\/[a-zA-Z0-9_-]{24,80}$/.test(path)) return json({error: 'Not found'}, 404)
    this.sql.exec('DELETE FROM rooms WHERE seen <= ?', Date.now() - TTL)
    if (path === '/rooms' && request.method === 'GET') {
      return json([...this.sql.exec('SELECT lobby, name, title, count FROM rooms ORDER BY seen DESC, lobby')])
    }
    if (path === '/rooms' && request.method === 'POST') {
      if (Number(request.headers.get('Content-Length')) > 4096) return json({error: 'Body too large'}, 413)
      const reader = request.body?.getReader()
      const decoder = new TextDecoder()
      let raw = ''
      let size = 0
      if (reader) {
        while (true) {
          const {value, done} = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 4096) {
            await reader.cancel()
            return json({error: 'Body too large'}, 413)
          }
          raw += decoder.decode(value, {stream: true})
        }
      }
      raw += decoder.decode()
      let data
      try { data = JSON.parse(raw) } catch { return json({error: 'Invalid JSON'}, 400) }
      if (!data || !code(data.key) || !code(data.lobby) || !text(data.name, 80) || !text(data.title, 200) || !Number.isInteger(data.count) || data.count < 0 || data.count > 12) {
        return json({error: 'Invalid listing'}, 400)
      }
      const owner = this.sql.exec('SELECT key FROM rooms WHERE lobby = ?', data.lobby).toArray()[0]
      if (owner && owner.key !== data.key) return json({error: 'Wrong key'}, 403)
      const existing = this.sql.exec('SELECT lobby FROM rooms WHERE key = ?', data.key).toArray()[0]
      if (existing && existing.lobby !== data.lobby) return json({error: 'Key already in use'}, 409)
      if (!existing && this.sql.exec('SELECT COUNT(*) AS count FROM rooms').one().count >= MAX_ROOMS) return json({error: 'Directory full'}, 503)
      this.sql.exec('INSERT INTO rooms (key, lobby, name, title, count, seen) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name, title = excluded.title, count = excluded.count, seen = excluded.seen', data.key, data.lobby, data.name, data.title, data.count, Date.now())
      return json({ok: true}, existing ? 200 : 201)
    }
    if (path !== '/rooms' && request.method === 'DELETE') {
      const key = path.slice('/rooms/'.length)
      if (!this.sql.exec('SELECT key FROM rooms WHERE key = ?', key).toArray().length) return json({error: 'Unknown key'}, 404)
      this.sql.exec('DELETE FROM rooms WHERE key = ?', key)
      return json({ok: true})
    }
    return json({error: 'Method not allowed'}, 405)
  }
}

export default {
  fetch(request, env) {
    return env.DIRECTORY.get(env.DIRECTORY.idFromName('rooms')).fetch(request)
  }
}
