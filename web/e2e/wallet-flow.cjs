// Wallet login, end to end on testnet with a stand-in wallet (e2e/testwallet.mjs):
// connect -> one approval (AddKey + deposit) -> bet signed by the browser's game key -> withdraw -> disconnect.
// usage: node e2e/wallet-flow.cjs <url> <contract> <account with a key in ~/.near-credentials/testnet>
const puppeteer = require('/root/dota/node_modules/puppeteer')
const [URL = 'http://127.0.0.1:5044/', CONTRACT = 'v5.befewer.testnet', ACCOUNT = 'walletqa.befewer.testnet'] = process.argv.slice(2)
async function rpc(method, params) {
  const r = await fetch('https://rpc.testnet.near.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return (await r.json()).result
}
const view = async (m, args) => JSON.parse(Buffer.from((await rpc('query', { request_type: 'call_function', finality: 'optimistic', account_id: CONTRACT, method_name: m, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') })).result).toString())
const keys = async () => (await rpc('query', { request_type: 'view_access_key_list', finality: 'optimistic', account_id: ACCOUNT })).keys
const click = (p, re) => p.evaluate(src => { const r = new RegExp(src); const b = [...document.querySelectorAll('button')].find(x => r.test(x.textContent)); if (!b) return false; b.click(); return true }, re.source)
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const { makeSigner } = await import('./testwallet.mjs')
  const wallet = makeSigner(ACCOUNT)
  const keysBefore = (await keys()).length
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 10 * 60_000 })
  const p = await b.newPage()
  const errors = []
  p.on('pageerror', e => errors.push(String(e)))
  await p.exposeFunction('__befewerSign', json => wallet.sign(json))
  await p.evaluateOnNewDocument(acc => {
    window.__befewerWallet = { accountId: acc, async signAndSend(txs) { const r = await window.__befewerSign(JSON.stringify(txs)); if (r !== 'ok') throw new Error(r) } }
  }, ACCOUNT)
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await p.goto(URL, { waitUntil: 'networkidle2' })
  await p.waitForSelector('.connect')
  await p.click('.connect')
  await p.waitForSelector('.dialog .wallet')
  console.log('dialog:', (await p.$eval('.dialog', e => e.innerText)).replace(/\s+/g, ' ').slice(0, 120))
  await p.evaluate(() => document.querySelector('.dialog .wallet').click())
  await p.waitForSelector('.dialog .go')
  console.log('setup step:', (await p.$eval('.dialog', e => e.innerText)).replace(/\s+/g, ' ').slice(0, 300))
  await click(p, /^0\.5 NEAR$/)
  await p.evaluate(() => document.querySelector('.dialog .go').click())
  await p.waitForFunction(() => Object.keys(localStorage).some(k => k.startsWith('fewer.session.') && JSON.parse(localStorage.getItem(k)).kind === 'wallet'), { timeout: 90_000 })
  console.log('wallet signed:', JSON.stringify(wallet.signed))
  const ks = await keys()
  const fc = ks.filter(k => k.access_key.permission !== 'FullAccess')
  console.log(`keys on ${ACCOUNT}: ${keysBefore} -> ${ks.length}; new game key permission:`, JSON.stringify(fc[fc.length - 1]?.access_key.permission))
  const sessionPk = await p.evaluate(() => { const k = Object.keys(localStorage).find(k => k.startsWith('fewer.session.')); return JSON.parse(localStorage.getItem(k)) })
  console.log('session kind:', sessionPk.kind, 'account:', sessionPk.accountId)
  await sleep(2500)
  console.log('header:', await p.$eval('.right', e => e.innerText.replace(/\s+/g, ' ')))
  // bet: signed in the browser with the game key, no wallet involved
  const nSigned = wallet.signed.length
  await p.waitForSelector('.answer.B', { timeout: 120_000 })
  await p.tap('.answer.B')
  await p.tap('.cta')
  await p.waitForFunction(() => document.querySelector('.sealed') || document.querySelector('.toast.err'), { timeout: 120_000 })
  const err = await p.$('.toast.err')
  if (err) throw new Error('bet failed: ' + (await p.evaluate(e => e.textContent, err)))
  const me = await view('get_player', { account_id: ACCOUNT })
  console.log('bet placed:', JSON.stringify(me.open), 'balance', Number(BigInt(me.balance) / 10n ** 18n) / 1e6, '| wallet asked again?', wallet.signed.length > nSigned ? 'YES (bad)' : 'no')
  // Me page: withdraw (game key), then disconnect
  await p.goto(URL + '#/me', { waitUntil: 'networkidle2' })
  await p.waitForSelector('.walletbox')
  console.log('me wallet box:', (await p.$eval('.walletbox', e => e.innerText)).replace(/\s+/g, ' ').slice(0, 100))
  await click(p, /^Withdraw .* NEAR to the wallet$/)
  await p.waitForFunction(() => /moved to your wallet/.test(document.body.innerText) || document.querySelector('.toast.err'), { timeout: 90_000 })
  const after = await view('get_player', { account_id: ACCOUNT })
  console.log('after withdraw: game balance', Number(BigInt(after.balance) / 10n ** 18n) / 1e6, 'NEAR (the open bet stays in escrow)')
  await click(p, /^Disconnect$/)
  await sleep(1500)
  console.log('after disconnect: session', await p.evaluate(() => localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('fewer.session.')) || 'x')), '| connect button back:', !!(await p.$('.connect')))
  console.log('errors:', errors.length ? errors : 'none')
  await b.close()
})().catch(e => { console.error('E2E FAILED', e.message); process.exit(1) })
