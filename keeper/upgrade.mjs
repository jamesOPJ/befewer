// Upgrade the code of a deployed BEFEWER contract in place (no init call: the state stays).
// Only for changes that leave the stored state layout as it is.
// usage: node upgrade.mjs <account>   e.g. node upgrade.mjs v6.befewer.testnet
import fs from 'node:fs'
import crypto from 'node:crypto'
import { actions } from 'near-api-js'
import { loadAccount, log } from './lib.mjs'

const id = process.argv[2]
if (!id) throw new Error('usage: node upgrade.mjs <account>')
const code = fs.readFileSync(new URL('../contract/target/near/fewer.wasm', import.meta.url))
const sha = crypto.createHash('sha256').update(code).digest('hex')
const acct = loadAccount(id)
log('deploying', code.length, 'bytes to', id, 'sha256', sha.slice(0, 16))
const res = await acct.signAndSendTransaction({ receiverId: id, actions: [actions.deployContract(code)] })
const ok = res.status && 'SuccessValue' in res.status
log('status', ok ? 'OK' : JSON.stringify(res.status).slice(0, 400), 'tx', res.transaction.hash)
const file = new URL('./deployments.json', import.meta.url)
const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {}
all[id] ??= {}
;(all[id].upgrades ??= []).push({ at: new Date().toISOString(), tx: res.transaction.hash, code_sha256: sha })
fs.writeFileSync(file, JSON.stringify(all, null, 2))
if (!ok) process.exit(1)
