// FEWER web server: serves the built page (gzip) and one endpoint, POST /api/guest, which
// creates a throwaway testnet account g<random>.befewer.testnet for a public key generated in
// the visitor's browser (the private key never leaves the browser). Testnet only.
// usage: PORT=5043 node server.mjs
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadAccount } from '../keeper/lib.mjs'

const PORT = Number(process.env.PORT || 5043)
const HOST = process.env.HOST || '127.0.0.1'
const ROOT_ACCOUNT = 'befewer.testnet'
const GUEST_NEAR = 5n * 10n ** 22n // 0.05 testnet NEAR for gas
const PER_IP_PER_HOUR = 3
const PER_DAY = 300
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.mp4': 'video/mp4' }

const cache = new Map() // path -> { raw, gz, type }
function file(p) {
  if (cache.has(p)) return cache.get(p)
  const full = path.join(DIST, p)
  if (!full.startsWith(DIST) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return null
  const raw = fs.readFileSync(full)
  const type = TYPES[path.extname(full)] || 'application/octet-stream'
  const entry = { raw, gz: /text|javascript|json|svg/.test(type) ? zlib.gzipSync(raw, { level: 9 }) : null, type }
  cache.set(p, entry)
  return entry
}

const hits = new Map() // ip -> [timestamps]
let day = { date: '', n: 0 }
function allowed(ip) {
  const now = Date.now()
  const today = new Date().toISOString().slice(0, 10)
  if (day.date !== today) day = { date: today, n: 0 }
  const list = (hits.get(ip) || []).filter(t => now - t < 3600_000)
  hits.set(ip, list)
  if (list.length >= PER_IP_PER_HOUR) return 'Too many guest accounts from your network this hour. Try again later.'
  if (day.n >= PER_DAY) return 'The guest faucet is out for today. Try again tomorrow.'
  return null
}

async function createGuest(publicKey) {
  const id = `g${crypto.randomBytes(6).toString('hex')}.${ROOT_ACCOUNT}`
  await loadAccount(ROOT_ACCOUNT).createSubAccount({ accountOrPrefix: id, publicKey, nearToTransfer: GUEST_NEAR })
  return id
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'POST' && url.pathname === '/api/guest') {
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress
    const origin = req.headers.origin
    if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'cross-site request' })
    let body = ''
    for await (const chunk of req) { body += chunk; if (body.length > 2000) return json(res, 413, { error: 'too large' }) }
    let pk
    try { pk = JSON.parse(body).publicKey } catch { return json(res, 400, { error: 'bad json' }) }
    if (typeof pk !== 'string' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(pk)) return json(res, 400, { error: 'publicKey must be ed25519:<base58>' })
    const why = allowed(ip)
    if (why) return json(res, 429, { error: why })
    try {
      const accountId = await createGuest(pk)
      hits.get(ip).push(Date.now())
      day.n += 1
      console.log(new Date().toISOString(), 'guest', accountId, 'for', ip)
      return json(res, 200, { accountId })
    } catch (e) {
      console.error(new Date().toISOString(), 'guest failed', e.message)
      return json(res, 502, { error: 'Could not create the account on testnet. Try again in a minute.' })
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' })
  const p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)
  const f = file(p) || file('/index.html')
  const gz = f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')
  res.writeHead(200, {
    'content-type': f.type,
    'cache-control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
    ...(gz ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}),
  })
  res.end(req.method === 'HEAD' ? undefined : gz ? f.gz : f.raw)
}).listen(PORT, HOST, () => console.log(`FEWER web on http://${HOST}:${PORT}`))
