// usage: node e2e/self-reveal.cjs <url>
// A new guest bets with the page open. The page's first reveal transaction is made to fail (every
// transaction it sends in the first seconds of the reveal window is aborted). The page must try
// again, reveal its own bet before a keeper does (30-60 s in), and count the reward it earned:
// the pick keeps it, Me says "you revealed it" and the net is stake-fee+reward (or -stake-fee+reward).
// About 5-6 minutes (one round). Exit 1 on any failed check.
const puppeteer = require(process.env.PUPPETEER || 'puppeteer')
const URL = process.argv[2] || 'http://127.0.0.1:5043/'
// how long after the first failed transaction every one keeps failing (all RPC fallbacks of one try)
const FAIL_MS = Number(process.env.FAIL_MS || 3000)
const fail = m => { console.log('FAIL', m); process.exitCode = 1 }
const near = y => Number(BigInt(y)) / 1e24
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 15 * 60_000 })
  const p = await b.newPage()
  const errors = []
  p.on('pageerror', e => errors.push(String(e)))
  const T = () => new Date().toISOString().slice(11, 19)
  if (process.env.VERBOSE) p.on('console', m => /reveal|warn|error/i.test(m.type() + m.text()) && console.log(T(), 'console', m.type(), m.text().slice(0, 300)))
  await p.setViewport({ width: 1280, height: 900 })
  // transactions (not view calls): answered with an RPC error while `armed` (a network abort is not
  // enough: the RPC client quietly resends), counted otherwise
  let armed = false, aborted = 0, sentInWindow = 0, inWindow = false, firstFail = 0, firstSent = 0
  await p.setRequestInterception(true)
  p.on('request', req => {
    const body = req.method() === 'POST' ? req.postData() || '' : ''
    if (/"method":"(send_tx|broadcast_tx_commit|broadcast_tx_async)"/.test(body)) {
      if (armed) {
        aborted++
        firstFail ||= Date.now()
        const id = (body.match(/"id":("?[\w-]+"?)/) || [])[1] || '"x"'
        return req.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
          body: `{"jsonrpc":"2.0","id":${id},"error":{"code":-32000,"message":"Server error","name":"HANDLER_ERROR","cause":{"name":"INVALID_TRANSACTION","info":{}},"data":"injected test failure"}}` })
      }
      if (inWindow) { sentInWindow++; firstSent ||= Date.now() }
      if (process.env.VERBOSE) console.log(T(), 'tx request', armed ? '(failed on purpose)' : '', 'to', req.url())
    }
    req.continue()
  })
  await p.goto(URL, { waitUntil: 'networkidle2' })
  await p.waitForSelector('.answer.A')
  await p.click('.answer.A')
  await p.click('.cta')
  await p.waitForFunction(() => document.querySelector('.sealed') || document.querySelector('.toast.err'), { timeout: 120000 })
  if (await p.$('.toast.err')) { console.log('bet failed:', await p.$eval('.toast.err', e => e.textContent)); process.exit(1) }
  const { acct, round } = await p.evaluate(() => {
    const g = window.befewer.game
    const pk = JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('fewer.picks.'))))
    return { acct: g.session.accountId, round: Math.max(...Object.keys(pk).map(Number)) }
  })
  console.log(`bet sealed: ${acct} round ${round}`)
  // from just before the reveal window opens, every transaction fails until FAIL_MS after the first
  // failure: the page's first reveal try (with all its RPC fallbacks) fails, a later one must not
  const { start, skew } = await p.evaluate(r => {
    const g = window.befewer.game, ms = ns => Number(BigInt(ns) / 1000000n)
    return { start: ms(g.params.genesis_ns) + (r + 1) * ms(g.params.commit_ns), skew: g.skew }
  }, round)
  const chain = () => Date.now() + skew
  while (chain() < start - 300) await new Promise(r => setTimeout(r, 100))
  const t0 = Date.now() - (chain() - start)
  armed = true; inWindow = true
  while (!(firstFail && Date.now() > firstFail + FAIL_MS) && chain() < start + 20000) await new Promise(r => setTimeout(r, 50))
  armed = false
  console.log(`reveal window open: failed ${aborted} transaction request(s), the first ${firstFail ? ((firstFail - t0) / 1000).toFixed(1) + ' s' : 'never'} into the window`)
  if (!aborted) fail('the page sent nothing to fail in the first 20 s (no reveal try?)')
  // the bet gets a side once someone reveals it
  await p.waitForFunction(r => window.befewer.game.me?.slots.some(s => s.open.some(o => Number(o.round) === r && o.side)), { timeout: 120000, polling: 500 }, round)
  const pick = await p.evaluate((a, r) => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('fewer.picks.'))))[r], acct, round)
  console.log(`revealed ${((Date.now() - t0) / 1000).toFixed(0)} s into the window · transactions the page sent after the failure: ${sentInWindow}${firstSent ? ` (first ${((firstSent - t0) / 1000).toFixed(1)} s in)` : ''} · reward kept with the pick: ${pick.bounty ? near(pick.bounty) : 'none'}`)
  if (!sentInWindow) fail('the page did not try again after the failed reveal')
  if (!pick.bounty || BigInt(pick.bounty) <= 0n) fail('no reveal reward recorded (a keeper revealed it, or the page did not read its events)')
  // the result, once the round settles
  await p.goto(URL + '#/me', { waitUntil: 'networkidle2' })
  await p.waitForFunction(r => Object.values(window.befewer.game.resultsBySlot).flat().some(x => x.round === r), { timeout: 8 * 60_000, polling: 1000 }, round)
  await new Promise(r => setTimeout(r, 800))
  const row = await p.evaluate(r => [...document.querySelectorAll('#me-results li')].find(li => li.innerText.includes('#' + r))?.innerText.replace(/\s+/g, ' '), round)
  const x = await p.evaluate(r => { const y = Object.values(window.befewer.game.resultsBySlot).flat().find(y => y.round === r); return { outcome: y.outcome, side: y.side } }, round)
  console.log(`result: picked ${x.side}, outcome ${x.outcome} | Me row: ${row}`)
  if (!row || !/you revealed it/.test(row)) fail('Me row does not say "you revealed it"')
  if (x.outcome !== 'void') {
    const amt = BigInt(pick.amount), fee = BigInt(pick.fee), bounty = BigInt(pick.bounty || 0)
    const want = near((x.outcome === x.side ? amt - fee : -(amt + fee)) + bounty)
    const shown = Number(row.match(/([+−])(\d+\.\d+)\s*$/)?.slice(1).join('').replace('−', '-'))
    console.log(`net: shown ${shown}, stake ${near(amt)} fee ${near(fee)} reward ${near(bounty)} -> expected ${want.toFixed(5)}`)
    if (!(Math.abs(shown - want) < 0.00006)) fail('net shown does not include the reward')
  }
  if (errors.length) fail(errors.slice(0, 3))
  await b.close()
  console.log(process.exitCode ? 'FAILED' : 'PASSED')
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
