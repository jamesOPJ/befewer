import './style.css'
import {
  CONTRACT, EXPLORER, ONE, view, fmt, nsToMs, randomSalt, commitHash, seal, loadSession, saveSession,
  newKeyPair, loadPicks, savePick, callContract, type Status, type Params, type RoundV, type PlayerV, type Session,
} from './chain'
import { questionFor, label, QUESTIONS } from './questions'
import * as H from './history'
import { decide, backtest, guard, PRESETS, type Rule, type Cond, type Pick, type Lookup } from './rules'

const $ = (sel: string) => document.querySelector(sel) as HTMLElement
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const NPCS = [
  ['npc-coin.befewer.testnet', 'Coin', 'flips a coin'],
  ['npc-echo.befewer.testnet', 'Echo', 'bets the last minority wins again'],
  ['npc-flip.befewer.testnet', 'Flip', 'bets the crowd over-corrects'],
  ['npc-whale.befewer.testnet', 'Whale', 'bets big on a hunch'],
] as const

let params: Params
let status: Status
let skew = 0 // chain time - local time (ms)
let session: Session | null = loadSession()
let me: PlayerV | null = null
let rounds: RoundV[] = []
let busy = ''
let stakeChoice: number | null = null // the player's slider choice survives re-renders
let notice = ''
let failure = '' // last error, shown in a red box until the next action

