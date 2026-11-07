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
  // open the newest round split between several players, else one with a recorded list
  const pick = await p.$$eval('.list .row', rs => {
    const c = rs.map(r => r.querySelector('.mchip')?.innerText ?? '')
    const i = c.findIndex(t => /[2-9]\d* players/.test(t)); return i >= 0 ? i : Math.max(0, c.findIndex(t => /player/.test(t)))
  })
  await p.evaluate(i => document.querySelectorAll('.list .row .sum')[i].click(), pick)
  await sleep(4000)
  console.log('mined:', await p.$eval('.list .row.open .detail dl', e => [...e.children].find(d => /Mined/i.test(d.innerText))?.innerText.replace(/\s+/g, ' ')))
  const tab = await p.$$eval('.list .row.open .mtab tr', trs => trs.map(tr => [...tr.children].map(td => td.innerText.replace(/\s+/g, ' ').trim())))
  for (const r of tab) console.log('   ', r.join(' | '))
  console.log('   ', await p.$eval('.list .row.open .miners', e => [...e.querySelectorAll('.small-note')].map(x => x.innerText).join(' ')).catch(() => ''))
  // the table must add up: shares sum to the total, each share = shares / total, cuts in that ratio
  const body = tab.filter(r => r.length === 4 && /\d/.test(r[1]) && !/^All$/.test(r[0]) && !/^Bet$/i.test(r[0]))
  const tot = body.reduce((t, r) => t + Number(r[1]), 0)
  const foot = tab.find(r => r[0] === 'All')
  if (foot) foot[1] = foot[1].replace(/ shares$/, '')
  const bad = body.filter(r => Math.abs(Number(r[2].replace('%', '')) - (Number(r[1]) / tot) * 100) > 0.11)
  const note = await p.$eval('.list .row.open .miners', e => [...e.querySelectorAll('.small-note')].map(x => x.innerText).join(' ')).catch(() => '')
  if (/The 0 left/.test(note)) { console.error('E2E FAILED: a leftover that rounds to 0 is printed'); process.exitCode = 1 }
  if (foot && Math.abs(body.reduce((t, r) => t + Number(r[2].replace('%', '')), 0) - 100) > 0.05) { console.error('E2E FAILED: shares do not add up to 100%'); process.exitCode = 1 }
  if (!body.length || bad.length || (foot && Number(foot[1]) !== tot)) { console.error('E2E FAILED: the split table does not add up'); process.exitCode = 1 }
  const width = await p.evaluate(() => document.documentElement.scrollWidth)
  console.log(`page width ${width}/${W}`, width > W ? 'TOO WIDE' : 'ok')
  if (width > W) process.exitCode = 1
  await p.screenshot({ path: `/tmp/fewer-v4/mined-${W}.png`, fullPage: false })
  console.log('errors:', errors.length ? errors : 'none')
  await b.close()
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
