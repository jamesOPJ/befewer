// A guest wallet running out of gas money. Bet once (creates the guest), then:
//  1. leave the wallet ~0.03 NEAR free (less than a bet's 0.04 up front): the next bet must move
//     0.05 NEAR from the game balance to the wallet by itself and go through;
//  2. leave it ~0.01 free (too little even to move NEAR): the bet must fail with a message that
//     says so, not "Exceeded 3 providers".
// usage: node e2e/gas-topup.cjs <url>   (about 8 minutes: one bet per round)
const puppeteer = require('/root/dota/node_modules/puppeteer')
const { Account, JsonRpcProvider, KeyPairSigner, KeyPair } = require('/root/fewer/web/node_modules/near-api-js/lib/index.cjs')
const URL = process.argv[2] || 'http://127.0.0.1:5044/'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const rpc = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' })
const near = y => (Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(4)
async function free(id) {
  const a = await rpc.query({ request_type: 'view_account', finality: 'optimistic', account_id: id })
  return BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n
}
async function leaveFree(s, target) {
  const acct = new Account(s.accountId, rpc, new KeyPairSigner(KeyPair.fromString(s.privateKey)))
  for (let i = 0; i < 3; i++) {
    await sleep(4000) // unused gas of earlier transactions comes back a block or two later
    const send = (await free(s.accountId)) - target - 10n ** 21n // the transfer's own fee
    if (send <= 10n ** 21n) break
    await acct.transfer({ receiverId: 'befewer.testnet', amount: send })
  }
  return free(s.accountId)
}
async function bet(p, side) {
  // wait for a round this slot has not bet in yet, with time left
  await p.waitForFunction(() => {
    const g = window.befewer.game
    const r = Number(g.status?.commit_round), left = Number(BigInt(g.status?.commit_ends_at ?? 0) / 1000000n) - Date.now()
    return r && !(g.me?.open ?? []).some(o => Number(o.round) === r) && left > 40_000
  }, { timeout: 6 * 60_000, polling: 2000 })
  await p.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()))
  await p.tap(`.answer.${side}`); await p.tap('.cta')
  await p.waitForFunction(() => document.querySelector('.toast.err') || /^Sealed/.test(document.querySelector('.toast.ok')?.innerText ?? ''), { timeout: 120_000 })
  return {
    err: await p.$eval('.toast.err', e => e.innerText).catch(() => null),
    toasts: await p.$$eval('.toast', ts => ts.map(t => t.innerText.replace(/\s+/g, ' '))),
  }
}
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 15 * 60_000 })
  const p = await b.newPage()
  const errors = []
  p.on('pageerror', e => errors.push(String(e)))
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await p.goto(URL, { waitUntil: 'networkidle2' })
  await p.waitForSelector('.answer.B', { timeout: 120_000 })
  const r0 = await bet(p, 'B')
  if (r0.err) throw new Error('first bet failed: ' + r0.err)
  const s = await p.evaluate(() => ({ ...window.befewer.game.session }))
  console.log('guest', s.accountId, 'wallet free', near(await free(s.accountId)))

  let fails = 0
  console.log('step 1: wallet free now', near(await leaveFree(s, 3n * 10n ** 22n)))
  const r1 = await bet(p, 'A')
  await sleep(4000) // unused gas comes back a block or two later
  const f1 = await free(s.accountId)
  console.log('  bet:', r1.err ? `FAILED: ${r1.err}` : 'sealed', '| toasts:', r1.toasts.join(' / '), '| wallet free after', near(f1))
  if (r1.err || f1 < 4n * 10n ** 22n) { console.error('  E2E FAILED: the low wallet was not topped up'); fails++ }
  // one top-up of 0.05 lands near 0.08 free; two (a reveal and the bet both topping up) near 0.13
  if (f1 > 11n * 10n ** 22n) { console.error('  E2E FAILED: topped up more than once'); fails++ }

  console.log('step 2: wallet free now', near(await leaveFree(s, 10n ** 22n)))
  const r2 = await bet(p, 'B')
  console.log('  bet:', r2.err ? `failed: ${r2.err}` : 'sealed (unexpected)')
  if (!r2.err || /Exceeded \d+ providers/.test(r2.err) || !/wallet/i.test(r2.err)) { console.error('  E2E FAILED: no plain message for an empty wallet'); fails++ }

  console.log('errors:', errors.length ? errors : 'none')
  await b.close()
  process.exit(fails ? 1 : 0)
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
