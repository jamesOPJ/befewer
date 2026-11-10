// BEFEWER testnet runner: four NPC players betting NEAR from their own wallets + a keeper that
// opens drand timelocks and reveals what players have not revealed themselves (earning the
// reveal reward), settles finished rounds nobody else settled, opens the DEX pool once the
// treasury is big enough and runs the treasury buybacks. Bets are booked lazily by the contract.
// Everything the keeper does is permissionless: anyone can run this file against the contract.
//
// usage: FEWER_CONTRACT=v6.befewer.testnet node run.mjs            (loop forever)
//        FEWER_CONTRACT=v6.befewer.testnet node run.mjs --setup    (create + fund NPC/keeper accounts, deposit NEAR)
//
// Run your own keeper (anyone can; no keys or permission from us):
//        FEWER_KEEPER_ONLY=1 FEWER_KEEPER_ACCOUNT=you.testnet node run.mjs
// It signs with ~/.near-credentials/testnet/you.testnet.json (what `near login` writes), registers
// the account with a 0.02 NEAR game deposit if needed (reveal rewards are paid into a game
// balance), then reveals, settles, opens the pool and runs buybacks whenever they are due.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import tlock from 'tlock-js'
import { createOpener, orderForOpening, stillSealed } from './opener.mjs'
import { revealStartMs } from './schedule.mjs'
import { actions } from 'near-api-js'
import { loadAccount, hasKey, newKeyFor, view, call, provider, newSalt, commitHash, NEAR, fmt, fmtN, sleep, log } from './lib.mjs'

const { timelockEncrypt, timelockDecrypt, roundAt, roundTime, mainnetClient } = tlock
const CONTRACT = process.env.FEWER_CONTRACT || 'v6.befewer.testnet'
const ROOT = 'befewer.testnet'
const KEEPER = process.env.FEWER_KEEPER_ACCOUNT || `keeper.${ROOT}`
const KEEPER_ONLY = process.env.FEWER_KEEPER_ONLY === '1'
const drand = mainnetClient() // drand quicknet (3 s rounds), the chain tlock uses
const drandInfo = await drand.chain().info()
const opener = createOpener(4) // opens timelocks on worker threads (see opener.mjs)
const junk = new Set() // "round:account:slot" of bets not worth trying again: the timelock opened to something that
// does not match the commitment, did not open twice, or the contract did not take the reveal
const misses = new Map() // "round:account:slot" -> times its timelock failed to open
const jitters = {} // round -> extra random wait before this keeper reveals (see revealTick)

// The NPCs' choices come from the system's random source, not Math.random(): its stream can be
// reconstructed from enough outputs, and the NPCs' stakes and timing are public on chain, so
// their sides could be predicted before betting closes.
const rnd = () => crypto.randomInt(0x1_0000_0000) / 0x1_0000_0000
const coin = () => (crypto.randomInt(2) === 0 ? 'A' : 'B')
const other = s => (s === 'A' ? 'B' : 'A')
// Personalities. pick(h) gets the last settled round's outcome. Stakes are in NEAR.
export const NPCS = [
  { id: `npc-coin.${ROOT}`, play: 0.85, stake: [0.01, 0.04], about: 'flips a coin; claims mined BEFEWER right away (pays the 10%)', claims: true, pick: () => coin() },
  { id: `npc-echo.${ROOT}`, play: 0.95, stake: [0.01, 0.03], about: 'bets the last minority wins again', pick: h => (h.last === 'A' || h.last === 'B' ? h.last : coin()) },
  { id: `npc-flip.${ROOT}`, play: 0.95, stake: [0.01, 0.03], about: 'bets the crowd over-corrects', pick: h => (h.last === 'A' || h.last === 'B' ? other(h.last) : coin()) },
  { id: `npc-whale.${ROOT}`, play: 0.5, stake: [0.04, 0.08], about: 'bets big on a hunch', pick: () => coin() },
]
const near = x => (BigInt(Math.round(x * 1e6)) * NEAR) / 1_000_000n
const NPC_TOP_UP_BELOW = near(0.3) // game balance under this: deposit NPC_TOP_UP from the NPC's wallet
const NPC_TOP_UP = near(1)
async function walletNear(id) {
  const a = await provider.query({ request_type: 'view_account', finality: 'final', account_id: id })
  return BigInt(a.amount)
}

