// Every preset loads into the draft and replays; every condition kind renders its own controls.
const puppeteer = require('/root/dota/node_modules/puppeteer')
const URL = (process.argv[2] || 'http://127.0.0.1:5043/') + '#/autopilot'
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
  await p.select('.rule select[aria-label="Stake"]', 'm:2')
  console.log('martingale stake option:', await p.$eval('.rule select[aria-label="Stake"]', s => s.options[s.selectedIndex].text))
  const width = await p.evaluate(() => document.documentElement.scrollWidth)
  console.log('page width', width, '| errors:', errors.length ? errors : 'none')
  await b.close()
})()
