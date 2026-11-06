// Rules sit at the top, start open, collapse on tap, and stay collapsed after a reload.
const puppeteer = require('/root/dota/node_modules/puppeteer')
const URL = process.argv[2] || 'http://127.0.0.1:5043/'
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const p = await b.newPage()
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await p.goto(URL, { waitUntil: 'networkidle2' })
  await p.waitForSelector('#rules')
  const info = () => p.evaluate(() => {
    const d = document.getElementById('rules'), live = document.querySelector('.live')
    return { open: d.open, rulesAboveGame: d.getBoundingClientRect().top < live.getBoundingClientRect().top,
      rulesTop: Math.round(d.getBoundingClientRect().top), abY: Math.round(document.querySelector('.pick')?.getBoundingClientRect().top ?? -1) }
  })
  const first = await info()
  await p.screenshot({ path: '/root/scratch/near-hack/shots/rules-open-390.png' })
  await p.click('#rules summary')
  const closed = await info()
  await p.screenshot({ path: '/root/scratch/near-hack/shots/rules-closed-390.png' })
  await p.reload({ waitUntil: 'networkidle2' })
  await p.waitForSelector('#rules')
  const after = await info()
  console.log('first visit:', JSON.stringify(first))
  console.log('after tap  :', JSON.stringify(closed))
  console.log('after reload:', JSON.stringify(after))
  const ok = first.open && first.rulesAboveGame && !closed.open && !after.open
  console.log(ok ? 'PASS' : 'FAIL')
  await b.close()
  process.exit(ok ? 0 : 1)
})()
