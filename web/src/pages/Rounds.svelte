<script lang="ts">
  import { slide } from 'svelte/transition'
  import * as H from '../history'
  import { questionFor, label } from '../questions'
  import Icon from '../lib/Icon.svelte'
  import Orbs from '../lib/Orbs.svelte'
  import { game, fmt, fmtN, commitRound, picks, slotName, short } from '../game.svelte'
  import { view, type RoundV, type MinerV } from '../chain'

  let filter = $state<'all' | 'mine' | 'mined'>('all')
  let open = $state<number | null>(null)
  let show = $state(30)

  const all = $derived.by(() => {
    game.history
    const cur = commitRound()
    const out: RoundV[] = []
    for (let t = cur; t >= 0 && out.length < 400; t--) {
      const x = H.round(t)
      if (x && x.commits > 0) out.push(x)
    }
    return out
  })
  // my bets by round, from every slot (picks: "round" for slot 0, "slot:round" for others)
  const mine = $derived.by(() => {
    game.results; game.resultsBySlot; game.me
    const by: Record<string, { slot: number; side: 'A' | 'B'; amount: string }[]> = {}
    for (const [k, v] of Object.entries(picks())) {
      const [slot, round] = k.includes(':') ? k.split(':') : ['0', k]
      ;(by[round] ??= []).push({ slot: Number(slot), side: v.side, amount: v.amount })
    }
    for (const l of Object.values(by)) l.sort((a, b) => a.slot - b.slot)
    return by
  })
  const mined = (x: RoundV) => BigInt(x.reward) > 0n
  const list = $derived(filter === 'mine' ? all.filter(x => mine[x.round]) : filter === 'mined' ? all.filter(mined) : all)
  const settled = $derived(all.filter(x => x.settled))
  // All-time totals: the server counts every settled round up to `through` (this browser only holds
  // the latest few hundred), and the rounds settled since then are added here as they come in.
  type Totals = { through: number; rounds: number; A: number; B: number; void: number; treasury: string; mined: string; minedRounds: number; last: number | null }
  let base = $state<Totals | null>(null)
  const loadTotals = () => fetch('api/totals').then(r => (r.ok ? r.json() : Promise.reject())).then(t => (base = t)).catch(() => {})
  $effect(() => { loadTotals(); const t = setInterval(loadTotals, 60_000); return () => clearInterval(t) })
  const sum = $derived.by(() => {
    // the server's count must reach the oldest round held here, or rounds in between would be missed
    const b = base && settled.length && base.through >= Number(settled[settled.length - 1].round) - 1 ? base : null
    const s = { allTime: !!b, rounds: b?.rounds ?? 0, A: b?.A ?? 0, B: b?.B ?? 0, void: b?.void ?? 0, treasury: BigInt(b?.treasury ?? 0), mined: BigInt(b?.mined ?? 0), minedRounds: b?.minedRounds ?? 0, last: b?.last ?? null }
    for (const x of settled) {
      if (b && Number(x.round) <= b.through) continue
      s.rounds++
      if (x.outcome === 'A' || x.outcome === 'B' || x.outcome === 'void') s[x.outcome]++
      s.treasury += BigInt(x.to_treasury)
      if (mined(x)) { s.mined += BigInt(x.reward); s.minedRounds++; s.last = Math.max(s.last ?? 0, Number(x.round)) }
    }
    return s
  })
  const share = (n: number) => (sum.rounds ? `${Math.round((n / sum.rounds) * 100)}%` : '0%')
  // who mined a round: loaded when its row opens
  const minersCache = new Map<number, Promise<MinerV[]>>()
  const minersOf = (n: number) => {
    if (!minersCache.has(n)) minersCache.set(n, view<MinerV[]>('get_round_miners', { round: String(n) }).catch(e => { minersCache.delete(n); throw e }))
    return minersCache.get(n)!
  }
  const people = (n: number) => `${n} ${n === 1 ? 'player' : 'players'}`
  const need = () => game.params?.streak_min ?? 3
  const SHARE_UNIT = 10n ** 21n // 0.001 NEAR: one share per streak step
  const pctOf = (a: bigint, t: bigint) => (t > 0n ? `${((Number(a) / Number(t)) * 100).toFixed(1)}%` : '—')
  const pct = (x: RoundV) => {
    const a = Number(BigInt(x.revealed_a) / 10n ** 18n), b = Number(BigInt(x.revealed_b) / 10n ** 18n)
    return a + b > 0 ? Math.round((a / (a + b)) * 100) : null
  }
  const phase = (x: RoundV) => (x.settled ? 'settled' : Number(x.round) === commitRound() ? 'betting' : 'opening')
</script>

