// (1) if the guest service refuses, the page says so in a red box; (2) a real bet later shows its result.
// usage: node e2e/error-and-result.cjs <url> error|result
const puppeteer = require('/root/dota/node_modules/puppeteer')
const [URL = 'http://127.0.0.1:5043/', MODE = 'error'] = process.argv.slice(2)
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const p = await b.newPage()
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  if (MODE === 'error') {
    await p.setRequestInterception(true)
    p.on('request', r => r.url().endsWith('/api/guest') ? r.respond({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Too many guest accounts from your network this hour. Try again later.' }) }) : r.continue())
  }
  await p.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
  await p.waitForSelector('.pick .side-A')
  await p.click('.pick .side-A')
  if (MODE === 'error') {
    await p.waitForSelector('.failure', { timeout: 30000 })
    console.log('red box:', await p.$eval('.failure', e => e.textContent))
    await p.screenshot({ path: '/root/scratch/near-hack/shots/err-390.png' })
  } else {
    await p.waitForFunction(() => /You're in round/.test(document.body.innerText), { timeout: 120000 })
    const t0 = Date.now()
    await p.waitForSelector('.last', { timeout: 11 * 60_000 })
    console.log(`result after ${Math.round((Date.now() - t0) / 1000)} s:`, await p.$eval('.last', e => e.textContent))
    console.log('results table:', (await p.$eval('#s-results', e => e.innerText)).replace(/\s+/g, ' '))
    await p.screenshot({ path: '/root/scratch/near-hack/shots/result-390.png', fullPage: true })
  }
  await b.close()
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
