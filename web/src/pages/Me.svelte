<script lang="ts">
  import Icon from '../lib/Icon.svelte'
  import { questionFor, label } from '../questions'
  import { game, fmt, fmtN, netOf, GUEST_GAME_NEAR, short, picks, forgetDevice, toast, commitRound, withdrawAll, claimBefewer, claimPreview } from '../game.svelte'

  const me = $derived(game.me)
  const decided = $derived(me ? me.wins + me.losses : 0)
  const rate = $derived(decided ? me!.wins / decided : 0)
  const pk = $derived.by(() => { game.me; return picks() })
  let confirming = $state(false)

  async function claim() {
    try { await claimBefewer() } catch (e: any) { toast('err', String(e.message || e)) }
  }
  const preview = $derived(me ? claimPreview(me) : null)
  const feePct = $derived((game.params?.refine_fee_bps ?? 0) / 100)
  async function withdraw() {
    try { await withdrawAll() } catch (e: any) { toast('err', String(e.message || e)) }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(game.session!.accountId); toast('ok', 'Account name copied.') } catch { toast('err', 'Could not copy.') }
  }
</script>

<header class="ph">
  <h1>Me</h1>
  <p class="muted">Your testnet account in this browser, your record and your bets.</p>
</header>

{#if !game.session || !me}
  <div class="card empty">
    <div class="halo"><Icon name="user" size={30} /></div>
    <h2>You haven't played yet</h2>
    <p class="muted">Your first bet creates a free testnet account right here in your browser with {fmtN(GUEST_GAME_NEAR)} testnet NEAR to play. No wallet, no seed phrase.</p>
    <a class="btn primary" href="#/">Play this round</a>
  </div>
{:else}
  <section class="top">
    <div class="card bal">
      <div class="eyebrow">Game balance</div>
      <div class="money num">{fmtN(me.balance)} <span>NEAR</span></div>
      <div class="tok"><b class="num">{fmt(me.tokens)}</b> BEFEWER in your wallet <span class="faint">· {fmt(me.mined)} mined by your streaks</span></div>
      <button class="acct" onclick={copy} title="Copy account name"><span class="num">{short(game.session.accountId)}</span><Icon name="copy" size={15} /></button>
      <div class="faint small">Testnet account kept in this browser · {me.open.length} bet{me.open.length === 1 ? '' : 's'} waiting to settle</div>
      <button class="btn small wd" onclick={withdraw} disabled={!!game.busy || BigInt(me.balance) === 0n}>Withdraw {fmtN(me.balance)} NEAR to the wallet</button>
    </div>
    <div class="card score">
      <div class="eyebrow">Picked the smaller side</div>
      {#if decided}
        <div class="money num">{Math.round(rate * 100)}<span>%</span></div>
        <div class="meter" aria-label="{Math.round(rate * 100)}% versus 50% for a coin flip">
          <span class="fill" class:above={rate > 0.5} style="width:{rate * 100}%"></span>
          <span class="coin" style="left:50%"></span>
        </div>
        <div class="small muted">{me.wins} of {decided} decided rounds. <span class="faint">The mark is a coin flip (50%).</span></div>
      {:else}
        <div class="money num faint">—</div>
        <div class="small muted">Shows up after your first round settles.</div>
      {/if}
    </div>
  </section>

  <section class="card befewer">
    <div class="eyebrow">Mined BEFEWER</div>
    <div class="buckets">
      <div><div class="faint small">Unrefined</div><div class="v num">{fmt(me.unrefined)}</div><div class="faint small">{feePct}% fee when claimed</div></div>
      <div><div class="faint small">Refined</div><div class="v num gold">{fmt(me.refined)}</div><div class="faint small">your share of others' fees · no fee</div></div>
      <div><div class="faint small">In your wallet</div><div class="v num">{fmt(me.tokens)}</div><div class="faint small">tradable once the pool opens</div></div>
    </div>
    <p class="small muted">Mined BEFEWER stays unrefined in the game. Claiming it to your wallet costs {feePct}% of the unrefined part, and that {feePct}% is shared among everyone who is still holding unrefined BEFEWER, as refined BEFEWER. The longer you hold, the more of other players' fees you collect.</p>
    {#if preview && preview.out > 0n}
      <button class="btn small" onclick={claim} disabled={!!game.busy}>Claim {fmt(preview.out)} BEFEWER to the wallet{preview.fee > 0n ? ` (fee ${fmt(preview.fee)})` : ''}</button>
    {/if}
  </section>

  <section class="stats">
    <div class="card st"><div class="eyebrow">Wins</div><div class="v num good">{me.wins}</div></div>
    <div class="card st"><div class="eyebrow">Losses</div><div class="v num burn">{me.losses}</div></div>
    <div class="card st"><div class="eyebrow">Void</div><div class="v num">{me.voids}</div></div>
    <div class="card st"><div class="eyebrow">Streak</div><div class="v num">{me.streak}<span class="faint small"> · best {me.best_streak}</span></div></div>
  </section>

  {#if me.open.length}
    <section>
      <h2 class="h2">Waiting to settle</h2>
      <ul class="list">
        {#each me.open as o}
          {@const n = Number(o.round)}
          <li class="card item">
            <span class="no num">#{n}</span>
            <span class="body"><span class="q">{questionFor(n).q}</span><span class="small muted">{fmtN(o.amount)} NEAR on {pk[o.round] ? label(n, pk[o.round].side) : '?'}{o.streak_if_win >= (game.params?.streak_min ?? 3) ? ` · mines if it wins (streak ${o.streak_if_win})` : ''}</span></span>
            <span class="pill">{n === commitRound() ? 'Sealed' : o.side ? 'Opened' : 'Opening'}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section>
    <h2 class="h2">Results</h2>
    {#if game.results.length}
      <ul class="list">
        {#each game.results as x}
          {@const n = netOf(x)}
          <li class="card item">
            <span class="no num">#{x.round}</span>
            <span class="body"><span class="q">{questionFor(x.round).q}</span>
              <span class="small muted">You picked {label(x.round, x.side)} · {x.outcome === 'void' ? 'void' : `${label(x.round, x.outcome)} was smaller`}</span></span>
            {#if x.outcome === 'void'}<span class="amt num">±0</span>
            {:else if n > 0n}<span class="amt num good">+{fmtN(n)}</span>
            {:else}<span class="amt num burn">−{fmtN(-n)}</span>{/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">No settled bets yet. Results appear here a few minutes after a round closes.</p>
    {/if}
  </section>

  <section class="danger card">
    <div>
      <h3>Forget this device</h3>
      <p class="small muted">Removes the testnet account's key from this browser. You lose access to its NEAR and BEFEWER. Testnet only.</p>
    </div>
    {#if confirming}
      <div class="row"><button class="btn small" onclick={() => (confirming = false)}>Keep it</button><button class="btn small bad" onclick={() => { forgetDevice(); confirming = false; toast('info', 'Forgot the account on this device.') }}>Forget</button></div>
    {:else}
      <button class="btn small" onclick={() => (confirming = true)}>Forget…</button>
    {/if}
  </section>
{/if}

<style>
  .ph { margin: 4px 0 16px }
  .ph h1 { font-size: 30px; font-weight: 800 }
  .ph p { margin: 4px 0 0 }
  .empty { padding: 40px 22px; display: grid; justify-items: center; text-align: center; gap: 10px }
  .empty p { margin: 0; max-width: 460px }
  .halo { width: 64px; height: 64px; border-radius: 20px; display: grid; place-items: center; background: rgba(232, 182, 94, 0.1); color: var(--brand) }
  .top { display: grid; gap: 12px; margin-bottom: 12px }
  @media (min-width: 860px) { .top { grid-template-columns: 1fr 1fr } }
  .bal, .score { padding: 18px 20px; display: grid; gap: 6px; align-content: start }
  .money { font-size: 40px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.1 }
  .money span { font-size: 15px; font-weight: 600; color: var(--fg-3); margin-left: 4px }
  .tok { font-size: 15px; color: var(--fg-2) }
  .befewer { padding: 16px 20px; display: grid; gap: 10px; margin-bottom: 12px }
  .befewer p { margin: 0 }
  .befewer .btn { justify-self: start }
  .buckets { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px }
  @media (max-width: 520px) { .buckets { grid-template-columns: 1fr 1fr } }
  .gold { color: var(--brand) }
  .wd { justify-self: start; margin-top: 6px }
  .acct { justify-self: start; display: inline-flex; gap: 6px; align-items: center; padding: 4px 10px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--line); color: var(--fg-2); font-size: 13px; cursor: pointer }
  .small { font-size: 13px }
  .meter { position: relative; height: 10px; border-radius: 5px; background: var(--surface-3); margin: 6px 0 4px }
  .meter .fill { position: absolute; inset: 0 auto 0 0; border-radius: 5px; background: var(--burn) }
  .meter .fill.above { background: var(--good) }
  .meter .coin { position: absolute; top: -4px; bottom: -4px; width: 2px; background: var(--fg); border-radius: 1px; transform: translateX(-1px) }
  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 22px }
  @media (max-width: 520px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)) } }
  .st { padding: 12px 14px }
  .v { font-size: 24px; font-weight: 800; margin-top: 2px }
  .h2 { font-size: 17px; font-weight: 750; margin: 0 0 10px }
  section { margin-bottom: 22px }
  .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px }
  .item { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 12px 16px }
  .no { color: var(--fg-3); font-weight: 700; font-size: 14px }
  .body { display: grid; gap: 2px; min-width: 0 }
  .q { font-weight: 650; font-size: 15px; overflow-wrap: anywhere }
  .amt { font-weight: 800; font-size: 16px }
  .danger { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 16px 18px; flex-wrap: wrap }
  .danger h3 { font-size: 15px }
  .danger p { margin: 4px 0 0 }
  .row { display: flex; gap: 8px }
  .bad { border-color: var(--err-line); background: var(--err-bg); color: var(--err-fg) }
</style>
