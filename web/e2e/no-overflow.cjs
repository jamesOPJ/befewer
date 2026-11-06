// Nothing may be wider than a 390 px phone, even with the longest question and answers in every slot.
const puppeteer = require('/root/dota/node_modules/puppeteer')
const URL = process.argv[2] || 'http://127.0.0.1:5043/'
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const p = await b.newPage()
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await p.goto(URL, { waitUntil: 'networkidle2' })
  await p.waitForSelector('.rounds tr td')
  const natural = await p.evaluate(() => ({ iw: innerWidth, sw: document.documentElement.scrollWidth }))
  // worst case: stuff the longest strings from the question list into every label slot
  await p.evaluate(() => {
    const longQ = 'Fight one horse-sized duck or 100 duck-sized horses?'
    document.querySelectorAll('td .fine, .q').forEach(e => (e.textContent = longQ))
    document.querySelectorAll('.pick small, .vs span').forEach(e => (e.textContent = '100 tiny horses 1,234,567'))
    document.querySelectorAll('.rounds td:nth-child(5)').forEach(e => (e.innerHTML = '<b>Blue &amp; black</b> doubles'))
  })
  await new Promise(r => setTimeout(r, 300))
  const stuffed = await p.evaluate(() => ({ iw: innerWidth, sw: document.documentElement.scrollWidth,
    wide: [...document.querySelectorAll('#app *')].filter(e => e.getBoundingClientRect().right > 390.5).slice(0, 3).map(e => e.tagName + '.' + e.className) }))
  console.log('natural', JSON.stringify(natural), 'worst case', JSON.stringify(stuffed))
  const ok = natural.iw === 390 && natural.sw === 390 && stuffed.sw === 390
  console.log(ok ? 'PASS: page fits a 390 px phone' : 'FAIL')
  await b.close()
  process.exit(ok ? 0 : 1)
})()
