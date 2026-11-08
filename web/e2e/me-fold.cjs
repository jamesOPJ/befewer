// usage: node e2e/me-fold.cjs <url> [outdir]
// Me page with a long history: wallet/forget cards sit above the lists, Results folds,
// the fold is remembered across reloads, and nothing gets wider than the screen.
const puppeteer = require(process.env.PUPPETEER || 'puppeteer')
const fs = require('fs')
const URL = process.argv[2] || 'http://127.0.0.1:5043/'
const OUT = process.argv[3] || 'e2e-shots'
const key = JSON.parse(fs.readFileSync(require('os').homedir() + '/.near-credentials/testnet/npc-echo.befewer.testnet.json', 'utf8'))
const fail = m => { console.log('FAIL', m); process.exitCode = 1 }
;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
    const p = await b.newPage()
    const errors = []
    p.on('pageerror', e => errors.push(String(e)))
    await p.setViewport({ width: w, height: h, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 })
    await p.goto(URL + '#/me', { waitUntil: 'networkidle2' })
    // a long history: 40 settled bets as picks in this (headless, throwaway) browser only
    await p.waitForFunction(() => window.befewer?.game?.rounds?.length > 0, { timeout: 60000 })
    await p.evaluate(k => {
      const newest = Math.max(...window.befewer.game.rounds.map(r => Number(r.round)))
      const picks = {}
      for (let r = newest - 45; r < newest - 5; r++) picks[r] = { side: r % 2 ? 'A' : 'B', salt: 'x', amount: '10000000000000000000000', drandRound: 0 }
      localStorage.setItem('fewer.session.v6.befewer.testnet', JSON.stringify({ accountId: k.account_id, privateKey: k.private_key, kind: 'guest' }))
      localStorage.setItem('fewer.picks.v6.befewer.testnet.' + k.account_id, JSON.stringify(picks))
      localStorage.removeItem('befewer.me.results')
    }, key)
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('button.fold', { timeout: 60000 })
    await new Promise(r => setTimeout(r, 1000))
    const m = () => p.evaluate(() => {
      const top = s => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top + scrollY) : null }
      return { wallet: top('.walletbox'), forget: top('.danger'), results: top('button.fold'), items: document.querySelectorAll('#me-results li').length,
        pageH: document.documentElement.scrollHeight, sw: document.documentElement.scrollWidth, label: document.querySelector('button.fold').innerText.replace(/\s+/g, ' ') }
    })
    const a = await m()
    await p.screenshot({ path: `${OUT}/me-open-${w}.png`, fullPage: true })
    await p.click('button.fold')
    await new Promise(r => setTimeout(r, 300))
    const c = await m()
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('button.fold', { timeout: 60000 })
    await new Promise(r => setTimeout(r, 1000))
    const r = await m()
    await p.screenshot({ path: `${OUT}/me-folded-${w}.png`, fullPage: true })
    console.log(`@${w} label "${a.label}" | wallet y=${a.wallet} forget y=${a.forget} results y=${a.results} | open ${a.items} items, page ${a.pageH}px → folded ${c.items} items, page ${c.pageH}px → after reload ${r.items} items | width ${r.sw}`)
    if (!(a.wallet < a.results && a.forget < a.results)) fail('wallet/forget not above Results')
    if (!(a.items > 0 && c.items === 0 && r.items === 0)) fail('fold did not hide or was not remembered')
    if (a.sw > w || r.sw > w) fail('page wider than the screen')
    if (errors.length) fail(errors.slice(0, 3))
    await p.close()
  }
  await b.close()
})()
