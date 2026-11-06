// Chain access for the FEWER web app: RPC views, a local signing key, commit/reveal helpers
// and drand timelock sealing. The page never needs a backend except the optional guest faucet.
import { Buffer } from 'buffer'
;(globalThis as any).Buffer ??= Buffer
import { Account, JsonRpcProvider, FailoverRpcProvider, KeyPairSigner, KeyPair } from 'near-api-js'
import tlock from 'tlock-js'

const { timelockEncrypt, roundAt, roundTime, mainnetClient } = tlock as any

export const CONTRACT: string = import.meta.env.VITE_CONTRACT || 'v2.befewer.testnet'
export const NETWORK = 'testnet'
export const EXPLORER = 'https://testnet.nearblocks.io'
export const ONE = 10n ** 18n

export const provider = new FailoverRpcProvider([
  new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' }),
  new JsonRpcProvider({ url: 'https://rpc.testnet.near.org' }),
])

export async function view<T = any>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId: CONTRACT, method, args, finality: 'optimistic' } as any)) as T
}

// ---- types mirrored from the contract views ----
export interface Status {
  now: string; commit_round: string; commit_ends_at: string
  reveal_round: string | null; reveal_ends_at: string | null
  initial_supply: string; total_supply: string; total_burned: string; faucet_reserve: string; escrow: string
  rounds_settled: string; best_streak: number; best_streak_holder: string | null
  biggest_burn: string; biggest_burn_round: string | null
}
export interface Params { genesis_ns: string; commit_ns: string; reveal_ns: string; max_stake_bps: number; min_stake: string; faucet_amount: string }
export interface RoundV {
  round: string; commit_starts_at: string; reveal_starts_at: string; reveal_ends_at: string
  committed: string; revealed_a: string; revealed_b: string; commits: number; reveals_a: number; reveals_b: number
  claims: number; settled: boolean; outcome: 'A' | 'B' | 'void' | null; burned: string
}
export interface PlayerV {
  account_id: string; balance: string; faucet_claimed: boolean; streak: number; best_streak: number
  wins: number; losses: number; voids: number; forfeits: number
  open: { round: string; amount: string; side: 'A' | 'B' | null }[]
}

export const nsToMs = (ns: string | bigint) => Number(BigInt(ns) / 1_000_000n)
export function fmt(x: string | bigint, digits = 0): string {
  const v = Number(BigInt(x) / 10n ** 14n) / 10_000
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })
}

// ---- commit-reveal (format fixed by the contract) ----
export function randomSalt(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('')
}
export async function commitHash(accountId: string, round: number, side: 'A' | 'B', salt: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`fewer:${accountId}:${round}:${side}:${salt}`))
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('')
}

const drand = mainnetClient()
let drandInfo: any
/** Seal "side:salt" so that nobody can open it before `revealStartMs`: we use the first
 *  drand round published at or after that moment (roundAt() alone can be up to 3 s early). */
export async function seal(side: 'A' | 'B', salt: string, revealStartMs: number): Promise<{ sealed: string; drandRound: number }> {
  drandInfo ??= await drand.chain().info()
  let r = roundAt(revealStartMs, drandInfo)
  if (roundTime(drandInfo, r) < revealStartMs) r += 1
  const sealed = await timelockEncrypt(r, Buffer.from(`${side}:${salt}`), drand)
  return { sealed, drandRound: r }
}

// ---- local session key (guest account, or a function-call key added by a wallet) ----
export interface Session { accountId: string; privateKey: string; kind: 'guest' | 'wallet' }
const SESSION_KEY = `fewer.session.${CONTRACT}`
export function loadSession(): Session | null {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') } catch { return null }
}
export function saveSession(s: Session | null) {
  s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY)
}
export function newKeyPair(): { publicKey: string; privateKey: string } {
  const kp = KeyPair.fromRandom('ed25519')
  return { publicKey: kp.getPublicKey().toString(), privateKey: kp.toString() }
}
export function accountFor(s: Session): Account {
  return new Account(s.accountId, provider, KeyPairSigner.fromSecretKey(s.privateKey as any))
}

/** My picks, so the page can show what I chose and reveal manually if the keeper is down. */
const PICKS_KEY = `fewer.picks.${CONTRACT}`
export type Pick = { side: 'A' | 'B'; salt: string; amount: string; drandRound: number }
export function loadPicks(accountId: string): Record<string, Pick> {
  try { return JSON.parse(localStorage.getItem(`${PICKS_KEY}.${accountId}`) || '{}') } catch { return {} }
}
export function savePick(accountId: string, round: number, p: Pick) {
  const all = loadPicks(accountId)
  all[round] = p
  localStorage.setItem(`${PICKS_KEY}.${accountId}`, JSON.stringify(all))
}

export async function callContract(s: Session, methodName: string, args: Record<string, unknown>, gasT = 30) {
  const res: any = await accountFor(s).callFunctionRaw({ contractId: CONTRACT, methodName, args, gas: BigInt(gasT) * 10n ** 12n, deposit: 0n })
  const fail = res?.status?.Failure || res?.receipts_outcome?.find((r: any) => r.outcome.status?.Failure)?.outcome.status.Failure
  if (fail) {
    const msg = JSON.stringify(fail)
    const m = msg.match(/Smart contract panicked: ([^"\\]+)/)
    throw new Error(m ? m[1] : msg.slice(0, 200))
  }
  return res
}
