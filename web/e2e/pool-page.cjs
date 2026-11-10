// The Pool page: pool state from Ref Finance, buybacks, and the two "adds up" checks.
// usage: node e2e/pool-page.cjs <url> [width]
const puppeteer = require(process.env.PUPPETEER || 'puppeteer')
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
  const checks = await p.$$eval('.check', cs => cs.map(c => ({ ok: !c.classList.contains('bad'), t: c.textContent })))
  console.log('checks:', JSON.stringify(checks))
  if (checks.length !== 3 || checks.some(c => !c.ok)) { console.error('E2E FAILED: the books must add up (3 checks)'); process.exitCode = 1 }
  // why only part of the treasury can be spent: account NEAR minus the five rows = what the contract says it can spend
  const held = await p.evaluate(() => {
    const h = document.getElementById('held'); if (!h) return null
    const t = h.querySelector('table')   // inside a closed <details>: textContent, not innerText
    const nums = [...t.querySelectorAll('td.r')].map(td => Number(td.textContent.replace(/[^0-9.]/g, '')))
    return { title: h.querySelector('summary').textContent, open: h.open, nums }
  })
  console.log('held:', JSON.stringify(held))
  if (!held || held.nums.length !== 7) { console.error('E2E FAILED: no spendable breakdown'); process.exitCode = 1 }
  else {
    const left = held.nums[0] - held.nums.slice(1, 6).reduce((a, b) => a + b, 0)
    if (Math.abs(left - held.nums[6]) > 0.0006) { console.error(`E2E FAILED: breakdown gives ${left}, table says ${held.nums[6]}`); process.exitCode = 1 }
  }
  // the card's headline is what can be spent; books − spendable = the part printed as held back, exactly as printed
  const card = await p.$eval('.block', el => ({ eyebrow: el.querySelector('.eyebrow').innerText, head: el.querySelector('.price').innerText, line: el.querySelector('.price + .small')?.innerText ?? '' }))
  console.log('card:', JSON.stringify(card))
  const num = t => parseFloat(t.replace(/,/g, ''))   // '14.42 NEAR' -> 14.42
  const m = /([\d,.]+) in its books, ([\d,.]+) of that/.exec(card.line)
  if (!/can be spent/i.test(card.eyebrow)) { console.error('E2E FAILED: the headline must be the spendable treasury'); process.exitCode = 1 }
  if (m && Math.round((num(m[1]) - num(card.head) - num(m[2])) * 100) !== 0) { console.error('E2E FAILED: card numbers do not subtract'); process.exitCode = 1 }
  // the card's "why" link opens the folded breakdown
  await p.evaluate(() => [...document.querySelectorAll('.block a')].find(a => a.textContent.trim() === 'why')?.click())
  await new Promise(r => setTimeout(r, 1000))
  if (held && held.title.includes('Why') && !(await p.$eval('#held', d => d.open))) { console.error('E2E FAILED: "why" did not open the breakdown'); process.exitCode = 1 }
  if (/1\/365 of the treasury per day|1\/365 of its NEAR/.test(blocks.join(' '))) { console.error('E2E FAILED: 1/365 must say of the spendable NEAR'); process.exitCode = 1 }
  if (/1 BEFEWER = —/.test(blocks[0])) { console.error('E2E FAILED: no pool price'); process.exitCode = 1 }
  const width = await p.evaluate(() => document.documentElement.scrollWidth)
  console.log(`page width ${width}/${W}`, width > W ? 'TOO WIDE' : 'ok'); if (width > W) process.exitCode = 1
  await p.screenshot({ path: `/tmp/fewer-v4/pool-${W}.png`, fullPage: true })
  console.log('errors:', errors.length ? errors : 'none')
  await b.close()
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
