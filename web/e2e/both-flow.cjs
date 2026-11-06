// Autopilot "All squares": load the preset, put it live, switch on, wait for a both-sides bet.
// Then check on chain that this account bet A and the second account bet B, same amount, same round.
// usage: node e2e/both-flow.cjs <url> <contract>
const puppeteer = require('/root/dota/node_modules/puppeteer')
const URL = process.argv[2] || 'http://127.0.0.1:5044/'
const CONTRACT = process.argv[3] || 'v4.befewer.testnet'
const btn = (p, re) => p.evaluate(src => { const r = new RegExp(src); const b = [...document.querySelectorAll('button')].find(x => r.test(x.textContent)); if (!b) return false; b.click(); return true }, re.source)
async function view(method, args) {
  const res = await fetch('https://test.rpc.fastnear.com', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) })
  const j = await res.json()
  return JSON.parse(Buffer.from(j.result.result).toString())
}
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 15 * 60_000 })
  const p = await b.newPage()
  const errors = []
  p.on('pageerror', e => errors.push(String(e)))
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await p.goto(URL + '#/autopilot', { waitUntil: 'networkidle2' })
  await p.waitForSelector('.preset')
  const loaded = await p.evaluate(() => { const x = [...document.querySelectorAll('.preset')].find(x => /All squares/.test(x.textContent)); x?.click(); return !!x })
  if (!loaded) throw new Error('no All squares preset')
  console.log('preset card:', (await p.evaluate(() => [...document.querySelectorAll('.preset')].find(x => /All squares/.test(x.textContent)).innerText)).replace(/\s+/g, ' ').slice(0, 260))
  if (!(await btn(p, /Put these rules live/))) throw new Error('no put-live button')
  await new Promise(r => setTimeout(r, 300))
  if (!(await btn(p, /Yes, run these/))) throw new Error('no confirm button')
  console.log('replay kpis:', (await p.$eval('.kpis', e => e.innerText)).replace(/\s+/g, ' '))
  await p.evaluate(() => document.querySelector('.switch input').click())
  const t0 = Date.now()
  await p.waitForFunction(() => [...document.querySelectorAll('.log li')].some(li => /both sides|rror|small|closing/.test(li.innerText)), { timeout: 10 * 60_000, polling: 2000 })
  const line = await p.$eval('.log li', e => e.innerText.replace(/\s+/g, ' '))
  console.log(`autopilot after ${Math.round((Date.now() - t0) / 1000)} s:`, line)
  const ids = await p.evaluate(() => {
    const k = Object.keys(localStorage)
    const get = pre => JSON.parse(localStorage.getItem(k.find(x => x.startsWith(pre))) || 'null')?.accountId
    return { main: get('fewer.session.'), twin: get('fewer.twin.') }
  })
  console.log('accounts:', ids)
  for (const [who, id] of Object.entries(ids)) {
    const pl = await view('get_player', { account_id: id })
    console.log(who, 'open bets:', JSON.stringify(pl.open), 'balance', Number(BigInt(pl.balance) / 10n ** 18n) / 1e6)
  }
  await p.goto(URL + '#/me', { waitUntil: 'networkidle2' })
  await p.waitForSelector('.money')
  console.log('me twin card:', await p.$eval('.twin', e => e.innerText.replace(/\s+/g, ' ')).catch(() => 'MISSING'))
  console.log('errors:', errors.length ? errors : 'none')
  await b.close()
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
