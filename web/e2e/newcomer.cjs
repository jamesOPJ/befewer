// Newcomer flow: open the page and tap A/B straight away (no separate sign-up step).
// usage: node e2e/newcomer.cjs <url> <outdir> <width>
const puppeteer = require('/root/dota/node_modules/puppeteer')
const [URL = 'http://127.0.0.1:5043/', OUT = '/root/scratch/near-hack/shots', W = '1100'] = process.argv.slice(2)
;(async () => {
  require('fs').mkdirSync(OUT, { recursive: true })
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const p = await b.newPage()
  const errors = []
  p.on('console', m => m.type() === 'error' && errors.push(m.text()))
  p.on('pageerror', e => errors.push(String(e)))
  const mobile = Number(W) < 600
  await p.setViewport({ width: Number(W), height: mobile ? 844 : 1300, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 })
  await p.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
  await p.waitForSelector('.pick .side-B', { timeout: 30000 })
  const box = await (await p.$('.pick .side-B')).boundingBox()
  console.log(`[${W}px] A/B visible on landing: yes, B button at y=${Math.round(box.y)} (viewport height ${mobile ? 844 : 1300})`)
  await p.screenshot({ path: `${OUT}/new-${W}-1-landing.png` })
  await p.click('.pick .side-B')
  await p.waitForFunction(() => /You're in round/.test(document.body.innerText) || (document.querySelector('.notice') && !/Creating|Claiming|Sealing|Sending/.test(document.querySelector('.notice').textContent) && document.querySelectorAll('.notice').length && !document.querySelector('.pick button[disabled]')), { timeout: 120000 })
  console.log(`[${W}px] after one tap:`, (await p.$eval('.card.now', e => e.innerText)).replace(/\s+/g, ' ').slice(0, 330))
  await p.screenshot({ path: `${OUT}/new-${W}-2-after.png` })
  console.log(`[${W}px] console errors:`, errors.length ? errors.slice(0, 5) : 'none')
  await b.close()
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
