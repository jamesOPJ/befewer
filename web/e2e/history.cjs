// History line: with a fake earlier round of the same question injected, the page explains it.
const puppeteer = require('/root/dota/node_modules/puppeteer')
const URL = process.argv[2] || 'http://127.0.0.1:5043/'
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const p = await b.newPage()
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await p.goto(URL, { waitUntil: 'networkidle2' })
  await p.waitForSelector('.hist')
  const before = await p.$eval('.hist', e => e.innerText)
  const out = await p.evaluate(() => {
    const cur = Number(document.querySelector('#s-round .k').textContent.match(/Round (\d+)/)[1])
    const E = 10n ** 18n
    // pretend this question was asked 100 rounds ago: 62 coins on B, 38 on A -> A was smaller
    window.befewer.history.remember([{ round: String(cur + 100 - 100 * 2 + 100), settled: false }])
    window.befewer.history.remember([{ round: String(cur - 100 < 0 ? cur + 100 : cur - 100), commit_starts_at: '0', reveal_starts_at: '0', reveal_ends_at: '0', committed: String(100n * E), revealed_a: String(38n * E), revealed_b: String(62n * E), commits: 5, reveals_a: 2, reveals_b: 3, claims: 5, settled: true, outcome: 'A', burned: String(24n * E) }])
    return cur
  })
  if (out < 100) {
    console.log(`round ${out} < 100: no real earlier occurrence exists yet; injected one at round ${out + 100} cannot be "earlier". Checking text only.`)
  }
  await p.evaluate(() => window.befewer.render())
  const after = await p.$eval('.hist', e => e.innerText)
  console.log('before:', before.replace(/\s+/g, ' '))
  console.log('after :', after.replace(/\s+/g, ' '))
  await p.screenshot({ path: '/root/scratch/near-hack/shots/hist-390.png' })
  await b.close()
})()
