// App-wide reactive state: chain data (polled), the player's session, bets, results, autopilot.
import {
  ONE, CHIP, NEAR, ROUND_RECORD_NEAR, CONTRACT, view, fmt, fmtN, toNear, toYocto, nsToMs, randomSalt, commitHash, seal, loadSession, saveSession, loadGuestBackup, saveGuestBackup, newKeyPair,
  loadPicks, savePick, pickKey, storageFor, callContract, setOnTopUp, provider, type Status, type Params, type RoundV, type PlayerV, type Session,
} from './chain'
import * as H from './history'
// @ts-ignore plain JS module shared with the keeper scripts
import { revealStartMs } from '../../keeper/schedule.mjs'
import { label } from './questions'
import { decide, guard, normalizeRule, stakeFor, meFrom, chipsOf, yoctoOf, PRESETS, SLOT_SETS, type Rule, type Lookup } from './rules'
import * as W from './wallet'

export type Side = 'A' | 'B'
/** `mine`: the reveal reward this page earned by revealing the bet itself (0 when a keeper did). */
export type Result = { round: number; slot: number; side: Side; amount: bigint; fee: bigint; outcome: 'A' | 'B' | 'void'; revealed?: bigint; mine?: bigint }
export type Toast = { id: number; kind: 'ok' | 'err' | 'info'; text: string; action?: { label: string; run: () => void } }
export type ApLog = { at: number; round: number; text: string; kind: 'bet' | 'skip' | 'err'; lane?: number }

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

/** A lane runs one rule set on one slot of the account (lane 0 = slot 0, the manual one).
 *  `slots` remembers, for each account, the slot this lane opened there (none until it first bets),
 *  so switching to another account (wallet ↔ guest) and back finds the same slot, not a new one. */
/** `on` false = this slot sits out; `strategy` = the preset it came from (or 'Custom rules'). */
export type Lane = { name: string; slots: Record<string, number>; live: Rule[]; draft: Rule[]; on?: boolean; strategy?: string }
const LANES_KEY = 'befewer.ap.lanes'
/** A saved lane's slots per account. Saves from before 11-09 kept one `slot` + `owner` pair. */
function savedSlots(l: any): Record<string, number> {
  const out: Record<string, number> = {}
  const ok = (s: unknown): s is number => Number.isInteger(s) && (s as number) > 0
  if (l?.slots && typeof l.slots === 'object') {
    for (const [a, s] of Object.entries(l.slots)) if (ok(s)) out[a] = s
  } else if (typeof l?.owner === 'string' && ok(l.slot)) {
    out[l.owner] = l.slot
  }
  return out
}
function loadLanes(): Lane[] {
  try {
    const saved = JSON.parse(localStorage.getItem(LANES_KEY) || 'null')
    if (Array.isArray(saved) && saved.length)
      return saved.map((l: any, i: number) => ({ name: String(l.name ?? `Slot ${i}`), slots: i === 0 ? {} : savedSlots(l),
        live: (l.live ?? []).map(normalizeRule), draft: (l.draft ?? l.live ?? []).map(normalizeRule), on: l.on !== false, strategy: l.strategy ?? undefined }))
  } catch {}
  const r = loadRules() // the single rule set from before slots existed becomes lane 0
  return [{ name: 'Main', slots: {}, live: r.live, draft: r.draft }]
}
const BUDGET_KEY = 'befewer.ap.budget'
function loadBudget(): { on: boolean; near: number } {
  try { const b = JSON.parse(localStorage.getItem(BUDGET_KEY) || 'null'); if (b && typeof b.near === 'number') return { on: !!b.on, near: b.near } } catch {}
  return { on: true, near: 0.8 }
}

