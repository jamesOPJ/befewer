// The Pool page: pool state from Ref Finance, buybacks, and the two "adds up" checks.
// usage: node e2e/pool-page.cjs <url> [width]
const puppeteer = require('/root/dota/node_modules/puppeteer')
const URL = process.argv[2] || 'http://127.0.0.1:5044/'
const W = Number(process.argv[3] || 390)
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const p = await b.newPage()
  const errors = []
  p.on('pageerror', e => errors.push(String(e)))
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
  await p.setViewport({ width: W, height: 900, isMobile: W < 600, hasTouch: W < 600 })
  await p.goto(URL + '#/pool', { waitUntil: 'networkidle2' })
  await p.waitForFunction(() => document.querySelectorAll('.block').length >= 4, { timeout: 60_000 })
  await new Promise(r => setTimeout(r, 6000))
  const blocks = await p.$$eval('.block', bs => bs.map(x => x.innerText.replace(/\s+/g, ' ')))
  blocks.forEach((t, i) => console.log(`[${i}]`, t.slice(0, 420)))
  const checks = await p.$$eval('.check', cs => cs.map(c => ({ ok: !c.classList.contains('bad'), t: c.innerText })))
  console.log('checks:', JSON.stringify(checks))
  if (checks.length !== 2 || checks.some(c => !c.ok)) { console.error('E2E FAILED: the books must add up'); process.exitCode = 1 }
  if (/1 BEFEWER = —/.test(blocks[0])) { console.error('E2E FAILED: no pool price'); process.exitCode = 1 }
  const width = await p.evaluate(() => document.documentElement.scrollWidth)
  console.log(`page width ${width}/${W}`, width > W ? 'TOO WIDE' : 'ok'); if (width > W) process.exitCode = 1
  await p.screenshot({ path: `/tmp/fewer-v4/pool-${W}.png`, fullPage: true })
  console.log('errors:', errors.length ? errors : 'none')
  await b.close()
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
