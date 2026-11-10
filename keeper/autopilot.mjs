// BEFEWER Autopilot from a terminal: the web page's strategies, run by your own computer with your
// own account, so it keeps betting while no browser is open. Your sides never leave this computer
// before the reveal: each bet is sealed here (the chain gets a fingerprint and a drand timelock),
// and this script reveals it itself when the reveal window opens (earning the reveal reward).
// A server running strategies for players would know every side before betting closes; that is
// why there is no such server.
//
// usage (Node 22.18+, testnet):
//   cd keeper && npm ci
//   node autopilot.mjs --list                                   the strategies
//   node autopilot.mjs --account you.testnet --strategy Echo    run one (Ctrl-C stops)
//   node autopilot.mjs --account you.testnet --rules my.json    rules copied from the web page
// options:
//   --strategy <name>  a strategy (bets from slot 0) or a slot set such as "A and B" (several slots)
//   --rules <json|file> the slots and rules the web page's Autopilot gives ("Run it on your computer")
//   --budget <NEAR>    pause for the day once today's bets lost this much (default 0.8; 0 = no limit)
//   --deposit <NEAR>   first move NEAR from the account's wallet into the game (full-access key)
//   --rounds <n>       stop after betting in n rounds
// The key comes from FEWER_PRIVATE_KEY=ed25519:... or ~/.near-credentials/testnet/<account>.json.
// Sides and salts are kept in ~/.befewer/<contract>/<account>.json (only this computer has them).
// Turn the web page's Autopilot off for the same account: a slot takes one bet per round.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import tlock from 'tlock-js'
import { Account, KeyPairSigner } from 'near-api-js'
import { provider, view, newSalt, commitHash, NEAR, fmtN, sleep, log } from './lib.mjs'
import { revealStartMs } from './schedule.mjs'
import { decide, guard, meFrom, stakeFor, chipsOf, yoctoOf, describe, normalizeRule, PRESETS, SLOT_SETS } from '../web/src/rules.ts'
import { QUESTIONS, label } from '../web/src/questions.ts'

const { timelockEncrypt, roundAt, roundTime, mainnetClient } = tlock
const CONTRACT = process.env.FEWER_CONTRACT || 'v6.befewer.testnet'
const ROUND_RECORD = 291n * 10n ** 19n // a void round's record, split by stake (same as the page)
const UPFRONT_PER_TGAS = 10n ** 21n // NEAR wants prepaid gas covered up front by the wallet
const GAS_TOPUP = 5n * 10n ** 22n // 0.05 NEAR moved from the game to a wallet low on gas money
const HISTORY = 320 // rounds of history the strategies may look at (as on the page)
const ns = x => Number(BigInt(x) / 1_000_000n)
const near = x => (BigInt(Math.round(x * 1e6)) * NEAR) / 1_000_000n
const sign = y => (y >= 0n ? '+' : '−') + fmtN(y < 0n ? -y : y)

// near-api-js prints a whole error with its stack each time an RPC server fails and it moves on to
// the next one (mostly rate limits): one line says the same. This script never prints a bare Error.
const consoleError = console.error
console.error = (...a) => {
  const e = a[0]
  if (a.length === 1 && e instanceof Error) {
    const m = String(e.message).match(/"message":\s*"([^"]+)"/)?.[1] ?? String(e.message)
    return log(`an RPC server failed (${m.slice(0, 80)}), using the next one`)
  }
  consoleError(...a)
}

const { values: opt } = parseArgs({
  options: {
    account: { type: 'string', default: process.env.FEWER_ACCOUNT },
    strategy: { type: 'string' },
    rules: { type: 'string' },
    budget: { type: 'string', default: '0.8' },
    deposit: { type: 'string' },
    rounds: { type: 'string' },
    list: { type: 'boolean' },
  },
})

if (opt.list) {
  console.log('Strategies (one slot):')
  for (const p of PRESETS) console.log(`  ${p.name.padEnd(22)} ${p.about}`)
  console.log('\nSlot sets (several slots, one account):')
  for (const s of SLOT_SETS) console.log(`  ${s.name.padEnd(30)} ${s.about}`)
  console.log('\nRun one: node autopilot.mjs --account you.testnet --strategy "Echo"')
  process.exit(0)
}
const fail = msg => { console.error(msg); process.exit(1) }
if (!opt.account) fail('--account you.testnet is required (or FEWER_ACCOUNT). See the top of this file.')
const ACCT = opt.account