export const NPCS = [
  { id: 'npc-coin.befewer.testnet', name: 'Coin', about: 'Flips a coin every round, and claims mined BEFEWER right away (paying the 10%).' },
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
  /** NEAR in the account's own wallet (outside the game), yocto; null until loaded */
  walletNear: null as string | null,
  rounds: [] as RoundV[], // newest first
  history: 0, // bumps whenever the round history changes, so derived views recompute
  results: [] as Result[], // slot 0's settled bets, newest first
  resultsBySlot: {} as Record<number, Result[]>,
  npcs: {} as Record<string, PlayerV>,
  busy: '', // what an in-flight bet is doing right now
  toasts: [] as Toast[],
  ap: { lanes: loadLanes(), sel: 0, on: localStorage.getItem('befewer.ap.on') === '1', log: [] as ApLog[], budget: loadBudget() },
  /** wallet login dialog: pick a wallet -> approve key + deposit -> done */
  wallet: { open: false, step: 'pick' as 'pick' | 'connecting' | 'setup' | 'approving', accountId: null as string | null, error: '' },
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
export const lookup: Lookup = { recent: H.recent, sameQuestion: H.sameQuestion, outcome: H.outcome, split: H.split }
export const picks = () => (game.session ? loadPicks(game.session.accountId) : {})
export const myOpen = (r: number) => game.me?.open.find(o => Number(o.round) === r)
/** More than one slot in this account: views add up across slots and say which slot. */
export const multi = () => (game.me?.slots.length ?? 0) > 1
/** The slot lane `i` bets from in the account signed in now (lane 0: slot 0), or null before it has one there. */
export function laneSlotId(i: number): number | null {
  if (i === 0) return 0
  const a = game.session?.accountId
  return a ? game.ap.lanes[i]?.slots[a] ?? null : null
}
export const slotName = (slot: number) => {
  const i = game.ap.lanes.findIndex((_, k) => laneSlotId(k) === slot)
  return i >= 0 && game.ap.lanes.length > 1 ? `${game.ap.lanes[i].name} (slot ${slot})` : `slot ${slot}`
}
/** Every slot's bet in round r, with the side from this browser's picks. */
export function myBetsIn(r: number) {
  const pk = game.session ? loadPicks(game.session.accountId) : {}
  return (game.me?.slots ?? []).flatMap(s => s.open.filter(o => Number(o.round) === r).map(o => ({ slot: s.slot, bet: o, side: pk[pickKey(s.slot, r)]?.side ?? null })))
}
/** Settled bets of all slots, newest first. */
export const allResults = (): Result[] => Object.values(game.resultsBySlot).flat().sort((a, b) => b.round - a.round || a.slot - b.slot)
/** A slot's record as it stands once every settled bet counts: the contract books a bet only
 *  when the slot bets again (lazy bookkeeping), so settled-but-unbooked results are added here. */
export function slotStats(s: { wins: number; losses: number; voids: number; streak: number; best_streak: number; open: { round: string; result: string | null }[] }) {
  let { wins, losses, voids, streak } = s
  let best = s.best_streak
  for (const o of [...s.open].sort((a, b) => Number(a.round) - Number(b.round))) {
    if (o.result === 'win') { wins++; streak++; best = Math.max(best, streak) }
    else if (o.result === 'loss') { losses++; streak = 0 }
    else if (o.result === 'void') voids++
    else if (o.result === 'forfeit') streak = 0
  }
  return { wins, losses, voids, streak, best }
}
/** Record across all slots, and the best streak running right now (and on which slot). */
export function totals() {
  const sl = game.me?.slots ?? []
  const t = { wins: 0, losses: 0, voids: 0, best: 0, now: 0, nowSlot: 0 }
  for (const s of sl) {
    const x = slotStats(s)
    t.wins += x.wins; t.losses += x.losses; t.voids += x.voids
    t.best = Math.max(t.best, x.best)
    if (x.streak > t.now) { t.now = x.streak; t.nowSlot = s.slot }
  }
  return t
}
/** Open bets of all slots, oldest round first. */
export const allOpen = () => (game.me?.slots ?? []).flatMap(s => s.open.map(o => ({ slot: s.slot, bet: o }))).sort((a, b) => Number(a.bet.round) - Number(b.bet.round) || a.slot - b.slot)
export const short = (a: string) => (a.length > 22 ? a.slice(0, 10) + '…' + a.slice(-10) : a)
export { fmt, fmtN, toNear, toYocto, label, ONE, CHIP, NEAR }
/** What a new guest account starts with in its game balance (the server deposits 0.3, the first
 *  deposit pays the 0.01 storage fee). Only used to preview stakes before the account exists. */
export const GUEST_GAME_NEAR = toYocto(0.29)
/** Fee the contract adds on top of a stake. */
export const feeFor = (amount: bigint) => (amount * BigInt(game.params?.fee_bps ?? 0)) / 10000n
/** A void bet's part of the round's record storage (split by stake over the revealed stake). */
export const voidCost = (x: Result) => (x.outcome === 'void' && x.revealed && x.revealed > 0n ? (ROUND_RECORD_NEAR * (x.amount < x.revealed ? x.amount : x.revealed)) / x.revealed : 0n)
/** What the revealer of a bet is paid: reveal_bounty_bps of its fee. */
export const bountyOf = (x: Result) => (x.fee * BigInt(game.params?.reveal_bounty_bps ?? 0)) / 10000n
/** Net result of a settled bet in NEAR yocto: win +stake-fee, loss -stake-fee, void -(its record
 *  share + the revealer's reward, held back from the refund); plus the reward if this page revealed it. */
export const netOf = (x: Result) =>
  (x.outcome === 'void' ? -voidCost(x) - bountyOf(x) : x.outcome === x.side ? x.amount - x.fee : -(x.amount + x.fee)) + (x.mine ?? 0n)

let toastId = 0
export function toast(kind: Toast['kind'], text: string, ms = kind === 'err' ? 9000 : 4500, action?: Toast['action']) {
  const id = ++toastId
  game.toasts.push({ id, kind, text, action })
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
    // the params never change: kept in this browser, refreshed in the background once per visit
    let first: Promise<Status> | null = null
    if (!game.params) {
      const cached = loadParams()
      if (cached) { game.params = cached; view<Params>('get_params').then(p => { game.params = p; saveParams(p) }).catch(() => {}) }
      else {
        // first visit: params and status at once
        first = view<Status>('get_status')
        game.params = await view<Params>('get_params')
        saveParams(game.params)
      }
    }
    // everything the first screen needs, asked at once (the round number follows from the params).
    // 12 rounds are enough for it; the deeper history comes behind (loadDeep)
    const guess = first ? null : roundGuess()
    const limit = game.rounds.length ? 6 : 12
    const [st, guessed, me] = await Promise.all([
      first ?? view<Status>('get_status'),
      guess != null ? view<RoundV[]>('get_rounds', { from: String(guess + 1), limit }).catch(() => null) : null,
      game.session ? view<PlayerV>('get_player', { account_id: game.session.accountId }) : null,
    ])
    game.status = st
    game.skew = nsToMs(st.now) - Date.now()
    const fresh = guessed ?? (await view<RoundV[]>('get_rounds', { from: st.commit_round, limit }))
    H.remember(fresh)
    const byId = new Map(game.rounds.map(r => [r.round, r]))
    for (const r of fresh) byId.set(r.round, r)
    game.rounds = [...byId.values()].sort((a, b) => Number(b.round) - Number(a.round)).slice(0, 60)
    game.history++
    // older history (backtests, same-question stats) fills in behind the first screen
    H.loadDeep(Number(st.commit_round)).then(() => game.history++)
    if (game.session && me) {
      const before = game.me
      game.me = me
      const minedNow = (p: PlayerV) => BigInt(p.mined) + BigInt(p.pending_mined)
      if (before && minedNow(game.me) > minedNow(before))
        toast('ok', `You mined ${fmt(minedNow(game.me) - minedNow(before))} BEFEWER with a 3+ win streak. It stays unrefined in the game until you claim it on the Me page.`, 9000)
      game.ready = true
      const acct = game.session.accountId
      selfReveal() // first: a keeper takes the reward if this page is slow
      await Promise.all([
        loadResults(),
        (provider as any).query({ request_type: 'view_account', finality: 'optimistic', account_id: acct }).then((a: any) => { game.walletNear = String(a.amount) }).catch(() => {}),
      ])
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

/** Settled bets of every slot, from this browser's picks and the rounds' outcomes (booked or not). */
async function loadResults() {
  if (!game.session || !game.me) return
  const pk = loadPicks(game.session.accountId)
  const entries = Object.keys(pk).map(k => {
    const [a, b] = k.includes(':') ? k.split(':') : ['0', k]
    return { key: k, slot: Number(a), round: Number(b) }
  }).sort((x, y) => y.round - x.round)
  const now = commitRound()
  const by: Record<number, Result[]> = {}
  for (const e of entries) {
    if ((by[e.slot]?.length ?? 0) >= 40 || e.round >= now) continue
    let rv = H.round(e.round)
    if (!rv?.settled) {
      rv = await view<RoundV>('get_round', { round: String(e.round) })
      H.remember([rv])
    }
    if (!rv.settled || !rv.outcome) continue
    const pick = pk[e.key]
    const amount = BigInt(pick.amount)
    const fee = pick.fee != null ? BigInt(pick.fee!) : (amount * BigInt(game.params?.fee_bps ?? 0)) / 10000n
    ;(by[e.slot] ??= []).push({ round: e.round, slot: e.slot, side: pick.side, amount, fee, outcome: rv.outcome, revealed: BigInt(rv.revealed_a) + BigInt(rv.revealed_b), mine: pick.bounty ? BigInt(pick.bounty) : 0n })
  }
  const out = by[0] ?? []
  const prevNewest = Math.max(-1, ...Object.values(game.resultsBySlot).flat().map(x => x.round))
  game.results = out
  game.resultsBySlot = by
  // announce a newly settled round once, adding up every slot that bet in it
  const all = allResults()
  if (all.length && prevNewest >= 0 && all[0].round > prevNewest) announce(all.filter(x => x.round === all[0].round))
}

/** Reveal my own sealed bets as soon as the reveal opens: the reveal reward (most of the fee)
 *  comes back to me instead of going to a keeper. The keeper reveals whatever I miss. */
// This page reveals its own bets as soon as the window opens: a clock timer fires it (no waiting
// for the next poll), since a keeper takes the reward 30-60 s in. A failed try goes again 5 s later,
// up to 5 times; a bet someone else revealed meanwhile has a side in the player view and drops out.
const selfRevealed = new Set<string>() // `${slot}:${round}` revealed by this page: never sent again
const revealTries = new Map<string, { n: number; at: number }>()
let revealing = false
/** The round whose reveal window is open now and when it opened (ms), from the params and the clock. */
function revealWindowNow(): { round: number; start: number } | null {
  const p = game.params
  if (!p) return null
  const now = Date.now() + game.skew
  const g = nsToMs(p.genesis_ns), c = nsToMs(p.commit_ns), rv = nsToMs(p.reveal_ns)
  if (now < g + c) return null
  const cr = Math.floor((now - g) / c)
  const start = g + cr * c
  return now - start < rv ? { round: cr - 1, start } : null
}
/** Every second: inside a reveal window (from 1.5 s after it opens, for block time), reveal mine. */
function revealTimer() {
  const w = revealWindowNow()
  if (w && Date.now() + game.skew >= w.start + 1500) selfReveal(w.round)
}
async function selfReveal(r: number | null = revealRound()) {
  const sess = game.session
  if (r == null || !sess || !game.me || game.busy || revealing) return
  const acct = sess.accountId
  const pk = loadPicks(acct)
  const items = []
  for (const s of game.me.slots) {
    const k = `${s.slot}:${r}`
    const o = s.open.find(x => Number(x.round) === r && !x.side)
    const p = o && pk[pickKey(s.slot, r)]
    const t = revealTries.get(k)
    if (!p || selfRevealed.has(k) || (t && (t.n >= 5 || Date.now() - t.at < 5000))) continue
    items.push({ round: String(r), slot: s.slot, account_id: acct, side: p.side, salt: p.salt })
  }
  if (!items.length) return
  revealing = true
  try {
    // a few per call: guests can only attach 40 Tgas
    for (let i = 0; i < items.length; i += 3) {
      const batch = items.slice(i, i + 3)
      for (const it of batch) revealTries.set(`${it.slot}:${r}`, { n: (revealTries.get(`${it.slot}:${r}`)?.n ?? 0) + 1, at: Date.now() })
      try {
        const res = await callContract(sess, 'reveal_many', { items: batch }, 300)
        // the contract's reveal events say which bets this call revealed (a keeper may have been
        // first) and the reward it paid: kept with the pick, so the results count it
        for (const e of revealEvents(res)) {
          if (e.by !== acct || e.account_id !== acct || Number(e.round) !== r) continue
          selfRevealed.add(`${e.slot}:${r}`)
          const p = loadPicks(acct)[pickKey(e.slot, r)]
          if (p) savePick(acct, r, { ...p, bounty: String(e.bounty ?? '0') }, Number(e.slot))
        }
      } catch (e) {
        console.warn('self reveal failed (tried again in 5 s; a keeper reveals it otherwise):', e)
      }
    }
  } finally {
    revealing = false
  }
}
/** The contract's `reveal` events in a transaction's logs. */
const revealEvents = (res: any): any[] =>
  (res?.receipts_outcome ?? [])
    .flatMap((x: any) => x.outcome?.logs ?? [])
    .filter((l: string) => l.startsWith('EVENT_JSON:') && l.includes('"event":"reveal"'))
    .map((l: string) => { try { return JSON.parse(l.slice('EVENT_JSON:'.length)).data[0] } catch { return null } })
    .filter(Boolean)

function announce(list: Result[]) {
  const x = list[0]
  if (list.length > 1) {
    const net = list.reduce((t, y) => t + netOf(y), 0n)
    const won = list.filter(y => y.outcome !== 'void' && y.outcome === y.side).length
    toast(net >= 0n ? 'ok' : 'info', `Round ${x.round}: ${x.outcome === 'void' ? 'void, refunded but for the round record' : `${label(x.round, x.outcome)} was the smaller side`}. ${won} of your ${list.length} slots won · net ${net >= 0n ? '+' : '−'}${fmtN(net >= 0n ? net : -net)} NEAR.`)
    return
  }
  if (x.outcome === 'void') toast('info', `Round ${x.round} was void: ${fmtN(x.amount + x.fee + netOf(x))} of your ${fmtN(x.amount + x.fee)} NEAR came back, fee included, less the round's record${x.mine ? '' : ' and the reveal reward'}.`)
  else if (x.outcome === x.side) toast('ok', `Round ${x.round}: ${label(x.round, x.side)} was the smaller side. You won +${fmtN(x.amount)} NEAR.`)
  else toast('info', `Round ${x.round}: ${label(x.round, x.outcome)} was the smaller side. You lost ${fmtN(x.amount)} NEAR.`)
}

export async function loadNpcs() {
  await Promise.all(NPCS.map(n => view<PlayerV>('get_player', { account_id: n.id }).then(p => { game.npcs[n.id] = p }).catch(() => {})))
}

// ---------- params cache ----------
const PARAMS_KEY = `fewer.params.v1.${CONTRACT}`
function loadParams(): Params | null {
  try { return JSON.parse(localStorage.getItem(PARAMS_KEY) || 'null') } catch { return null }
}
function saveParams(p: Params) {
  try { localStorage.setItem(PARAMS_KEY, JSON.stringify(p)) } catch {}
}
/** The round taking bets now, from the params and this device's clock (null before the params). */
function roundGuess(): number | null {
  const p = game.params
  if (!p) return null
  const now = BigInt(Date.now() + game.skew) * 1_000_000n
  return now < BigInt(p.genesis_ns) ? 0 : Number((now - BigInt(p.genesis_ns)) / BigInt(p.commit_ns))
}

// ---------- account + bets ----------
/** Make sure this browser has a testnet account with NEAR in its game balance. */
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
  if (!game.me.registered)
    throw new Error(game.session.kind === 'wallet' ? 'Deposit NEAR from your wallet first (Me page).' : 'This account has no game balance yet. Reload the page in a few seconds.')
}

// ---------- wallet login ----------
export function openWallet() {
  W.preload() // so that picking a wallet can open its window right away
  game.wallet.open = true
  game.wallet.error = ''
  game.wallet.step = game.wallet.accountId ? 'setup' : 'pick'
}
export function closeWallet() {
  game.wallet.open = false
}
export async function pickWallet(id: string) {
  game.wallet.error = ''
  game.wallet.step = 'connecting'
  try {
    game.wallet.accountId = await W.connect(id) // redirect wallets continue after the page comes back
    game.wallet.step = 'setup'
  } catch (e: any) {
    game.wallet.step = 'pick'
    game.wallet.error = String(e?.message || e || 'The wallet did not connect.')
  }
}
/** One wallet approval: add this browser's key for the game and deposit `near`. */
export async function approveWallet(near: number) {
  if (!game.wallet.accountId) return
  game.wallet.error = ''
  game.wallet.step = 'approving'
  try {
    await W.setupSession(game.wallet.accountId, toYocto(near))
    await waitForPending(60_000)
    if (game.session?.kind !== 'wallet') throw new Error('The wallet did not add the key. Try again.')
  } catch (e: any) {
    game.wallet.step = 'setup'
    game.wallet.error = String(e?.message || e || 'The wallet did not approve.')
  }
}
async function waitForPending(ms: number) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const s = await W.finishPendingSession()
    if (s) return adopt(s)
    if (!W.hasPending()) return
    await new Promise(r => setTimeout(r, 2000))
  }
}
/** Play with the wallet account from now on. A guest account is kept aside, not lost. */
async function adopt(s: Session) {
  if (game.session?.kind === 'guest') saveGuestBackup(game.session)
  saveSession(s)
  game.session = s
  game.me = null
  game.results = []
  game.wallet.open = false
  toast('ok', `Connected ${short(s.accountId)}. Bets are signed in this browser now: no wallet popups.`)
  await refresh(true)
}
/** Stop using the wallet account here (its key stays on the account; remove it in the wallet any time). */
export async function disconnectWallet() {
  await W.disconnect()
  game.wallet.accountId = null
  const guest = loadGuestBackup()
  saveGuestBackup(null)
  saveSession(guest)
  game.session = guest
  game.me = null
  game.results = []
  toast('info', guest ? 'Wallet disconnected. Back to your guest account.' : 'Wallet disconnected.')
  await refresh(true)
}
export async function depositMore(near: number) {
  if (!game.session || game.session.kind !== 'wallet') return
  const before = BigInt(game.me?.balance ?? '0')
  try {
    game.busy = 'Waiting for the wallet'
    await W.depositFromWallet(toYocto(near))
    for (let i = 0; i < 10; i++) {
      await refresh(true)
      if (BigInt(game.me?.balance ?? '0') > before) break
      await new Promise(r => setTimeout(r, 1500))
    }
    toast('ok', `Deposited ${near} NEAR into your game balance.`)
  } finally {
    game.busy = ''
  }
}

