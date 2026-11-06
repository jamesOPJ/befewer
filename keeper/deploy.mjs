// Deploy FEWER to <prefix>.befewer.testnet (fresh sub-account) and initialise it in one transaction.
// usage: node deploy.mjs <prefix> [commitMin=5] [revealMin=3]
import fs from 'node:fs'
import crypto from 'node:crypto'
import { actions } from 'near-api-js'
import { loadAccount, newKeyFor, log, ONE } from './lib.mjs'

const ROOT = 'befewer.testnet'
const [prefix, commitMin = '5', revealMin = '3'] = process.argv.slice(2)
if (!prefix) throw new Error('usage: node deploy.mjs <prefix> [commitMin] [revealMin]')
const id = `${prefix}.${ROOT}`
const code = fs.readFileSync(new URL('../contract/target/near/fewer.wasm', import.meta.url))
const MIN = 60_000_000_000n
const nowNs = BigInt(Date.now()) * 1_000_000n
const genesis = (nowNs / MIN + 3n) * MIN // three minutes from now, on a whole minute
const icon = 'data:image/svg+xml;base64,' + Buffer.from(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#1c1b19'/>" +
  "<circle cx='42' cy='31' r='14' fill='#5d5a54'/><circle cx='20' cy='36' r='7' fill='#f0b94a'/></svg>").toString('base64')
const params = {
  genesis_ns: genesis.toString(),
  commit_ns: (BigInt(commitMin) * MIN).toString(),
  reveal_ns: (BigInt(revealMin) * MIN).toString(),
  max_stake_bps: 2500,
  min_stake: ONE.toString(),
  faucet_amount: (1000n * ONE).toString(),
}
const args = {
  total_supply: (1_000_000_000n * ONE).toString(),
  params,
  metadata: { spec: 'ft-1.0.0', name: 'FEWER', symbol: 'FEWER', icon, reference: null, reference_hash: null, decimals: 18 },
}

const root = loadAccount(ROOT)
const kp = newKeyFor(id)
log('creating', id)
await root.createSubAccount({ accountOrPrefix: id, publicKey: kp.getPublicKey(), nearToTransfer: 4n * 10n ** 24n })
const acct = loadAccount(id)
log('deploying', code.length, 'bytes and calling new()')
const res = await acct.signAndSendTransaction({
  receiverId: id,
  actions: [actions.deployContract(code), actions.functionCall('new', args, 100_000_000_000_000n, 0n)],
})
const ok = res.status && 'SuccessValue' in res.status
log('status', ok ? 'OK' : JSON.stringify(res.status).slice(0, 400), 'tx', res.transaction.hash)
const file = new URL('./deployments.json', import.meta.url)
const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {}
all[id] = { deployed_at: new Date().toISOString(), tx: res.transaction.hash, code_sha256: crypto.createHash('sha256').update(code).digest('hex'), params }
fs.writeFileSync(file, JSON.stringify(all, null, 2))
