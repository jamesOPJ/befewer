// usage: node e2e/claim-split.cjs <url> [outdir] [--claim]
// Me page, claiming mined BEFEWER: "Refined only" (0.01% of unrefined, the contract's minimum)
// is picked by default when there is refined BEFEWER, the percent buttons and the % box change
// the unrefined part, and the breakdown matches the contract's integer math and adds up.
// With --claim it also sends two real claims on testnet (npc-echo: refined only, npc-flip: 1%)
// and checks the minted amount in the contract's event equals the "To your wallet" line.
const puppeteer = require(process.env.PUPPETEER || 'puppeteer')
const fs = require('fs')
const URL = process.argv[2] || 'http://127.0.0.1:5043/'
const OUT = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'e2e-shots'
const CLAIM = process.argv.includes('--claim')
const keyOf = a => JSON.parse(fs.readFileSync(require('os').homedir() + `/.near-credentials/testnet/${a}.befewer.testnet.json`, 'utf8'))
const fail = m => { console.log('FAIL', m); process.exitCode = 1 }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const MICRO = 10n ** 12n
const cut = x => (x / MICRO) * MICRO
const units = s => { // "1,008.959506" -> 18-decimal units
  const t = s.replace(/[,+−\-\s]|BEFEWER/g, '')
  const [i, f = ''] = t.split('.')
  return BigInt(i || '0') * 10n ** 18n + BigInt((f + '000000').slice(0, 6)) * MICRO
}

async function open(b, account, w, h, mobile) {
  const p = await b.newPage()
  const errors = []
  p.on('pageerror', e => errors.push(String(e)))
  await p.setViewport({ width: w, height: h, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 })
  await p.goto(URL + '#/me', { waitUntil: 'networkidle2' })
  await p.evaluate(k => localStorage.setItem('fewer.session.v6.befewer.testnet', JSON.stringify({ accountId: k.account_id, privateKey: k.private_key, kind: 'guest' })), keyOf(account))
  await p.reload({ waitUntil: 'networkidle2' })
  await p.waitForSelector('.claim .total dd', { timeout: 60000 })
  await sleep(800)
  return { p, errors }
}

// what the page shows, and what the contract's math gives for the same player view
const read = p => p.evaluate(() => {
  const g = window.befewer.game
  const on = [...document.querySelectorAll('.claim .seg button')].find(x => x.classList.contains('on'))
  const rows = [...document.querySelectorAll('.claim .sum > div')].map(d => [d.querySelector('dt').innerText, d.querySelector('dd').innerText])
  return {
    on: on ? on.innerText : null, pct: document.querySelector('.claim .custom input')?.value, rows,
    left: document.querySelector('.claim > p')?.innerText ?? '', button: document.querySelector('.claim > button').innerText,
    unrefined: g.me.unrefined, refined: g.me.refined, tokens: g.me.tokens, feeBps: g.params.refine_fee_bps,
    sw: document.documentElement.scrollWidth,
  }
})

function check(tag, s, bps, w) {
  const u = BigInt(s.unrefined), r = BigInt(s.refined)
  const take = (u * BigInt(bps)) / 10000n
  const fee = (take * BigInt(s.feeBps)) / 10000n
  const out = take - fee + r
  const row = k => s.rows.find(([dt]) => dt.startsWith(k))?.[1]
  const shown = { take: units(row('Unrefined claimed')), fee: units(row('Fee')), refined: units(row('Refined')), out: units(row('To your wallet')) }
  console.log(`@${w} ${tag}: on=${s.on} box=${s.pct}% | ${s.rows.map(([a, b]) => `${a.split(' ·')[0].split(' →')[0]} ${b}`).join(' | ')}`)
  if (shown.take !== cut(take)) fail(`${tag}: unrefined line ${shown.take} != contract ${cut(take)}`)
  if (shown.refined !== cut(r)) fail(`${tag}: refined line ${shown.refined} != ${cut(r)}`)
  if (shown.out !== cut(out)) fail(`${tag}: wallet line ${shown.out} != contract ${cut(out)}`)
  if (shown.take - shown.fee + shown.refined !== shown.out) fail(`${tag}: lines do not add up`)
  const feeErr = shown.fee > fee ? shown.fee - fee : fee - shown.fee
  if (feeErr > 2n * MICRO) fail(`${tag}: fee line ${shown.fee} vs contract ${fee}`)
  if (!s.button.includes(row('To your wallet').replace(' BEFEWER', ''))) fail(`${tag}: button "${s.button}" differs from the wallet line`)
  if (s.sw > w) fail(`${tag}: page ${s.sw}px wider than ${w}px`)
  return { out: cut(out), take, fee }
}

