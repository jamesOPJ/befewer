// FEWER testnet runner: four NPC players with their own wallets + a keeper that
// opens drand timelocks, reveals every sealed commit and pays out every finished round.
// Everything the keeper does is permissionless: anyone can run this file against the contract.
//
// usage: FEWER_CONTRACT=v2.befewer.testnet node run.mjs            (loop forever)
//        FEWER_CONTRACT=v2.befewer.testnet node run.mjs --setup    (create + fund NPC/keeper accounts, claim faucet)
//        FEWER_KEEPER_ONLY=1 ... node run.mjs                       (no NPCs, just reveal + claim)
import fs from 'node:fs'
import tlock from 'tlock-js'
import { actions } from 'near-api-js'
import { loadAccount, hasKey, newKeyFor, view, call, newSalt, commitHash, ONE, fmt, sleep, log } from './lib.mjs'

const { timelockEncrypt, timelockDecrypt, roundAt, roundTime, mainnetClient } = tlock
const CONTRACT = process.env.FEWER_CONTRACT || 'v2.befewer.testnet'
const ROOT = 'befewer.testnet'
const KEEPER = `keeper.${ROOT}`
const KEEPER_ONLY = process.env.FEWER_KEEPER_ONLY === '1'
const drand = mainnetClient() // drand quicknet (3 s rounds), the chain tlock uses
const drandInfo = await drand.chain().info()

const coin = () => (Math.random() < 0.5 ? 'A' : 'B')
const other = s => (s === 'A' ? 'B' : 'A')
// Personalities. pick(h) gets the last settled round's outcome.
export const NPCS = [
  { id: `npc-coin.${ROOT}`, play: 0.85, stake: [0.04, 0.18], about: 'flips a coin', pick: () => coin() },
  { id: `npc-echo.${ROOT}`, play: 0.75, stake: [0.04, 0.15], about: 'bets the last minority wins again', pick: h => (h.last === 'A' || h.last === 'B' ? h.last : coin()) },
  { id: `npc-flip.${ROOT}`, play: 0.75, stake: [0.04, 0.15], about: 'bets the crowd over-corrects', pick: h => (h.last === 'A' || h.last === 'B' ? other(h.last) : coin()) },
  { id: `npc-whale.${ROOT}`, play: 0.5, stake: [0.18, 0.25], about: 'bets big on a hunch', pick: () => coin() },
]

const STATE_DIR = new URL('./state/', import.meta.url)
fs.mkdirSync(STATE_DIR, { recursive: true })
const STATE_FILE = new URL(`./state/${CONTRACT}.json`, import.meta.url)
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { plans: {}, salts: {}, gas: [] }
const save = () => {
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state))
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE)
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
  for (const [id, near] of [[KEEPER, 15n], ...NPCS.map(n => [n.id, 6n])]) {
    if (!hasKey(id)) {
      const kp = newKeyFor(id)
      await root.createSubAccount({ accountOrPrefix: id, publicKey: kp.getPublicKey(), nearToTransfer: near * 10n ** 23n })
      log('created', id, `${Number(near) / 10} NEAR`)
    }
  }
  for (const n of NPCS) {
    const p = await view(CONTRACT, 'get_player', { account_id: n.id })
    if (!p.faucet_claimed) {
      await call(loadAccount(n.id), CONTRACT, 'faucet')
      log('faucet', n.id)
    }
  }
}

async function npcTick(st) {
  const r = Number(st.commit_round)
  const start = Number(BigInt(st.commit_ends_at) / 1_000_000n) - Number(BigInt((await params()).commit_ns) / 1_000_000n)
  const end = Number(BigInt(st.commit_ends_at) / 1_000_000n)
  for (const n of NPCS) {
    const key = `${n.id}:${r}`
    if (!state.plans[key]) {
      // decide once per round: whether to play and when (spread across the window)
      const playing = Math.random() < n.play
      state.plans[key] = { playing, at: start + (0.1 + 0.7 * Math.random()) * (end - start), done: false }
      save()
    }
    const plan = state.plans[key]
    if (!plan.playing || plan.done || Date.now() < plan.at) continue
    plan.done = true
    save()
    try {
      const p = await view(CONTRACT, 'get_player', { account_id: n.id })
      if (p.open.length >= 8) { log(n.id, 'skips: too many open rounds'); continue }
      const bal = BigInt(p.balance)
      const frac = n.stake[0] + Math.random() * (n.stake[1] - n.stake[0])
      let amount = (bal * BigInt(Math.floor(frac * 10000))) / 10000n
      const cap = (bal * 2500n) / 10000n
      if (amount > cap) amount = cap
      if (amount < ONE) { log(n.id, 'skips: balance too small'); continue }
      const side = n.pick({ last: lastOutcome })
      const salt = newSalt()
      const hash = commitHash(n.id, r, side, salt)
      let dr = roundAt(end, drandInfo) // roundAt() can return a round published up to 3 s BEFORE `end`
      if (roundTime(drandInfo, dr) < end) dr += 1 // so take the first round published at/after reveal start
      const sealed = await timelockEncrypt(dr, Buffer.from(`${side}:${salt}`), drand)
      state.salts[key] = { side, salt }
      save()
      const res = await loadAccount(n.id).callFunctionRaw({ contractId: CONTRACT, methodName: 'commit', args: { round: String(r), amount: amount.toString(), hash, sealed }, gas: 30_000_000_000_000n })
      noteGas('commit', res)
      const f = failed(res)
      log(n.id, f ? `commit FAILED ${f}` : `committed ${fmt(amount)} FEWER to round ${r} (sealed for drand #${dr})`)
    } catch (e) {
      log(n.id, 'commit error', String(e.message || e).slice(0, 200))
    }
  }
}