const STATE_DIR = new URL('./state/', import.meta.url)
fs.mkdirSync(STATE_DIR, { recursive: true })
const STATE_FILE = fileURLToPath(new URL(`./state/${CONTRACT}.json`, import.meta.url))
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { plans: {}, salts: {}, gas: [] }
// the file holds the NPCs' sides and salts before they are revealed: readable by this user only
const save = () => {
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state), { mode: 0o600 })
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE)
}
/** Forget plans and salts of rounds long finished (the file is rewritten on every save). */
function prune(r) {
  const old = k => Number(k.slice(k.lastIndexOf(':') + 1)) < r - 50
  let n = 0
  for (const k of Object.keys(state.plans)) if (old(k)) { delete state.plans[k]; n++ }
  for (const k of Object.keys(state.salts)) if (old(k)) { delete state.salts[k]; n++ }
  return n
}

function burnt(res) {
  let t = BigInt(res.transaction_outcome?.outcome?.tokens_burnt || 0)
  for (const r of res.receipts_outcome || []) t += BigInt(r.outcome.tokens_burnt || 0)
  return t
}
function noteGas(kind, res, n = 1) {
  state.gas.push([Date.now(), kind, n, burnt(res).toString()])
  if (state.gas.length > 2000) state.gas.splice(0, state.gas.length - 2000)
}
function failed(res) {
  const s = res.status || {}
  if (s.Failure) return JSON.stringify(s.Failure).slice(0, 300)
  for (const r of res.receipts_outcome || []) if (r.outcome.status?.Failure) return JSON.stringify(r.outcome.status.Failure).slice(0, 300)
  return null
}

async function setup() {
  const root = loadAccount(ROOT)
  for (const [id, amount] of [[KEEPER, near(15)], ...NPCS.map(n => [n.id, near(6)])]) {
    if (!hasKey(id)) {
      const kp = newKeyFor(id)
      await root.createSubAccount({ accountOrPrefix: id, publicKey: kp.getPublicKey(), nearToTransfer: amount })
      log('created', id, `${fmtN(amount)} NEAR`)
    }
  }
  for (const n of NPCS) {
    const p = await view(CONTRACT, 'get_player', { account_id: n.id })
    if (!p.registered) {
      await call(loadAccount(n.id), CONTRACT, 'deposit', {}, { deposit: NPC_TOP_UP })
      log('deposited', fmtN(NPC_TOP_UP), 'NEAR for', n.id)
    }
  }
  await registerKeeper()
}

/** Reveal rewards are paid into a game balance: a keeper without one deposits 0.02 NEAR first. */
async function registerKeeper() {
  const k = await view(CONTRACT, 'get_player', { account_id: KEEPER })
  if (!k.registered) {
    await call(loadAccount(KEEPER), CONTRACT, 'deposit', {}, { deposit: near(0.02) })
    log(KEEPER, 'registered for reveal rewards (0.02 NEAR game deposit)')
  }
}

/** Keep each NPC's game balance topped up from its own wallet (never from the root). */
async function topUp(n, p) {
  if (BigInt(p.balance) >= NPC_TOP_UP_BELOW) return p
  const wallet = await walletNear(n.id)
  if (wallet < NPC_TOP_UP + near(0.2)) { log(n.id, `wallet low (${fmtN(wallet)} NEAR): cannot top up`); return p }
  await call(loadAccount(n.id), CONTRACT, 'deposit', {}, { deposit: NPC_TOP_UP })
  log(n.id, 'topped up', fmtN(NPC_TOP_UP), 'NEAR')
  return view(CONTRACT, 'get_player', { account_id: n.id })
}

