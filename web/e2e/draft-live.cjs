// Editing the draft must not change what the autopilot runs; "Put live" must.
const puppeteer = require(process.env.PUPPETEER || 'puppeteer')
const URL = (process.argv[2] || 'http://127.0.0.1:5043/') + '#/autopilot'
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 15 * 60_000 })
  const p = await b.newPage()
  const errors = []
  p.on('pageerror', e => errors.push(String(e)))
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  // migration: only the old single rule set exists
  await p.goto(URL, { waitUntil: 'domcontentloaded' })
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('befewer.ap.rules', JSON.stringify([{ cond: { kind: 'always' }, pick: 'A', unit: 'fixed', amount: 2 }])) })
  await p.reload({ waitUntil: 'networkidle2' })
  await p.waitForSelector('.live-rules li')
  const live = () => p.$$eval('.live-rules li', els => els.map(e => e.textContent.trim()))
  console.log('migrated running rules:', await live(), '| dirty bar:', await p.$eval('.draftbar', e => e.className.includes('dirty')))
  // edit the draft: stake 2 -> 50
  await p.select('.rule select[aria-label="Stake"]', 'f:50')
  console.log('after editing draft -> running:', await live(), '| dirty:', await p.$eval('.draftbar', e => e.className.includes('dirty')))
  console.log('compare line:', (await p.$eval('.vs-live', e => e.innerText)).replace(/\s+/g, ' '))
  // the autopilot must bet with the RUNNING rules (2), not the draft (50)
  await p.evaluate(() => document.querySelector('.switch input').click())
  await p.waitForSelector('.log li', { timeout: 8 * 60_000 })
  console.log('autopilot used:', (await p.$eval('.log li', e => e.innerText)).replace(/\s+/g, ' '))
  // put the draft live
  await p.evaluate(() => [...document.querySelectorAll('.draftbar button')].find(x => /Put these rules live/.test(x.textContent)).click())
  await p.evaluate(() => [...document.querySelectorAll('.draftbar button')].find(x => /Yes, run these/.test(x.textContent)).click())
  console.log('after put live -> running:', await live(), '| dirty:', await p.$eval('.draftbar', e => e.className.includes('dirty')))
  await p.reload({ waitUntil: 'networkidle2' })
  await p.waitForSelector('.live-rules li')
  console.log('after reload -> running:', await live())
  console.log('errors:', errors.length ? errors : 'none')
  await b.close()
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
