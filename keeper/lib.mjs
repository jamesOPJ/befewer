// Shared helpers for FEWER ops scripts (deploy, NPC players, keeper). Testnet only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Account, JsonRpcProvider, FailoverRpcProvider, KeyPairSigner, KeyPair } from 'near-api-js'

export const NETWORK = process.env.NEAR_NETWORK || 'testnet'
if (NETWORK !== 'testnet') throw new Error('these scripts are testnet-only')
const RPCS = (process.env.NEAR_RPCS || 'https://test.rpc.fastnear.com,https://rpc.testnet.near.org').split(',')
export const provider = new FailoverRpcProvider(RPCS.map(url => new JsonRpcProvider({ url })))
const CRED_DIR = path.join(os.homedir(), '.near-credentials', NETWORK)

export function loadAccount(accountId) {
  const j = JSON.parse(fs.readFileSync(path.join(CRED_DIR, `${accountId}.json`), 'utf8'))
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(j.private_key))
}

export function hasKey(accountId) {
  return fs.existsSync(path.join(CRED_DIR, `${accountId}.json`))
}

export function newKeyFor(accountId) {
  const kp = KeyPair.fromRandom('ed25519')
  fs.mkdirSync(CRED_DIR, { recursive: true })
  const file = path.join(CRED_DIR, `${accountId}.json`)
  if (fs.existsSync(file)) throw new Error(`key file already exists: ${file}`)
  fs.writeFileSync(file, JSON.stringify({ account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 })
  return kp
}

export async function view(contractId, method, args = {}) {
  return provider.callFunction({ contractId, method, args, finality: 'optimistic' })
}

export async function call(account, contractId, methodName, args = {}, { gas = 50_000_000_000_000n, deposit = 0n } = {}) {
  return account.callFunction({ contractId, methodName, args, gas, deposit })
}

// Commit-reveal helpers. Preimage format is fixed by the contract: fewer:<account>:<round>:<A|B>:<salt>
export function newSalt() {
  return crypto.randomBytes(16).toString('hex') // 128-bit, 32 chars
}
export function commitHash(accountId, round, side, salt) {
  return crypto.createHash('sha256').update(`fewer:${accountId}:${round}:${side}:${salt}`).digest('hex')
}

export const TOKEN = 10n ** 18n // 1 BEFEWER
export const NEAR = 10n ** 24n // 1 NEAR in yocto
export const ONE = TOKEN
/** BEFEWER amount (18 decimals) for logs */
export const fmt = x => (Number(BigInt(x) / 10n ** 15n) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })
/** NEAR amount (24 decimals) for logs */
export const fmtN = x => (Number(BigInt(x) / 10n ** 20n) / 10000).toLocaleString('en-US', { maximumFractionDigits: 4 })
export const sleep = ms => new Promise(r => setTimeout(r, ms))
export const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a)