async function npcTick(st) {
  const r = Number(st.commit_round)
  // when betting closes: from the pinned launch parameters, never from the RPC's clock (schedule.mjs)
  const end = revealStartMs(CONTRACT, r, await params())
  const start = end - Number(BigInt((await params()).commit_ns) / 1_000_000n)
  if (!state.pruned || state.pruned < r - 50) { prune(r); state.pruned = r }
  for (const n of NPCS) {
    const key = `${n.id}:${r}`
    if (!state.plans[key]) {
      // decide once per round: whether to play and when (spread across the window)
      const playing = rnd() < n.play
      state.plans[key] = { playing, at: start + (0.1 + 0.7 * rnd()) * (end - start), done: false }
      save()
    }
    const plan = state.plans[key]
    if (!plan.playing || plan.done || Date.now() < plan.at) continue
    plan.done = true
    save()
    try {
      const pr = await params()
      let p = await view(CONTRACT, 'get_player', { account_id: n.id })
      if (p.open.length >= 8) { log(n.id, 'skips: too many open rounds'); continue }
      p = await topUp(n, p)
      if (n.claims && BigInt(p.unrefined) + BigInt(p.refined) > 0n) {
        // the impatient one: claims to its wallet as soon as it mines, so the 10% reaches the holders
        const res = await loadAccount(n.id).callFunctionRaw({ contractId: CONTRACT, methodName: 'claim_befewer', args: { book: [0] }, gas: 50_000_000_000_000n })
        const f = failed(res)
        log(n.id, f ? `claim_befewer FAILED ${f}` : `claimed ${fmt(BigInt(p.unrefined) * 9n / 10n + BigInt(p.refined))} BEFEWER to its wallet`)
      }
      const bal = BigInt(p.balance)
      let amount = near(n.stake[0] + rnd() * (n.stake[1] - n.stake[0]))
      const cap = (bal * BigInt(pr.max_stake_bps)) / 10000n
      if (amount > cap) amount = cap
      if (amount + (amount * BigInt(pr.fee_bps)) / 10000n > bal) amount = (bal * 10000n) / (10000n + BigInt(pr.fee_bps))
      if (amount < BigInt(pr.min_stake)) { log(n.id, 'skips: balance too small'); continue }
      const side = n.pick({ last: lastOutcome })
      const salt = newSalt()
      const hash = commitHash(n.id, 0, r, side, salt)
      let dr = roundAt(end, drandInfo) // roundAt() can return a round published up to 3 s BEFORE `end`
      if (roundTime(drandInfo, dr) < end) dr += 1 // so take the first round published at/after reveal start
      const sealed = await timelockEncrypt(dr, Buffer.from(`${side}:${salt}`), drand)
      state.salts[`${n.id}:0:${r}`] = { side, salt }
      save()
      // committing also books this NPC's finished bets (lazy bookkeeping), so give it room
      const res = await loadAccount(n.id).callFunctionRaw({ contractId: CONTRACT, methodName: 'commit', args: { round: String(r), slot: 0, amount: amount.toString(), hash, sealed }, gas: 100_000_000_000_000n })
      noteGas('commit', res)
      const f = failed(res)
      log(n.id, f ? `commit FAILED ${f}` : `committed ${fmtN(amount)} NEAR to round ${r} (sealed for drand #${dr})`)
    } catch (e) {
      log(n.id, 'commit error', String(e.message || e).slice(0, 200))
    }
  }
}

let paramsCache
async function params() {
  return (paramsCache ??= await view(CONTRACT, 'get_params'))
}