/** BEFEWER a claim of everything would put in the wallet, and the refining fee it would pay. */
export function claimPreview(p: PlayerV) {
  const u = BigInt(p.unrefined)
  const fee = (u * BigInt(game.params?.refine_fee_bps ?? 0)) / 10000n
  return { out: u - fee + BigInt(p.refined), fee }
}
/** Book the finished bets of every extra slot (one small call each), so a following withdraw or
 *  claim (which books slot 0 itself) includes them. */
async function bookExtraSlots(p: PlayerV) {
  for (const s of p.slots) if (s.slot !== 0 && s.open.some(o => o.result)) await callContract(game.session!, 'claim', { slot: s.slot }, 60)
}
/** Claim all mined BEFEWER (unrefined minus the fee, plus refined) to this browser's wallet. */
export async function claimBefewer() {
  if (!game.session || !game.me) return
  try {
    game.busy = 'Claiming your BEFEWER'
    const { out, fee } = claimPreview(game.me)
    await bookExtraSlots(game.me)
    await callContract(game.session, 'claim_befewer', { book: [0] }, 60)
    toast('ok', `${fmt(out)} BEFEWER are in your wallet. ${fmt(fee)} went to everyone still holding unrefined BEFEWER.`)
  } finally {
    game.busy = ''
    await refresh(true)
  }
}