// ---- strategy: lanes = [{ name, rules }], lane 0 bets from slot 0, the others from their own slots
function lanesFrom() {
  if (opt.rules) {
    const text = /^\s*[[{]/.test(opt.rules) ? opt.rules : fs.readFileSync(opt.rules, 'utf8')
    const j = JSON.parse(text)
    const list = Array.isArray(j) && j.length && j[0].cond ? [{ name: 'Rules', rules: j }] : Array.isArray(j) ? j : j.lanes
    if (!Array.isArray(list) || !list.length) fail('--rules: expected the JSON the web page gives ("Run it on your computer")')
    // `slot`: the slot the page used for it, so its streak carries on (if it is still open)
    return list.map((l, i) => ({ name: String(l.name ?? `Slot ${i}`), slot: Number.isInteger(l.slot) ? l.slot : null, rules: (l.rules ?? l.live ?? []).map(normalizeRule) }))
  }
  const name = (opt.strategy ?? '').toLowerCase()
  const p = PRESETS.find(x => x.name.toLowerCase() === name)
  if (p) return [{ name: p.name, rules: p.rules }]
  const s = SLOT_SETS.find(x => x.name.toLowerCase() === name)
  if (s) return s.slots.map(x => ({ name: x.name, rules: x.rules }))
  fail(opt.strategy ? `No strategy called "${opt.strategy}". node autopilot.mjs --list shows them.` : 'Pick a strategy (--strategy "Echo") or rules (--rules file.json). --list shows the strategies.')
}
const LANES = lanesFrom()

// ---- account and local state (sides and salts: kept here, never sent before the reveal)
function keyOf() {
  if (process.env.FEWER_PRIVATE_KEY) return process.env.FEWER_PRIVATE_KEY
  const f = path.join(os.homedir(), '.near-credentials', 'testnet', `${ACCT}.json`)
  if (!fs.existsSync(f)) fail(`No key for ${ACCT}: set FEWER_PRIVATE_KEY=ed25519:... or put it in ${f} (near-cli login writes it there).`)
  return JSON.parse(fs.readFileSync(f, 'utf8')).private_key
}
const account = new Account(ACCT, provider, KeyPairSigner.fromSecretKey(keyOf()))
const STATE_FILE = path.join(os.homedir(), '.befewer', CONTRACT, `${ACCT}.json`)
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 })
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {}
state.picks ??= {} // "slot:round" -> { side, salt, amount, fee, lane, bounty? }
state.slots ??= {} // lane name -> slot id opened for it
state.reported ??= {} // "slot:round" -> true once its result was printed
function save() {
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state), { mode: 0o600 })
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE)
}

// ---- rounds seen (the strategies read only finished rounds before the one they decide)
const rounds = new Map()
const remember = list => { for (const r of list) rounds.set(Number(r.round), r) }
const outcome = r => { const x = rounds.get(r); return x && x.settled && x.outcome ? x.outcome : null }
const lookup = {
  outcome,
  recent(r, n) {
    const out = []
    for (let t = r - 1; t >= 0 && out.length < n && r - t <= 400; t--) { const o = outcome(t); if (o) out.push({ round: t, outcome: o }) }
    return out
  },
  sameQuestion(r, max = 5) {
    const out = []
    for (let t = r - QUESTIONS.length; t >= 0 && out.length < max; t -= QUESTIONS.length) if (outcome(t)) out.push(t)
    return out
  },
  split(r) {
    const x = rounds.get(r)
    if (!x) return null
    const a = Number(BigInt(x.revealed_a) / 10n ** 15n), b = Number(BigInt(x.revealed_b) / 10n ** 15n)
    return a + b > 0 ? { a: a / (a + b), b: b / (a + b) } : null
  },
}

let params, skew = 0
const now = () => Date.now() + skew

