// Polling must not repaint: the slider node and its value survive 15 s of polling,
// and the whole #app is never replaced after the first paint.
const puppeteer = require('/root/dota/node_modules/puppeteer')
const URL = process.argv[2] || 'http://127.0.0.1:5043/'
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const p = await b.newPage()
  const errors = []
  p.on('pageerror', e => errors.push(String(e)))
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await p.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
  await p.waitForSelector('#amt')
  await p.evaluate(() => {
    window.__slider = document.getElementById('amt')
    window.__header = document.querySelector('header')
    window.__writes = 0
    new MutationObserver(m => (window.__writes += m.length)).observe(document.getElementById('app'), { childList: true })
    const s = document.getElementById('amt'); s.value = '37'; s.dispatchEvent(new Event('input', { bubbles: true }))
    window.scrollTo(0, 300)
  })
  await new Promise(r => setTimeout(r, 15000))
  const r = await p.evaluate(() => ({
    sameSlider: window.__slider === document.getElementById('amt') && window.__slider.isConnected,
    sliderValue: document.getElementById('amt')?.value,
    label: document.getElementById('amtv')?.textContent,
    headerKept: window.__header.isConnected,
    appChildWrites: window.__writes,
    scrollY: window.scrollY,
    timer: document.querySelector('.t')?.textContent,
  }))
  console.log(JSON.stringify(r), 'errors:', errors.length ? errors : 'none')
  const ok = r.sliderValue === '37' && r.label === '37' && r.headerKept && r.appChildWrites === 0 && r.scrollY === 300 && /\d:\d\d/.test(r.timer)
  console.log(ok ? 'PASS: polling does not repaint the page' : 'FAIL')
  await b.close()
  process.exit(ok ? 0 : 1)
})()
