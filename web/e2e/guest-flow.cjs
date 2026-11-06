// Headless check of the guest flow on the local server: load -> guest -> faucet -> sealed bet.
const puppeteer = require('/root/dota/node_modules/puppeteer')
const URL = process.argv[2] || 'http://127.0.0.1:5043/'
const OUT = process.argv[3] || '/root/scratch/near-hack/shots'
;(async () => {
  require('fs').mkdirSync(OUT, { recursive: true })
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const p = await b.newPage()
  const errors = []
  p.on('console', m => m.type() === 'error' && errors.push(m.text()))
  p.on('pageerror', e => errors.push(String(e)))
  await p.setViewport({ width: 1100, height: 1400 })
  await p.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
  await p.waitForSelector('[data-act="guest"]', { timeout: 30000 })
  await p.screenshot({ path: `${OUT}/1-landing.png`, fullPage: true })
  await p.click('[data-act="guest"]')
  await p.waitForFunction(() => document.querySelector('.who') && /FEWER/.test(document.querySelector('.who').textContent) && document.querySelector('.pick, .locked'), { timeout: 90000 })
  const who = await p.$eval('.who', e => e.textContent.trim())
  console.log('signed in:', who.replace(/\s+/g, ' '))
  await p.screenshot({ path: `${OUT}/2-ready.png`, fullPage: true })
  if (await p.$('.pick')) {
    await p.click('.pick .side-A')
    await p.waitForFunction(() => /Sealed:|You're in round/.test(document.body.innerText) || /panicked|Error|closing/.test(document.querySelector('.notice')?.textContent || ''), { timeout: 90000 })
    console.log('after bet:', (await p.$eval('.card.now', e => e.innerText)).replace(/\s+/g, ' ').slice(0, 400))
  }
  await p.screenshot({ path: `${OUT}/3-bet.png`, fullPage: true })
  const session = await p.evaluate(() => Object.keys(localStorage))
  console.log('localStorage keys:', session.join(', '))
  console.log('console errors:', errors.length ? errors.slice(0, 5) : 'none')
  await b.close()
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
