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
let notice = ''

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
    if (session) me = await view<PlayerV>('get_player', { account_id: session.accountId })
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

function renderMove(cr: RoundV | undefined): string {
  const r = Number(status.commit_round)
  if (!session) {
    return `<div class="move">
      <p class="lead">Play on NEAR testnet. No wallet, no seed phrase, no popups.</p>
      <button class="primary" data-act="guest">Play now as a guest</button>
      <p class="fine">Creates a throwaway testnet account in your browser. The key never leaves this device.</p>
    </div>`
  }
  if (!me) return `<div class="move"><p>Loading your account…</p></div>`
  const bal = BigInt(me.balance)
  const head = `<div class="who">${esc(short(session.accountId))} · <b>${fmt(bal)}</b> FEWER
     · streak ${me.streak} (best ${me.best_streak}) · <a href="#" data-act="logout">forget this device</a></div>`
  if (!me.faucet_claimed && bal === 0n) {
    return `<div class="move">${head}<button class="primary" data-act="faucet">Claim ${fmt(params.faucet_amount)} FEWER</button></div>`
  }
  const mine = me.open.find(o => o.round === String(r))
  if (mine) {
    const pick = loadPicks(session.accountId)[r]
    return `<div class="move">${head}<p class="locked">You're in round ${r}: <b>${fmt(mine.amount)}</b> FEWER on
      <b class="side-${pick?.side ?? 'x'}">${pick?.side ?? '?'}</b>, sealed until drand #${pick?.drandRound ?? '?'}.
      Nobody, including us, can see your side until the reveal opens. It reveals itself.</p></div>`
  }
  const cap = (bal * BigInt(params.max_stake_bps)) / 10000n
  if (cap < BigInt(params.min_stake)) return `<div class="move">${head}<p>Your balance is too small to play (max stake is 25% of your balance).</p></div>`
  const maxW = Number(cap / ONE)
  const def = Math.max(1, Math.round(maxW / 2))
  return `<div class="move">${head}
    <label class="stake">Stake <input id="amt" type="range" min="1" max="${maxW}" value="${def}"><b id="amtv">${def}</b> FEWER <span class="fine">(max 25% of balance)</span></label>
    <div class="pick"><button class="side-A" data-act="commit" data-side="A" ${busy ? 'disabled' : ''}>A</button>
    <button class="side-B" data-act="commit" data-side="B" ${busy ? 'disabled' : ''}>B</button></div>
    <p class="fine">Pick the side you think <b>fewer coins</b> will pick. Win: 2× back. Lose: your stake. The gap between the sides burns.</p>
  </div>`
}

