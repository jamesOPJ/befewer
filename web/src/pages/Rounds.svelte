<script lang="ts">
  import { slide } from 'svelte/transition'
  import * as H from '../history'
  import { questionFor, label } from '../questions'
  import Icon from '../lib/Icon.svelte'
  import Orbs from '../lib/Orbs.svelte'
  import { game, fmt, fmtN, commitRound, picks } from '../game.svelte'
  import type { RoundV } from '../chain'

  let filter = $state<'all' | 'mine'>('all')
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
  const mine = $derived.by(() => { game.results; game.me; return picks() })
  const list = $derived(filter === 'mine' ? all.filter(x => mine[x.round]) : all)
  const settled = $derived(all.filter(x => x.settled))
  const sum = $derived.by(() => {
    const s = { A: 0, B: 0, void: 0, treasury: 0n, mined: 0n }
    for (const x of settled) {
      if (x.outcome === 'A' || x.outcome === 'B' || x.outcome === 'void') s[x.outcome]++
      s.treasury += BigInt(x.to_treasury)
      s.mined += BigInt(x.reward)
    }
    return s
  })
  const pct = (x: RoundV) => {
    const a = Number(BigInt(x.revealed_a) / 10n ** 18n), b = Number(BigInt(x.revealed_b) / 10n ** 18n)
    return a + b > 0 ? Math.round((a / (a + b)) * 100) : null
  }
  const phase = (x: RoundV) => (x.settled ? 'settled' : Number(x.round) === commitRound() ? 'betting' : 'opening')
</script>

<header class="ph">
  <div>
    <h1>Rounds</h1>
    <p class="muted">Every round so far. Bets on the smaller side won +100%; fees and the gap between the sides went to the treasury.</p>
  </div>
</header>

<section class="summary">
  <div class="card tile"><div class="eyebrow">Settled</div><div class="big num">{settled.length}</div><div class="faint">rounds with bets</div></div>
  <div class="card tile"><div class="eyebrow">A smaller</div><div class="big num"><span class="dot A"></span>{sum.A}</div><div class="faint">{settled.length ? Math.round((sum.A / settled.length) * 100) : 0}% of rounds</div></div>
  <div class="card tile"><div class="eyebrow">B smaller</div><div class="big num"><span class="dot B"></span>{sum.B}</div><div class="faint">{settled.length ? Math.round((sum.B / settled.length) * 100) : 0}% of rounds</div></div>
  <div class="card tile"><div class="eyebrow">To the treasury</div><div class="big num gold">{fmtN(sum.treasury, 2)}</div><div class="faint">NEAR · {fmt(sum.mined)} BEFEWER mined · {sum.void} void</div></div>
</section>

<div class="seg" role="tablist" aria-label="Filter rounds">
  <button role="tab" aria-selected={filter === 'all'} class:on={filter === 'all'} onclick={() => (filter = 'all')}>All rounds</button>
  <button role="tab" aria-selected={filter === 'mine'} class:on={filter === 'mine'} onclick={() => (filter = 'mine')}>With my bets</button>
</div>

{#if !list.length}
  <div class="card empty">
    <Icon name="rounds" size={28} />
    <p>{filter === 'mine' ? 'You have not bet in any round yet.' : 'No rounds with bets yet.'}</p>
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
            {#if my}<span class="mine-tag">you: {label(n, my.side)}</span>{/if}
          </span>
        </button>
        {#if open === n}
          <div class="detail" transition:slide={{ duration: 200 }}>
            {#if p !== null}<Orbs round={x} compact />{/if}
            <dl>
              <div><dt>Bets</dt><dd class="num">{x.commits} ({x.reveals_a} on A, {x.reveals_b} on B{x.commits - x.reveals_a - x.reveals_b > 0 && x.settled ? `, ${x.commits - x.reveals_a - x.reveals_b} never opened` : ''})</dd></div>
              <div><dt>Staked</dt><dd class="num">{fmtN(x.committed)} NEAR <span class="faint">+ {fmtN(x.fees)} fees</span></dd></div>
              {#if x.settled}<div><dt>To the treasury</dt><dd class="num gold">{fmtN(x.to_treasury)} NEAR</dd></div>
                <div><dt>Mined</dt><dd class="num">{BigInt(x.reward) > 0n ? `${fmt(x.reward)} BEFEWER to streak winners` : `none (pot rolls over: +${fmt(x.emission)})`}</dd></div>{/if}
              {#if my}<div><dt>Your bet</dt><dd class="num">{fmtN(my.amount)} NEAR on {label(n, my.side)}</dd></div>{/if}
            </dl>
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
  @media (min-width: 860px) { .summary { grid-template-columns: repeat(4, minmax(0, 1fr)) } }
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