/** NEAR left in the wallet for gas when moving NEAR into the game (a guest's calls need up to
 *  0.04 NEAR of prepaid gas up front). */
/** NEAR that stays in a guest wallet when moving NEAR back into the game: it pays the gas.
 *  (Below about 0.045 the page moves 0.05 from the game balance to the wallet by itself.) */
export const WALLET_RESERVE = toYocto(0.1)
/** NEAR in the wallet that can go back into the game (0 if less than 0.01). */
export function movable(): bigint {
  const w = BigInt(game.walletNear ?? '0') - WALLET_RESERVE
  return w >= toYocto(0.01) ? w : 0n
}
/** Put the wallet's NEAR (minus the gas reserve) back into the game balance. */
export async function moveToGame() {
  if (!game.session) return
  const amount = movable()
  if (amount === 0n) throw new Error('Not enough NEAR in the wallet (it keeps 0.1 for gas).')
  try {
    game.busy = game.session.kind === 'wallet' ? 'Waiting for the wallet' : 'Moving NEAR into the game'
    if (game.session.kind === 'wallet') await W.depositFromWallet(amount)
    else await callContract(game.session, 'deposit', {}, 30, amount)
    toast('ok', `${fmtN(amount)} NEAR moved into your game balance.`)
  } finally {
    game.busy = ''
    await refresh(true)
  }
}

