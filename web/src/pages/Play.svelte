<script lang="ts">
  import { fade, scale } from 'svelte/transition'
  import * as H from '../history'
  import { questionFor, label } from '../questions'
  import Countdown from '../lib/Countdown.svelte'
  import Orbs from '../lib/Orbs.svelte'
  import Icon from '../lib/Icon.svelte'
  import LowBalance from '../lib/LowBalance.svelte'
  import {
    game, fmt, fmtN, toNear, toYocto, feeFor, GUEST_GAME_NEAR, openWallet, multi, slotName, myBetsIn, totals, allResults, netOf, commitRound, revealRound, started, msLeft, clock, roundById, myOpen, picks, placeBet, capFor, toast,
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
  // every slot's bet this round (manual bets go from slot 0)
  const bets = $derived.by(() => { game.me; return myBetsIn(r) })
  const others = $derived(bets.filter(x => x.slot !== 0))
  // the newest settled round, added up over every slot that bet in it
  const last = $derived.by(() => {
    game.resultsBySlot
    const all = allResults()
    if (!all.length) return null
    const list = all.filter(x => x.round === all[0].round)
    return { round: all[0].round, list, net: list.reduce((t, x) => t + netOf(x), 0n) }
  })
  const newcomer = $derived(!game.session || !game.me || !game.me.registered)
  const balance = $derived(newcomer ? GUEST_GAME_NEAR : BigInt(game.me?.balance ?? '0'))
  const cap = $derived(game.params ? capFor(balance) : 0n)
  // stakes are picked in NEAR, in steps of 0.01 (the smallest bet)
  const capW = $derived(Math.floor(toNear(cap) * 100) / 100)
  const minW = $derived(game.params ? toNear(game.params.min_stake) : 0.01)

  // crowd hints: what happened last time this question was asked + the recent smaller sides
  const past = $derived.by(() => { game.history; return H.sameQuestion(r, 5) })
  const recent = $derived.by(() => { game.history; return H.recent(r, 14) })
  const lastTime = $derived(past.length ? { t: past[0], o: H.outcome(past[0])!, sp: H.split(past[0]) } : null)

  let side = $state<Side | null>(null)
  let stake = $state(0.01)
  $effect(() => { if (stake > capW && capW >= minW) stake = capW })
  const chips = $derived([0.01, 0.02, 0.05, 0.1, 0.25].filter(x => x < capW).slice(-3).concat(capW >= minW ? [capW] : []))
  const stakeY = $derived(toYocto(Math.max(minW, Math.round((stake || 0) * 100) / 100)))
  const feeY = $derived(feeFor(stakeY))

  // mining: the streak this bet would complete if it wins, counted over finished rounds
  const st = $derived(game.status)
  const need = $derived(game.params?.streak_min ?? 3)
  // the best streak running on any slot (with several slots, that is the one closest to mining)
  const tot = $derived.by(() => { game.me; return totals() })
  const streak = $derived(tot.now)
  const nextStreak = $derived(streak + 1)
  const sharesIfWin = $derived(nextStreak >= need ? nextStreak - need + 1 : 0)
  const dex = $derived(st?.dex)
  const toGraduate = $derived(st ? Math.min(1, toNear(st.treasury) / Math.max(1e-9, toNear(st.graduate_at))) : 0)
  const everyMin = $derived(game.params ? Math.round(Number(BigInt(game.params.buyback_every_ns) / 1_000_000_000n) / 60) : 0)

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
      await placeBet(side, stakeY)
      side = null
    } catch (e: any) {
      toast('err', String(e.message || e))
    }
  }
</script>

