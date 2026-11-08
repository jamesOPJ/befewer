// Two slots ("A and B") run for a couple of rounds; then every page must show both slots:
// Play (sealed panel, last round card), Me (totals, waiting list, results), Rounds (my tag).
// usage: node e2e/multi-views.cjs <url>
const puppeteer = require(process.env.PUPPETEER || 'puppeteer')
const URL = process.argv[2] || 'http://127.0.0.1:5044/'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const txt = (p, s) => p.$eval(s, e => e.innerText.replace(/\s+/g, ' ')).catch(() => '(none)')
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 20 * 60_000 })
  const p = await b.newPage()
  const errors = []
  p.on('pageerror', e => errors.push(String(e)))
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await p.goto(URL + '#/autopilot', { waitUntil: 'networkidle2' })
  await p.waitForSelector('.preset')
  await p.evaluate(() => [...document.querySelectorAll('.bh .seg button')].find(e => /Several/.test(e.textContent)).click())
  await sleep(300)
  await p.evaluate(() => [...document.querySelectorAll('.preset')].find(e => /A and B/.test(e.textContent)).querySelector('.btn.primary').click())
  // wait until two rounds with both slots' bets have settled (results for slot 0 and slot 1)
  const t0 = Date.now()
  await p.waitForFunction(() => {
    const g = window.befewer?.game
    const by = g?.resultsBySlot || {}
    return (by[0]?.length ?? 0) >= 2 && (by[1]?.length ?? 0) >= 2
  }, { timeout: 18 * 60_000, polling: 3000 })
  console.log(`two settled rounds on both slots after ${Math.round((Date.now() - t0) / 1000)} s`)
  await p.goto(URL + '#/', { waitUntil: 'networkidle2' }); await sleep(4000)
  console.log('PLAY sealed:', (await txt(p, '.sealed')).slice(0, 200))
  console.log('PLAY last round:', await txt(p, '.card.mine'))
  console.log('PLAY mining:', (await txt(p, '.mining .dots')))
  await p.goto(URL + '#/me', { waitUntil: 'networkidle2' }); await sleep(4000)
  console.log('ME stats:', await txt(p, '.stats'))
  // a fresh guest: every bet it made is in its settled results, so the page's record must match a recount
  const chk = await p.evaluate(() => {
    const g = window.befewer.game
    const all = Object.values(g.resultsBySlot).flat()
    const want = { wins: all.filter(x => x.outcome !== 'void' && x.outcome === x.side).length, losses: all.filter(x => x.outcome !== 'void' && x.outcome !== x.side).length }
    const cells = [...document.querySelectorAll('.stats > *')].map(e => e.innerText.replace(/\s+/g, ' '))
    const num = re => Number((cells.find(c => re.test(c)) || '').match(/\d+/)?.[0])
    return { account: g.session?.accountId, want, shown: { wins: num(/WINS/i), losses: num(/LOSSES/i) } }
  })
  console.log('ME record check:', JSON.stringify(chk))
  if (chk.want.wins !== chk.shown.wins || chk.want.losses !== chk.shown.losses) { console.error('E2E FAILED: record on Me does not match the settled results'); process.exitCode = 1 }
  console.log('ME score:', (await txt(p, '.score')).slice(0, 140))
  console.log('ME results (first 3):', await p.$$eval('section .list', ls => { const l = ls[ls.length - 1]; return [...l.querySelectorAll('li')].slice(0, 3).map(li => li.innerText.replace(/\s+/g, ' ')) }))
  await p.goto(URL + '#/rounds', { waitUntil: 'networkidle2' }); await sleep(3000)
  console.log('ROUNDS my tags:', await p.$$eval('.mine-tag', e => e.slice(0, 3).map(x => x.innerText)))
  console.log('errors:', errors.length ? errors : 'none')
  await b.close()
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