const now = () => Date.now() + skew
function left(ns: string): string {
  const s = Math.max(0, Math.round((nsToMs(ns) - now()) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const short = (a: string) => (a.length > 22 ? a.slice(0, 10) + '…' + a.slice(-10) : a)

async function refresh(full = false) {
  try {
    params ??= await view<Params>('get_params')
    status = await view<Status>('get_status')
    skew = nsToMs(status.now) - Date.now()
    if (full || !rounds.length) rounds = await view<RoundV[]>('get_rounds', { from: status.commit_round, limit: 30 })
    else {
      // keep the newest few fresh
      const fresh = await view<RoundV[]>('get_rounds', { from: status.commit_round, limit: 4 })
      const byId = new Map(rounds.map(r => [r.round, r]))
      for (const r of fresh) byId.set(r.round, r)
      rounds = [...byId.values()].sort((a, b) => Number(b.round) - Number(a.round)).slice(0, 30)
    }
    H.remember(rounds)
    await H.loadDeep(Number(status.commit_round))
    if (session) {
      me = await view<PlayerV>('get_player', { account_id: session.accountId })
      await loadResults()
    }
    render()
  } catch (e) {
    console.error(e)
  }
}

function roundById(id: string | null): RoundV | undefined {
  return id == null ? undefined : rounds.find(r => r.round === id)
}

function bar(a: bigint, b: bigint): string {
  const t = a + b
  const pa = t === 0n ? 50 : Number((a * 1000n) / t) / 10
  return `<div class="bar"><span class="a" style="width:${pa}%"></span><span class="b" style="width:${100 - pa}%"></span></div>`
}

function renderMove(_cr: RoundV | undefined): string {
  const r = Number(status.commit_round)
  if (BigInt(status.now) < BigInt(params.genesis_ns)) {
    return `<div class="move"><p class="lead">The game opens in ${timer(params.genesis_ns)}. Round 0 takes bets right after.</p></div>`
  }
  const decided = me ? me.wins + me.losses : 0
  const head = session && me
    ? `<div class="who">${esc(short(session.accountId))} · <b>${fmt(me.balance)}</b> BEFEWER
       · streak ${me.streak} (best ${me.best_streak}) · <a href="#" data-act="logout">forget this device</a></div>
       ${decided ? `<div class="score">You picked the smaller side <b>${me.wins} of ${decided}</b> times (<b class="${me.wins * 2 > decided ? 'good' : me.wins * 2 < decided ? 'burn' : ''}">${Math.round((me.wins * 100) / decided)}%</b>). A coin flip gets 50%.</div>` : ''}`
    : ''
  const mine = me?.open.find(o => o.round === String(r))
  if (session && mine) {
    const pick = loadPicks(session.accountId)[r]
    return `<div class="move">${head}<p class="locked">You're in round ${r}: <b>${fmt(mine.amount)}</b> BEFEWER on
      <b class="side-${pick?.side ?? 'x'}">${pick ? `${pick.side} · ${esc(label(r, pick.side))}` : '?'}</b>, sealed until drand #${pick?.drandRound ?? '?'}.
      Nobody, including us, can see your side until the reveal opens. It reveals itself; the result shows up here.</p></div>`
  }
  // newcomers bet straight away: their first tap creates a testnet account and claims the faucet
  const newcomer = !session || !me || (!me.faucet_claimed && BigInt(me.balance) === 0n)
  const bal = newcomer ? BigInt(params.faucet_amount) : BigInt(me!.balance)
  const cap = (bal * BigInt(params.max_stake_bps)) / 10000n
  if (cap < BigInt(params.min_stake)) return `<div class="move">${head}<p>Your balance is too small to play (max stake is 25% of your balance).</p></div>`
  const maxW = Number(cap / ONE)
  const def = 1 // start at the minimum; the player's own choice is applied after painting (applyStake)
  return `<div class="move">${head}
    <label class="stake">Stake <input id="amt" type="range" min="1" max="${maxW}" value="${def}"><b id="amtv">${def}</b> BEFEWER <span class="fine">(max 25% of balance)</span></label>
    <div class="pick"><button class="side-A" data-act="commit" data-side="A" ${busy ? 'disabled' : ''}>A<small>${esc(questionFor(r).a)}</small></button>
    <button class="side-B" data-act="commit" data-side="B" ${busy ? 'disabled' : ''}>B<small>${esc(questionFor(r).b)}</small></button></div>
    <p class="fine">Don't pick what you like. Pick the answer you think <b>fewer coins</b> will pick. Win: 2× back. Lose: your stake. The gap between the sides burns.</p>
    ${newcomer ? `<p class="fine">Your first tap creates a free testnet account in this browser and gives you ${fmt(params.faucet_amount)} BEFEWER. No wallet, no seed phrase, no popups.</p>` : ''}
  </div>`
}

// Results of my finished bets, rebuilt from the picks this browser remembers + the settled rounds.
type Result = { round: string; side: 'A' | 'B'; amount: bigint; outcome: 'A' | 'B' | 'void' }
let results: Result[] = []
const settled = new Map<string, RoundV>()
async function loadResults() {
  if (!session || !me) return
  const picks = loadPicks(session.accountId)
  const open = new Set(me.open.map(o => o.round))
  const ids = Object.keys(picks).filter(r => !open.has(r)).sort((a, b) => Number(b) - Number(a)).slice(0, 6)
  const out: Result[] = []
  for (const id of ids) {
    let rv = settled.get(id) ?? roundById(id)
    if (!rv?.settled) rv = await view<RoundV>('get_round', { round: id })
    if (!rv.settled || !rv.outcome) continue
    settled.set(id, rv)
    out.push({ round: id, side: picks[id].side, amount: BigInt(picks[id].amount), outcome: rv.outcome })
  }
  results = out
}
function resultText(x: Result): string {
  if (x.outcome === 'void') return `refunded ${fmt(x.amount)} (everyone was on one side, or a tie)`
  return x.outcome === x.side ? `<b class="good">won +${fmt(x.amount)}</b> (got ${fmt(2n * x.amount)} back)` : `<b class="burn">lost ${fmt(x.amount)}</b>`
}

/** What the crowd did before: last time this question was asked + the recent smaller sides. */
function historyHTML(r: number): string {
  const past = H.sameQuestion(r, 5)
  let q = `<span class="fine">First time this question comes up in this game.</span>`
  if (past.length) {
    const t = past[0]
    const sp = H.split(t)
    const o = H.outcome(t)!
    const pct = (x: number) => `${Math.round(x * 100)}%`
    q = `Last time (round ${t}): ${esc(label(t, 'A'))} ${sp ? pct(sp.a) : '—'} · ${esc(label(t, 'B'))} ${sp ? pct(sp.b) : '—'} of the coins → ${o === 'void' ? 'void (everyone on one side)' : `<b class="side-${o}">${esc(label(t, o))}</b> was the smaller side`}.`
    if (past.length > 1) {
      const n = (s: string) => past.filter(x => H.outcome(x) === s).length
      q += ` <span class="fine">Asked ${past.length} times: ${esc(label(t, 'A'))} won ${n('A')}, ${esc(label(t, 'B'))} won ${n('B')}${n('void') ? `, void ${n('void')}` : ''}.</span>`
    }
  }
  const rec = H.recent(r, 12)
  const chips = rec.length
    ? `<div class="chips" title="Smaller side of the last rounds, newest first">${rec.map(x => `<span class="chip c-${x.outcome}" title="Round ${x.round}: ${esc(questionFor(x.round).q)} → ${esc(label(x.round, x.outcome))}">${x.outcome === 'void' ? '·' : x.outcome}</span>`).join('')}<span class="fine"> ← newest</span></div>`
    : ''
  return `<div class="hist">${q}${chips}</div>`
}

/** Make sure this browser has a testnet account with BEFEWER in it. */
async function ensurePlayer() {
  if (!session) {
    busy = 'Creating your testnet account…'
    render()
    const kp = newKeyPair()
    const res = await fetch('/api/guest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: kp.publicKey }) })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || 'The guest account service is unavailable.')
    session = { accountId: j.accountId, privateKey: kp.privateKey, kind: 'guest' }
    saveSession(session)
  }
  me = await view<PlayerV>('get_player', { account_id: session.accountId })
  if (!me.faucet_claimed && BigInt(me.balance) === 0n) {
    busy = `Claiming ${fmt(params.faucet_amount)} BEFEWER…`
    render()
    await callContract(session, 'faucet', {})
    me = await view<PlayerV>('get_player', { account_id: session.accountId })
  }
}

/** Write a section only when its HTML actually changed, so polling never repaints the page
 *  (and never resets the stake slider or the scroll position). */
const painted = new Map<string, string>()
function setHTML(id: string, html: string) {
  if (painted.get(id) === html) return
  const el = document.getElementById(id)
  if (!el) return
  el.innerHTML = html
  painted.set(id, html)
}
// countdowns are filled in by tick(), never baked into the HTML (that would change it every second)
const timer = (ns: string | null) => `<b class="t" data-t="${ns ?? ''}"></b>`
function tick() {
  document.querySelectorAll<HTMLElement>('.t[data-t]').forEach(el => {
    if (el.dataset.t) el.textContent = left(el.dataset.t)
  })
}

/** Put the player's slider choice back without changing the section HTML. */
function applyStake() {
  const el = document.getElementById('amt') as HTMLInputElement | null
  if (!el || stakeChoice == null) return
  const v = String(Math.min(Number(el.max), Math.max(1, stakeChoice)))
  if (el.value !== v) el.value = v
  $('#amtv').textContent = el.value
}

let skeleton = false
function render() {
  if (!skeleton) {
    $('#app').innerHTML = `
  <header>
    <h1>$BEFEWER</h1>
    <p class="tag">Pick the side fewer coins pick.</p>
    <p class="sub">A memecoin whose daily ritual is a sealed-bid minority game on NEAR. The minority doubles, the imbalance burns.</p>
    <p class="testnet">Testnet demo built for NEAR HACKATHON. Testnet BEFEWER is free and has no monetary value; there is no token sale.</p>
  </header>
  <details class="rules" id="rules">
    <summary><b>How to play</b> <span class="gist">Each round asks a question. Pick the answer you think <b>fewer coins</b> will pick. Win: 2× back. Lose: your stake. The gap burns.</span></summary>
    <p class="fine">All of this is enforced by the contract. There is no owner and no admin.</p>
    <ol>
      <li>Every round asks a two-answer question. Don't pick what you like: pick the answer you think <b>fewer coins</b> will pick.</li>
      <li>You can bet up to 25% of your balance on answer A or B. Your side is sealed: the contract stores only a hash.</li>
      <li>Your browser also locks your side with a <a href="https://drand.love" target="_blank" rel="noopener">drand</a> timelock that opens when the reveal window opens. Then anyone can open it and reveal it for you, so you never have to come back.</li>
      <li>After the reveal window, the side with <b>less</b> revealed BEFEWER wins. Winners get exactly 2× their stake. Losers lose their stake.</li>
      <li>The gap between the sides is burned, along with every bet that was never revealed. A tie or a one-sided round refunds everyone.</li>
      <li>Supply only goes down: everything was minted once at launch, there is no mint function and no owner.</li>
    </ol>
    <p class="fine">Contract <a href="${EXPLORER}/address/${CONTRACT}" target="_blank" rel="noopener">${CONTRACT}</a> · this demo runs a round every ${Number(BigInt(params.commit_ns) / 60_000_000_000n)} minutes; the mechanic is designed for one round a day. Questions come from a fixed public list (round number mod ${QUESTIONS.length}); the contract only knows A and B, so the wording cannot change who wins.</p>
  </details>
  <section class="live">
    <div class="card now"><div id="s-round"></div><div id="s-last"></div><div id="s-move"></div><div id="s-notice"></div></div>
    <div class="card reveal" id="s-reveal"></div>
  </section>
  <section class="card autopilot"><h2>Autopilot</h2>
    <p class="fine">Write rules and let them bet for you. Rules are checked top to bottom; the first one that fits decides. They only look at rounds that already finished.</p>
    <div class="presets">Start from: ${PRESETS.map((x, i) => `<button class="mini" data-act="ap-preset" data-i="${i}" title="${esc(x.about)}">${esc(x.name)}</button>`).join('')}</div>
    <div id="ap-rules"></div>
    <div id="ap-bt"></div>
    <label class="ap-on"><input type="checkbox" id="ap-on"> Run my rules every round while this page is open</label>
    <div id="ap-status"></div>
  </section>
  <section class="stats" id="s-stats"></section>
  <div id="s-mine"></div>
  <div id="s-results"></div>
  <section><h2>Recent rounds</h2><div id="s-rounds"></div>
    <p class="fine">Rounds nobody played are skipped. The burn is |A − B| plus any bet that was never opened.</p></section>
  <section><h2>NPC players</h2><p class="fine">Four bots with their own testnet wallets keep every round alive. They play by the same rules as you.</p>
    <div class="npcs" id="npcs"></div></section>
`
    skeleton = true
    const det = document.getElementById('rules') as HTMLDetailsElement
    det.open = localStorage.getItem('fewer.rules') !== 'closed'
    det.addEventListener('toggle', () => localStorage.setItem('fewer.rules', det.open ? 'open' : 'closed'))
  }
  const cr = roundById(status.commit_round)
  const rr = roundById(status.reveal_round)
  const burned = BigInt(status.total_burned)
  const supply = BigInt(status.total_supply)
  const initial = BigInt(status.initial_supply)
  const handedOut = initial - BigInt(status.faucet_reserve) // everything that ever left the launch reserve
  const circulating = supply - BigInt(status.faucet_reserve) - BigInt(status.escrow)
  const burnPct = handedOut > 0n ? Number((burned * 100000n) / handedOut) / 1000 : 0

  setHTML('s-round', `<div class="k">Round ${status.commit_round} · bets close in ${timer(status.commit_ends_at)}</div>
      <div class="q">${esc(questionFor(status.commit_round).q)}</div>
      <div class="k"><b class="amt">${fmt(cr?.committed ?? '0')}</b> BEFEWER in · ${cr?.commits ?? 0} sealed bet${cr?.commits === 1 ? '' : 's'} · sides hidden until the reveal opens</div>
      ${historyHTML(Number(status.commit_round))}`)
  setHTML('s-move', renderMove(cr))
  applyStake()
  setHTML('s-notice', `${failure ? `<p class="failure">Your bet did not go through: ${esc(failure)}</p>` : ''}${notice ? `<p class="notice">${esc(notice)}</p>` : ''}${busy ? `<p class="notice busy">${esc(busy)}</p>` : ''}`)
  setHTML('s-reveal', rr
    ? `<div class="k">Round ${rr.round} · revealing · result in ${timer(status.reveal_ends_at)}</div>
        <div class="q small">${esc(questionFor(rr.round).q)}</div>
        <div class="vs"><span class="side-A">${esc(label(rr.round, 'A'))} ${fmt(rr.revealed_a)}</span><span class="side-B">${esc(label(rr.round, 'B'))} ${fmt(rr.revealed_b)}</span></div>
        ${bar(BigInt(rr.revealed_a), BigInt(rr.revealed_b))}
        <div class="k">${rr.reveals_a + rr.reveals_b} of ${rr.commits} bets opened · drand published the key, the keeper is opening them</div>`
    : `<div class="k">No round is revealing right now.</div>`)
  setHTML('s-stats', `
    <div><div class="k">Handed out by the faucet</div><div class="v">${fmt(handedOut)}</div><div class="k">${fmt(status.faucet_reserve)} still in the launch reserve</div></div>
    <div><div class="k">Burned so far</div><div class="v burn">${fmt(burned)}</div><div class="k">${burnPct}% of everything handed out · ${status.rounds_settled} rounds</div></div>
    <div><div class="k">In players' hands</div><div class="v">${fmt(circulating)}</div><div class="k">${fmt(status.escrow)} locked in bets</div></div>
    <div><div class="k">Longest minority streak</div><div class="v">${status.best_streak}</div><div class="k">${status.best_streak_holder ? esc(short(status.best_streak_holder)) : '—'}</div></div>`)
  const last = results[0]
  setHTML('s-last', last ? `<p class="last">Round ${last.round} · ${esc(questionFor(last.round).q)} ${last.outcome === 'void' ? 'Void.' : `<b class="side-${last.outcome}">${esc(label(last.round, last.outcome))}</b> was the smaller side.`} You picked <b class="side-${last.side}">${esc(label(last.round, last.side))}</b> → ${resultText(last)}.</p>` : '')
  setHTML('s-results', results.length ? `<section><h2>Your results</h2><table><tr><th>Round</th><th>Your side</th><th>Stake</th><th>Smaller side</th><th>Result</th></tr>
    ${results.map(x => `<tr><td>${x.round}<div class="fine">${esc(questionFor(x.round).q)}</div></td><td class="side-${x.side}">${esc(label(x.round, x.side))}</td><td>${fmt(x.amount)}</td><td>${esc(label(x.round, x.outcome))}</td><td>${resultText(x)}</td></tr>`).join('')}</table></section>` : '')
  setHTML('s-mine', session && me && me.open.length ? `<section><h2>Your bets</h2><table><tr><th>Round</th><th>Stake</th><th>Your side</th><th>Status</th></tr>
    ${me.open.map(o => { const p = loadPicks(session!.accountId)[o.round]; const rv = roundById(o.round)
      const st = rv?.settled ? `settled: ${rv.outcome}` : o.side ? 'opened' : 'sealed'
      return `<tr><td>${o.round}<div class="fine">${esc(questionFor(o.round).q)}</div></td><td>${fmt(o.amount)}</td><td class="side-${p?.side ?? 'x'}">${p ? esc(label(o.round, p.side)) : '?'}</td><td>${st}</td></tr>` }).join('')}
    </table><p class="fine">W ${me.wins} · L ${me.losses} · void ${me.voids} · forfeited ${me.forfeits}</p></section>` : '')
  setHTML('s-rounds', `<table class="rounds"><tr><th>Round</th><th>Bets</th><th>A</th><th>B</th><th>Smaller side</th><th>Burned</th></tr>
    ${rounds.filter(r => r.round !== status.commit_round).map(r => `<tr>
      <td>${r.round}<div class="fine">${esc(questionFor(r.round).q)}</div></td><td>${r.commits}</td>
      <td class="${r.outcome === 'A' ? 'win' : ''}">${r.reveals_a ? fmt(r.revealed_a) : '—'}<div class="fine">${esc(label(r.round, 'A'))}</div></td>
      <td class="${r.outcome === 'B' ? 'win' : ''}">${r.reveals_b ? fmt(r.revealed_b) : '—'}<div class="fine">${esc(label(r.round, 'B'))}</div></td>
      <td>${r.settled ? (r.outcome === 'void' ? 'void (refund)' : `<b class="side-${r.outcome}">${esc(label(r.round, r.outcome))}</b> doubles`) : (r.round === status.reveal_round ? 'revealing' : 'waiting for keeper')}</td>
      <td class="burn">${r.settled ? fmt(r.burned) : ''}</td></tr>`).join('')}
    </table>`)
  renderNpcs()
  apRender()
  tick()
}

let npcCache: Record<string, PlayerV> = {}
async function loadNpcs() {
  for (const [id] of NPCS) npcCache[id] = await view<PlayerV>('get_player', { account_id: id })
  renderNpcs()
}
function renderNpcs() {
  const el = document.getElementById('npcs')
  if (!el) return
  setHTML('npcs', NPCS.map(([id, name, about]) => {
    const p = npcCache[id]
    return `<div class="npc"><b>${name}</b> <span class="fine">${about}</span>
      <div>${p ? `${fmt(p.balance)} BEFEWER · W ${p.wins} L ${p.losses} · streak ${p.streak}` : '…'}</div></div>`
  }).join(''))
}

/** Seal a side with drand and commit it to the round taking bets right now. */
async function placeBet(side: 'A' | 'B', want: bigint, who = 'you'): Promise<{ round: number; amount: bigint }> {
  const cap = (BigInt(me!.balance) * BigInt(params.max_stake_bps)) / 10000n
  let amount = want > cap ? cap : want
  if (amount < BigInt(params.min_stake)) amount = BigInt(params.min_stake)
  status = await view<Status>('get_status')
  const r = Number(status.commit_round)
  const revealStart = nsToMs(status.commit_ends_at)
  if (revealStart - now() < 8000) throw new Error('This round is closing; wait a few seconds for the next one.')
  busy = `Sealing ${who === 'you' ? 'your' : 'the autopilot\'s'} side with drand…`
  render()
  const salt = randomSalt()
  const hash = await commitHash(session!.accountId, r, side, salt)
  const { sealed, drandRound } = await seal(side, salt, revealStart)
  savePick(session!.accountId, r, { side, salt, amount: amount.toString(), drandRound })
  busy = 'Sending the sealed bet…'
  render()
  await callContract(session!, 'commit', { round: String(r), amount: amount.toString(), hash, sealed })
  notice = `Sealed${who === 'you' ? '' : ' by the autopilot'}: ${fmt(amount)} BEFEWER on ${side} · ${label(r, side)} in round ${r}.`
  return { round: r, amount }
}

async function act(kind: string, el: HTMLElement) {
  notice = ''
  failure = ''
  try {
    if (kind === 'faucet') {
      await ensurePlayer()
    } else if (kind === 'logout') {
      if (!confirm('Forget this testnet account on this device? You will lose access to it.')) return
      saveSession(null)
      session = null
      me = null
    } else if (kind === 'commit') {
      const side = el.dataset.side as 'A' | 'B'
      const amount = BigInt((document.getElementById('amt') as HTMLInputElement).value) * ONE // read before re-rendering
      await ensurePlayer()
      await placeBet(side, amount)
    } else if (kind.startsWith('ap-')) {
      apAction(kind, el)
    }
  } catch (e: any) {
    failure = String(e.message || e)
    console.error('BEFEWER action failed', kind, e)
  } finally {
    busy = ''
    await refresh(true)
  }
}

// ---------------- Autopilot ----------------
const AP_KEY = 'befewer.ap.rules'
let apRules: Rule[] = (() => {
  try { return JSON.parse(localStorage.getItem(AP_KEY) || 'null') ?? structuredClone(PRESETS[1].rules) } catch { return structuredClone(PRESETS[1].rules) }
})()
let apOn = localStorage.getItem('befewer.ap.on') === '1'
let apStatus = ''
const apDone = new Set<number>() // rounds the autopilot already decided in this tab
const lookup: Lookup = { recent: H.recent, sameQuestion: H.sameQuestion, outcome: H.outcome }
const saveRules = () => localStorage.setItem(AP_KEY, JSON.stringify(apRules))

const sel = (i: number, field: string, value: string, options: [string, string][]) =>
  `<select data-ap="${field}" data-i="${i}">${options.map(([v, t]) => `<option value="${v}"${v === value ? ' selected' : ''}>${t}</option>`).join('')}</select>`

function ruleHTML(r: Rule, i: number): string {
  const c = r.cond
  const kind = sel(i, 'kind', c.kind, [['last', 'the round before'], ['streak', 'the last few rounds'], ['question', 'last time this question was asked'], ['always', 'anything else']])
  const n = c.kind === 'streak' ? sel(i, 'n', String(c.n), [2, 3, 4, 5, 6].map(x => [String(x), `${x} rounds`])) : ''
  const winner = c.kind === 'always' ? '' : sel(i, 'winner', c.winner, [['A', c.kind === 'streak' ? 'were all won by A' : 'was won by A'], ['B', c.kind === 'streak' ? 'were all won by B' : 'was won by B'], ['any', c.kind === 'streak' ? 'were all won by one side' : 'had a winner']])
  const picks: [string, string][] = c.kind === 'always'
    ? [['A', 'A'], ['B', 'B'], ['random', 'a random side'], ['skip', 'nothing (skip)']]
    : [['same', 'that same side'], ['other', 'the other side'], ['A', 'A'], ['B', 'B'], ['random', 'a random side'], ['skip', 'nothing (skip)']]
  const pick = sel(i, 'pick', picks.some(([v]) => v === r.pick) ? r.pick : picks[0][0], picks)
  const pct = r.pick === 'skip' ? '' : `with ${sel(i, 'pct', String(r.pct), [1, 2, 5, 10, 15, 20, 25].map(x => [String(x), `${x}%`]))} of my balance`
  return `<div class="rule"><span class="n">${i + 1}</span><div class="sentence">${c.kind === 'always' ? 'For' : 'If'} ${kind} ${n} ${winner} → bet ${pick} ${pct}</div>
    <div class="ops"><button class="mini" data-act="ap-up" data-i="${i}" title="move up" ${i === 0 ? 'disabled' : ''}>↑</button><button class="mini" data-act="ap-down" data-i="${i}" title="move down" ${i === apRules.length - 1 ? 'disabled' : ''}>↓</button><button class="mini" data-act="ap-del" data-i="${i}" title="remove">✕</button></div></div>`
}

function apRender() {
  if (!document.getElementById('ap-rules')) return
  setHTML('ap-rules', `${apRules.map(ruleHTML).join('')}<button class="mini add" data-act="ap-add">+ add a rule</button>
    <p class="fine">If no rule fits, the autopilot skips the round.</p>`)
  const cur = Number(status.commit_round)
  const from = Math.max(0, cur - 60)
  const bt = backtest(apRules, from, cur - 1, lookup, 1000)
  setHTML('ap-bt', bt.rounds
    ? `<div class="bt">Over the last <b>${bt.rounds}</b> finished rounds these rules would have bet <b>${bt.bets}</b> times:
       won <b class="good">${bt.wins}</b>, lost <b class="burn">${bt.losses}</b>${bt.voids ? `, ${bt.voids} void` : ''} → 1,000 becomes <b class="${bt.end >= 1000 ? 'good' : 'burn'}">${bt.end.toLocaleString('en-US')}</b>.
       <span class="fine">Assumes your bet would not have changed which side was smaller.</span></div>`
    : `<div class="bt fine">No finished rounds to test on yet.</div>`)
  const box = document.getElementById('ap-on') as HTMLInputElement
  if (box && box.checked !== apOn) box.checked = apOn
  setHTML('ap-status', apOn ? `<p class="fine ap-st">${esc(apStatus || 'Waiting for the right moment in this round (after the previous round finishes)…')}</p>` : '')
}

function apAction(kind: string, el: HTMLElement) {
  const i = Number(el.dataset.i)
  if (kind === 'ap-preset') apRules = structuredClone(PRESETS[i].rules)
  else if (kind === 'ap-add') apRules.splice(Math.max(0, apRules.length - (apRules.at(-1)?.cond.kind === 'always' ? 1 : 0)), 0, { cond: { kind: 'last', winner: 'any' }, pick: 'other', pct: 5 })
  else if (kind === 'ap-del') apRules.splice(i, 1)
  else if (kind === 'ap-up' && i > 0) [apRules[i - 1], apRules[i]] = [apRules[i], apRules[i - 1]]
  else if (kind === 'ap-down' && i < apRules.length - 1) [apRules[i + 1], apRules[i]] = [apRules[i], apRules[i + 1]]
  saveRules()
  apRender()
}

function apChange(el: HTMLSelectElement) {
  const i = Number(el.dataset.i)
  const r = apRules[i]
  const v = el.value
  switch (el.dataset.ap) {
    case 'kind': {
      const w = 'winner' in r.cond ? r.cond.winner : 'any'
      r.cond = v === 'always' ? { kind: 'always' } : v === 'streak' ? { kind: 'streak', winner: w, n: 3 } : ({ kind: v, winner: w } as Cond)
      if (v === 'always' && (r.pick === 'same' || r.pick === 'other')) r.pick = 'random'
      break
    }
    case 'n': if (r.cond.kind === 'streak') r.cond.n = Number(v); break
    case 'winner': if ('winner' in r.cond) r.cond.winner = v as any; break
    case 'pick': r.pick = v as Pick; break
    case 'pct': r.pct = Number(v); break
  }
  saveRules()
  apRender()
}

/** Each poll: if the autopilot is on and this round is still open, decide once and bet. */
async function autopilotTick() {
  if (!apOn || busy || !status || !params) return
  const r = Number(status.commit_round)
  if (apDone.has(r) || BigInt(status.now) < BigInt(params.genesis_ns)) return
  if (me?.open.some(o => o.round === String(r))) { apDone.add(r); return }
  const left = nsToMs(status.commit_ends_at) - now()
  if (left < 25_000) return // too close to the deadline: wait for the next round
  // "the round before" must mean the same thing as in the backtest: wait until it has finished
  const prev = H.round(r - 1)
  if (prev && !prev.settled) { apStatus = `Round ${r}: waiting for round ${r - 1} to finish before deciding…`; return }
  apDone.add(r)
  const d = decide(apRules, r, guard(lookup, r))
  if ('skip' in d) { apStatus = `Round ${r}: skipped (${d.rule == null ? 'no rule fit' : `rule ${d.rule + 1} says skip`}).`; return }
  try {
    if (!session || !me) await ensurePlayer()
    const want = (BigInt(me!.balance) * BigInt(d.pct)) / 100n
    const placed = await placeBet(d.side, want, 'autopilot')
    apStatus = `Round ${placed.round}: rule ${d.rule + 1} bet ${fmt(placed.amount)} BEFEWER on ${d.side} · ${label(placed.round, d.side)}.`
  } catch (e: any) {
    apStatus = `Round ${r}: the autopilot could not bet: ${String(e.message || e)}`
  } finally {
    busy = ''
    await refresh(true)
  }
}

document.addEventListener('click', e => {
  const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null
  if (!el) return
  e.preventDefault()
  if (el.dataset.act!.startsWith('ap-')) return apAction(el.dataset.act!, el)
  act(el.dataset.act!, el)
})
document.addEventListener('change', e => {
  const t = e.target as HTMLElement
  if (t instanceof HTMLSelectElement && t.dataset.ap) apChange(t)
  if (t instanceof HTMLInputElement && t.id === 'ap-on') {
    apOn = t.checked
    localStorage.setItem('befewer.ap.on', apOn ? '1' : '0')
    apStatus = ''
    apRender()
    autopilotTick()
  }
})
document.addEventListener('input', e => {
  const t = e.target as HTMLInputElement
  if (t.id === 'amt') {
    stakeChoice = Number(t.value)
    $('#amtv').textContent = t.value
  }
})
setInterval(tick, 1000)
setInterval(async () => { if (!busy) { await refresh(); await autopilotTick() } }, 6000)
setInterval(() => loadNpcs(), 30000)
// handy for anyone poking at the game from the console (and for our browser tests)
;(window as any).befewer = { history: H, render: () => render() }
await refresh(true)
loadNpcs()
