// BEFEWER web server: serves the built page (gzip) and one endpoint, POST /api/guest, which
// creates a throwaway testnet account g<random>.befewer.testnet for a public key generated in
// the visitor's browser (the private key never leaves the browser) and deposits a little
// testnet NEAR into its game balance so it can play right away. Testnet only.
// usage: PORT=5043 node server.mjs
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadAccount, view, NEAR } from '../keeper/lib.mjs'

const PORT = Number(process.env.PORT || 5043)
const HOST = process.env.HOST || '127.0.0.1'
const ROOT_ACCOUNT = 'befewer.testnet'
const CONTRACT = process.env.FEWER_CONTRACT || 'v6.befewer.testnet'
const GUEST_NEAR = NEAR / 20n // 0.05 testnet NEAR in the wallet, for gas
const GUEST_PLAY = (NEAR * 3n) / 10n // 0.3 testnet NEAR in the game balance (0.01 of it pays the storage fee)
const PER_IP_PER_HOUR = 3
const PER_DAY = 60
// Pages that may call /api/guest besides this server's own host. claude.aifinode.xyz/p/5043/ is
// the owner's password-gated preview proxy (it rewrites Host to 127.0.0.1:5043 but keeps Origin).
const ORIGINS = (process.env.FEWER_ORIGINS || 'https://befewer.com,https://www.befewer.com,https://claude.aifinode.xyz').split(',')
// No Origin is trusted for the rate limits: any program can send any Origin header, so an
// exemption by Origin let anyone create guests without limit (and empty the faucet account).
const DIST = process.env.FEWER_DIST || path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.mp4': 'video/mp4' }