/** Move NEAR from the game balance back to this browser's testnet wallet. */
export async function withdrawAll() {
  if (!game.session || !game.me) return
  const amount = BigInt(game.me.balance) + BigInt(game.me.pending_near)
  if (amount === 0n) throw new Error('Nothing to withdraw.')
  try {
    game.busy = 'Sending NEAR to your wallet'
    await bookExtraSlots(game.me)
    await callContract(game.session, 'withdraw', { book: [0] }, 60)
    toast('ok', `${fmtN(amount)} NEAR moved to your wallet. Betting stops until you move NEAR back into the game (Me page).`, 9000)
  } finally {
    game.busy = ''
    await refresh(true)
  }
}

/** The smallest game balance that can still bet: the minimum stake, its fee and the storage
 *  the bet holds until its result (about 0.02 NEAR). */
export function minToBet(): bigint {
  if (!game.params) return 0n
  const min = BigInt(game.params.min_stake), bps = BigInt(game.params.max_stake_bps)
  const byCap = (min * 10000n + bps - 1n) / bps // max_stake_bps is 10000 (no cap) since Nov 7
  const direct = min + feeFor(min) + storageFor(game.session?.accountId ?? '', 700)
  return byCap > direct ? byCap : direct
}

/** The most a balance can stake this round: stake + fee + storage have to fit in it. */
export function capFor(balance: bigint) {
  const p = game.params!
  const byBps = (balance * BigInt(p.max_stake_bps)) / 10000n
  const storage = storageFor(game.session?.accountId ?? '', 700)
  const afford = balance > storage ? ((balance - storage) * 10000n) / (10000n + BigInt(p.fee_bps)) : 0n
  return byBps < afford ? byBps : afford
}

