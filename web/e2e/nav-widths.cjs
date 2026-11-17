// usage: node e2e/nav-widths.cjs <url>   (exit 1 on any width where the header does not fit)
// Drags the browser window from 1400px down to 320px with a playing account (Testnet pill +
// Connect wallet + "NEAR · BEFEWER" balance, the widest header there is) and checks, at every
// width: the page is not wider than the window, no tab label wraps onto a second line, and
// logo / tabs / right-hand pills do not overlap or run past the edge.
const puppeteer = require(process.env.PUPPETEER || 'puppeteer')
const fs = require('fs')
const URL = process.argv[2] || 'http://127.0.0.1:5043/'
const key = JSON.parse(fs.readFileSync(require('os').homedir() + '/.near-credentials/testnet/npc-echo.befewer.testnet.json', 'utf8'))
const widths = []
for (let w = 1400; w >= 320; w -= 10) widths.push(w)
widths.push(1099, 1100, 859, 861, 599, 601, 521, 519, 359, 361)
;(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const p = await b.newPage()
  await p.setViewport({ width: 1400, height: 800 })
  await p.goto(URL, { waitUntil: 'networkidle2' })
  await p.evaluate(k => localStorage.setItem('fewer.session.v6.befewer.testnet', JSON.stringify({ accountId: k.account_id, privateKey: k.private_key, kind: 'guest' })), key)
  await p.reload({ waitUntil: 'networkidle2' })
  await p.waitForSelector('.bal', { timeout: 30000 })
  await new Promise(r => setTimeout(r, 800))
  let bad = 0
  for (const w of widths.sort((x, y) => y - x)) {
    await p.setViewport({ width: w, height: 800 })
    await new Promise(r => setTimeout(r, 120))
    const m = await p.evaluate(() => {
      const box = s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? r : null }
      const vw = document.documentElement.clientWidth
      const brand = box('.brand'), tabs = box('.tabs-top'), right = box('.right')
      const probs = []
      if (document.documentElement.scrollWidth > vw) probs.push(`page ${document.documentElement.scrollWidth}px wide`)
      // the text's own box (flex stretches every tab to the tallest one, so the link box would flag them all)
      for (const a of document.querySelectorAll('.tabs-top a')) { if (!a.getBoundingClientRect().width) continue; const rg = document.createRange(); rg.selectNodeContents(a); const lines = new Set([...rg.getClientRects()].filter(x => x.width).map(x => Math.round(x.top))).size; if (lines > 1) probs.push(`tab "${a.innerText.replace(/\n/g, ' ')}" wraps onto ${lines} lines`) }
      if (right && right.right > vw + 0.5) probs.push(`right side ends at ${Math.round(right.right)}`)
      if (tabs && brand.right > tabs.left + 0.5) probs.push('logo overlaps tabs')
      if (tabs && tabs.right > right.left + 0.5) probs.push('tabs overlap pills')
      if (!tabs && brand.right > right.left + 0.5) probs.push('logo overlaps pills')
      const bal = document.querySelector('.bal'); if (bal && bal.getBoundingClientRect().height > 34) probs.push('balance wraps')
      return { probs, tabsShown: !!tabs, labels: [...document.querySelectorAll('.tabs-top a')].map(a => a.innerText).join('|'), bal: bal?.innerText.replace(/\n/g, ' ') }
    })
    if (m.probs.length) bad++
    console.log(`${w}px ${m.probs.length ? 'FAIL ' + m.probs.join('; ') : 'ok'}  ${m.tabsShown ? '[' + m.labels + ']' : '[bottom nav]'}  "${m.bal}"`)
  }
  console.log(bad ? `${bad} widths do not fit` : 'header fits at every width')
  process.exitCode = bad ? 1 : 0
  await b.close()
})()
