// Chain access for the FEWER web app: RPC views, a local signing key, commit/reveal helpers
// and drand timelock sealing. The page never needs a backend except the optional guest faucet.
import { Buffer } from 'buffer'
;(globalThis as any).Buffer ??= Buffer
import { Account, JsonRpcProvider, FailoverRpcProvider, KeyPairSigner, KeyPair } from 'near-api-js'
import tlock from 'tlock-js'

const { timelockEncrypt, roundAt, roundTime, mainnetClient } = tlock as any

export const CONTRACT: string = import.meta.env.VITE_CONTRACT || 'v5.befewer.testnet'
export const NETWORK = 'testnet'
export const EXPLORER = 'https://testnet.nearblocks.io'
export const TOKEN = 10n ** 18n // 1 BEFEWER
export const NEAR = 10n ** 24n // 1 NEAR in yocto
export const CHIP = 10n ** 22n // 0.01 NEAR: the smallest bet, and the autopilot's unit
export const ONE = TOKEN

export const provider = new FailoverRpcProvider([
  new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' }),
  new JsonRpcProvider({ url: 'https://rpc.testnet.near.org' }),
])

export async function view<T = any>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId: CONTRACT, method, args, finality: 'optimistic' } as any)) as T
}

// ---- types mirrored from the contract views ----
export interface DexV {
  stage: string; step: number; busy: boolean; dex: string; wnear: string; pool_id: number | null
  near_amount: string; seed: string; shares: string; graduated_at: string; held_wnear: string
  next_buyback_at: string; buybacks: number; bought_near: string; bought_burned: string
}
export interface Status {
  now: string; commit_round: string; commit_ends_at: string
  reveal_round: string | null; reveal_ends_at: string | null
  treasury: string; treasury_spendable: string; treasury_in: string; graduate_at: string
  balances_total: string; escrow: string; storage_fees: string
  total_supply: string; max_supply: string; issued: string; mined: string; pot: string; total_burned: string
  unrefined_total: string; refine_fee_bps: number; refine_fees: string; refine_to_pot: string; claimed: string
  rounds_settled: string; best_streak: number; best_streak_holder: string | null
  biggest_reward: string; biggest_reward_round: string | null
  dex: DexV
}
export interface Params {
  genesis_ns: string; commit_ns: string; reveal_ns: string; max_stake_bps: number; min_stake: string
  fee_bps: number; reward_per_round: string; max_supply: string; streak_min: number; graduate_at: string
  dex: string; wnear: string; pool_fee: number; buyback_max: string; buyback_every_ns: string; refine_fee_bps: number
}
export interface RoundV {
  round: string; commit_starts_at: string; reveal_starts_at: string; reveal_ends_at: string
  committed: string; fees: string; revealed_a: string; revealed_b: string; shares_a: string; shares_b: string
  commits: number; reveals_a: number; reveals_b: number
  claims: number; settled: boolean; outcome: 'A' | 'B' | 'void' | null
  to_treasury: string; emission: string; reward: string; reward_shares: string
}
export interface PlayerV {
  account_id: string; balance: string; tokens: string; registered: boolean; streak: number; best_streak: number
  wins: number; losses: number; voids: number; forfeits: number; mined: string
  /** mined BEFEWER still in the game (claiming costs the refining fee on it) and the share of others' fees (no fee) */
  unrefined: string; refined: string
  open: { round: string; amount: string; fee: string; side: 'A' | 'B' | null; streak_if_win: number; shares: string }[]
}

export const nsToMs = (ns: string | bigint) => Number(BigInt(ns) / 1_000_000n)
/** BEFEWER (18 decimals). Small amounts keep enough digits to not read as 0. */
export function fmt(x: string | bigint, digits?: number): string {
  const v = Number(BigInt(x) / 10n ** 12n) / 1e6
  const d = digits ?? (v === 0 ? 0 : Math.abs(v) < 1 ? 4 : Math.abs(v) < 100 ? 2 : 0)
  return v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 })
}
/** NEAR (24 decimals), up to 4 decimals, trailing zeros dropped. */
export function fmtN(x: string | bigint, digits = 4): string {
  const v = Number(BigInt(x) / 10n ** 18n) / 1e6
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}
/** NEAR as a number -> yocto. */
export const toYocto = (near: number) => (BigInt(Math.round(near * 1e6)) * NEAR) / 1_000_000n
/** yocto -> NEAR as a number (for inputs and arithmetic in the UI only). */
export const toNear = (yocto: string | bigint) => Number(BigInt(yocto) / 10n ** 18n) / 1e6

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
export type Pick = { side: 'A' | 'B'; salt: string; amount: string; fee?: string; drandRound: number }
export function loadPicks(accountId: string): Record<string, Pick> {
  try { return JSON.parse(localStorage.getItem(`${PICKS_KEY}.${accountId}`) || '{}') } catch { return {} }
}
export function savePick(accountId: string, round: number, p: Pick) {
  const all = loadPicks(accountId)
  all[round] = p
  localStorage.setItem(`${PICKS_KEY}.${accountId}`, JSON.stringify(all))
}

export async function callContract(s: Session, methodName: string, args: Record<string, unknown>, gasT = 30, deposit = 0n) {
  const res: any = await accountFor(s).callFunctionRaw({ contractId: CONTRACT, methodName, args, gas: BigInt(gasT) * 10n ** 12n, deposit })
  const fail = res?.status?.Failure || res?.receipts_outcome?.find((r: any) => r.outcome.status?.Failure)?.outcome.status.Failure
  if (fail) {
    const msg = JSON.stringify(fail)
    const m = msg.match(/Smart contract panicked: ([^"\\]+)/)
    throw new Error(m ? m[1] : msg.slice(0, 200))
  }
  return res
}