// ---- results of my bets (from my picks and the rounds' outcomes), as the page counts them
const bountyOf = fee => (fee * BigInt(params.reveal_bounty_bps)) / 10000n
function netOf(pk, out, revealed) {
  const amount = BigInt(pk.amount), fee = BigInt(pk.fee), mine = BigInt(pk.bounty ?? 0)
  if (out === 'void') {
    const share = revealed > 0n ? (ROUND_RECORD * (amount < revealed ? amount : revealed)) / revealed : 0n
    return -share - bountyOf(fee) + mine
  }
  return (out === pk.side ? amount - fee : -(amount + fee)) + mine
}
function results(slot, before) {
  return Object.entries(state.picks)
    .map(([k, pk]) => ({ slot: Number(k.split(':')[0]), round: Number(k.split(':')[1]), pk }))
    .filter(x => x.slot === slot && x.round < before && outcome(x.round))
    .sort((a, b) => b.round - a.round)
    .slice(0, 40)
    .map(x => ({ side: x.pk.side, outcome: outcome(x.round), round: x.round }))
}
const localDay = ms => new Date(ms).toLocaleDateString('en-CA')
function todayNet() {
  const g = ns(params.genesis_ns), c = ns(params.commit_ns), rv = ns(params.reveal_ns)
  let net = 0n
  for (const [k, pk] of Object.entries(state.picks)) {
    const r = Number(k.split(':')[1]), x = rounds.get(r)
    if (outcome(r) && localDay(g + (r + 1) * c + rv) === localDay(Date.now())) net += netOf(pk, outcome(r), BigInt(x.revealed_a) + BigInt(x.revealed_b))
  }
  return net
}
function report() {
  for (const [k, pk] of Object.entries(state.picks)) {
    const r = Number(k.split(':')[1]), out = outcome(r)
    if (!out || state.reported[k]) continue
    state.reported[k] = true
    const x = rounds.get(r), net = netOf(pk, out, BigInt(x.revealed_a) + BigInt(x.revealed_b))
    const what = out === 'void' ? 'void' : out === pk.side ? 'won' : 'lost'
    log(`round ${r} · ${pk.lane}: picked ${label(r, pk.side)} (${pk.side}), ${out === 'void' ? 'void round' : `${label(r, out)} was smaller`} · ${what} ${sign(net)} NEAR` +
      (pk.bounty ? ` (incl. +${fmtN(pk.bounty)} for revealing it)` : ' (a keeper revealed it)'))
  }
  save()
}