/** Seal a side with drand and commit it from `slot` to the round taking bets right now.
 *  `want` is NEAR in yocto. The bet also holds a little NEAR for its storage (returned later). */
export async function placeBet(side: Side, want: bigint, by: 'you' | 'autopilot' = 'you', slot = 0) {
  try {
    await ensurePlayer()
    // winnings of this slot that are settled but not booked yet are booked by this very bet
    const pend = game.me!.slots.find(s => s.slot === slot)?.open.reduce((t, o) => t + BigInt(o.payout), 0n) ?? 0n
    const bal = BigInt(game.me!.balance) + pend
    const cap = capFor(bal)
    let amount = want > cap ? cap : want
    const min = BigInt(game.params!.min_stake)
    if (amount < min) amount = min
    if (amount > cap) throw new Error(`Your game balance (${fmtN(bal)} NEAR) is too small: the smallest bet needs about ${fmtN(minToBet())} NEAR with its fee and storage.`)
    const fee = feeFor(amount)
    const storage = storageFor(game.session!.accountId, 700)
    if (amount + fee + storage > bal) throw new Error(`Not enough NEAR for the stake, the fee and about ${fmtN(storage)} NEAR held for the bet's storage (returned later).`)
    const st = await view<Status>('get_status')
    game.status = st
    const r = Number(st.commit_round)
    // when betting closes (= when the timelock may open): computed from the launch parameters
    // pinned in this build, never taken from the RPC server's answer (see keeper/schedule.mjs)
    const revealStart = revealStartMs(CONTRACT, r, game.params, Date.now() + game.skew)
    if (revealStart - (Date.now() + game.skew) < 8000) throw new Error('This round is closing. Wait a few seconds for the next one.')
    game.busy = 'Sealing your answer with drand'
    const salt = randomSalt()
    const hash = await commitHash(game.session!.accountId, slot, r, side, salt)
    const { sealed, drandRound } = await seal(side, salt, revealStart)
    savePick(game.session!.accountId, r, { side, salt, amount: amount.toString(), fee: fee.toString(), drandRound }, slot)
    game.busy = 'Sending the sealed bet'
    await callContract(game.session!, 'commit', { round: String(r), slot, amount: amount.toString(), hash, sealed }, 100)
    if (by === 'you') toast('ok', `Sealed: ${fmtN(amount)} NEAR on ${label(r, side)} (+${fmtN(fee)} fee). It opens itself at the reveal.`)
    return { round: r, amount }
  } finally {
    game.busy = ''
    await refresh(true)
  }
}

/** Close an extra slot whose bets are all finished: its 0.002 NEAR storage comes back. */
export async function closeSlot(slot: number) {
  if (!game.session) return
  try {
    game.busy = `Closing slot ${slot}`
    await callContract(game.session, 'close_slot', { slot }, 60)
    const a = game.session.accountId
    for (const l of game.ap.lanes) if (l.slots[a] === slot) delete l.slots[a]
    saveRules()
    toast('ok', `Slot ${slot} closed; its 0.002 NEAR is back in your balance.`)
  } finally {
    game.busy = ''
    await refresh(true)
  }
}

export function forgetDevice() {
  game.resultsBySlot = {}
  game.walletNear = null
  saveSession(null)
  game.session = null
  game.me = null
  game.results = []
}

// ---------- autopilot ----------
// Lanes: each runs its own rule set on its own slot. Each has `live` (what runs) and `draft`
// (what you edit and replay); editing never touches the running rules until "Put live".
const apDone = new Set<string>()
export const lane = () => game.ap.lanes[game.ap.sel] ?? game.ap.lanes[0]
export function saveRules() {
  localStorage.setItem(LANES_KEY, JSON.stringify($state.snapshot(game.ap.lanes)))
  localStorage.setItem(BUDGET_KEY, JSON.stringify($state.snapshot(game.ap.budget)))
}
export const draftDirty = () => JSON.stringify(lane().draft) !== JSON.stringify(lane().live)
/** Replace the selected lane's running rules with its draft. Takes effect from the next decision. */
export function putDraftLive() {
  const l = lane()
  l.live = structuredClone($state.snapshot(l.draft) as Rule[])
  const same = PRESETS.find(p => JSON.stringify(p.rules) === JSON.stringify($state.snapshot(l.live)))
  l.strategy = same?.name ?? 'Custom rules'
  saveRules()
}
/** One tap: run a single-slot strategy on lane `i` right away (draft too), switch the autopilot
 *  on, and offer an undo. */
