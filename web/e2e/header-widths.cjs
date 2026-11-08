// usage: node e2e/header-widths.cjs <url>   (exit 1 if the page gets wider than the screen)
// Header on iPhone widths with a playing account (balance pill + Connect wallet + Testnet).
const puppeteer = require(process.env.PUPPETEER || 'puppeteer')
const fs = require('fs')
const URL = process.argv[2] || 'http://127.0.0.1:5043/'
const key = JSON.parse(fs.readFileSync(require('os').homedir() + '/.near-credentials/testnet/npc-echo.befewer.testnet.json', 'utf8'))
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  for (const w of [320, 375, 390, 430]) {
    const p = await b.newPage()
    await p.setUserAgent(UA)
    await p.setViewport({ width: w, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
    await p.goto(URL, { waitUntil: 'networkidle2' })
    await p.evaluate(k => localStorage.setItem('fewer.session.v6.befewer.testnet', JSON.stringify({ accountId: k.account_id, privateKey: k.private_key, kind: 'guest' })), key)
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.bal', { timeout: 30000 })
    await new Promise(r => setTimeout(r, 800))
    const m = await p.evaluate(() => {
      const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right)] }
      return { vw: innerWidth, docw: document.documentElement.scrollWidth, brand: r('.brand'), testnet: r('.testnet'), connect: r('.connect'), bal: r('.bal'), balText: document.querySelector('.bal')?.innerText }
    })
    const over = m.docw > m.vw
    if (over) process.exitCode = 1
    const cut = Object.entries(m).filter(([k, v]) => Array.isArray(v) && v[1] > m.vw).map(([k]) => k)
    console.log(`${w}px: page ${m.docw}/${m.vw}  brand ${m.brand}  testnet ${m.testnet}  connect ${m.connect}  balance ${m.bal} "${m.balText}"  ${cut.length ? 'CUT OFF: ' + cut.join(', ') : 'all visible'}${over ? '  PAGE WIDER THAN SCREEN' : ''}`)
    if (w === 390) await p.screenshot({ path: require('os').tmpdir() + '/befewer-header-390.png', clip: { x: 0, y: 0, width: w, height: 70 } })
    await p.close()
  }
  await b.close()
})()
