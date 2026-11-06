// App-wide reactive state: chain data (polled), the player's session, bets, results, autopilot.
import {
  ONE, view, fmt, nsToMs, randomSalt, commitHash, seal, loadSession, saveSession, newKeyPair,
  loadPicks, savePick, callContract, type Status, type Params, type RoundV, type PlayerV, type Session,
} from './chain'
import * as H from './history'
import { label } from './questions'
import { decide, guard, normalizeRule, stakeFor, PRESETS, type Rule, type Lookup } from './rules'

export type Side = 'A' | 'B'
export type Result = { round: number; side: Side; amount: bigint; outcome: 'A' | 'B' | 'void' }
export type Toast = { id: number; kind: 'ok' | 'err' | 'info'; text: string }
export type ApLog = { at: number; round: number; text: string; kind: 'bet' | 'skip' | 'err' }

// Two rule sets: `live` is what the autopilot runs; `draft` is what you edit and replay.
// Editing never touches the running rules until you press "Put live".
const LIVE_KEY = 'befewer.ap.live'
const DRAFT_KEY = 'befewer.ap.draft'
const OLD_KEY = 'befewer.ap.rules' // single rule set from the previous version
function readRules(key: string): Rule[] | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null')
    return Array.isArray(saved) ? saved.map(normalizeRule) : null
  } catch {
    return null
  }
}
function loadRules(): { live: Rule[]; draft: Rule[] } {
  const live = readRules(LIVE_KEY) ?? readRules(OLD_KEY) ?? structuredClone(PRESETS[0].rules)
  const draft = readRules(DRAFT_KEY) ?? structuredClone(live)
  return { live, draft }
}
const initialRules = loadRules()

export const NPCS = [
  { id: 'npc-coin.befewer.testnet', name: 'Coin', about: 'Flips a coin every round.' },
  { id: 'npc-echo.befewer.testnet', name: 'Echo', about: 'Bets the last smaller side wins again.' },
  { id: 'npc-flip.befewer.testnet', name: 'Flip', about: 'Bets the crowd over-corrects.' },
  { id: 'npc-whale.befewer.testnet', name: 'Whale', about: 'Plays half the rounds and bets big.' },
]

export const game = $state({
  ready: false,
  error: '',
  params: null as Params | null,
  status: null as Status | null,
  skew: 0,
  now: Date.now(),
  session: loadSession() as Session | null,
  me: null as PlayerV | null,
  rounds: [] as RoundV[], // newest first
  history: 0, // bumps whenever the round history changes, so derived views recompute
  results: [] as Result[],
  npcs: {} as Record<string, PlayerV>,
  busy: '', // what an in-flight bet is doing right now
  toasts: [] as Toast[],
  ap: { live: initialRules.live, draft: initialRules.draft, on: localStorage.getItem('befewer.ap.on') === '1', log: [] as ApLog[] },
})

