import './style.css'
import {
  CONTRACT, EXPLORER, ONE, view, fmt, nsToMs, randomSalt, commitHash, seal, loadSession, saveSession,
  newKeyPair, loadPicks, savePick, callContract, type Status, type Params, type RoundV, type PlayerV, type Session,
} from './chain'

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
  const head = session && me
    ? `<div class="who">${esc(short(session.accountId))} · <b>${fmt(me.balance)}</b> FEWER
       · streak ${me.streak} (best ${me.best_streak}) · <a href="#" data-act="logout">forget this device</a></div>`
    : ''
  const mine = me?.open.find(o => o.round === String(r))
  if (session && mine) {
    const pick = loadPicks(session.accountId)[r]
    return `<div class="move">${head}<p class="locked">You're in round ${r}: <b>${fmt(mine.amount)}</b> FEWER on
      <b class="side-${pick?.side ?? 'x'}">${pick?.side ?? '?'}</b>, sealed until drand #${pick?.drandRound ?? '?'}.
      Nobody, including us, can see your side until the reveal opens. It reveals itself; the result shows up here.</p></div>`
  }
  // newcomers bet straight away: their first tap creates a testnet account and claims the faucet
  const newcomer = !session || !me || (!me.faucet_claimed && BigInt(me.balance) === 0n)
  const bal = newcomer ? BigInt(params.faucet_amount) : BigInt(me!.balance)
  const cap = (bal * BigInt(params.max_stake_bps)) / 10000n
  if (cap < BigInt(params.min_stake)) return `<div class="move">${head}<p>Your balance is too small to play (max stake is 25% of your balance).</p></div>`
  const maxW = Number(cap / ONE)
  const def = Math.max(1, Math.round(maxW / 2)) // the player's own choice is applied after painting (applyStake)
  return `<div class="move">${head}
    <label class="stake">Stake <input id="amt" type="range" min="1" max="${maxW}" value="${def}"><b id="amtv">${def}</b> FEWER <span class="fine">(max 25% of balance)</span></label>
    <div class="pick"><button class="side-A" data-act="commit" data-side="A" ${busy ? 'disabled' : ''}>A</button>
    <button class="side-B" data-act="commit" data-side="B" ${busy ? 'disabled' : ''}>B</button></div>
    <p class="fine">Pick the side you think <b>fewer coins</b> will pick. Win: 2× back. Lose: your stake. The gap between the sides burns.</p>
    ${newcomer ? `<p class="fine">Your first tap creates a free testnet account in this browser and gives you ${fmt(params.faucet_amount)} FEWER. No wallet, no seed phrase, no popups.</p>` : ''}
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

/** Make sure this browser has a testnet account with FEWER in it. */
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
    busy = `Claiming ${fmt(params.faucet_amount)} FEWER…`
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
    <h1>$FEWER</h1>
    <p class="tag">Pick the side fewer coins pick.</p>
    <p class="sub">A memecoin whose daily ritual is a sealed-bid minority game on NEAR. The minority doubles, the imbalance burns.</p>
    <p class="testnet">Testnet demo built for NEAR HACKATHON. Testnet FEWER is free and has no monetary value; there is no token sale.</p>
  </header>
  <section class="live">
    <div class="card now"><div id="s-round"></div><div id="s-last"></div><div id="s-move"></div><div id="s-notice"></div></div>
    <div class="card reveal" id="s-reveal"></div>
  </section>
  <section class="stats" id="s-stats"></section>
  <div id="s-mine"></div>
  <div id="s-results"></div>
  <section><h2>Recent rounds</h2><div id="s-rounds"></div>
    <p class="fine">Rounds nobody played are skipped. The burn is |A − B| plus any bet that was never opened.</p></section>
  <section><h2>NPC players</h2><p class="fine">Four bots with their own testnet wallets keep every round alive. They play by the same rules as you.</p>
    <div class="npcs" id="npcs"></div></section>
  <section class="rules"><h2>Rules (enforced by the contract, no admin)</h2>
    <ol>
      <li>Every round you can bet up to 25% of your balance on A or B. Your side is sealed: the contract stores only a hash.</li>
      <li>Your browser also locks your side with a <a href="https://drand.love" target="_blank" rel="noopener">drand</a> timelock that opens when the reveal window opens. Then anyone can open it and reveal it for you, so you never have to come back.</li>
      <li>After the reveal window, the side with <b>less</b> revealed FEWER wins. Winners get exactly 2× their stake. Losers lose their stake.</li>
      <li>The gap between the sides is burned, along with every bet that was never revealed. A tie or a one-sided round refunds everyone.</li>
      <li>Supply only goes down: everything was minted once at launch, there is no mint function and no owner.</li>
    </ol>
    <p class="fine">Contract <a href="${EXPLORER}/address/${CONTRACT}" target="_blank" rel="noopener">${CONTRACT}</a> · this demo runs a round every ${Number(BigInt(params.commit_ns) / 60_000_000_000n)} minutes; the mechanic is designed for one round a day.</p>
  </section>`
    skeleton = true
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
      <div class="big">${fmt(cr?.committed ?? '0')} <span>FEWER in</span></div>
      <div class="k">${cr?.commits ?? 0} sealed bet${cr?.commits === 1 ? '' : 's'} · sides hidden until the reveal opens</div>`)
  setHTML('s-move', renderMove(cr))
  applyStake()
  setHTML('s-notice', `${failure ? `<p class="failure">Your bet did not go through: ${esc(failure)}</p>` : ''}${notice ? `<p class="notice">${esc(notice)}</p>` : ''}${busy ? `<p class="notice busy">${esc(busy)}</p>` : ''}`)
  setHTML('s-reveal', rr
    ? `<div class="k">Round ${rr.round} · revealing · result in ${timer(status.reveal_ends_at)}</div>
        <div class="vs"><span class="side-A">A ${fmt(rr.revealed_a)}</span><span class="side-B">B ${fmt(rr.revealed_b)}</span></div>
        ${bar(BigInt(rr.revealed_a), BigInt(rr.revealed_b))}
        <div class="k">${rr.reveals_a + rr.reveals_b} of ${rr.commits} bets opened · drand published the key, the keeper is opening them</div>`
    : `<div class="k">No round is revealing right now.</div>`)
  setHTML('s-stats', `
    <div><div class="k">Handed out by the faucet</div><div class="v">${fmt(handedOut)}</div><div class="k">${fmt(status.faucet_reserve)} still in the launch reserve</div></div>
    <div><div class="k">Burned so far</div><div class="v burn">${fmt(burned)}</div><div class="k">${burnPct}% of everything handed out · ${status.rounds_settled} rounds</div></div>
    <div><div class="k">In players' hands</div><div class="v">${fmt(circulating)}</div><div class="k">${fmt(status.escrow)} locked in bets</div></div>
    <div><div class="k">Longest minority streak</div><div class="v">${status.best_streak}</div><div class="k">${status.best_streak_holder ? esc(short(status.best_streak_holder)) : '—'}</div></div>`)
  const last = results[0]
  setHTML('s-last', last ? `<p class="last">Round ${last.round}: <b class="side-${last.outcome}">${last.outcome === 'void' ? 'void' : last.outcome}</b>${last.outcome === 'void' ? '' : ' was the smaller side'}. You bet <b class="side-${last.side}">${last.side}</b> → ${resultText(last)}.</p>` : '')
  setHTML('s-results', results.length ? `<section><h2>Your results</h2><table><tr><th>Round</th><th>Your side</th><th>Stake</th><th>Smaller side</th><th>Result</th></tr>
    ${results.map(x => `<tr><td>${x.round}</td><td class="side-${x.side}">${x.side}</td><td>${fmt(x.amount)}</td><td>${x.outcome}</td><td>${resultText(x)}</td></tr>`).join('')}</table></section>` : '')
  setHTML('s-mine', session && me && me.open.length ? `<section><h2>Your bets</h2><table><tr><th>Round</th><th>Stake</th><th>Your side</th><th>Status</th></tr>
    ${me.open.map(o => { const p = loadPicks(session!.accountId)[o.round]; const rv = roundById(o.round)
      const st = rv?.settled ? `settled: ${rv.outcome}` : o.side ? 'opened' : 'sealed'
      return `<tr><td>${o.round}</td><td>${fmt(o.amount)}</td><td class="side-${p?.side ?? 'x'}">${p?.side ?? '?'}</td><td>${st}</td></tr>` }).join('')}
    </table><p class="fine">W ${me.wins} · L ${me.losses} · void ${me.voids} · forfeited ${me.forfeits}</p></section>` : '')
  setHTML('s-rounds', `<table class="rounds"><tr><th>Round</th><th>Bets</th><th>A</th><th>B</th><th>Smaller side</th><th>Burned</th></tr>
    ${rounds.filter(r => r.round !== status.commit_round).map(r => `<tr>
      <td>${r.round}</td><td>${r.commits}</td>
      <td class="${r.outcome === 'A' ? 'win' : ''}">${r.reveals_a ? fmt(r.revealed_a) : '—'}</td>
      <td class="${r.outcome === 'B' ? 'win' : ''}">${r.reveals_b ? fmt(r.revealed_b) : '—'}</td>
      <td>${r.settled ? (r.outcome === 'void' ? 'void (refund)' : `<b class="side-${r.outcome}">${r.outcome}</b> doubles`) : (r.round === status.reveal_round ? 'revealing' : 'waiting for keeper')}</td>
      <td class="burn">${r.settled ? fmt(r.burned) : ''}</td></tr>`).join('')}
    </table>`)
  renderNpcs()
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
      <div>${p ? `${fmt(p.balance)} FEWER · W ${p.wins} L ${p.losses} · streak ${p.streak}` : '…'}</div></div>`
  }).join(''))
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
      let amount = BigInt((document.getElementById('amt') as HTMLInputElement).value) * ONE // read before re-rendering
      await ensurePlayer()
      const cap = (BigInt(me!.balance) * BigInt(params.max_stake_bps)) / 10000n
      if (amount > cap) amount = cap
      status = await view<Status>('get_status')
      const r = Number(status.commit_round)
      const revealStart = nsToMs(status.commit_ends_at)
      if (revealStart - now() < 8000) throw new Error('This round is closing; wait a few seconds for the next one.')
      busy = 'Sealing your side with drand…'
      render()
      const salt = randomSalt()
      const hash = await commitHash(session!.accountId, r, side, salt)
      const { sealed, drandRound } = await seal(side, salt, revealStart)
      savePick(session!.accountId, r, { side, salt, amount: amount.toString(), drandRound })
      busy = 'Sending your sealed bet…'
      render()
      await callContract(session!, 'commit', { round: String(r), amount: amount.toString(), hash, sealed })
      notice = `Sealed: ${fmt(amount)} FEWER on ${side} in round ${r}.`
    }
  } catch (e: any) {
    failure = String(e.message || e)
    console.error('FEWER action failed', kind, e)
  } finally {
    busy = ''
    await refresh(true)
  }
}

document.addEventListener('click', e => {
  const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null
  if (!el) return
  e.preventDefault()
  act(el.dataset.act!, el)
})
document.addEventListener('input', e => {
  const t = e.target as HTMLInputElement
  if (t.id === 'amt') {
    stakeChoice = Number(t.value)
    $('#amtv').textContent = t.value
  }
})
setInterval(tick, 1000)
setInterval(() => !busy && refresh(), 6000)
setInterval(() => loadNpcs(), 30000)
await refresh(true)
loadNpcs()