const cache = new Map() // path -> { raw, gz, type }
function file(p) {
  if (cache.has(p)) return cache.get(p)
  const full = path.join(DIST, p)
  if (!full.startsWith(DIST + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return null
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

// Guests are created one at a time: two transactions signed by the root key at once collide on
// the key's nonce and one of them fails. A failed attempt is retried once.
let queue = Promise.resolve()
const serial = fn => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p }
async function createGuestOnce(publicKey) {
  const id = `g${crypto.randomBytes(6).toString('hex')}.${ROOT_ACCOUNT}`
  const root = loadAccount(ROOT_ACCOUNT)
  await root.createSubAccount({ accountOrPrefix: id, publicKey, nearToTransfer: GUEST_NEAR })
  await root.callFunction({ contractId: CONTRACT, methodName: 'deposit', args: { account_id: id }, gas: 30_000_000_000_000n, deposit: GUEST_PLAY })
  return id
}
function createGuest(publicKey) {
  return serial(async () => {
    try {
      return await createGuestOnce(publicKey)
    } catch (e) {
      console.error(new Date().toISOString(), 'guest attempt failed, retrying', e.message)
      await new Promise(r => setTimeout(r, 1500))
      return createGuestOnce(publicKey)
    }
  })
}

// GET /api/totals: all-time totals of the settled rounds (the Rounds page tiles). A browser only
// holds the latest few hundred rounds, so the server reads every round once, keeps the counts in
// a file and afterwards only reads the rounds newer than the last one it counted. Read-only.
const TALLY_FILE = process.env.FEWER_TALLY || path.join(path.dirname(fileURLToPath(import.meta.url)), `.tally.${CONTRACT}.json`)
const EMPTY = { through: -1, rounds: 0, A: 0, B: 0, void: 0, treasury: '0', mined: '0', minedRounds: 0, last: null }
let tally = { ...EMPTY }
try { tally = { ...EMPTY, ...JSON.parse(fs.readFileSync(TALLY_FILE, 'utf8')) } } catch {}
let tallyAt = 0
let tallyRun = null
async function refreshTally() {
  const cur = Number((await view(CONTRACT, 'get_status')).commit_round)
  // get_rounds(from, 50) returns the rounds at or below `from` that have bets, newest first;
  // stepping `from` down by 50 covers every round
  const froms = []
  for (let from = cur; from > tally.through; from -= 50) froms.push(from)
  const got = new Map()
  for (let i = 0; i < froms.length; i += 3) {
    const pages = await Promise.all(froms.slice(i, i + 3).map(from => view(CONTRACT, 'get_rounds', { from: String(from), limit: 50 })))
    for (const r of pages.flat()) got.set(Number(r.round), r)
  }
  // count in round order, stopping at the first round with bets that is not settled yet; a round
  // below the betting round with no record never had a bet and never will
  const t = { ...tally }
  let treasury = BigInt(t.treasury), mined = BigInt(t.mined)
  for (let r = t.through + 1; r < cur; r++) {
    const x = got.get(r)
    if (x && x.commits > 0) {
      if (!x.settled) break
      t.rounds++
      if (x.outcome === 'A' || x.outcome === 'B' || x.outcome === 'void') t[x.outcome]++
      treasury += BigInt(x.to_treasury)
      if (BigInt(x.reward) > 0n) { mined += BigInt(x.reward); t.minedRounds++; t.last = r }
    }
    t.through = r
  }
  t.treasury = String(treasury)
  t.mined = String(mined)
  if (t.through !== tally.through) {
    tally = t
    fs.writeFileSync(TALLY_FILE + '.tmp', JSON.stringify(tally))
    fs.renameSync(TALLY_FILE + '.tmp', TALLY_FILE)
  }
  tallyAt = Date.now()
}
/** The counts so far; reads newer rounds at most every 15 s. The very first count (every round,
 *  a few seconds) is waited for; later ones run in the background and answer with what is known. */
async function totals() {
  if (Date.now() - tallyAt > 15_000) {
    tallyAt = Date.now()
    tallyRun ??= refreshTally().catch(e => console.error(new Date().toISOString(), 'totals failed', e.message)).finally(() => { tallyRun = null })
  }
  if (tally.through < 0 && tallyRun) await tallyRun
  return tally
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function reject(res, req, code, error) {
  console.log(new Date().toISOString(), 'reject', code, req.method, req.url, 'host', req.headers.host, 'origin', req.headers.origin, error)
  return json(res, code, { error })
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (!url.pathname.startsWith('/assets/')) console.log(new Date().toISOString(), req.method, url.pathname, 'via', req.headers['cf-connecting-ip'] ? 'cloudflare' : req.socket.remoteAddress, 'host', req.headers.host, (req.headers['user-agent'] || '').slice(0, 60))
  if (req.method === 'POST' && url.pathname === '/api/guest') {
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress
    const origin = req.headers.origin
    let originHost = null
    try { originHost = origin && origin !== 'null' ? new URL(origin).host : null } catch { originHost = 'invalid' }
    const hosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean)
    const sameSite = !originHost || hosts.includes(originHost) || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(originHost) || ORIGINS.includes(origin)
    if (!sameSite) return reject(res, req, 403, 'cross-site request')
    let body = ''
    for await (const chunk of req) { body += chunk; if (body.length > 2000) return reject(res, req, 413, 'too large') }
    let pk
    try { pk = JSON.parse(body).publicKey } catch { return reject(res, req, 400, 'bad json') }
    if (typeof pk !== 'string' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(pk)) return reject(res, req, 400, 'publicKey must be ed25519:<base58>')
    // loopback without a Cloudflare header = someone on this machine or an SSH tunnel: not rate limited
    const local = !req.headers['cf-connecting-ip'] && /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(req.socket.remoteAddress || '')
    const why = local ? null : allowed(ip)
    if (why) return reject(res, req, 429, why)
    try {
      const accountId = await createGuest(pk)
      if (!local) hits.get(ip).push(Date.now())
      day.n += 1
      console.log(new Date().toISOString(), 'guest', accountId, 'for', ip)
      return json(res, 200, { accountId })
    } catch (e) {
      console.error(new Date().toISOString(), 'guest failed', e.message)
      return json(res, 502, { error: 'Could not create the account on testnet. Try again in a minute.' })
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' })
  if (url.pathname === '/api/totals') {
    const t = await totals()
    return t.through < 0 ? json(res, 503, { error: 'totals not counted yet' }) : json(res, 200, t)
  }
  const p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)
  const f = file(p) || file('/index.html')
  const gz = f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')
  res.writeHead(200, {
    'content-type': f.type,
    'cache-control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "frame-ancestors 'none'",
    ...(gz ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}),
  })
  res.end(req.method === 'HEAD' ? undefined : gz ? f.gz : f.raw)
}).listen(PORT, HOST, () => console.log(`FEWER web on http://${HOST}:${PORT}`))