// ---------- small helpers used by the pages ----------
export const commitRound = () => Number(game.status?.commit_round ?? 0)
export const revealRound = () => (game.status?.reveal_round == null ? null : Number(game.status.reveal_round))
export const started = () => !!game.status && !!game.params && BigInt(game.status.now) >= BigInt(game.params.genesis_ns)
export const msLeft = (ns: string | null | undefined) => (ns ? Math.max(0, nsToMs(ns) - game.now) : 0)
export const clock = (ms: number) => {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
export const roundById = (r: number | null) => (r == null ? undefined : game.rounds.find(x => Number(x.round) === r) ?? H.round(r))
export const lookup: Lookup = { recent: H.recent, sameQuestion: H.sameQuestion, outcome: H.outcome }
export const picks = () => (game.session ? loadPicks(game.session.accountId) : {})
export const myOpen = (r: number) => game.me?.open.find(o => Number(o.round) === r)
export const short = (a: string) => (a.length > 22 ? a.slice(0, 10) + '…' + a.slice(-10) : a)
export { fmt, label, ONE }

let toastId = 0
export function toast(kind: Toast['kind'], text: string, ms = kind === 'err' ? 9000 : 4500) {
  const id = ++toastId
  game.toasts.push({ id, kind, text })
  setTimeout(() => dismiss(id), ms)
}
export function dismiss(id: number) {
  game.toasts = game.toasts.filter(t => t.id !== id)
}

// ---------- polling ----------
let refreshing = false
export async function refresh(full = false) {
  if (refreshing) return
  refreshing = true
  try {
    game.params ??= await view<Params>('get_params')
    const st = await view<Status>('get_status')
    game.status = st
    game.skew = nsToMs(st.now) - Date.now()
    const fresh = await view<RoundV[]>('get_rounds', { from: st.commit_round, limit: full || !game.rounds.length ? 40 : 6 })
    H.remember(fresh)
    await H.loadDeep(Number(st.commit_round))
    const byId = new Map(game.rounds.map(r => [r.round, r]))
    for (const r of fresh) byId.set(r.round, r)
    game.rounds = [...byId.values()].sort((a, b) => Number(b.round) - Number(a.round)).slice(0, 60)
    game.history++
    if (game.session) {
      game.me = await view<PlayerV>('get_player', { account_id: game.session.accountId })
      await loadResults()
    }
    game.ready = true
    game.error = ''
  } catch (e: any) {
    game.error = 'Cannot reach NEAR testnet right now. Retrying…'
    console.error(e)
  } finally {
    refreshing = false
  }
}

async function loadResults() {
  if (!game.session || !game.me) return
  const pk = loadPicks(game.session.accountId)
  const open = new Set(game.me.open.map(o => o.round))
  const ids = Object.keys(pk).filter(r => !open.has(r)).sort((a, b) => Number(b) - Number(a)).slice(0, 40)
  const out: Result[] = []
  for (const id of ids) {
    let rv = H.round(Number(id))
    if (!rv?.settled) {
      rv = await view<RoundV>('get_round', { round: id })
      H.remember([rv])
    }
    if (!rv.settled || !rv.outcome) continue
    out.push({ round: Number(id), side: pk[id].side, amount: BigInt(pk[id].amount), outcome: rv.outcome })
  }
  const newest = out[0]
  const prevNewest = game.results[0]
  if (newest && prevNewest && newest.round !== prevNewest.round) announce(newest)
  game.results = out
}

function announce(x: Result) {
  if (x.outcome === 'void') toast('info', `Round ${x.round} was void: your ${fmt(x.amount)} BEFEWER came back.`)
  else if (x.outcome === x.side) toast('ok', `Round ${x.round}: ${label(x.round, x.side)} was the smaller side. You won +${fmt(x.amount)} BEFEWER.`)
  else toast('info', `Round ${x.round}: ${label(x.round, x.outcome)} was the smaller side. You lost ${fmt(x.amount)} BEFEWER.`)
}

export async function loadNpcs() {
  for (const n of NPCS) {
    try { game.npcs[n.id] = await view<PlayerV>('get_player', { account_id: n.id }) } catch {}
  }
}

// ---------- account + bets ----------
/** Make sure this browser has a testnet account with BEFEWER in it. */
export async function ensurePlayer() {
  if (!game.session) {
    game.busy = 'Creating your testnet account'
    const kp = newKeyPair()
    const res = await fetch('api/guest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: kp.publicKey }) })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || 'The guest account service is unavailable.')
    game.session = { accountId: j.accountId, privateKey: kp.privateKey, kind: 'guest' }
    saveSession(game.session)
  }
  game.me = await view<PlayerV>('get_player', { account_id: game.session.accountId })
  if (!game.me.faucet_claimed && BigInt(game.me.balance) === 0n) {
    game.busy = `Claiming ${fmt(game.params!.faucet_amount)} free BEFEWER`
    await callContract(game.session, 'faucet', {})
    game.me = await view<PlayerV>('get_player', { account_id: game.session.accountId })
  }
}

export function capFor(balance: bigint) {
  return (balance * BigInt(game.params!.max_stake_bps)) / 10000n
}

/** Seal a side with drand and commit it to the round taking bets right now. */
export async function placeBet(side: Side, want: bigint, by: 'you' | 'autopilot' = 'you') {
  try {
    await ensurePlayer()
    const cap = capFor(BigInt(game.me!.balance))
    let amount = want > cap ? cap : want
    const min = BigInt(game.params!.min_stake)
    if (amount < min) amount = min
    if (amount > cap) throw new Error('Your balance is too small: the most you can bet is 25% of it.')
    const st = await view<Status>('get_status')
    game.status = st
    const r = Number(st.commit_round)
    const revealStart = nsToMs(st.commit_ends_at)
    if (revealStart - (Date.now() + game.skew) < 8000) throw new Error('This round is closing. Wait a few seconds for the next one.')
    game.busy = 'Sealing your answer with drand'
    const salt = randomSalt()
    const hash = await commitHash(game.session!.accountId, r, side, salt)
    const { sealed, drandRound } = await seal(side, salt, revealStart)
    savePick(game.session!.accountId, r, { side, salt, amount: amount.toString(), drandRound })
    game.busy = 'Sending the sealed bet'
    await callContract(game.session!, 'commit', { round: String(r), amount: amount.toString(), hash, sealed })
    if (by === 'you') toast('ok', `Sealed: ${fmt(amount)} BEFEWER on ${label(r, side)}. It opens itself at the reveal.`)
    return { round: r, amount }
  } finally {
    game.busy = ''
    await refresh(true)
  }
}

export function forgetDevice() {
  saveSession(null)
  game.session = null
  game.me = null
  game.results = []
}

// ---------- autopilot ----------
const apDone = new Set<number>()
export function saveRules() {
  localStorage.setItem(LIVE_KEY, JSON.stringify(game.ap.live))
  localStorage.setItem(DRAFT_KEY, JSON.stringify(game.ap.draft))
}
export const draftDirty = () => JSON.stringify(game.ap.draft) !== JSON.stringify(game.ap.live)
/** Replace the running rules with the draft. Takes effect from the next decision. */
export function putDraftLive() {
  game.ap.live = structuredClone($state.snapshot(game.ap.draft) as Rule[])
  saveRules()
}
/** Throw away the draft: back to a copy of the running rules. */
export function discardDraft() {
  game.ap.draft = structuredClone($state.snapshot(game.ap.live) as Rule[])
  saveRules()
}
export function setAutopilot(on: boolean) {
  game.ap.on = on
  localStorage.setItem('befewer.ap.on', on ? '1' : '0')
  if (on) autopilotTick()
}
function apLog(round: number, kind: ApLog['kind'], text: string) {
  game.ap.log = [{ at: Date.now(), round, kind, text }, ...game.ap.log].slice(0, 30)
}

/** Each poll: if the autopilot is on and this round is still open, decide once and bet. */
export async function autopilotTick() {
  if (!game.ap.on || game.busy || !started()) return
  const r = commitRound()
  if (apDone.has(r)) return
  if (myOpen(r)) { apDone.add(r); return }
  if (msLeft(game.status!.commit_ends_at) < 25_000) return
  // "the round before" must mean the same thing as in the backtest: wait until it has finished
  const prev = H.round(r - 1)
  if (prev && !prev.settled) return
  apDone.add(r)
  const d = decide($state.snapshot(game.ap.live) as Rule[], r, guard(lookup, r))
  if ('skip' in d) {
    apLog(r, 'skip', d.rule == null ? 'No rule fit, so it skipped.' : `Rule ${d.rule + 1} says skip.`)
    return
  }
  try {
    if (!game.me) await ensurePlayer()
    const bal = Number(BigInt(game.me!.balance) / ONE)
    const coins = stakeFor(d.unit, d.amount, bal)
    if (coins < 1) { apLog(r, 'skip', 'Balance too small to bet (the cap is 25% of it).'); return }
    const want = BigInt(coins) * ONE
    const placed = await placeBet(d.side, want, 'autopilot')
    apLog(placed.round, 'bet', `Rule ${d.rule + 1}: ${fmt(placed.amount)} BEFEWER on ${label(placed.round, d.side)} (${d.side}).`)
  } catch (e: any) {
    apLog(r, 'err', String(e.message || e))
  }
}

// ---------- start ----------
let startedLoops = false
export function start() {
  if (startedLoops) return
  startedLoops = true
  refresh(true).then(() => loadNpcs())
  setInterval(() => (game.now = Date.now() + game.skew), 250)
  setInterval(async () => {
    if (game.busy) return
    await refresh()
    await autopilotTick()
  }, 5000)
  setInterval(loadNpcs, 30000)
  ;(window as any).befewer = { history: H, game }
}