function render() {
  const cr = roundById(status.commit_round)
  const rr = roundById(status.reveal_round)
  const burned = BigInt(status.total_burned)
  const supply = BigInt(status.total_supply)
  const initial = BigInt(status.initial_supply)
  const handedOut = initial - BigInt(status.faucet_reserve) // everything that ever left the launch reserve
  const circulating = supply - BigInt(status.faucet_reserve) - BigInt(status.escrow)
  const burnPct = handedOut > 0n ? Number((burned * 100000n) / handedOut) / 1000 : 0
  $('#app').innerHTML = `
  <header>
    <h1>$FEWER</h1>
    <p class="tag">Pick the side fewer coins pick.</p>
    <p class="sub">A memecoin whose daily ritual is a sealed-bid minority game on NEAR. The minority doubles, the imbalance burns.</p>
  </header>

  <section class="live">
    <div class="card now">
      <div class="k">Round ${status.commit_round} · bets close in <b class="t" data-t="${status.commit_ends_at}">${left(status.commit_ends_at)}</b></div>
      <div class="big">${fmt(cr?.committed ?? '0')} <span>FEWER in</span></div>
      <div class="k">${cr?.commits ?? 0} sealed bet${cr?.commits === 1 ? '' : 's'} · sides hidden until the reveal opens</div>
      ${renderMove(cr)}
      ${notice ? `<p class="notice">${esc(notice)}</p>` : ''}
      ${busy ? `<p class="notice">${esc(busy)}</p>` : ''}
    </div>
    <div class="card reveal">
      ${rr ? `<div class="k">Round ${rr.round} · revealing · result in <b class="t" data-t="${status.reveal_ends_at}">${left(status.reveal_ends_at!)}</b></div>
        <div class="vs"><span class="side-A">A ${fmt(rr.revealed_a)}</span><span class="side-B">B ${fmt(rr.revealed_b)}</span></div>
        ${bar(BigInt(rr.revealed_a), BigInt(rr.revealed_b))}
        <div class="k">${rr.reveals_a + rr.reveals_b} of ${rr.commits} bets opened · drand published the key, the keeper is opening them</div>`
        : `<div class="k">No round is revealing right now.</div>`}
    </div>
  </section>

  <section class="stats">
    <div><div class="k">Handed out by the faucet</div><div class="v">${fmt(handedOut)}</div><div class="k">${fmt(status.faucet_reserve)} still in the launch reserve</div></div>
    <div><div class="k">Burned so far</div><div class="v burn">${fmt(burned)}</div><div class="k">${burnPct}% of everything handed out · ${status.rounds_settled} rounds</div></div>
    <div><div class="k">In players' hands</div><div class="v">${fmt(circulating)}</div><div class="k">${fmt(status.escrow)} locked in bets</div></div>
    <div><div class="k">Longest minority streak</div><div class="v">${status.best_streak}</div><div class="k">${status.best_streak_holder ? esc(short(status.best_streak_holder)) : '—'}</div></div>
  </section>

  ${session && me && me.open.length ? `<section><h2>Your bets</h2><table><tr><th>Round</th><th>Stake</th><th>Your side</th><th>Status</th></tr>
    ${me.open.map(o => { const p = loadPicks(session!.accountId)[o.round]; const rv = roundById(o.round)
      const st = rv?.settled ? `settled: ${rv.outcome}` : o.side ? 'opened' : 'sealed'
      return `<tr><td>${o.round}</td><td>${fmt(o.amount)}</td><td class="side-${p?.side ?? 'x'}">${p?.side ?? '?'}</td><td>${st}</td></tr>` }).join('')}
    </table><p class="fine">W ${me.wins} · L ${me.losses} · void ${me.voids} · forfeited ${me.forfeits}</p></section>` : ''}

  <section><h2>Recent rounds</h2>
    <table class="rounds"><tr><th>Round</th><th>Bets</th><th>A</th><th>B</th><th>Smaller side</th><th>Burned</th></tr>
    ${rounds.filter(r => r.round !== status.commit_round).map(r => `<tr>
      <td>${r.round}</td><td>${r.commits}</td>
      <td class="${r.outcome === 'A' ? 'win' : ''}">${r.reveals_a ? fmt(r.revealed_a) : '—'}</td>
      <td class="${r.outcome === 'B' ? 'win' : ''}">${r.reveals_b ? fmt(r.revealed_b) : '—'}</td>
      <td>${r.settled ? (r.outcome === 'void' ? 'void (refund)' : `<b class="side-${r.outcome}">${r.outcome}</b> doubles`) : (r.round === status.reveal_round ? 'revealing' : 'waiting for keeper')}</td>
      <td class="burn">${r.settled ? fmt(r.burned) : ''}</td></tr>`).join('')}
    </table>
    <p class="fine">Rounds nobody played are skipped. The burn is |A − B| plus any bet that was never opened.</p>
  </section>

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
    <p class="fine">Contract <a href="${EXPLORER}/address/${CONTRACT}" target="_blank" rel="noopener">${CONTRACT}</a> · rounds every ${Number(BigInt(params.commit_ns) / 60_000_000_000n)} min on testnet (daily on mainnet).</p>
  </section>`
  renderNpcs()
}

let npcCache: Record<string, PlayerV> = {}
async function loadNpcs() {
  for (const [id] of NPCS) npcCache[id] = await view<PlayerV>('get_player', { account_id: id })
  renderNpcs()
}
function renderNpcs() {
  const el = document.getElementById('npcs')
  if (!el) return
  el.innerHTML = NPCS.map(([id, name, about]) => {
    const p = npcCache[id]
    return `<div class="npc"><b>${name}</b> <span class="fine">${about}</span>
      <div>${p ? `${fmt(p.balance)} FEWER · W ${p.wins} L ${p.losses} · streak ${p.streak}` : '…'}</div></div>`
  }).join('')
}

async function act(kind: string, el: HTMLElement) {
  notice = ''
  try {
    if (kind === 'guest') {
      busy = 'Creating your testnet account…'
      render()
      const kp = newKeyPair()
      const res = await fetch('/api/guest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: kp.publicKey }) })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || 'guest account service unavailable')
      session = { accountId: j.accountId, privateKey: kp.privateKey, kind: 'guest' }
      saveSession(session)
      busy = `Claiming ${fmt(params.faucet_amount)} FEWER…`
      render()
      await callContract(session, 'faucet', {})
    } else if (kind === 'faucet') {
      busy = 'Claiming…'
      render()
      await callContract(session!, 'faucet', {})
    } else if (kind === 'logout') {
      if (!confirm('Forget this testnet account on this device? You will lose access to it.')) return
      saveSession(null)
      session = null
      me = null
    } else if (kind === 'commit') {
      const side = el.dataset.side as 'A' | 'B'
      const amount = BigInt((document.getElementById('amt') as HTMLInputElement).value) * ONE
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
    notice = String(e.message || e)
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
  if (t.id === 'amt') $('#amtv').textContent = t.value
})
setInterval(() => document.querySelectorAll<HTMLElement>('.t[data-t]').forEach(el => (el.textContent = left(el.dataset.t!))), 1000)
setInterval(() => !busy && refresh(), 6000)
setInterval(() => loadNpcs(), 30000)
await refresh(true)
loadNpcs()