export function runPreset(p: number, i: number) {
  const l = game.ap.lanes[i]
  const before = $state.snapshot(l) as Lane
  const wasOn = game.ap.on
  l.live = structuredClone(PRESETS[p].rules)
  l.draft = structuredClone(PRESETS[p].rules)
  l.strategy = PRESETS[p].name
  l.on = true
  saveRules()
  if (!game.ap.on) setAutopilot(true)
  toast('ok', `${PRESETS[p].name} is running on ${l.name}.`, 7000, {
    label: 'Undo',
    run: () => { game.ap.lanes[i] = before; saveRules(); if (!wasOn) setAutopilot(false) },
  })
}
/** One tap: set up a multi-slot strategy, switch on, offer an undo. */
export function runSlotSet(k: number) {
  const before = $state.snapshot(game.ap.lanes) as Lane[]
  const wasOn = game.ap.on
  useSlotSet(k)
  for (const l of game.ap.lanes) { l.strategy = SLOT_SETS[k].name; l.on = true }
  saveRules()
  if (!game.ap.on) setAutopilot(true)
  toast('ok', `${SLOT_SETS[k].name} is running on ${game.ap.lanes.length} slots. Each extra slot holds 0.002 NEAR of storage once it bets.`, 8000, {
    label: 'Undo',
    run: () => { game.ap.lanes = before; game.ap.sel = 0; saveRules(); if (!wasOn) setAutopilot(false) },
  })
}
/** The strategy a lane runs: the one it was started from, or the preset its rules match. */
export function strategyOf(l: Lane): string {
  if (l.strategy) return l.strategy
  const live = JSON.stringify($state.snapshot(l.live))
  return PRESETS.find(p => JSON.stringify(p.rules) === live)?.name ?? (l.live.length ? 'Custom rules' : 'No rules')
}
export function setLaneOn(i: number, on: boolean) {
  game.ap.lanes[i].on = on
  saveRules()
}
/** What lane `i` is doing in the round taking bets right now. */
export function laneNow(i: number): { kind: 'bet' | 'skip' | 'err' | 'wait' | 'off'; text: string; slot: number | null } {
  const l = game.ap.lanes[i]
  const r = commitRound()
  const slot = laneSlotId(i)
  if (slot != null && game.me) {
    const bet = game.me.slots.find(s => s.slot === slot)?.open.find(o => Number(o.round) === r)
    if (bet) {
      const p = loadPicks(game.session!.accountId)[pickKey(slot, r)]
      return { kind: 'bet', text: `bet ${fmtN(bet.amount)} NEAR on ${p ? p.side : '?'}`, slot }
    }
  }
  if (l.on === false) return { kind: 'off', text: 'switched off', slot }
  if (!l.live.length) return { kind: 'off', text: 'no rules', slot }
  const log = game.ap.log.find(x => x.round === r && x.lane === i)
  if (log) return { kind: log.kind === 'err' ? 'err' : 'skip', text: log.kind === 'err' ? log.text : 'sits this round out', slot }
  return { kind: game.ap.on ? 'wait' : 'off', text: game.ap.on ? 'waiting for the round before to finish' : 'autopilot is off', slot }
}
/** Throw away the draft: back to a copy of the running rules. */
export function discardDraft() {
  lane().draft = structuredClone($state.snapshot(lane().live) as Rule[])
  saveRules()
}
/** Add a lane (its slot is opened on chain when it first bets: 0.002 NEAR, refunded on close). */
export function addLane(name = `Slot ${game.ap.lanes.length}`, rules: Rule[] = []) {
  game.ap.lanes.push({ name, slots: {}, live: structuredClone(rules), draft: structuredClone(rules) })
  game.ap.sel = game.ap.lanes.length - 1
  saveRules()
}
/** Stop using a lane (not lane 0). Its slot stays in the account; close it on the Me page. */
export function removeLane(i: number) {
  if (i === 0) return
  game.ap.lanes.splice(i, 1)
  game.ap.sel = Math.min(game.ap.sel, game.ap.lanes.length - 1)
  saveRules()
}
/** Load a multi-slot strategy: lane 0 takes the first slot's rules, more lanes for the rest. */
export function useSlotSet(i: number) {
  // (callers set `strategy` and `on`)
  const set = SLOT_SETS[i]
  // every account's extra slots carry over in order (its 1st extra slot to the new 2nd lane, ...), streaks and all
  const per: Record<string, number[]> = {}
  for (const l of game.ap.lanes.slice(1)) for (const [a, s] of Object.entries($state.snapshot(l.slots) as Record<string, number>)) (per[a] ??= []).push(s)
  game.ap.lanes = set.slots.map((x, k) => {
    const slots: Record<string, number> = {}
    if (k > 0) for (const [a, list] of Object.entries(per)) if (list[k - 1] != null) slots[a] = list[k - 1]
    return { name: x.name, slots, live: structuredClone(x.rules), draft: structuredClone(x.rules) }
  })
  game.ap.sel = 0
  saveRules()
}
export function setAutopilot(on: boolean) {
  game.ap.on = on
  localStorage.setItem('befewer.ap.on', on ? '1' : '0')
  if (on) autopilotTick()
}
function apLog(round: number, kind: ApLog['kind'], text: string, lane?: number) {
  game.ap.log = [{ at: Date.now(), round, kind, text, lane }, ...game.ap.log].slice(0, 60)
}
const localDay = (ms: number) => new Date(ms).toLocaleDateString('en-CA')
/** Today's result of every slot's settled bets (stake, fee, and the reward when this page revealed them). */
export function todayNet(): bigint {
  if (!game.params) return 0n
  const today = localDay(Date.now())
  const g = nsToMs(game.params.genesis_ns), c = nsToMs(game.params.commit_ns), rv = nsToMs(game.params.reveal_ns)
  let net = 0n
  for (const list of Object.values(game.resultsBySlot))
    for (const x of list) if (localDay(g + (x.round + 1) * c + rv) === today) net += netOf(x)
  return net
}
export const budgetLeft = () => toYocto(game.ap.budget.near) + todayNet()

