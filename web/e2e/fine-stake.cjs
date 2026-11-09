// Stakes go in steps of 0.001 NEAR: a new player types 0.011 into the custom stake, the button
// says so, and the contract records exactly 0.011 (not 0.01 or 0.02, as the old 0.01 steps did).
// usage: node e2e/fine-stake.cjs <url>   (about 1-4 minutes: waits for a round with time left)
const puppeteer = require(process.env.PUPPETEER || 'puppeteer')
const URL = process.argv[2] || 'http://127.0.0.1:5044/'
const WANT = 11n * 10n ** 21n // 0.011 NEAR
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 10 * 60_000 })
  const p = await b.newPage()
  const errors = []
  p.on('pageerror', e => errors.push(String(e)))
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await p.goto(URL, { waitUntil: 'networkidle2' })
  await p.waitForSelector('.answer.B', { timeout: 120_000 })
  await p.waitForFunction(() => {
    const g = window.befewer.game
    return Number(BigInt(g.status?.commit_ends_at ?? 0) / 1000000n) - Date.now() > 40_000 && !g.busy
  }, { timeout: 6 * 60_000, polling: 2000 })
  await p.tap('.answer.B')
  const input = await p.$('.stake input[type=number]')
  await input.click({ clickCount: 3 })
  await input.type('0.011')
  await new Promise(r => setTimeout(r, 300))
  const cta = await p.$eval('.cta', e => e.innerText.replace(/\s+/g, ' ').trim())
  const valid = await p.$eval('.stake input[type=number]', e => e.checkValidity())
  console.log('button:', cta, '| input valid:', valid)
  await p.tap('.cta')
  await p.waitForFunction(() => document.querySelector('.toast.err') || /^Sealed/.test(document.querySelector('.toast.ok')?.innerText ?? ''), { timeout: 120_000 })
  const err = await p.$eval('.toast.err', e => e.innerText).catch(() => null)
  await new Promise(r => setTimeout(r, 4000))
  const bet = await p.evaluate(() => { const g = window.befewer.game; const r = Number(g.status.commit_round); return { acct: g.session?.accountId ?? null, amount: g.me?.open?.find(o => Number(o.round) === r)?.amount ?? null } })
  console.log('account:', bet.acct, '| on chain:', bet.amount, 'yocto', err ? `| ERROR: ${err}` : '')
  const ok = !err && valid && /0\.011 NEAR/.test(cta) && bet.amount && BigInt(bet.amount) === WANT
  if (!ok) { console.error('E2E FAILED: a 0.011 NEAR stake must show on the button and reach the contract as exactly 0.011'); process.exitCode = 1 }
  console.log('errors:', errors.length ? errors : 'none')
  await b.close()
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
