// Every preset loads into the draft and replays; every condition kind renders its own controls.
const puppeteer = require(process.env.PUPPETEER || 'puppeteer')
const URL = (process.argv[2] || 'http://127.0.0.1:5043/') + '#/autopilot'
const typeAmount = async (p, v) => { const el = await p.$('.rule input[aria-label="Stake amount"]'); await el.click({ clickCount: 3 }); await el.type(v); await p.keyboard.press('Tab'); await new Promise(r => setTimeout(r, 150)) }
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const p = await b.newPage()
  const errors = []
  p.on('pageerror', e => errors.push(String(e)))
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await p.goto(URL, { waitUntil: 'domcontentloaded' })
  await p.evaluate(() => localStorage.clear())
  await p.reload({ waitUntil: 'networkidle2' })
  await p.waitForSelector('.preset')
  const groups = await p.$$eval('.pg', els => els.map(e => e.textContent.trim()))
  console.log('groups:', groups.join(' | '))
  const names = await p.$$eval('.preset .pn', els => els.map(e => e.textContent.trim()))
  for (const n of names) {
    await p.evaluate(n => [...document.querySelectorAll('.preset')].find(x => x.querySelector('.pn').textContent.trim() === n).click(), n)
    await new Promise(r => setTimeout(r, 150))
    const res = await p.evaluate(n => [...document.querySelectorAll('.preset')].find(x => x.querySelector('.pn').textContent.trim() === n).querySelector('.pr')?.innerText.replace(/\s+/g, ' '), n)
    const rules = await p.$$eval('.rule', els => els.length)
    console.log(`${n.padEnd(22)} rules ${rules} · ${res}`)
  }
  // every condition kind in the editor
  for (const k of ['last', 'margin', 'streak', 'tally', 'question', 'mine', 'always']) {
    await p.select('.rule select[aria-label="Condition"]', k)
    await new Promise(r => setTimeout(r, 100))
    const sel = await p.$eval('.rule .sentence', e => [...e.querySelectorAll('select')].map(s => s.options[s.selectedIndex]?.text).join(' / '))
    console.log(`kind ${k.padEnd(8)}: ${sel}`)
  }
  // the stake: a typed amount + a method
  const amt = () => p.$eval('.rule input[aria-label="Stake amount"]', e => e.value)
  const method = () => p.$eval('.rule select[aria-label="Stake method"]', s => s.value)
  await p.select('.rule select[aria-label="Stake method"]', 'martingale')
  await typeAmount(p, '0.02')
  console.log('martingale stake:', await amt(), await p.$eval('.rule select[aria-label="Stake method"]', s => s.options[s.selectedIndex].text))
  const checks = []
  await p.select('.rule select[aria-label="Stake method"]', 'fixed')
  await typeAmount(p, '0.011'); checks.push(['0.011 is kept', await amt(), '0.011'])
  await typeAmount(p, '0.0115'); checks.push(['0.0115 rounds down to a 0.001 step', await amt(), '0.011'])
  await typeAmount(p, '0'); checks.push(['0 becomes the smallest bet', await amt(), '0.01'])
  await typeAmount(p, '1.5'); checks.push(['1.5 NEAR is kept', await amt(), '1.5'])
  await p.select('.rule select[aria-label="Stake method"]', 'pct'); await new Promise(r => setTimeout(r, 150))
  checks.push(['NEAR -> % starts at 5', `${await amt()} ${await method()}`, '5 pct'])
  await typeAmount(p, '150'); checks.push(['% stops at 100', await amt(), '100'])
  await p.select('.rule select[aria-label="Stake method"]', 'paroli'); await new Promise(r => setTimeout(r, 150))
  checks.push(['% -> NEAR starts at 0.1', await amt(), '0.1'])
  await p.select('.rule select[aria-label="Stake method"]', 'fixed'); await typeAmount(p, '0.011')
  const saved = await p.evaluate(() => { const k = Object.keys(localStorage).find(k => /ap/.test(k) && /0\.11|1\.1/.test(localStorage.getItem(k) ?? '')); return k ? localStorage.getItem(k).match(/"amount":([0-9.]+)/g) : null })
  checks.push(['saved rule holds 1.1 chips', String(saved), 'contains 1.1'])
  for (const [what, got, want] of checks) {
    const ok = want.startsWith('contains ') ? got.includes(want.slice(9)) : got === want
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${got}`)
    if (!ok) process.exitCode = 1
  }
  const width = await p.evaluate(() => document.documentElement.scrollWidth)
  console.log('page width', width, '| errors:', errors.length ? errors : 'none')
  await b.close()
})()