// ---- transactions: the wallet pays gas up front, so a wallet low on NEAR attaches less or tops up
async function walletFree() {
  const a = await provider.query({ request_type: 'view_account', finality: 'optimistic', account_id: ACCT })
  return BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n
}
async function gasFor(want) {
  const can = (free, t) => free >= BigInt(t) * UPFRONT_PER_TGAS + near(0.005)
  let free = await walletFree()
  if (can(free, want)) return want
  if (can(free, 40)) return 40
  const p = await view(CONTRACT, 'get_player', { account_id: ACCT })
  const amount = BigInt(p.balance) < GAS_TOPUP ? BigInt(p.balance) : GAS_TOPUP
  if (amount <= 0n || !can(free, 20)) throw new Error(`the wallet holds ${fmtN(free)} NEAR, too little for gas, and cannot move NEAR out of the game`)
  await call('withdraw', { amount: amount.toString(), book: [] }, 20)
  log(`moved ${fmtN(amount)} NEAR from the game to the wallet for gas`)
  for (let i = 0; i < 12 && !can((free = await walletFree().catch(() => 0n)), 40); i++) await sleep(1000)
  return can(free, want) ? want : 40
}
async function call(methodName, args, tgas, deposit = 0n) {
  for (let i = 0; ; i++) {
    try {
      const res = await account.callFunctionRaw({ contractId: CONTRACT, methodName, args, gas: BigInt(tgas) * 10n ** 12n, deposit })
      const f = res.status?.Failure || res.receipts_outcome?.find(r => r.outcome.status?.Failure)?.outcome.status.Failure
      if (f) { const m = JSON.stringify(f); throw new Error(m.match(/Smart contract panicked: ([^"\\]+)/)?.[1] ?? m.slice(0, 200)) }
      return res
    } catch (e) {
      if (i >= 2 || !/invalid nonce|InvalidNonce/i.test(String(e?.message ?? e))) throw e
      await sleep(1500) // the RPC server had not seen our previous transaction yet: sign again
    }
  }
}
const revealEvents = res => (res.receipts_outcome ?? []).flatMap(x => x.outcome?.logs ?? [])
  .filter(l => l.startsWith('EVENT_JSON:') && l.includes('"event":"reveal"'))
  .map(l => { try { return JSON.parse(l.slice(11)).data[0] } catch { return null } }).filter(Boolean)

// ---- reveal my own bets as soon as the window opens (a keeper would take the reward 30-60 s in)
const tries = new Map()
async function revealTick(st, me) {
  if (st.reveal_round == null) return false
  const r = Number(st.reveal_round)
  const items = []
  for (const s of me.slots) {
    const k = `${s.slot}:${r}`, pk = state.picks[k], t = tries.get(k)
    if (!pk || !s.open.some(o => Number(o.round) === r && !o.side)) continue
    if (t && (t.n >= 5 || Date.now() - t.at < 5000)) continue
    items.push({ round: String(r), slot: s.slot, account_id: ACCT, side: pk.side, salt: pk.salt })
  }
  if (!items.length) return false
  const tgas = await gasFor(300)
  const per = tgas >= 300 ? 30 : 3
  for (let i = 0; i < items.length; i += per) {
    const batch = items.slice(i, i + per)
    for (const it of batch) { const k = `${it.slot}:${r}`; tries.set(k, { n: (tries.get(k)?.n ?? 0) + 1, at: Date.now() }) }
    try {
      const res = await call('reveal_many', { items: batch }, tgas)
      for (const e of revealEvents(res)) {
        if (e.by !== ACCT || e.account_id !== ACCT || Number(e.round) !== r) continue
        const pk = state.picks[`${e.slot}:${r}`]
        if (pk) pk.bounty = String(e.bounty ?? '0')
        log(`round ${r} · ${pk?.lane ?? `slot ${e.slot}`}: revealed my bet, +${fmtN(e.bounty ?? 0)} NEAR reward`)
      }
      save()
    } catch (e) {
      log(`round ${r}: reveal failed, trying again in 5 s:`, String(e.message || e).slice(0, 200))
    }
  }
  return true
}

// ---- bet: once per round per lane, after the round before has finished (same as the page)
const decided = new Set()
let roundsBet = 0
async function laneSlot(i, me) {
  const want = LANES[i].slot
  if (want === 0 || (want != null && me.slots.some(s => s.slot === want))) return want
  if (i === 0 && want == null) return 0
  const name = LANES[i].name, id = state.slots[name]
  if (id != null && me.slots.some(s => s.slot === id)) return id
  const res = await call('open_slot', {}, await gasFor(30))
  state.slots[name] = Number(JSON.parse(Buffer.from(res.status.SuccessValue, 'base64').toString()))
  save()
  log(`opened slot ${state.slots[name]} for ${name} (0.002 NEAR held while it is open)`)
  return state.slots[name]
}
function capFor(bal) {
  const storage = BigInt(3 * ACCT.length + 700 + 380) * 10n ** 19n // the contract's commit_storage
  const byBps = (bal * BigInt(params.max_stake_bps)) / 10000n
  const afford = bal > storage ? ((bal - storage) * 10000n) / (10000n + BigInt(params.fee_bps)) : 0n
  return byBps < afford ? byBps : afford
}
/** A pick whose commit did not reach the chain is dropped, so it never shows up as a result. */
async function forgetIfNotOnChain(r) {
  const me = await view(CONTRACT, 'get_player', { account_id: ACCT })
  for (const k of Object.keys(state.picks)) {
    const [slot, round] = k.split(':').map(Number)
    if (round === r && !me.slots.find(s => s.slot === slot)?.open.some(o => Number(o.round) === r)) delete state.picks[k]
  }
  save()
}
async function betTick(st) {
  const r = Number(st.commit_round)
  // when betting closes: from the pinned launch parameters, never from the RPC's clock (schedule.mjs)
  const revealStart = revealStartMs(CONTRACT, r, params, now())
  if (revealStart - now() < 25_000) return
  const prev = rounds.get(r - 1)
  if (prev && !prev.settled) return
  const budget = near(Number(opt.budget))
  if (budget > 0n && budget + todayNet() <= 0n) {
    if (!decided.has(`budget:${r}`)) { decided.add(`budget:${r}`); log(`daily budget of ${opt.budget} NEAR used up: paused until tomorrow`) }
    return
  }
  let betNow = false
  for (let i = 0; i < LANES.length; i++) {
    const key = `${i}:${r}`
    if (decided.has(key)) continue
    decided.add(key)
    const lane = LANES[i]
    try {
      let me = await view(CONTRACT, 'get_player', { account_id: ACCT })
      const slot = await laneSlot(i, me)
      me = await view(CONTRACT, 'get_player', { account_id: ACCT })
      const s = me.slots.find(x => x.slot === slot)
      if (s?.open.some(o => Number(o.round) === r)) { log(`round ${r} · ${lane.name}: slot ${slot} already has a bet this round, placed elsewhere (on the web page?), so this one sits out`); continue }
      const mine = meFrom(results(slot, r))
      const d = decide(lane.rules, r, guard(lookup, r), mine)
      if ('skip' in d) { log(`round ${r} · ${lane.name}: ${d.rule == null ? 'no rule fit' : `rule ${d.rule + 1} says skip`}, sits out`); continue }
      // this slot's settled winnings are booked by the bet itself, so they count
      const bal = BigInt(me.balance) + (s?.open ?? []).reduce((t, o) => t + BigInt(o.payout), 0n)
      const chips = stakeFor(d.unit, d.amount, chipsOf(bal), mine, chipsOf(capFor(bal)))
      if (chips < 1) { log(`round ${r} · ${lane.name}: balance ${fmtN(bal)} NEAR is too small to bet`); continue }
      let amount = yoctoOf(chips)
      if (amount < BigInt(params.min_stake)) amount = BigInt(params.min_stake)
      const fee = (amount * BigInt(params.fee_bps)) / 10000n
      const salt = newSalt()
      const hash = commitHash(ACCT, slot, r, d.side, salt)
      let dr = roundAt(revealStart, drandInfo) // roundAt() can be up to 3 s early: take the first round at/after it
      if (roundTime(drandInfo, dr) < revealStart) dr += 1
      const sealed = await timelockEncrypt(dr, Buffer.from(`${d.side}:${salt}`), drand)
      state.picks[`${slot}:${r}`] = { side: d.side, salt, amount: amount.toString(), fee: fee.toString(), lane: lane.name }
      save() // before sending: the reveal needs the salt even if this script stops right after
      await call('commit', { round: String(r), slot, amount: amount.toString(), hash, sealed }, await gasFor(100))
      log(`round ${r} · ${lane.name}: rule ${d.rule + 1} → ${fmtN(amount)} NEAR on ${label(r, d.side)} (${d.side}), +${fmtN(fee)} fee, sealed until drand #${dr}`)
      betNow = true
    } catch (e) {
      log(`round ${r} · ${lane.name}: bet failed:`, String(e.message || e).slice(0, 200))
      await forgetIfNotOnChain(r).catch(() => {})
    }
  }
  if (betNow && opt.rounds && ++roundsBet >= Number(opt.rounds)) stopAfter = r
}

// ---- main loop
const drand = mainnetClient() // drand quicknet, the chain tlock uses (3 s rounds)
const drandInfo = await drand.chain().info()
params = await view(CONTRACT, 'get_params')
let stopAfter = null
let stopping = false
process.on('SIGINT', () => { if (stopping) process.exit(130); stopping = true; save(); log('stopping (Ctrl-C again to quit now; bets still open are revealed by a keeper)') })

if (opt.deposit) {
  await call('deposit', {}, 30, near(Number(opt.deposit)))
  log(`deposited ${opt.deposit} NEAR into the game`)
}
{
  const st = await view(CONTRACT, 'get_status')
  const top = Number(st.commit_round)
  const froms = []
  for (let from = top; from >= Math.max(0, top - HISTORY); from -= 50) froms.push(from)
  await Promise.all(froms.map(from => view(CONTRACT, 'get_rounds', { from: String(from), limit: 50 }).then(remember).catch(() => {})))
  const me = await view(CONTRACT, 'get_player', { account_id: ACCT })
  if (!me.registered) fail(`${ACCT} has no game balance on ${CONTRACT}: add --deposit 1 (moves 1 NEAR from its wallet), or play once on the web page.`)
  log(`${ACCT} on ${CONTRACT} · game balance ${fmtN(me.balance)} NEAR · wallet ${fmtN(await walletFree())} NEAR · ${rounds.size} rounds of history`)
  LANES.forEach((l, i) => log(`  ${l.slot != null ? `slot ${l.slot}` : i === 0 ? 'slot 0' : 'new slot'}: ${l.name}`, l.rules.map((x, j) => `\n      ${describe(x, j + 1)}`).join('')))
  log(`  daily budget ${Number(opt.budget) > 0 ? `${opt.budget} NEAR` : 'off'} · turn the web page's Autopilot off for this account · Ctrl-C stops`)
}
for (;;) {
  let fast = false
  try {
    const st = await view(CONTRACT, 'get_status')
    skew = ns(st.now) - Date.now()
    remember(await view(CONTRACT, 'get_rounds', { from: st.commit_round, limit: 6 }))
    const me = await view(CONTRACT, 'get_player', { account_id: ACCT })
    fast = await revealTick(st, me) // first: it has a deadline
    report()
    if (!stopping && stopAfter == null) await betTick(st)
    const open = Object.keys(state.picks).filter(k => !outcome(Number(k.split(':')[1]))).length
    if ((stopping || (stopAfter != null && Number(st.commit_round) > stopAfter)) && (stopping || open === 0)) break
  } catch (e) {
    log('error:', String(e.message || e).slice(0, 200))
  }
  await sleep(fast ? 1000 : 3000)
}
save()
log('stopped')
process.exit(0)
