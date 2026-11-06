// Autopilot: presets load, a dropdown edits the rule, the backtest line updates, rules survive a
// reload, and with the switch on the autopilot places (or skips) a bet by itself.
const puppeteer = require('/root/dota/node_modules/puppeteer')
const URL = process.argv[2] || 'http://127.0.0.1:5043/'
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 15 * 60_000 })
  const p = await b.newPage()
  const errors = []
  p.on('pageerror', e => errors.push(String(e)))
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await p.goto(URL, { waitUntil: 'networkidle2' })
  await p.waitForSelector('#ap-rules .rule')
  const txt = sel => p.$eval(sel, e => e.innerText.replace(/\s+/g, ' ').trim())
  await p.evaluate(() => document.querySelector('[data-act="ap-preset"][data-i="2"]').click()) // Streak breaker
  console.log('preset Streak breaker ->', await txt('#ap-rules .rule'))
  console.log('backtest ->', await txt('#ap-bt'))
  await p.select('#ap-rules .rule select[data-ap="n"]', '2')
  await p.select('#ap-rules .rule select[data-ap="pct"]', '20')
  console.log('after edit ->', await txt('#ap-rules .rule'))
  console.log('backtest ->', await txt('#ap-bt'))
  await p.reload({ waitUntil: 'networkidle2' })
  await p.waitForSelector('#ap-rules .rule')
  console.log('after reload ->', await txt('#ap-rules .rule'))
  // a rule that always bets, so the live test does not depend on streaks
  await p.evaluate(() => document.querySelector('[data-act="ap-preset"][data-i="1"]').click()) // Flip (falls back to random)
  const width = await p.evaluate(() => document.documentElement.scrollWidth)
  console.log('page width with the editor:', width)
  await p.click('#ap-on')
  const t0 = Date.now()
  await p.waitForFunction(() => /bet .* BEFEWER on|skipped|could not bet/.test(document.getElementById('ap-status')?.innerText || ''), { timeout: 8 * 60_000, polling: 1000 })
  console.log(`autopilot after ${Math.round((Date.now() - t0) / 1000)} s ->`, await txt('#ap-status'))
  console.log('bet card ->', (await txt('#s-move')).slice(0, 160))
  console.log('errors:', errors.length ? errors : 'none')
  await p.screenshot({ path: '/root/scratch/near-hack/shots/autopilot-390.png', fullPage: true })
  await b.close()
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
