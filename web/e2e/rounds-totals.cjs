// The Rounds tiles are all-time (server count from /api/totals + rounds settled since), A + B + void
// add up to Settled, the six tiles fit the screen, and without /api/totals the page says it is
// counting only the latest rounds. usage: node e2e/rounds-totals.cjs <url>
const puppeteer = require(process.env.PUPPETEER || 'puppeteer')
const URL = process.argv[2] || 'http://127.0.0.1:5044/'
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  for (const [W, block] of [[390, false], [1280, false], [390, true]]) {
    const p = await b.newPage()
    const errors = []
    p.on('pageerror', e => errors.push(String(e)))
    if (block) { await p.setRequestInterception(true); p.on('request', r => (/api\/totals/.test(r.url()) ? r.respond({ status: 503, body: '{}' }) : r.continue())) }
    await p.setViewport({ width: W, height: 900, isMobile: W < 600, hasTouch: W < 600 })
    await p.goto(URL + '#/rounds', { waitUntil: 'networkidle2' })
    await p.waitForSelector('.summary', { timeout: 60_000 })
    await sleep(8000)
    const scope = await p.$eval('.scope', e => e.innerText)
    const tiles = await p.$$eval('.summary .tile', ts => ts.map(t => t.innerText.replace(/\s+/g, ' ').trim()))
    const width = await p.evaluate(() => document.documentElement.scrollWidth)
    console.log(`--- ${W}px${block ? ' (totals blocked)' : ''}: ${scope}`)
    for (const t of tiles) console.log('   ', t)
    const n = s => Number((s.match(/[\d,]+/) || ['0'])[0].replace(/,/g, ''))
    const [settled, a, bb, v] = tiles.map(n)
    const sumPct = tiles.slice(1, 4).reduce((t, s) => t + Number(s.match(/(\d+)% of rounds/)[1]), 0)
    console.log(`    A+B+void=${a + bb + v} vs settled ${settled}; % sum ${sumPct}; width ${width}/${W}; errors ${errors.length ? errors : 'none'}`)
    if (a + bb + v !== settled || width > W || errors.length || Math.abs(sumPct - 100) > 2) { console.error('E2E FAILED'); process.exitCode = 1 }
    if (block === /All time/.test(scope)) { console.error('E2E FAILED: scope label wrong'); process.exitCode = 1 }
    await p.screenshot({ path: `/tmp/fewer-v4/rounds-totals-${W}${block ? '-blocked' : ''}.png` })
    await p.close()
  }
  await b.close()
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