<header class="ph">
  <div>
    <h1>Rounds</h1>
    <p class="muted">Bets on the smaller side won +100%; fees and the gap between the sides went to the treasury. A round is void when nobody bet against it or it tied: bets come back.</p>
  </div>
</header>

<p class="scope faint">{sum.allTime ? 'All time, since round #0' : `The latest ${sum.rounds} rounds only: the all-time count is not available right now`}</p>
<section class="summary">
  <div class="card tile stile"><div class="eyebrow">Settled</div><div class="big num">{sum.rounds.toLocaleString('en-US')}</div><div class="faint">rounds with bets</div></div>
  <div class="card tile"><div class="eyebrow">A smaller</div><div class="big num"><span class="dot A"></span>{sum.A.toLocaleString('en-US')}</div><div class="faint">{share(sum.A)} of rounds</div></div>
  <div class="card tile"><div class="eyebrow">B smaller</div><div class="big num"><span class="dot B"></span>{sum.B.toLocaleString('en-US')}</div><div class="faint">{share(sum.B)} of rounds</div></div>
  <div class="card tile"><div class="eyebrow">Void</div><div class="big num">{sum.void.toLocaleString('en-US')}</div><div class="faint">{share(sum.void)} of rounds · bets refunded</div></div>
  <div class="card tile"><div class="eyebrow">To the treasury</div><div class="big num gold">{fmtN(sum.treasury, 2)}</div><div class="faint">NEAR from fees and gaps</div></div>
  <button class="card tile mtile" onclick={() => (filter = 'mined')} aria-label="Show the rounds that mined BEFEWER">
    <div class="eyebrow">BEFEWER mined</div><div class="big num"><Icon name="spark" size={20} />{fmt(sum.mined)}</div>
    <div class="faint">1 per round · {sum.minedRounds ? `paid out in ${sum.minedRounds} round${sum.minedRounds === 1 ? '' : 's'} · last #${sum.last}` : 'nobody has won 3 in a row yet'}</div>
  </button>
</section>

<div class="seg" role="tablist" aria-label="Filter rounds">
  <button role="tab" aria-selected={filter === 'all'} class:on={filter === 'all'} onclick={() => (filter = 'all')}>All rounds</button>
  <button role="tab" aria-selected={filter === 'mine'} class:on={filter === 'mine'} onclick={() => (filter = 'mine')}>With my bets</button>
  <button role="tab" aria-selected={filter === 'mined'} class:on={filter === 'mined'} onclick={() => (filter = 'mined')}>Mined</button>
</div>

