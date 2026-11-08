// The REAL wallet modules (not the test seam): open the chooser, click Meteor like a person does,
// and Meteor's testnet connect window must open with no page errors. Catches 'global is not
// defined' and popups blocked because the modules loaded after the click.
// usage: node e2e/wallet-real.cjs <url>
const puppeteer = require(process.env.PUPPETEER || 'puppeteer')
const URL = process.argv[2] || 'http://127.0.0.1:5043/'
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const p = await b.newPage()
  const errors = []
  p.on('pageerror', e => errors.push(String(e).slice(0, 160)))
  await p.setViewport({ width: 1280, height: 900 })
  await p.goto(URL + '#/', { waitUntil: 'networkidle2' })
  await p.waitForSelector('.connect')
  await p.click('.connect')
  await new Promise(r => setTimeout(r, 4000))
  const box = await p.evaluate(() => { const r = [...document.querySelectorAll('button')].find(x => x.innerText.startsWith('Meteor')).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
  await p.mouse.click(box.x, box.y)
  await new Promise(r => setTimeout(r, 8000))
  const opened = b.targets().map(t => t.url()).filter(u => /meteorwallet\.app\/connect\/testnet/.test(u))
  const modal = await p.evaluate(() => document.querySelector('[role=dialog],.modal')?.innerText ?? '')
  console.log('Meteor window:', opened[0] ?? 'NONE', '| errors:', errors.length ? errors : 'none')
  if (!opened.length || errors.length || /global is not defined/.test(modal)) { console.error('E2E FAILED'); process.exitCode = 1 }
  await b.close()
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