/** The slot lane `i` bets from in this account; opens one on chain the first time it bets from this account. */
async function laneSlot(i: number): Promise<number> {
  if (i === 0) return 0
  const l = game.ap.lanes[i]
  const a = game.session!.accountId
  const had = l.slots[a]
  if (had != null && game.me?.slots.some(s => s.slot === had)) return had
  game.busy = 'Opening a slot for this lane'
  const res: any = await callContract(game.session!, 'open_slot', {}, 30)
  const id = Number(JSON.parse(atob(res.status.SuccessValue)))
  l.slots[a] = id
  saveRules()
  game.busy = ''
  return id
}

/** Each poll: if the autopilot is on and this round is still open, every lane decides once. */
export async function autopilotTick() {
  if (!game.ap.on || game.busy || !started()) return
  const r = commitRound()
  if (msLeft(game.status!.commit_ends_at) < 25_000) return
  // "the round before" must mean the same thing as in the backtest: wait until it has finished
  const prev = H.round(r - 1)
  if (prev && !prev.settled) return
  if (game.ap.budget.on && budgetLeft() <= 0n) {
    if (!apDone.has(`budget:${r}`)) { apDone.add(`budget:${r}`); apLog(r, 'skip', `Daily budget of ${game.ap.budget.near} NEAR used up: paused until tomorrow.`) }
    return
  }
  for (let i = 0; i < game.ap.lanes.length; i++) {
    const l = game.ap.lanes[i]
    const key = `${i}:${r}`
    if (apDone.has(key) || !l.live.length || l.on === false) continue
    apDone.add(key)
    const tag = game.ap.lanes.length > 1 ? `${l.name}: ` : ''
    try {
      if (!game.me) await ensurePlayer()
      const slot = await laneSlot(i)
      if (game.me!.slots.find(s => s.slot === slot)?.open.some(o => Number(o.round) === r)) continue
      const mine = (game.resultsBySlot[slot] ?? []).map(x => ({ side: x.side, outcome: x.outcome, round: x.round }))
      const me = meFrom(mine)
      const d = decide($state.snapshot(l.live) as Rule[], r, guard(lookup, r), me)
      if ('skip' in d) {
        apLog(r, 'skip', tag + (d.rule == null ? 'No rule fit, so it skipped.' : `Rule ${d.rule + 1} says skip.`), i)
        continue
      }
      // the autopilot counts in chips of 0.01 NEAR (the smallest bet), in steps of 0.001; this slot's settled
      // winnings are booked by the bet itself, so they count
      const pend = game.me!.slots.find(s => s.slot === slot)?.open.reduce((t, o) => t + BigInt(o.payout), 0n) ?? 0n
      const balY = BigInt(game.me!.balance) + pend
      const chips = stakeFor(d.unit, d.amount, chipsOf(balY), me, chipsOf(capFor(balY)))
      if (chips < 1) { apLog(r, 'skip', `${tag}Balance too small to bet: ${fmtN(balY)} NEAR, and the smallest bet needs about ${fmtN(minToBet())} with its fee and storage.`, i); continue }
      const placed = await placeBet(d.side, yoctoOf(chips), 'autopilot', slot)
      apLog(placed.round, 'bet', `${tag}Rule ${d.rule + 1}: ${fmtN(placed.amount)} NEAR on ${label(placed.round, d.side)} (${d.side}).`, i)
    } catch (e: any) {
      apLog(r, 'err', tag + String(e.message || e), i)
    } finally {
      game.busy = ''
    }
  }
}

// ---------- start ----------
let startedLoops = false
export function start() {
  if (startedLoops) return
  startedLoops = true
  setOnTopUp(a => toast('info', `Moved ${fmtN(a)} NEAR from your game balance to your wallet: every transaction pays a small network fee (gas) from the wallet.`, 7000))
  refresh(true).then(() => loadNpcs())
  // coming back from a redirect wallet: finish the key it just added, or reopen the next step
  if (W.hasPending()) waitForPending(90_000)
  W.connectedAccount().then(a => {
    if (!a) return
    game.wallet.accountId = a
    if (game.session?.kind !== 'wallet' && !W.hasPending()) { game.wallet.open = true; game.wallet.step = 'setup' }
  }).catch(() => {})
  setInterval(() => (game.now = Date.now() + game.skew), 250)
  setInterval(revealTimer, 1000)
  setInterval(async () => {
    if (game.busy) return
    await refresh()
    await autopilotTick()
  }, 5000)
  setInterval(loadNpcs, 30000)
  ;(window as any).befewer = { history: H, game }
}