{#if !list.length}
  <div class="card empty">
    <Icon name="rounds" size={28} />
    <p>{filter === 'mine' ? 'You have not bet in any round yet.' : filter === 'mined' ? 'No round has mined BEFEWER yet: a bet mines when it wins 3 rounds in a row.' : 'No rounds with bets yet.'}</p>
    {#if filter === 'mine'}<a class="btn primary" href="#/">Play this round</a>{/if}
  </div>
{:else}
  <ul class="list">
    {#each list.slice(0, show) as x (x.round)}
      {@const n = Number(x.round)}
      {@const p = pct(x)}
      {@const st = phase(x)}
      {@const my = mine[x.round]}
      <li class="card row" class:open={open === n}>
        <button class="sum" onclick={() => (open = open === n ? null : n)} aria-expanded={open === n}>
          <span class="no num">#{n}</span>
          <span class="main">
            <span class="q">{questionFor(n).q}</span>
            {#if p !== null}
              <span class="split" aria-label="{label(n, 'A')} {p}%, {label(n, 'B')} {100 - p}%">
                <span class="sa" style="width:{p}%"></span><span class="sb" style="width:{100 - p}%"></span>
              </span>
              <span class="lbl"><span class="side-A">{label(n, 'A')} {p}%</span><span class="side-B">{label(n, 'B')} {100 - p}%</span></span>
            {:else}
              <span class="sealed-lbl faint"><Icon name="lock" size={13} /> {x.commits} sealed · {st === 'betting' ? 'taking bets' : 'opening'}</span>
            {/if}
          </span>
          <span class="res">
            {#if st !== 'settled'}<span class="pill">{st === 'betting' ? 'Live' : 'Opening'}</span>
            {:else if x.outcome === 'void'}<span class="pill">Void</span>
            {:else}<span class="win side-{x.outcome}">{label(n, x.outcome!)} won</span><span class="gold small num"><Icon name="flame" size={13} /> {fmtN(x.to_treasury, 3)}</span>{/if}
            {#if mined(x)}<span class="mchip num"><Icon name="spark" size={12} /> {fmt(x.reward)} BEFEWER{x.miners ? ` · ${people(x.mining_players ?? 0)}` : ''}</span>{/if}
            {#if my}<span class="mine-tag">you: {my.length > 1 ? my.map(b => b.side).join(' + ') : label(n, my[0].side)}</span>{/if}
          </span>
        </button>
        {#if open === n}
          <div class="detail" transition:slide={{ duration: 200 }}>
            {#if p !== null}<Orbs round={x} compact />{/if}
            <dl>
              <div><dt>Bets</dt><dd class="num">{x.commits} ({x.reveals_a} on A, {x.reveals_b} on B{x.commits - x.reveals_a - x.reveals_b > 0 && x.settled ? `, ${x.commits - x.reveals_a - x.reveals_b} never opened` : ''})</dd></div>
              <div><dt>Staked</dt><dd class="num">{fmtN(x.committed)} NEAR <span class="faint">+ {fmtN(x.fees)} fees</span></dd></div>
              {#if x.settled}<div><dt>To the treasury</dt><dd class="num gold">{fmtN(x.to_treasury)} NEAR</dd></div>
                <div><dt>Mined</dt><dd class="num">{#if !mined(x)}none (pot rolls over: +{fmt(x.emission)})
                  {:else if x.miners}{fmt(x.reward)} BEFEWER, split by shares among {x.miners} streak bet{x.miners === 1 ? '' : 's'} ({people(x.mining_players ?? 0)})
                  {:else}{fmt(x.reward)} BEFEWER to streak winners <span class="faint">(who shared it is not known: the contract started keeping that list on Nov 7, after this round)</span>{/if}</dd></div>{/if}
              {#if my}<div><dt>Your bet{my.length > 1 ? 's' : ''}</dt><dd class="num">{#each my as b, k}{k ? ' · ' : ''}{my.length > 1 ? `${slotName(b.slot)}: ` : ''}{fmtN(b.amount)} NEAR on {label(n, b.side)}{/each}</dd></div>{/if}
            </dl>
            {#if x.settled && mined(x) && x.miners}
              <div class="miners">
                <div class="eyebrow">Who mined · split by shares</div>
                <p class="faint how">A bet's shares = its stake in 0.001 NEAR × (wins in a row − {need() - 1}). Each bet gets the round's BEFEWER × its shares ÷ all shares, so a bigger stake or a longer streak gets more.</p>
                {#await minersOf(n)}<div class="faint">Loading…</div>
                {:then ms}
                  {@const total = BigInt(x.reward_shares)}
                  {@const paid = ms.reduce((t, m) => t + BigInt(m.mined), 0n)}
                  <table class="mtab">
                    <thead><tr><th>Bet</th><th class="r">Shares (count)</th><th class="r">% of pot</th><th class="r">BEFEWER</th></tr></thead>
                    <tbody>
                      {#each ms as m}
                        {@const mult = m.streak - need() + 1}
                        <tr class:me={m.account_id === game.session?.accountId}>
                          <td><span class="who">{m.account_id === game.session?.accountId ? 'You' : short(m.account_id)}{m.slot ? ` · slot ${m.slot}` : ''}</span>
                            <span class="faint sub">{fmtN((BigInt(m.shares) / BigInt(mult)) * SHARE_UNIT)} NEAR · {m.streak} in a row (×{mult})</span></td>
                          <td class="r num">{m.shares}</td>
                          <td class="r num">{pctOf(BigInt(m.shares), total)}</td>
                          <td class="r num">{fmt(m.mined)}</td>
                        </tr>
                      {/each}
                    </tbody>
                    {#if ms.length === x.miners && ms.length > 1}
                      <tfoot><tr><td>All</td><td class="r num">{total} shares</td><td class="r num">100%</td><td class="r num">{fmt(paid)}</td></tr></tfoot>
                    {/if}
                  </table>
                  {#if (x.miners ?? 0) > ms.length}<div class="faint">and {(x.miners ?? 0) - ms.length} more bets</div>
                  {:else if paid < BigInt(x.reward) && fmt(BigInt(x.reward) - paid) !== '0'}<div class="faint small-note">The {fmt(BigInt(x.reward) - paid)} left over from rounding down goes back to the pot.</div>{/if}
                {:catch}<div class="faint">Could not load the list. Open the round again to retry.</div>
                {/await}
              </div>
            {/if}
            {#if H.sameQuestion(n, 4).length}
              <div class="same">
                <div class="eyebrow">Same question, earlier</div>
                {#each H.sameQuestion(n, 4) as t}
                  {@const o = H.outcome(t)}
                  <div class="sq"><span class="num faint">#{t}</span> {o === 'void' ? 'void' : `${label(t, o!)} was smaller`}</div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
  {#if list.length > show}<button class="btn more" onclick={() => (show += 30)}>Show more rounds</button>{/if}
{/if}

<style>
  .ph { margin: 4px 0 16px }
  .ph h1 { font-size: 30px; font-weight: 800 }
  .ph p { margin: 4px 0 0 }
  .summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px }
  .mtile, .stile { grid-column: 1 / -1 }
  .mtile { text-align: left; color: var(--fg); font: inherit; cursor: pointer }
  .scope { margin: 0 0 8px; font-size: 13px }
  .mtile .big { color: var(--brand) }
  @media (min-width: 860px) { .summary { grid-template-columns: repeat(6, minmax(0, 1fr)) } .mtile, .stile { grid-column: auto } }
  .mchip { font-size: 11.5px; font-weight: 700; color: var(--brand); display: inline-flex; align-items: center; gap: 3px; overflow-wrap: anywhere }
  .miners { margin-top: 14px; display: grid; gap: 6px; font-size: 14px }
  .how { margin: 0; font-size: 13px; line-height: 1.45 }
  .mtab { width: 100%; border-collapse: collapse; font-size: 14px }
  .mtab th { font-size: 11.5px; color: var(--fg-3); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; text-align: left; padding: 4px 6px 4px 0 }
  .mtab td { padding: 6px 6px 6px 0; vertical-align: top; border-top: 1px solid var(--line-soft) }
  .mtab tfoot td { font-weight: 700 }
  .mtab .r { text-align: right; white-space: nowrap }
  .mtab .who { display: block; overflow-wrap: anywhere }
  .mtab .sub { display: block; font-size: 12px }
  .mtab tr.me .who { color: var(--brand); font-weight: 700 }
  .small-note { font-size: 12.5px }
  .tile { padding: 14px 16px }
  .big { font-size: 26px; font-weight: 800; margin: 4px 0 2px; display: flex; align-items: center; gap: 8px }
  .tile .faint { font-size: 13px }
  .dot { width: 12px; height: 12px; border-radius: 50% }
  .dot.A { background: var(--a) } .dot.B { background: var(--b) }
  .seg { display: inline-flex; padding: 4px; gap: 4px; border-radius: 12px; background: var(--surface); border: 1px solid var(--line-soft); margin-bottom: 14px }
  .seg button { border: 0; background: none; color: var(--fg-2); font-weight: 650; font-size: 14px; padding: 8px 14px; border-radius: 9px; cursor: pointer }
  .seg button.on { background: var(--surface-3); color: var(--fg) }
  .list { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px }
  .row { overflow: hidden }
  .sum { width: 100%; display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 14px 16px; background: none; border: 0; text-align: left; cursor: pointer; color: var(--fg) }
  .sum:hover { background: rgba(255, 255, 255, 0.015) }
  .no { color: var(--fg-3); font-weight: 700; font-size: 14px }
  .main { display: grid; gap: 7px; min-width: 0 }
  .q { font-weight: 700; font-size: 15.5px; line-height: 1.3; overflow-wrap: anywhere }
  .split { display: flex; height: 8px; border-radius: 4px; overflow: hidden; gap: 2px; background: var(--surface) }
  .split .sa { background: var(--a); border-radius: 4px 0 0 4px; min-width: 2px }
  .split .sb { background: var(--b); border-radius: 0 4px 4px 0; min-width: 2px }
  .lbl { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--fg-2); flex-wrap: wrap }
  .sealed-lbl { display: inline-flex; align-items: center; gap: 5px; font-size: 13px }
  .lbl .side-A, .lbl .side-B { color: var(--fg-2); white-space: normal }
  .res { display: grid; justify-items: end; gap: 4px; text-align: right; max-width: 132px }
  .win { font-weight: 750; font-size: 14px; white-space: normal; overflow-wrap: anywhere }
  .small { font-size: 12.5px; display: inline-flex; align-items: center; gap: 3px }
  .mine-tag { font-size: 11.5px; font-weight: 650; color: var(--brand); overflow-wrap: anywhere }
  .detail { padding: 0 16px 16px 76px }
  @media (max-width: 520px) { .detail { padding-left: 16px } .sum { grid-template-columns: 40px minmax(0, 1fr) auto; gap: 10px; padding: 12px 14px } .res { max-width: 104px } }
  dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px 16px; margin: 12px 0 0 }
  dt { font-size: 12px; color: var(--fg-3); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em }
  dd { margin: 2px 0 0; font-size: 14px }
  .same { margin-top: 14px; display: grid; gap: 4px; font-size: 14px }
  .empty { padding: 36px 20px; display: grid; justify-items: center; gap: 10px; text-align: center; color: var(--fg-2) }
  .empty p { margin: 0 }
  .more { margin: 16px auto 0; display: flex }
  .gold { color: var(--brand) }
</style>