<LowBalance />
<div class="grid">
  <section class="card round" aria-labelledby="q">
    <div class="head">
      <div>
        <div class="eyebrow">Round {r} · {started() ? 'taking bets' : 'opens soon'}</div>
        <div class="meta">
          <span class="pill num"><Icon name="lock" size={14} /> {cur?.commits ?? 0} sealed · {fmtN(cur?.committed ?? '0')} NEAR in</span>
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
    <p class="ask">Don't pick what you like. Pick what you think <b>less NEAR</b> will be on.</p>

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
          <div class="eyebrow">Sealed in round {r}{bets.length > 1 ? ` · ${bets.length} slots` : ''}</div>
          {#if bets.length > 1}
            {#each bets as b}<div class="sealed-line"><span class="faint">{slotName(b.slot)}</span> <b class="num">{fmtN(b.bet.amount)}</b> NEAR on <b class="side-{b.side}">{b.side ? label(r, b.side) : '?'}</b></div>{/each}
          {:else}
            <div class="sealed-amt"><b class="num">{fmtN(mine.amount)}</b> NEAR on <b class="side-{myPick?.side}">{myPick ? label(r, myPick.side) : '?'}</b> <span class="faint small">+{fmtN(mine.fee)} fee · {fmtN(mine.storage)} held for storage</span></div>
          {/if}
          <p class="muted">Nobody, including us, can see your answer until the reveal opens in <b class="num">{clock(leftCommit)}</b>. It opens itself, so you can close this page. The result lands about {Math.round(revealTotal / 1000)} s after that.</p>
        </div>
      </div>
    {:else}
      {#if others.length}
        <p class="others small">Your other slots already bet this round: {others.map(b => `${slotName(b.slot)} ${fmtN(b.bet.amount)} on ${b.side ?? '?'}`).join(' · ')}. A bet here goes from slot 0.</p>
      {/if}
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

      {#if capW >= minW}
        <div class="stake">
          <span class="eyebrow">Stake</span>
          <div class="seg" role="radiogroup" aria-label="Stake">
            {#each chips as c}
              <button role="radio" aria-checked={stake === c} class:on={stake === c} onclick={() => (stake = c)}>{c === capW ? `Max ${c}` : c}</button>
            {/each}
          </div>
          <label class="custom"><span class="sr">Custom stake</span><input type="number" min={minW} max={capW} step="0.01" bind:value={stake} inputmode="decimal" /> <span class="faint">NEAR</span></label>
        </div>
      {/if}

      <button bind:this={ctaEl} class="btn primary cta" disabled={!side || !!game.busy || capW < minW} onclick={seal}>
        {#if game.busy}<span class="spin" aria-hidden="true"></span>{game.busy}…
        {:else if !side}Pick an answer
        {:else}<Icon name="lock" size={18} /> Seal {fmtN(stakeY)} NEAR on {side === 'A' ? q.a : q.b}{/if}
      </button>
      <p class="fine">
        {#if newcomer && game.session?.kind !== 'wallet'}Your first bet creates a free testnet account in this browser with {fmtN(GUEST_GAME_NEAR)} testnet NEAR to play. No wallet, no seed phrase, no popups. Have a testnet wallet? <button class="link" onclick={openWallet}>Play with your wallet</button>.
        {:else if newcomer}Deposit NEAR from your wallet on the Me page to start betting.
        {:else}Win: +{fmtN(stakeY)} NEAR (you get {fmtN(stakeY * 2n)} back). Lose: −{fmtN(stakeY)}. Every bet pays a {(game.params?.fee_bps ?? 0) / 100}% fee ({fmtN(feeY)} NEAR); if this page is open when betting closes it reveals your bet itself and {(game.params?.reveal_bounty_bps ?? 0) / 100}% of the fee comes back to you. A little NEAR is held for the bet's storage and returned with the result. Max {capW} per round (25% of your balance).{/if}
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
          {:else}<span class="gold"><Icon name="flame" size={14} /> {fmtN(lastSettled.to_treasury)} NEAR to the treasury</span> · bets on the smaller side won +100%{#if BigInt(lastSettled.reward) > 0n} · <b class="good">{fmt(lastSettled.reward)} BEFEWER mined</b> by streak winners{/if}.{/if}
        </p>
      </section>
    {/if}

    {#if last}
      {@const x = last.list[0]}
      <a class="card mine" href="#/me">
        <div class="eyebrow">Your last {last.list.length > 1 ? `round · ${last.list.length} slots` : 'bet'} · round {last.round}</div>
        <div class="res">
          {#if last.list.length > 1}
            <b class={last.net > 0n ? 'good' : last.net < 0n ? 'burn' : ''}>Net {last.net >= 0n ? '+' : '−'}{fmtN(last.net >= 0n ? last.net : -last.net)} NEAR</b>
            <span class="muted">· {last.list.filter(y => y.outcome !== 'void' && y.outcome === y.side).length} of {last.list.length} slots won</span>
          {:else if x.outcome === 'void'}<b>Refunded {fmtN(x.amount + x.fee)} NEAR</b>
          {:else if x.outcome === x.side}<b class="good">Won +{fmtN(x.amount)} NEAR</b>
          {:else}<b class="burn">Lost {fmtN(x.amount)} NEAR</b>{/if}
          {#if last.list.length === 1}<span class="muted">· you picked {label(x.round, x.side)}</span>{/if}
        </div>
        <Icon name="chevron" size={18} />
      </a>
    {/if}

    {#if st && game.params}
      <section class="card mining" aria-labelledby="mine-h">
        <div class="eyebrow" id="mine-h">Mine BEFEWER</div>
        <div class="pot"><b class="num">{fmt(st.pot)}</b> BEFEWER in the pot</div>
        <div class="dots" aria-label="Your streak: {streak} of {need}">
          {#each Array(need) as _, i}<span class="dot" class:on={i < streak}></span>{/each}
          <span class="small muted">streak {streak}{multi() && streak > 0 ? ` · ${slotName(tot.nowSlot)}` : ''}{multi() ? ' (best of your slots)' : ''}</span>
        </div>
        <p class="fine">
          {#if sharesIfWin > 0}Win this round and you mine: a {nextStreak}-win streak earns {sharesIfWin} share{sharesIfWin === 1 ? '' : 's'} per 0.001 NEAR staked. Winners split the pot by shares.
          {:else}Win {need} rounds in a row and that win mines the pot. Win this one for streak {nextStreak} of {need}.{/if}
          Each round adds {fmt(game.params.reward_per_round)} BEFEWER; nobody else can mint. {fmt(st.issued)} of {fmt(st.max_supply)} issued so far.
          Mined BEFEWER stays unrefined until you claim it; claiming costs {game.params.refine_fee_bps / 100}%, paid to everyone still holding.
        </p>
      </section>

      {#if dex}
        <section class="card treasury" aria-labelledby="tr-h">
          <div class="eyebrow" id="tr-h">Treasury</div>
          {#if dex.step < 5}
            <div class="pot"><b class="num">{fmtN(st.treasury)}</b> of {fmtN(st.graduate_at)} NEAR</div>
            <div class="bar" aria-label="{Math.round(toGraduate * 100)}% of the way to opening the pool"><span style="width:{toGraduate * 100}%"></span></div>
            <p class="fine">
              {#if dex.step > 0}Opening the pool now: step {dex.step} of 5 ({dex.stage}).
              {:else}At {fmtN(st.graduate_at)} NEAR the contract opens a BEFEWER/NEAR pool on Ref Finance with all of it, plus as many new BEFEWER as have been mined. The pool shares stay locked in the contract.{/if}
              Fees, the gap between the sides and unopened bets fill it.
            </p>
          {:else}
            <div class="pot"><b class="num">{fmtN(st.treasury)}</b> NEAR</div>
            <p class="fine">Pool <a href="https://testnet.ref.finance/pool/{dex.pool_id}" target="_blank" rel="noopener">#{dex.pool_id} on Ref Finance</a> is open, its shares locked in the contract. Every {everyMin} min the treasury buys up to {fmtN(game.params.buyback_max)} NEAR of BEFEWER there and burns it: {dex.buybacks} buyback{dex.buybacks === 1 ? '' : 's'} so far, {fmtN(dex.bought_near)} NEAR spent, <b>{fmt(dex.bought_burned)} BEFEWER burned</b>.</p>
          {/if}
        </section>
      {/if}
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
  .sealed-line { font-size: 16px; margin-top: 2px; overflow-wrap: anywhere }
  .others { margin: 14px 0 0; padding: 8px 12px; border-radius: 10px; background: var(--surface-2); color: var(--fg-2) }
  .side { display: grid; gap: 16px }
  .reveal { padding: 18px }
  .q2 { font-size: 18px; font-weight: 750; margin-top: 6px; line-height: 1.25; overflow-wrap: anywhere }
  .mine { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 8px; padding: 14px 16px; color: var(--fg); text-decoration: none }
  .mine .eyebrow { grid-column: 1 }
  .mine .res { grid-column: 1; font-size: 15px }
  .mine :global(svg) { grid-column: 2; grid-row: 1 / span 2; color: var(--fg-3) }
  .mining, .treasury { padding: 16px 18px }
  .pot { font-size: 20px; margin-top: 4px; overflow-wrap: anywhere }
  .dots { display: flex; align-items: center; gap: 6px; margin-top: 10px }
  .dot { width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid var(--brand); background: transparent }
  .dot.on { background: var(--brand) }
  .bar { height: 8px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--line); margin-top: 10px; overflow: hidden }
  .bar span { display: block; height: 100%; background: var(--brand); border-radius: 999px }
  .gold { color: var(--brand) }
  .link { border: 0; padding: 0; background: none; color: var(--brand); font: inherit; text-decoration: underline; cursor: pointer }
</style>
