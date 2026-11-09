// Autopilot keeps each account's slot across an account switch (11-09: a slot of the Autopilot
// remembered one account only, so wallet -> guest -> wallet opened a new slot each time and left
// the old one idle with its streak). Slot 0 has no rules; the second slot "Always B" bets 0.01 a round.
// A bets (opens a slot), switch to B (opens B's slot), back to A: A must bet from the slot it
// opened, and no other slot may be opened on A.
// usage: node e2e/account-switch.cjs <url> <accountA> <accountB>   (keys in ~/.near-credentials/testnet,
// both with ~0.1 NEAR game balance on v6; each run opens one slot on each, 0.002 NEAR each)
const puppeteer = require(process.env.PUPPETEER || 'puppeteer')
const fs = require('fs')
const [URL = 'http://127.0.0.1:5044/', A = 'cli1.befewer.testnet', B = 'walletqa.befewer.testnet'] = process.argv.slice(2)
const CONTRACT = 'v6.befewer.testnet'
const keyOf = id => JSON.parse(fs.readFileSync(require('os').homedir() + `/.near-credentials/testnet/${id}.json`, 'utf8'))
async function view(m, args) {
  for (const rpc of ['https://near-testnet.drpc.org', 'https://rpc.testnet.fastnear.com']) {
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: CONTRACT, method_name: m, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) })
      return JSON.parse(Buffer.from((await r.json()).result.result).toString())
    } catch {}
  }
  throw new Error(`view ${m} failed on every RPC`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const slotsOf = async id => (await view('get_player', { account_id: id })).slots
const lanes = [
  { name: 'Main', slots: {}, on: true, live: [] },
  { name: 'Always B', slots: {}, on: true, live: [{ cond: { kind: 'always' }, pick: 'loop', unit: 'fixed', amount: 1, pattern: 'B' }] },
]
let failed = false
const fail = m => { console.log('FAIL', m); failed = true }

;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 20 * 60_000 })
  const p = await b.newPage()
  const errors = []
  p.on('pageerror', e => errors.push(String(e)))
  await p.setViewport({ width: 1280, height: 900 })
  await p.goto(URL + '#/autopilot', { waitUntil: 'networkidle2' })
  const use = async (id, first) => {
    const k = keyOf(id)
    await p.evaluate((k, lanes, first, C) => {
      if (first) {
        localStorage.clear()
        localStorage.setItem('befewer.ap.lanes', JSON.stringify(lanes))
        localStorage.setItem('befewer.ap.on', '1')
        localStorage.setItem('befewer.ap.budget', JSON.stringify({ on: false, near: 0.8 }))
      }
      localStorage.setItem('fewer.session.' + C, JSON.stringify({ accountId: k.account_id, privateKey: k.private_key, kind: 'guest' }))
    }, k, lanes, first, CONTRACT)
    await p.reload({ waitUntil: 'networkidle2' })
  }
  const pageLog = () => p.$$eval('.log li', els => els.map(e => e.innerText.replace(/\s+/g, ' ')).slice(0, 3)).catch(() => [])
  // wait until `id` has a bet open on a slot that `test` accepts; stop early if `bad` says so
  async function waitFor(id, what, test, bad = () => '', ms = 9 * 60_000) {
    const t0 = Date.now()
    for (;;) {
      const s = await slotsOf(id)
      const why = bad(s)
      if (why) return { s, why }
      const hit = test(s)
      if (hit) { console.log(`${what}: after ${Math.round((Date.now() - t0) / 1000)} s`, JSON.stringify(hit)); return { s, hit } }
      if (Date.now() - t0 > ms) throw new Error(`${what}: nothing after ${ms / 1000} s; page log: ${JSON.stringify(await pageLog())}`)
      await sleep(4000)
    }
  }

  const a0 = (await slotsOf(A)).map(s => s.slot)
  const b0 = (await slotsOf(B)).map(s => s.slot)
  console.log(`before: ${A} slots ${a0.join(',')} · ${B} slots ${b0.join(',')}`)

  // 1. account A: the second slot opens a slot on A and bets
  await use(A, true)
  const one = await waitFor(A, `1. ${A} bets from a new slot`, s => s.filter(x => !a0.includes(x.slot) && x.open.length).map(x => ({ slot: x.slot, round: x.open[0].round }))[0])
  const aSlot = one.hit.slot, aRound = Number(one.hit.round)

  // 2. switch to account B (as a wallet disconnect does): it opens a slot on B and bets
  await use(B, false)
  await waitFor(B, `2. ${B} bets from a new slot`, s => s.filter(x => !b0.includes(x.slot) && x.open.length).map(x => ({ slot: x.slot, round: x.open[0].round }))[0])

  // 3. back to account A: the same slot bets again in a later round; no new slot on A
  await use(A, false)
  const three = await waitFor(A, `3. ${A} bets again from slot ${aSlot}`,
    s => s.find(x => x.slot === aSlot)?.open.filter(o => Number(o.round) > aRound).map(o => ({ slot: aSlot, round: o.round }))[0],
    s => { const extra = s.filter(x => !a0.includes(x.slot) && x.slot !== aSlot).map(x => x.slot); return extra.length ? `opened another slot on ${A}: ${extra.join(',')}` : '' })
  if (three.why) fail(three.why)

  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('befewer.ap.lanes'))[1])
  console.log('saved second slot:', JSON.stringify({ slots: saved.slots, slot: saved.slot, owner: saved.owner }))
  const tab = await p.$eval('.lanes', e => e.innerText.replace(/\s+/g, ' ')).catch(() => '')
  console.log('editor tabs:', tab)
  if (!failed && !tab.includes(`slot ${aSlot}`)) fail(`editor tab does not say slot ${aSlot}`)
  // switch the page's Autopilot off so these test accounts stop betting
  await p.evaluate(() => localStorage.setItem('befewer.ap.on', '0'))
  console.log('page log:', JSON.stringify(await pageLog()))
  console.log('errors:', errors.length ? errors : 'none')
  if (errors.length) fail('page errors')
  console.log(failed ? 'E2E FAILED' : 'E2E PASSED')
  process.exitCode = failed ? 1 : 0
  await b.close()
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
