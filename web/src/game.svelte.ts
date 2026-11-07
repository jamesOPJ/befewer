// App-wide reactive state: chain data (polled), the player's session, bets, results, autopilot.
import {
  ONE, CHIP, NEAR, view, fmt, fmtN, toNear, toYocto, nsToMs, randomSalt, commitHash, seal, loadSession, saveSession, loadGuestBackup, saveGuestBackup, newKeyPair,
  loadPicks, savePick, pickKey, storageFor, callContract, provider, type Status, type Params, type RoundV, type PlayerV, type Session,
} from './chain'
import * as H from './history'
import { label } from './questions'
import { decide, guard, normalizeRule, stakeFor, meFrom, PRESETS, SLOT_SETS, type Rule, type Lookup } from './rules'
import * as W from './wallet'

export type Side = 'A' | 'B'
export type Result = { round: number; slot: number; side: Side; amount: bigint; fee: bigint; outcome: 'A' | 'B' | 'void' }
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
 *  `slot` is null until the slot is opened on chain; `owner` is the account it belongs to. */
/** `on` false = this slot sits out; `strategy` = the preset it came from (or 'Custom rules'). */
export type Lane = { name: string; slot: number | null; owner: string | null; live: Rule[]; draft: Rule[]; on?: boolean; strategy?: string }
const LANES_KEY = 'befewer.ap.lanes'
function loadLanes(): Lane[] {
  try {
    const saved = JSON.parse(localStorage.getItem(LANES_KEY) || 'null')
    if (Array.isArray(saved) && saved.length)
      return saved.map((l: any, i: number) => ({ name: String(l.name ?? `Slot ${i}`), slot: i === 0 ? 0 : l.slot ?? null, owner: l.owner ?? null,
        live: (l.live ?? []).map(normalizeRule), draft: (l.draft ?? l.live ?? []).map(normalizeRule), on: l.on !== false, strategy: l.strategy ?? undefined }))
  } catch {}
  const r = loadRules() // the single rule set from before slots existed becomes lane 0
  return [{ name: 'Main', slot: 0, owner: null, live: r.live, draft: r.draft }]
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
export const short = (a: string) => (a.length > 22 ? a.slice(0, 10) + '…' + a.slice(-10) : a)
export { fmt, fmtN, toNear, toYocto, label, ONE, CHIP, NEAR }
/** What a new guest account starts with in its game balance (the server deposits 0.3, the first
 *  deposit pays the 0.01 storage fee). Only used to preview stakes before the account exists. */
export const GUEST_GAME_NEAR = toYocto(0.29)
/** Fee the contract adds on top of a stake. */
export const feeFor = (amount: bigint) => (amount * BigInt(game.params?.fee_bps ?? 0)) / 10000n
/** Net result of a settled bet in NEAR yocto: win +stake-fee, loss -stake-fee, void 0. */
export const netOf = (x: Result) => (x.outcome === 'void' ? 0n : x.outcome === x.side ? x.amount - x.fee : -(x.amount + x.fee))

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
      const before = game.me
      game.me = await view<PlayerV>('get_player', { account_id: game.session.accountId })
      const minedNow = (p: PlayerV) => BigInt(p.mined) + BigInt(p.pending_mined)
      if (before && minedNow(game.me) > minedNow(before))
        toast('ok', `You mined ${fmt(minedNow(game.me) - minedNow(before))} BEFEWER with a 3+ win streak. It stays unrefined in the game until you claim it on the Me page.`, 9000)
      await loadResults()
      selfReveal()
      try {
        const a: any = await (provider as any).query({ request_type: 'view_account', finality: 'optimistic', account_id: game.session.accountId })
        game.walletNear = String(a.amount)
      } catch {}
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
    ;(by[e.slot] ??= []).push({ round: e.round, slot: e.slot, side: pick.side, amount, fee, outcome: rv.outcome })
  }
  const out = by[0] ?? []
  const newest = out[0]
  const prevNewest = game.results[0]
  if (newest && prevNewest && newest.round !== prevNewest.round) announce(newest)
  game.results = out
  game.resultsBySlot = by
}

/** Reveal my own sealed bets as soon as the reveal opens: the reveal reward (most of the fee)
 *  comes back to me instead of going to a keeper. The keeper reveals whatever I miss. */
const selfRevealed = new Set<string>()
async function selfReveal() {
  const r = revealRound()
  if (r == null || !game.session || !game.me || game.busy) return
  const pk = loadPicks(game.session.accountId)
  const items = []
  for (const s of game.me.slots) {
    const o = s.open.find(x => Number(x.round) === r && !x.side)
    const p = o && pk[pickKey(s.slot, r)]
    if (!p || selfRevealed.has(`${s.slot}:${r}`)) continue
    selfRevealed.add(`${s.slot}:${r}`)
    items.push({ round: String(r), slot: s.slot, account_id: game.session.accountId, side: p.side, salt: p.salt })
  }
  // a few per call: guests can only attach 40 Tgas
  for (let i = 0; i < items.length; i += 3) {
    try {
      await callContract(game.session, 'reveal_many', { items: items.slice(i, i + 3) }, 300)
    } catch (e) {
      console.warn('self reveal failed (the keeper will reveal):', e)
    }
  }
}

