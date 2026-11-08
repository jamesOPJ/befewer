// usage: node e2e/offpage.cjs <url> <outdir> <account>   (the account's key in ~/.near-credentials/testnet)
// Autopilot page, "Runs only while this page is open": fits phone and desktop width, and "Copy the
// last line" gives a command for the terminal script with this account, its key and the switched-on
// slots' rules (printed, so it can be run). The page's own Autopilot stays off.
const puppeteer = require(process.env.PUPPETEER || 'puppeteer')
const fs = require('fs')
const [URL = 'http://127.0.0.1:5043/', OUT = 'e2e-shots', ACCT] = process.argv.slice(2)
const key = JSON.parse(fs.readFileSync(require('os').homedir() + `/.near-credentials/testnet/${ACCT}.json`, 'utf8'))
const fail = m => { console.log('FAIL', m); process.exitCode = 1 }
// two slots: Echo on slot 0, "Always B" on slot 1 (opened by the terminal run before, so its streak carries on)
const lanes = [
  { name: 'Echo', slot: 0, owner: null, on: true, live: [{ cond: { kind: 'last', winner: 'any' }, pick: 'same', unit: 'fixed', amount: 1 }] },
  { name: 'Always B', slot: 1, owner: key.account_id, on: true, live: [{ cond: { kind: 'always' }, pick: 'loop', unit: 'fixed', amount: 1, pattern: 'B' }] },
]
;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
    for (const withSession of [false, true]) {
      const p = await b.newPage()
      const errors = []
      p.on('pageerror', e => errors.push(String(e)))
      await p.setViewport({ width: w, height: h, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 })
      await p.goto(URL + '#/autopilot', { waitUntil: 'networkidle2' })
      await p.evaluate((k, lanes, s) => {
        localStorage.clear()
        if (s) localStorage.setItem('fewer.session.v6.befewer.testnet', JSON.stringify({ accountId: k.account_id, privateKey: k.private_key, kind: 'guest' }))
        localStorage.setItem('befewer.ap.lanes', JSON.stringify(lanes))
        localStorage.setItem('befewer.ap.on', '0')
      }, key, lanes, withSession)
      await p.reload({ waitUntil: 'networkidle2' })
      await p.waitForSelector('details.offpage', { timeout: 30000 })
      await p.click('details.offpage summary')
      await new Promise(r => setTimeout(r, 600))
      await p.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async t => { window.__copied = t } })
      const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, text: document.querySelector('details.offpage').innerText, copy: !!document.querySelector('details.offpage .btn') }))
      const tag = `${w}-${withSession ? 'account' : 'new'}`
      await (await p.$('details.offpage')).screenshot({ path: `${OUT}/offpage-${tag}.png` })
      console.log(`@${tag}: width ${m.sw}/${w} · copy button ${m.copy} · shows the key? ${m.text.includes(key.private_key)}`)
      if (m.sw > w) fail('page wider than the screen')
      if (m.text.includes(key.private_key)) fail('the full key is shown on the page')
      if (withSession) {
        await p.click('details.offpage .btn')
        const cmd = await p.evaluate(() => window.__copied)
        const json = cmd && cmd.match(/--rules '(.*)'$/)?.[1]
        if (!cmd || !cmd.includes(`FEWER_PRIVATE_KEY=${key.private_key} `) || !cmd.includes(`--account ${key.account_id} `) || !json) fail('copied command is not right: ' + cmd)
        else if (w === 1280) { fs.writeFileSync(`${OUT}/offpage-command.txt`, cmd); console.log('command (key hidden here):', cmd.replace(key.private_key, 'ed25519:…'), '\n  rules:', JSON.stringify(JSON.parse(json))) }
      }
      if (errors.length) fail(errors.slice(0, 3))
      await p.close()
    }
  }
  await b.close()
})()
