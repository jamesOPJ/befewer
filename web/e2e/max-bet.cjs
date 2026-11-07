// No 25% cap: the "Max" stake is what the balance covers after the fee and storage, and the
// contract takes it. First bet creates the guest; next round bet Max.
// usage: node e2e/max-bet.cjs <url>   (about 4 minutes)
const puppeteer = require('/root/dota/node_modules/puppeteer')
const URL = process.argv[2] || 'http://127.0.0.1:5044/'
const near = y => (Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(4)
async function waitRound(p, after = -1) {
  await p.waitForFunction(after => {
    const g = window.befewer.game
    const r = Number(g.status?.commit_round), left = Number(BigInt(g.status?.commit_ends_at ?? 0) / 1000000n) - Date.now()
    return r > after && !(g.me?.open ?? []).some(o => Number(o.round) === r) && left > 40_000 && !g.busy
  }, { timeout: 6 * 60_000, polling: 2000 }, after)
  await p.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()))
}
const outcome = p => p.waitForFunction(() => document.querySelector('.toast.err') || /^Sealed/.test(document.querySelector('.toast.ok')?.innerText ?? ''), { timeout: 120_000 })
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 10 * 60_000 })
  const p = await b.newPage()
  const errors = []
  p.on('pageerror', e => errors.push(String(e)))
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await p.goto(URL, { waitUntil: 'networkidle2' })
  await p.waitForSelector('.answer.B', { timeout: 120_000 })
  await waitRound(p)
  await p.tap('.answer.B'); await p.tap('.cta'); await outcome(p)
  if (await p.$('.toast.err')) throw new Error('first bet failed: ' + await p.$eval('.toast.err', e => e.innerText))
  const r0 = await p.evaluate(() => Number(window.befewer.game.status.commit_round))
  await waitRound(p, r0)
  await new Promise(r => setTimeout(r, 6000)) // let the page refresh the balance
  const before = await p.evaluate(() => window.befewer.game.me.balance)
  await p.tap('.answer.A')
  const max = await p.evaluate(() => { const b = [...document.querySelectorAll('.stake .seg button')].find(x => /^Max/.test(x.textContent)); b?.click(); return b?.textContent ?? null })
  console.log('game balance', near(before), '| max chip:', max, '| note:', await p.$eval('.stake', e => e.innerText.replace(/\s+/g, ' ')).catch(() => '-'))
  await p.tap('.cta'); await outcome(p)
  const err = await p.$eval('.toast.err', e => e.innerText).catch(() => null)
  await new Promise(r => setTimeout(r, 4000))
  const after = await p.evaluate(() => { const g = window.befewer.game; const r = Number(g.status.commit_round); return { bal: g.me.balance, bet: g.me.open.find(o => Number(o.round) === r)?.amount ?? null } })
  console.log('max bet:', err ? `FAILED: ${err}` : `sealed ${after.bet ? near(after.bet) : '?'} NEAR`, '| game balance left', near(after.bal))
  const share = after.bet ? Number(BigInt(after.bet) * 1000n / BigInt(before)) / 10 : 0
  console.log(`stake = ${share}% of the balance`)
  if (err || share <= 25) { console.error('E2E FAILED: the max bet must go through and be above the old 25% cap'); process.exitCode = 1 }
  console.log('errors:', errors.length ? errors : 'none')
  await b.close()
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