function announce(x: Result) {
  if (x.outcome === 'void') toast('info', `Round ${x.round} was void: your ${fmtN(x.amount + x.fee)} NEAR came back, fee included.`)
  else if (x.outcome === x.side) toast('ok', `Round ${x.round}: ${label(x.round, x.side)} was the smaller side. You won +${fmtN(x.amount)} NEAR.`)
  else toast('info', `Round ${x.round}: ${label(x.round, x.outcome)} was the smaller side. You lost ${fmtN(x.amount)} NEAR.`)
}

export async function loadNpcs() {
  for (const n of NPCS) {
    try { game.npcs[n.id] = await view<PlayerV>('get_player', { account_id: n.id }) } catch {}
  }
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
export const WALLET_RESERVE = toYocto(0.05)
/** NEAR in the wallet that can go back into the game (0 if less than 0.01). */
export function movable(): bigint {
  const w = BigInt(game.walletNear ?? '0') - WALLET_RESERVE
  return w >= toYocto(0.01) ? w : 0n
}
/** Put the wallet's NEAR (minus the gas reserve) back into the game balance. */
export async function moveToGame() {
  if (!game.session) return
  const amount = movable()
  if (amount === 0n) throw new Error('Not enough NEAR in the wallet (it keeps 0.05 for gas).')
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

export function capFor(balance: bigint) {
  return (balance * BigInt(game.params!.max_stake_bps)) / 10000n
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
    if (amount > cap) throw new Error(`Your game balance is too small: the most you can bet is 25% of it, and the smallest bet is ${fmtN(min)} NEAR.`)
    const fee = feeFor(amount)
    const storage = storageFor(game.session!.accountId, 700)
    if (amount + fee + storage > bal) throw new Error(`Not enough NEAR for the stake, the fee and about ${fmtN(storage)} NEAR held for the bet's storage (returned later).`)
    const st = await view<Status>('get_status')
    game.status = st
    const r = Number(st.commit_round)
    const revealStart = nsToMs(st.commit_ends_at)
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
    for (const l of game.ap.lanes) if (l.slot === slot && l.owner === game.session.accountId) { l.slot = null; l.owner = null }
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
  const slot = i === 0 ? 0 : l.owner === game.session?.accountId ? l.slot : null
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
  game.ap.lanes.push({ name, slot: null, owner: null, live: structuredClone(rules), draft: structuredClone(rules) })
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
  const keep = game.ap.lanes.slice(1).filter(l => l.slot != null && l.owner === game.session?.accountId)
  game.ap.lanes = set.slots.map((x, k) => {
    const old = k === 0 ? game.ap.lanes[0] : keep[k - 1]
    return { name: x.name, slot: k === 0 ? 0 : old?.slot ?? null, owner: k === 0 ? null : old?.owner ?? null, live: structuredClone(x.rules), draft: structuredClone(x.rules) }
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
/** Today's result of every slot's settled bets (stake and fee; the reveal reward I may get back is ignored). */
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

/** The slot a lane bets from; opens it on chain the first time. */
async function laneSlot(l: Lane): Promise<number> {
  if (l === game.ap.lanes[0]) return 0
  if (l.slot != null && l.owner === game.session!.accountId && game.me?.slots.some(s => s.slot === l.slot)) return l.slot
  game.busy = 'Opening a slot for this lane'
  const res: any = await callContract(game.session!, 'open_slot', {}, 30)
  const id = JSON.parse(atob(res.status.SuccessValue))
  l.slot = Number(id)
  l.owner = game.session!.accountId
  saveRules()
  game.busy = ''
  return l.slot
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
      const slot = await laneSlot(l)
      if (game.me!.slots.find(s => s.slot === slot)?.open.some(o => Number(o.round) === r)) continue
      const mine = (game.resultsBySlot[slot] ?? []).map(x => ({ side: x.side, outcome: x.outcome, round: x.round }))
      const me = meFrom(mine)
      const d = decide($state.snapshot(l.live) as Rule[], r, guard(lookup, r), me)
      if ('skip' in d) {
        apLog(r, 'skip', tag + (d.rule == null ? 'No rule fit, so it skipped.' : `Rule ${d.rule + 1} says skip.`), i)
        continue
      }
      // the autopilot counts in chips of 0.01 NEAR (the smallest bet)
      const bal = Number(BigInt(game.me!.balance) / CHIP)
      const chips = stakeFor(d.unit, d.amount, bal, me)
      if (chips < 1) { apLog(r, 'skip', tag + 'Balance too small to bet (the cap is 25% of it).', i); continue }
      const placed = await placeBet(d.side, BigInt(chips) * CHIP, 'autopilot', slot)
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
  refresh(true).then(() => loadNpcs())
  // coming back from a redirect wallet: finish the key it just added, or reopen the next step
  if (W.hasPending()) waitForPending(90_000)
  W.connectedAccount().then(a => {
    if (!a) return
    game.wallet.accountId = a
    if (game.session?.kind !== 'wallet' && !W.hasPending()) { game.wallet.open = true; game.wallet.step = 'setup' }
  }).catch(() => {})
  setInterval(() => (game.now = Date.now() + game.skew), 250)
  setInterval(async () => {
    if (game.busy) return
    await refresh()
    await autopilotTick()
  }, 5000)
  setInterval(loadNpcs, 30000)
  ;(window as any).befewer = { history: H, game }
}
