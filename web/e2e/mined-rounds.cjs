// The Rounds page shows where BEFEWER was mined and by how many: a "BEFEWER mined" tile, a
// "Mined BEFEWER" filter, a chip on each round that mined, and who mined it in the round detail.
// usage: node e2e/mined-rounds.cjs <url> [width]
const puppeteer = require('/root/dota/node_modules/puppeteer')
const URL = process.argv[2] || 'http://127.0.0.1:5044/'
const W = Number(process.argv[3] || 390)
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const p = await b.newPage()
  const errors = []
  p.on('pageerror', e => errors.push(String(e)))
  await p.setViewport({ width: W, height: 900, isMobile: W < 600, hasTouch: W < 600 })
  await p.goto(URL + '#/rounds', { waitUntil: 'networkidle2' })
  await p.waitForSelector('.summary', { timeout: 60_000 })
  await sleep(5000)
  console.log('tile:', (await p.$eval('.mtile', e => e.innerText)).replace(/\s+/g, ' '))
  await p.evaluate(() => [...document.querySelectorAll('.seg button')].find(x => /Mined/.test(x.textContent)).click())
  await sleep(500)
  const rows = await p.$$eval('.list .row', rs => rs.map(r => r.querySelector('.no').innerText + ' ' + (r.querySelector('.mchip')?.innerText ?? '(no chip)')))
  console.log(`mined filter: ${rows.length} rounds:`, rows.slice(0, 6).join(' | '))
  if (!rows.length || rows.some(r => /no chip/.test(r))) { console.error('E2E FAILED: every listed round must carry its mined chip'); process.exitCode = 1 }
  // open the newest mined round with a recorded list, else the newest one
  const pick = await p.$$eval('.list .row', rs => { const i = rs.findIndex(r => /player/.test(r.querySelector('.mchip')?.innerText ?? '')); return i >= 0 ? i : 0 })
  await p.evaluate(i => document.querySelectorAll('.list .row .sum')[i].click(), pick)
  await sleep(4000)
  const det = await p.$eval('.list .row.open .detail', e => e.innerText.replace(/\s+/g, ' '))
  console.log('detail:', det.slice(0, 400))
  const width = await p.evaluate(() => document.documentElement.scrollWidth)
  console.log(`page width ${width}/${W}`, width > W ? 'TOO WIDE' : 'ok')
  if (width > W) process.exitCode = 1
  await p.screenshot({ path: `/tmp/fewer-v4/mined-${W}.png`, fullPage: false })
  console.log('errors:', errors.length ? errors : 'none')
  await b.close()
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
