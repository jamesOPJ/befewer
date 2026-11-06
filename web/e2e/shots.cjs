// Screenshots of every page at phone and desktop width + basic health (errors, overflow).
// usage: node e2e/shots.cjs <url> <outdir> [pages=play,rounds,autopilot,me,how]
const puppeteer = require('/root/dota/node_modules/puppeteer')
const [URL = 'http://127.0.0.1:5043/', OUT = '/root/scratch/near-hack/shots/v2', PAGES = 'play,rounds,autopilot,me,how'] = process.argv.slice(2)
;(async () => {
  require('fs').mkdirSync(OUT, { recursive: true })
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
    const p = await b.newPage()
    const errors = []
    p.on('pageerror', e => errors.push(String(e)))
    p.on('console', m => m.type() === 'error' && errors.push(m.text()))
    await p.setViewport({ width: w, height: h, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 })
    for (const pg of PAGES.split(',')) {
      await p.goto(URL + '#/' + (pg === 'play' ? '' : pg), { waitUntil: 'networkidle2' })
      await p.waitForFunction(() => !document.querySelector('.skeleton'), { timeout: 30000 })
      await new Promise(r => setTimeout(r, 1200))
      const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }))
      await p.screenshot({ path: `${OUT}/${pg}-${w}.png`, fullPage: true })
      console.log(`${pg} @${w}: width ${m.sw}/${m.iw}${m.sw > m.iw ? ' OVERFLOW' : ''}`)
    }
    console.log(`@${w} errors:`, errors.length ? [...new Set(errors)].slice(0, 5) : 'none')
    await p.close()
  }
  await b.close()
})()