// What an RPC server answers is not trusted to be sane: the contract takes at most 1024 bytes of
// timelock per bet and a page of 100, so anything else is dropped, and the paging stops at
// MAX_COMMITS (a server answering full pages forever would otherwise keep the keeper here).
const MAX_SEALED = 1024
const MAX_COMMITS = 20_000
async function allCommits(r) {
  const out = []
  for (let from = 0; from < MAX_COMMITS; from += 100) {
    const page = await view(CONTRACT, 'get_round_commits', { round: String(r), from_index: from, limit: 100 })
    if (!Array.isArray(page)) break
    for (const c of page.slice(0, 100)) {
      if (c && typeof c.account_id === 'string' && Number.isInteger(c.slot) && typeof c.hash === 'string' && (c.sealed == null || (typeof c.sealed === 'string' && c.sealed.length <= MAX_SEALED))) out.push(c)
    }
    if (page.length < 100) break
  }
  return out
}

async function sendBatch(kind, calls, per = 8) {
  const keeper = loadAccount(KEEPER)
  for (let i = 0; i < calls.length; i += per) {
    const chunk = calls.slice(i, i + per)
    const res = await keeper.signAndSendTransaction({
      receiverId: CONTRACT,
      actions: chunk.map(([m, a, g]) => actions.functionCall(m, a, g, 0n)),
    })
    noteGas(kind, res, chunk.length)
    const f = failed(res)
    log('keeper', f ? `${kind} batch FAILED ${f}` : `${kind} x${chunk.length} ok`)
  }
}

// Players' own pages reveal their bets first (they get the reveal reward). A page in the background
// (screen off, another tab in front) only wakes about once a minute, so the keeper waits over a
// minute: 62 s into a 90 s window (never later than 28 s before it closes), plus up to 5 s of
// jitter, then reveals whatever is still sealed (it lands ~70 s in), with 15+ s left for retries.
const SELF_REVEAL_GRACE_MS = 62_000
const KEEPER_MARGIN_MS = 28_000
async function revealTick(st) {
  if (st.reveal_round == null) return
  const r = Number(st.reveal_round)
  const revealEnds = Number(BigInt(st.reveal_ends_at) / 1_000_000n)
  const windowMs = Number(BigInt((await params()).reveal_ns) / 1_000_000n)
  const revealStarts = revealEnds - windowMs
  // players' pages reveal their own bets first; then keepers, each a few random seconds apart so
  // the later one sees (for free) what the earlier one revealed instead of paying to lose a race
  // (a transaction takes 2-3 s to land: spread over 5 s, two keepers rarely overlap)
  const jitter = (jitters[r] ??= Math.random() * Math.min(5_000, windowMs / 18))
  const grace = Math.max(0, Math.min(SELF_REVEAL_GRACE_MS, windowMs - KEEPER_MARGIN_MS))
  const wait = revealStarts + grace + jitter - Number(BigInt(st.now) / 1_000_000n)
  if (wait > 3000) return // the loop comes back every 3 s in a reveal window
  if (wait > 0) await sleep(wait)
  // timelocks already found not to open to their commitment are not opened again every tick
  for (const k of junk) if (Number(k.split(':')[0]) < r - 2) junk.delete(k)
  for (const k of misses.keys()) if (Number(k.split(':')[0]) < r - 2) misses.delete(k)
  const pending = (await allCommits(r)).filter(c => !c.side && !junk.has(`${r}:${c.account_id}:${c.slot}`))
  const items = []
  const fallback = c => state.salts[`${c.account_id}:${c.slot}:${r}`] // our own NPCs' bets
  const add = (c, side, salt) => {
    if (commitHash(c.account_id, c.slot, r, side, salt) !== c.hash) { junk.add(`${r}:${c.account_id}:${c.slot}`); return void skipped.mismatch++ }
    items.push({ round: String(r), slot: c.slot, account_id: c.account_id, side, salt })
  }
  const skipped = { mismatch: 0, unopened: 0 }
  for (const c of pending) if (!c.sealed && fallback(c)) add(c, fallback(c).side, fallback(c).salt)
  // fair order (every account's first bet before anyone's second; timelocks aimed at the drand
  // round honest pages use first), opened on worker threads, revealed as they come
  const queue = orderForOpening(pending.filter(c => c.sealed), roundAt(revealStarts, drandInfo))
  const deadline = revealEnds - 3000
  let lastSend = Date.now(), done = 0
  for (let i = 0; i < queue.length && Date.now() < deadline; i += 16) {
    await Promise.all(queue.slice(i, i + 16).map(async c => {
      let side, salt, transient = false
      try {
        const pt = await opener.open(c.sealed)
        ;[side, salt] = [pt.slice(0, 1), pt.slice(2)]
      } catch (e) {
        transient = /in time|worker|fetch|network|timeout/i.test(String(e?.message ?? e)) // drand slow or a worker replaced: not the bet's fault
      }
      if (!side && fallback(c)) ({ side, salt } = fallback(c))
      if (side) return add(c, side, salt)
      skipped.unopened++
      // a timelock that failed twice (garbage, another drand chain, a later round) is not tried
      // again on every 3 s tick; once more is allowed in case drand was just slow
      if (transient) return
      const k = `${r}:${c.account_id}:${c.slot}`
      misses.set(k, (misses.get(k) ?? 0) + 1)
      if (misses.get(k) >= 2) junk.add(k)
    }))
    done = Math.min(queue.length, i + 16)
    if (items.length >= 30 || Date.now() - lastSend > 5000) { await sendReveals(r, items.splice(0)); lastSend = Date.now() }
  }
  await sendReveals(r, items.splice(0))
  if (skipped.mismatch || skipped.unopened) log('keeper', `round ${r}: ${skipped.unopened} timelock(s) could not be opened, ${skipped.mismatch} opened to something that does not match its commitment`)
  if (done < queue.length) log('keeper', `round ${r}: reveal window nearly over, ${queue.length - done} of ${queue.length} sealed bets not opened`)
}