async function claimFor(b, account, setup, bps, tag) {
  const { p, errors } = await open(b, account, 390, 844, true)
  await setup(p)
  await sleep(300)
  const before = await read(p)
  const exp = check(tag + ' before', before, bps, 390)
  const shownOut = units(before.rows.find(([dt]) => dt.startsWith('To your wallet'))[1])
  const tokens0 = BigInt(before.tokens)
  await p.click('.claim > button')
  await p.waitForFunction(() => [...document.querySelectorAll('.toast, [class*=toast]')].some(t => /in your wallet|Claimed\./.test(t.innerText)) || document.body.innerText.includes('panicked'), { timeout: 120000 })
  const toast = await p.evaluate(() => [...document.querySelectorAll('.toast, [class*=toast]')].map(t => t.innerText).find(t => /in your wallet|Claimed\./.test(t)) || '')
  const m = toast.match(/^([\d,.]+) BEFEWER are in your wallet/)
  await sleep(2000)
  await p.waitForFunction(t0 => BigInt(window.befewer.game.me.tokens) > BigInt(t0), { timeout: 60000 }, tokens0.toString())
  const after = await read(p)
  const minted = BigInt(after.tokens) - tokens0
  console.log(`${tag}: toast "${toast.replace(/\s+/g, ' ')}" | shown ${shownOut} minted ${minted} | unrefined ${before.unrefined} → ${after.unrefined}, refined ${before.refined} → ${after.refined}`)
  if (!m) fail(`${tag}: toast without the minted amount`)
  else if (units(m[1]) !== cut(minted)) fail(`${tag}: toast ${m[1]} != minted ${minted}`)
  // the shown line can only be behind by what was mined/refined between reading and sending
  if (cut(minted) !== shownOut) console.log(`  note: minted differs from the preview by ${minted - shownOut} units (balances moved meanwhile)`)
  if (minted < shownOut) fail(`${tag}: minted less than shown`)
  const dropped = BigInt(before.unrefined) - BigInt(after.unrefined)
  if (dropped !== exp.take) console.log(`  note: unrefined fell by ${dropped}, expected ${exp.take} (mining meanwhile?)`)
  if (errors.length) fail(errors.slice(0, 3))
  await p.screenshot({ path: `${OUT}/claim-after-${account}.png`, fullPage: true })
  await p.close()
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
    const { p, errors } = await open(b, 'npc-echo', w, h, mobile)
    const s0 = await read(p)
    if (BigInt(s0.refined) === 0n || BigInt(s0.unrefined) === 0n) { fail('npc-echo needs both refined and unrefined BEFEWER for this test'); break }
    if (s0.on !== 'Refined only') fail(`default pick is "${s0.on}", expected Refined only`)
    check('refined only', s0, 1, w)
    if (!s0.rows[0][0].includes('the least a claim takes')) fail('refined-only line does not say it is the minimum')
    await p.screenshot({ path: `${OUT}/claim-refined-only-${w}.png`, fullPage: true })
    for (const [label, bps] of [['25%', 2500], ['All', 10000]]) {
      await p.evaluate(l => [...document.querySelectorAll('.claim .seg button')].find(x => x.innerText === l).click(), label)
      await sleep(200)
      const s = await read(p)
      if (s.on !== label) fail(`${label} not highlighted`)
      check(label, s, bps, w)
      if (bps === 10000 && s.left) fail('All still says some stays unrefined')
    }
    // the % box: 1.5% -> 150 bps, no preset lit; out-of-range values are clamped
    const box = await p.$('.claim .custom input')
    await box.click({ clickCount: 3 }); await box.type('1.5'); await p.keyboard.press('Tab'); await sleep(200)
    let s = await read(p)
    if (s.on !== null) fail(`a preset is still lit at 1.5%: ${s.on}`)
    check('1.5%', s, 150, w)
    await box.click({ clickCount: 3 }); await box.type('250'); await p.keyboard.press('Tab'); await sleep(200)
    s = await read(p)
    if (s.on !== 'All' || s.pct !== '100') fail(`250% did not clamp to 100: on=${s.on} box=${s.pct}`)
    await box.click({ clickCount: 3 }); await box.type('0.001'); await p.keyboard.press('Tab'); await sleep(200)
    s = await read(p)
    if (s.on !== 'Refined only' || s.pct !== '0.01') fail(`0.001% did not clamp to 0.01: on=${s.on} box=${s.pct}`)
    await p.screenshot({ path: `${OUT}/claim-box-${w}.png`, fullPage: true })
    if (errors.length) fail(errors.slice(0, 3))
    await p.close()
  }
  if (CLAIM) {
    await claimFor(b, 'npc-echo', async () => {}, 1, 'claim refined only (npc-echo)')
    await claimFor(b, 'npc-flip', async p => {
      const box = await p.$('.claim .custom input')
      await box.click({ clickCount: 3 }); await box.type('1'); await p.keyboard.press('Tab')
    }, 100, 'claim 1% (npc-flip)')
  }
  await b.close()
  console.log(process.exitCode ? 'FAILED' : 'OK')
})()
