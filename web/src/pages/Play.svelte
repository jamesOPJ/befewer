<script lang="ts">
  import { fade, scale } from 'svelte/transition'
  import * as H from '../history'
  import { questionFor, label } from '../questions'
  import Countdown from '../lib/Countdown.svelte'
  import Orbs from '../lib/Orbs.svelte'
  import Icon from '../lib/Icon.svelte'
  import {
    game, fmt, ONE, commitRound, revealRound, started, msLeft, clock, roundById, myOpen, picks, placeBet, capFor, toast,
    type Side,
  } from '../game.svelte'

  const r = $derived(commitRound())
  const q = $derived(questionFor(r))
  const cur = $derived(roundById(r))
  const rr = $derived(revealRound())
  const revealing = $derived(rr == null ? undefined : roundById(rr))
  const lastSettled = $derived.by(() => { game.history; return game.rounds.find(x => x.settled && Number(x.round) < r) })
  const commitTotal = $derived(game.params ? Number(BigInt(game.params.commit_ns) / 1_000_000n) : 1)
  const revealTotal = $derived(game.params ? Number(BigInt(game.params.reveal_ns) / 1_000_000n) : 1)
  const leftCommit = $derived(msLeft(game.status?.commit_ends_at))
  const leftReveal = $derived(msLeft(game.status?.reveal_ends_at))
  const mine = $derived(myOpen(r))
  const myPick = $derived(mine ? picks()[r] : undefined)
  const newcomer = $derived(!game.session || !game.me || (!game.me.faucet_claimed && BigInt(game.me.balance) === 0n))
  const balance = $derived(newcomer ? BigInt(game.params?.faucet_amount ?? '0') : BigInt(game.me?.balance ?? '0'))
  const cap = $derived(game.params ? capFor(balance) : 0n)
  const capW = $derived(Number(cap / ONE))

  // crowd hints: what happened last time this question was asked + the recent smaller sides
  const past = $derived.by(() => { game.history; return H.sameQuestion(r, 5) })
  const recent = $derived.by(() => { game.history; return H.recent(r, 14) })
  const lastTime = $derived(past.length ? { t: past[0], o: H.outcome(past[0])!, sp: H.split(past[0]) } : null)

  let side = $state<Side | null>(null)
  let stake = $state(1)
  $effect(() => { if (stake > capW && capW >= 1) stake = capW })
  const chips = $derived([1, 10, 50, 100].filter(x => x < capW).concat(capW >= 1 ? [capW] : []))

  let ctaEl = $state<HTMLButtonElement | null>(null)
  function pickSide(S: Side) {
    side = side === S ? null : S
    if (side && ctaEl) {
      const r = ctaEl.getBoundingClientRect()
      if (r.bottom > innerHeight - 80) ctaEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  async function seal() {
    if (!side) return
    try {
      await placeBet(side, BigInt(Math.max(1, Math.floor(stake))) * ONE)
      side = null
    } catch (e: any) {
      toast('err', String(e.message || e))
    }
  }
</script>

<div class="grid">
  <section class="card round" aria-labelledby="q">
    <div class="head">
      <div>
        <div class="eyebrow">Round {r} · {started() ? 'taking bets' : 'opens soon'}</div>
        <div class="meta">
          <span class="pill num"><Icon name="lock" size={14} /> {cur?.commits ?? 0} sealed · {fmt(cur?.committed ?? '0')} in</span>
        </div>
      </div>
      {#if started()}
        <Countdown left={leftCommit} total={commitTotal} caption="to bet" />
      {:else}
        <Countdown left={msLeft(game.params?.genesis_ns)} total={60000} caption="opens" />
      {/if}
    </div>

    {#key r}
      <h1 id="q" class="question" in:fade={{ duration: 250 }}>{q.q}</h1>
    {/key}
    <p class="ask">Don't pick what you like. Pick what you think <b>fewer coins</b> will pick.</p>

    <div class="crowd">
      {#if lastTime}
        <div class="hint"><Icon name="eye" size={16} />
          <span>Last time ({'#'}{lastTime.t}): {label(lastTime.t, 'A')} {lastTime.sp ? Math.round(lastTime.sp.a * 100) : 0}% vs {label(lastTime.t, 'B')} {lastTime.sp ? Math.round(lastTime.sp.b * 100) : 0}% →
          {#if lastTime.o === 'void'}void{:else}<b class="side-{lastTime.o}">{label(lastTime.t, lastTime.o)}</b> was smaller{/if}{past.length > 1 ? ` · asked ${past.length}×` : ''}</span>
        </div>
      {:else}
        <div class="hint faint"><Icon name="spark" size={16} /><span>First time this question comes up. No crowd history yet.</span></div>
      {/if}
      {#if recent.length}
        <div class="chips" aria-label="Smaller side of recent rounds, newest first">
          <span class="faint small">Recent</span>
          {#each recent as x}
            <span class="chip c-{x.outcome}" title="Round {x.round}: {questionFor(x.round).q} → {label(x.round, x.outcome)}">{x.outcome === 'void' ? '·' : x.outcome}</span>
          {/each}
        </div>
      {/if}
    </div>

    {#if !started()}
      <div class="panel locked"><Icon name="clock" /><div><b>The game opens shortly.</b><br /><span class="muted">Round 0 takes bets as soon as the timer runs out.</span></div></div>
    {:else if mine}
      <div class="panel sealed" in:scale={{ start: 0.97, duration: 220 }}>
        <div class="lockicon"><Icon name="lock" size={26} /></div>
        <div>
          <div class="eyebrow">Sealed in round {r}</div>
          <div class="sealed-amt"><b class="num">{fmt(mine.amount)}</b> BEFEWER on <b class="side-{myPick?.side}">{myPick ? label(r, myPick.side) : '?'}</b></div>
          <p class="muted">Nobody, including us, can see your answer until the reveal opens in <b class="num">{clock(leftCommit)}</b>. It opens itself, so you can close this page. The result lands about {Math.round(revealTotal / 1000)} s after that.</p>
        </div>
      </div>
    {:else}
      <div class="answers" role="group" aria-label="Pick an answer">
        {#each ['A', 'B'] as s}
          {@const S = s as Side}
          <button class="answer {S}" class:on={side === S} aria-pressed={side === S} onclick={() => pickSide(S)} disabled={!!game.busy}>
            <span class="letter">{S}</span>
            <span class="text">{S === 'A' ? q.a : q.b}</span>
            {#if side === S}<span class="tick" in:scale={{ duration: 160 }}><Icon name="check" size={18} stroke={2.4} /></span>{/if}
          </button>
        {/each}
      </div>

      {#if capW >= 1}
        <div class="stake">
          <span class="eyebrow">Stake</span>
          <div class="seg" role="radiogroup" aria-label="Stake">
            {#each chips as c}
              <button role="radio" aria-checked={stake === c} class:on={stake === c} onclick={() => (stake = c)}>{c === capW ? `Max ${c}` : c}</button>
            {/each}
          </div>
          <label class="custom"><span class="sr">Custom stake</span><input type="number" min="1" max={capW} bind:value={stake} inputmode="numeric" /> <span class="faint">BEFEWER</span></label>
        </div>
      {/if}

      <button bind:this={ctaEl} class="btn primary cta" disabled={!side || !!game.busy || capW < 1} onclick={seal}>
        {#if game.busy}<span class="spin" aria-hidden="true"></span>{game.busy}…
        {:else if !side}Pick an answer
        {:else}<Icon name="lock" size={18} /> Seal {stake} BEFEWER on {side === 'A' ? q.a : q.b}{/if}
      </button>
      <p class="fine">
        {#if newcomer}Your first bet creates a free testnet account in this browser and gives you {fmt(game.params?.faucet_amount ?? '0')} BEFEWER. No wallet, no seed phrase, no popups.
        {:else}Win: +{stake} (you get {stake * 2} back). Lose: −{stake}. The gap between the two sides burns. Max {capW} per round (25% of your balance).{/if}
      </p>
    {/if}
  </section>

  <aside class="side">
    {#if revealing && revealing.commits > 0}
      <section class="card reveal">
        <div class="head small">
          <div>
            <div class="eyebrow">Round {revealing.round} · opening now</div>
            <h2 class="q2">{questionFor(Number(revealing.round)).q}</h2>
          </div>
          <Countdown left={leftReveal} total={revealTotal} caption="result" size={72} tone="var(--b)" />
        </div>
        {#if revealing.reveals_a + revealing.reveals_b === 0}
          <div class="vault" aria-label="{revealing.commits} sealed bets waiting to open">
            {#each Array(Math.min(revealing.commits, 12)) as _, i}<span class="seal" style="animation-delay:{i * 120}ms"><Icon name="lock" size={18} /></span>{/each}
          </div>
          <p class="fine center">{revealing.commits} sealed bet{revealing.commits === 1 ? '' : 's'}. drand has just published the key for this round; the keeper is opening them now.</p>
        {:else}
          <Orbs round={revealing} />
          <p class="fine center">{revealing.reveals_a + revealing.reveals_b} of {revealing.commits} bets open. Bets on the smaller side win +100% when the timer ends.</p>
        {/if}
      </section>
    {:else if lastSettled}
      <section class="card reveal">
        <div class="head small">
          <div>
            <div class="eyebrow">Last result · round {lastSettled.round}</div>
            <h2 class="q2">{questionFor(Number(lastSettled.round)).q}</h2>
          </div>
        </div>
        <Orbs round={lastSettled} />
        <p class="fine center">
          {#if lastSettled.outcome === 'void'}Everyone was on one side, so everyone got their bet back.
          {:else}<span class="burn"><Icon name="flame" size={14} /> {fmt(lastSettled.burned)} BEFEWER burned</span> · bets on the smaller side won +100%.{/if}
        </p>
      </section>
    {/if}

    {#if game.results[0]}
      {@const x = game.results[0]}
      <a class="card mine" href="#/me">
        <div class="eyebrow">Your last bet · round {x.round}</div>
        <div class="res">
          {#if x.outcome === 'void'}<b>Refunded {fmt(x.amount)}</b>
          {:else if x.outcome === x.side}<b class="good">Won +{fmt(x.amount)}</b>
          {:else}<b class="burn">Lost {fmt(x.amount)}</b>{/if}
          <span class="muted">· you picked {label(x.round, x.side)}</span>
        </div>
        <Icon name="chevron" size={18} />
      </a>
    {/if}
  </aside>
</div>

<style>
  .grid { display: grid; gap: 16px }
  @media (min-width: 860px) { .grid { grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); align-items: start } }
  .round { padding: 22px }
  .head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start }
  .head.small { align-items: center }
  .meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px }
  .question { font-size: clamp(26px, 6.6vw, 42px); line-height: 1.12; font-weight: 800; margin: 14px 0 6px; overflow-wrap: anywhere }
  .ask { margin: 0; color: var(--fg-2); font-size: 15px }
  .ask b { color: var(--fg) }
  .crowd { margin: 16px 0 4px; display: grid; gap: 10px }
  .hint { display: flex; gap: 8px; align-items: flex-start; font-size: 14px; color: var(--fg-2); line-height: 1.45 }
  .hint :global(svg) { flex: none; margin-top: 2px }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; align-items: center }
  .small { font-size: 12px; margin-right: 4px }
  .chip { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 7px; font-size: 12px; font-weight: 800; background: var(--surface-2); border: 1px solid var(--line); color: var(--fg-3) }
  .chip.c-A { color: #17120a; border-color: transparent; background: var(--a) }
  .chip.c-B { color: #0b1420; border-color: transparent; background: var(--b) }
  @media (max-width: 520px) { .chips .chip:nth-of-type(n + 11) { display: none } .round { padding: 18px } .answers { margin: 16px 0 12px } .crowd { margin-top: 12px } }
  .vault { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; padding: 34px 8px 18px }
  .seal { width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center; color: var(--brand); background: rgba(232, 182, 94, 0.08); border: 1px solid rgba(232, 182, 94, 0.3); animation: breathe 1.6s var(--ease) infinite }
  @keyframes breathe { 0%, 100% { opacity: 0.55; transform: scale(0.96) } 50% { opacity: 1; transform: scale(1) } }
  .answers { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 20px 0 16px }
  .answer { position: relative; display: grid; justify-items: start; gap: 8px; min-height: 104px; padding: 16px; text-align: left; border-radius: var(--r-lg); border: 1.5px solid var(--line); background: var(--surface-2); cursor: pointer; transition: border-color 0.15s var(--ease), background 0.15s var(--ease), transform 0.12s var(--ease) }
  .answer:hover:not(:disabled) { border-color: var(--fg-3) }
  .answer:active:not(:disabled) { transform: scale(0.985) }
  .answer .letter { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; font-weight: 800; font-size: 14px; border: 1.5px solid currentColor }
  .answer.A .letter { color: var(--a) }
  .answer.B .letter { color: var(--b) }
  .answer .text { font-size: clamp(18px, 4.6vw, 22px); font-weight: 750; line-height: 1.2; overflow-wrap: anywhere; color: var(--fg) }
  .answer.A.on { border-color: var(--a); background: var(--a-soft) }
  .answer.B.on { border-color: var(--b); background: var(--b-soft) }
  .tick { position: absolute; top: 14px; right: 14px; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; color: var(--brand-ink) }
  .A .tick { background: var(--a) }
  .B .tick { background: var(--b) }
  .stake { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; margin: 4px 0 16px }
  .seg { display: flex; flex-wrap: wrap; gap: 6px }
  .seg button { min-height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface-2); color: var(--fg-2); font-weight: 650; font-size: 14px; cursor: pointer; font-variant-numeric: tabular-nums }
  .seg button.on { background: var(--fg); color: var(--bg); border-color: var(--fg) }
  .custom { display: flex; align-items: center; gap: 6px; font-size: 14px }
  .custom input { width: 84px }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0) }
  .cta { width: 100%; min-height: 54px; font-size: 17px; border-radius: 14px }
  .fine { font-size: 13px; color: var(--fg-3); margin: 10px 0 0; line-height: 1.5 }
  .center { text-align: center }
  .spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid rgba(26, 20, 8, 0.25); border-top-color: var(--brand-ink); animation: rot 0.8s linear infinite }
  @keyframes rot { to { transform: rotate(360deg) } }
  .panel { display: flex; gap: 14px; align-items: flex-start; margin-top: 20px; padding: 16px; border-radius: var(--r-lg); border: 1px solid var(--line); background: var(--surface-2) }
  .panel p { margin: 6px 0 0; font-size: 14px; line-height: 1.5 }
  .sealed { border-color: rgba(232, 182, 94, 0.35); background: linear-gradient(180deg, rgba(232, 182, 94, 0.08), transparent), var(--surface-2) }
  .lockicon { width: 48px; height: 48px; border-radius: 14px; display: grid; place-items: center; background: rgba(232, 182, 94, 0.14); color: var(--brand); flex: none }
  .sealed-amt { font-size: 20px; margin-top: 2px; overflow-wrap: anywhere }
  .side { display: grid; gap: 16px }
  .reveal { padding: 18px }
  .q2 { font-size: 18px; font-weight: 750; margin-top: 6px; line-height: 1.25; overflow-wrap: anywhere }
  .mine { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 8px; padding: 14px 16px; color: var(--fg); text-decoration: none }
  .mine .eyebrow { grid-column: 1 }
  .mine .res { grid-column: 1; font-size: 15px }
  .mine :global(svg) { grid-column: 2; grid-row: 1 / span 2; color: var(--fg-3) }
</style>