/** reveal_many in chunks; each call reveals as many as its gas allows and says how far it got. */
async function sendReveals(r, items) {
  while (items.length) {
    // free check right before paying gas: skip bets someone else revealed in the meantime
    const { keep, dropped } = stillSealed(items, await allCommits(r))
    items.splice(0, items.length, ...keep)
    if (dropped) log('keeper', `round ${r}: ${dropped} already revealed by someone else, not sent`)
    if (!items.length) break
    const chunk = items.splice(0, 60)
    const res = await loadAccount(KEEPER).callFunctionRaw({ contractId: CONTRACT, methodName: 'reveal_many', args: { items: chunk }, gas: 300_000_000_000_000n })
    noteGas('reveal', res, chunk.length)
    const f = failed(res)
    let done = chunk.length
    try { done = JSON.parse(Buffer.from(res.status.SuccessValue, 'base64').toString()) } catch {}
    if (done < chunk.length) items.unshift(...chunk.slice(done))
    // count the bets THIS keeper revealed (and so earned the reward for): the reveal events say who
    const events = (res.receipts_outcome || []).flatMap(o => o.outcome.logs)
      .filter(l => l.includes('"event":"reveal"')).map(l => { try { return JSON.parse(l.replace(/^EVENT_JSON:/, '')).data[0] } catch { return null } })
      .filter(Boolean)
    const mine = events.filter(d => d.by === KEEPER).length
    // a bet the contract looked at but did not reveal (e.g. a salt shorter than it accepts, which
    // still matches the hash here) would be sent again on every tick, paying gas each time
    if (!f) {
      const revealed = new Set(events.map(d => `${d.account_id}:${d.slot}`))
      for (const x of chunk.slice(0, done)) if (!revealed.has(`${x.account_id}:${x.slot}`)) junk.add(`${r}:${x.account_id}:${x.slot}`)
    }
    log('keeper', f ? `reveal_many FAILED ${f}` : `revealed ${mine} of ${chunk.length} in one call` + (mine < done ? ` (${done - mine} already revealed by someone else or not revealable)` : ''))
    if (f || done === 0) break
  }
}