let paramsCache
async function params() {
  return (paramsCache ??= await view(CONTRACT, 'get_params'))
}

async function allCommits(r) {
  const out = []
  for (let from = 0; ; from += 100) {
    const page = await view(CONTRACT, 'get_round_commits', { round: String(r), from_index: from, limit: 100 })
    out.push(...page)
    if (page.length < 100) return out
  }
}

async function sendBatch(kind, calls) {
  const keeper = loadAccount(KEEPER)
  for (let i = 0; i < calls.length; i += 10) {
    const chunk = calls.slice(i, i + 10)
    const res = await keeper.signAndSendTransaction({
      receiverId: CONTRACT,
      actions: chunk.map(([m, a, g]) => actions.functionCall(m, a, g, 0n)),
    })
    noteGas(kind, res, chunk.length)
    const f = failed(res)
    log('keeper', f ? `${kind} batch FAILED ${f}` : `${kind} x${chunk.length} ok`)
  }
}

async function revealTick(st) {
  if (st.reveal_round == null) return
  const r = Number(st.reveal_round)
  const commits = await allCommits(r)
  const todo = []
  for (const c of commits) {
    if (c.side) continue
    let side, salt
    if (c.sealed) {
      try {
        const pt = (await timelockDecrypt(c.sealed, drand)).toString()
        ;[side, salt] = [pt.slice(0, 1), pt.slice(2)]
      } catch (e) {
        if (!String(e.message || e).includes('too early')) log('keeper', `cannot open ${c.account_id}'s timelock: ${String(e.message || e).slice(0, 120)}`)
      }
    }
    if (!side && state.salts[`${c.account_id}:${r}`]) ({ side, salt } = state.salts[`${c.account_id}:${r}`]) // our own NPC fallback
    if (!side) continue
    if (commitHash(c.account_id, r, side, salt) !== c.hash) {
      log('keeper', `skip ${c.account_id}: opened value does not match its commitment`)
      continue
    }
    todo.push(['reveal', { round: String(r), side, salt, account_id: c.account_id }, 20_000_000_000_000n])
  }
  if (todo.length) await sendBatch('reveal', todo)
}

let lastOutcome = null
async function claimTick(st) {
  const p = await params()
  const now = BigInt(st.now)
  const c = Number(st.commit_round)
  for (let r = Math.max(0, c - (state.scannedFrom ?? 300)); r < c; r++) {
    const rv = await view(CONTRACT, 'get_round', { round: String(r) })
    if (rv.commits === 0) continue
    if (now < BigInt(rv.reveal_ends_at)) continue
    if (rv.settled) lastOutcome = rv.outcome
    if (rv.claims >= rv.commits) continue
    const commits = await allCommits(r)
    const who = [...new Set(commits.map(x => x.account_id))]
    if (who.length) await sendBatch('claim', who.map(a => ['claim', { account_id: a }, 25_000_000_000_000n]))
    const after = await view(CONTRACT, 'get_round', { round: String(r) })
    if (after.settled) {
      lastOutcome = after.outcome
      log('round', r, `outcome ${after.outcome}  A ${fmt(after.revealed_a)} vs B ${fmt(after.revealed_b)}  burned ${fmt(after.burned)}`)
    }
  }
  state.scannedFrom = 4 // after the first full scan, only look back a few rounds
  save()
}

async function main() {
  if (process.argv.includes('--setup')) return setup()
  log('runner on', CONTRACT, KEEPER_ONLY ? '(keeper only)' : `with ${NPCS.length} NPCs`)
  for (;;) {
    try {
      const st = await view(CONTRACT, 'get_status')
      if (BigInt(st.now) >= BigInt((await params()).genesis_ns)) {
        await claimTick(st)
        await revealTick(st)
        if (!KEEPER_ONLY) await npcTick(st)
      }
    } catch (e) {
      log('tick error', String(e.message || e).slice(0, 300))
    }
    await sleep(10_000)
  }
}
await main()