let lastOutcome = null
/** Rounds settle when anyone bets; if a finished round is still waiting (nobody bet since),
 *  settle it. Views only: no transaction unless something is due. */
async function settleTick(st) {
  const now = BigInt(st.now)
  const rounds = await view(CONTRACT, 'get_rounds', { from: st.commit_round, limit: 8 })
  const due = rounds.some(rv => !rv.settled && rv.commits > 0 && now >= BigInt(rv.reveal_ends_at))
  if (due) {
    const res = await loadAccount(KEEPER).callFunctionRaw({ contractId: CONTRACT, methodName: 'settle_due', args: {}, gas: 100_000_000_000_000n })
    noteGas('settle', res)
    const f = failed(res)
    if (f) log('keeper', `settle_due FAILED ${f}`)
  }
  for (const rv of [...rounds].reverse()) {
    if (!rv.settled) continue
    const r = Number(rv.round)
    lastOutcome = rv.outcome
    if ((state.logged ?? -1) >= r) continue
    state.logged = r
    save()
    log('round', r, `outcome ${rv.outcome}  A ${fmtN(rv.revealed_a)} vs B ${fmtN(rv.revealed_b)} NEAR  to treasury ${fmtN(rv.to_treasury)}  reveal rewards ${fmtN(rv.bounties)}` +
      (BigInt(rv.reward) > 0n ? `  mined ${fmt(rv.reward)} BEFEWER` : ''))
  }
}

/** Open the DEX pool step by step once the treasury is big enough, then run the buybacks. */
async function dexTick() {
  const s = await view(CONTRACT, 'get_status')
  const d = s.dex
  if (d.busy) return
  let method = null
  if (d.step < 5 && (d.step > 0 || BigInt(s.treasury_spendable) >= BigInt(s.graduate_at))) method = 'graduate'
  // buybacks: 1/365 of the treasury per day, spent once the share reaches 0.1 NEAR (next_buyback_at says when)
  else if (d.step === 5 && BigInt(s.now) >= BigInt(d.next_buyback_at) && BigInt(d.buyback_now ?? 0) >= near(0.1)) method = 'buyback'
  if (!method) return
  const res = await loadAccount(KEEPER).callFunctionRaw({ contractId: CONTRACT, methodName: method, args: {}, gas: 300_000_000_000_000n })
  noteGas(method, res)
  const f = failed(res)
  const events = (res.receipts_outcome || []).flatMap(r => r.outcome.logs).filter(l => l.includes('"graduate_result"') || l.includes('"buyback_result"'))
  log('keeper', method, f ? `FAILED ${f}` : 'ok', events.map(e => e.replace(/^EVENT_JSON:/, '')).join(' '))
}

async function main() {
  if (process.argv.includes('--setup')) return setup()
  if (!hasKey(KEEPER)) throw new Error(`no key for ${KEEPER}: put it in ~/.near-credentials/testnet/${KEEPER}.json (near login does)`)
  await registerKeeper()
  log('runner on', CONTRACT, KEEPER_ONLY ? `(keeper only, as ${KEEPER})` : `with ${NPCS.length} NPCs, keeper ${KEEPER}`)
  for (;;) {
    try {
      const st = await view(CONTRACT, 'get_status')
      if (BigInt(st.now) >= BigInt((await params()).genesis_ns)) {
        await revealTick(st) // first: it has a deadline
        await settleTick(st)
        if (!KEEPER_ONLY) await npcTick(st)
        await dexTick().catch(e => log('dex error', String(e.message || e).slice(0, 200)))
      }
    } catch (e) {
      log('tick error', String(e.message || e).slice(0, 300))
    }
    // poll fast only while a reveal window is open (reveals have a deadline); RPCs rate-limit per IP
    let wait = 10_000
    try {
      const st = await view(CONTRACT, 'get_status')
      if (st.reveal_round != null) wait = 3_000
    } catch {}
    await sleep(wait)
  }
}
await main()
