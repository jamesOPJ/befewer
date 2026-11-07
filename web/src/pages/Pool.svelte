<script lang="ts">
  // The treasury's BEFEWER/NEAR pool on Ref Finance, the buybacks that burn BEFEWER, and where
  // every treasury NEAR and every BEFEWER went (each table adds up to its total).
  import { onMount } from 'svelte'
  import Icon from '../lib/Icon.svelte'
  import { game, fmt, fmtN } from '../game.svelte'
  import { view, viewOn, CONTRACT, GRADUATION_COST, MIN_BUYBACK, type BuybackV, type RefPool } from '../chain'

  const st = $derived(game.status)
  const pr = $derived(game.params)
  const dex = $derived(st?.dex)
  const open = $derived(dex?.step === 5)
  const B = (x: string | bigint | undefined) => BigInt(x ?? '0')

  let pool = $state<RefPool | null>(null)
  let buys = $state<BuybackV[] | null>(null)
  let loadErr = $state('')
  async function load() {
    try {
      if (dex?.pool_id != null) pool = await viewOn<RefPool>(pr?.dex ?? 'ref-finance-101.testnet', 'get_pool', { pool_id: dex.pool_id })
      buys = await view<BuybackV[]>('get_buybacks')
      loadErr = ''
    } catch (e: any) { loadErr = String(e.message || e) }
  }
  onMount(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t) })
  $effect(() => { if (open && dex?.pool_id != null && !pool) load() })

  // pool reserves by token
  const amt = (id: string) => { const i = pool?.token_account_ids.indexOf(id) ?? -1; return i >= 0 ? B(pool!.amounts[i]) : 0n }
  const poolNear = $derived(pool ? amt(pr?.wnear ?? 'wrap.testnet') : 0n)
  const poolTok = $derived(pool ? amt(CONTRACT) : 0n)
  const priceOf = (near: bigint, tok: bigint) => (tok > 0n ? Number(near) / 1e24 / (Number(tok) / 1e18) : 0)
  const price = $derived(priceOf(poolNear, poolTok))
  const p4 = (x: number) => (x === 0 ? '—' : x.toPrecision(4).replace(/\.?0+$/, ''))
  const lockedPct = $derived(pool && B(pool.shares_total_supply) > 0n ? (Number(B(dex?.shares)) / Number(B(pool.shares_total_supply))) * 100 : 0)

  const when = (ns: string | bigint) => {
    const d = new Date(Number(B(ns) / 1_000_000n))
    const today = d.toDateString() === new Date().toDateString()
    return d.toLocaleString(undefined, today ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  }
  const nextIn = $derived(dex ? Math.max(0, Number(B(dex.next_buyback_at) / 1_000_000n) - game.now) : 0)
  const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`
  const everyMin = $derived(pr ? Math.round(Number(B(pr.buyback_every_ns) / 1_000_000_000n) / 60) : 0)
  const hm = (ms: number) => (ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)} h ${Math.floor((ms % 3_600_000) / 60_000)} min` : mmss(ms))
  const buyNow = $derived(B(dex?.buyback_now))
  // Buybacks before the rule changed (contract upgrade) ran under the old rule: every 10 minutes,
  // up to 0.5 NEAR each. They stay listed and counted (that NEAR was spent, those BEFEWER burned).
  const OLD_RULE_UNTIL: Record<string, bigint> = { 'v6.befewer.testnet': BigInt(Date.UTC(2026, 10, 7, 16, 32, 46)) * 1_000_000n }
  const cut = OLD_RULE_UNTIL[CONTRACT] ?? 0n
  const isOld = (b: BuybackV) => B(b.at) < cut
  const oldCount = $derived(Math.max(0, (dex?.buybacks ?? 0) - (buys ?? []).filter(b => !isOld(b) && B(b.spent) > 0n).length))
  const firstOld = $derived((buys ?? []).findIndex(isOld))
  const listed = $derived((buys ?? []).filter(b => B(b.spent) > 0n).length)
  const earlier = $derived(Math.max(0, (dex?.buybacks ?? 0) - listed))

  // treasury NEAR: everything collected = what it went to
  const nearRows = $derived(st && dex ? [
    { k: 'Put into the pool', v: B(dex.near_amount), note: 'when it opened' },
    { k: 'Pool setup', v: open || dex.step > 0 ? GRADUATION_COST : 0n, note: 'storage at wrap.near and Ref Finance (fixed in the contract)' },
    { k: 'Spent on buybacks', v: B(dex.bought_near), note: '' },
    { k: 'Waiting as wNEAR', v: B(dex.held_wnear), note: 'the pool did not take it yet; next buyback uses it first' },
    { k: 'In the treasury now', v: B(st.treasury), note: `${fmtN(st.treasury_spendable)} can be spent now` },
  ] : [])
  const nearLeft = $derived(st ? B(st.treasury_in) - nearRows.reduce((t, r) => t + r.v, 0n) : 0n)

  // BEFEWER, the contract's own identities (its tests check them after every step):
  // emitted + what flowed back to the pot (rounding dust, refining fees nobody held) = mined + pot
  // in circulation + burned = claimed + pool seed
  const emitted = $derived(B(st?.issued) - B(dex?.seed))
  const back = $derived(B(st?.refine_to_pot) + B(st?.dust_to_pot))
  const issuedOk = $derived(!!st && emitted + back === B(st.mined) + B(st.pot))
  const supplyOk = $derived(!!st && !!dex && B(st.total_supply) + B(st.total_burned) === B(st.claimed) + B(dex.seed))
</script>

<header class="ph">
  <h1>Pool</h1>
  <p class="muted">The treasury's BEFEWER/NEAR pool on Ref Finance, the buybacks that burn BEFEWER, and where every NEAR and BEFEWER went.</p>
</header>

{#if !st || !dex || !pr}
  <div class="card empty">Loading…</div>
{:else}
  <!-- the pool -->
  <section class="card block">
    {#if open}
      <div class="top">
        <div>
          <div class="eyebrow">Pool #{dex.pool_id} · open since {when(dex.graduated_at)}</div>
          <div class="price num">1 BEFEWER = {p4(price)} <span class="faint">NEAR</span></div>
        </div>
        <a class="btn small" href="https://testnet.ref.finance/pool/{dex.pool_id}" target="_blank" rel="noopener">Open on Ref Finance ↗</a>
      </div>
      <div class="grid">
        <div><div class="eyebrow">In the pool now</div><div class="v num">{fmtN(poolNear, 2)} <span class="faint">NEAR</span></div><div class="v num">{fmt(poolTok)} <span class="faint">BEFEWER</span></div></div>
        <div><div class="eyebrow">Opened with</div><div class="v num">{fmtN(dex.near_amount, 2)} <span class="faint">NEAR</span></div><div class="v num">{fmt(dex.seed)} <span class="faint">BEFEWER</span></div><div class="faint small">the treasury at {fmtN(pr.graduate_at)} NEAR, plus as many new BEFEWER as had been mined</div></div>
        <div><div class="eyebrow">Locked</div><div class="v num">{lockedPct ? `${lockedPct.toFixed(4).replace(/\.?0+$/, '')}%` : '—'}</div><div class="faint small">of the pool's shares belong to the contract, which has no method to take liquidity out</div></div>
      </div>
    {:else}
      <div class="eyebrow">Pool · not open yet</div>
      <div class="price num">{fmtN(st.treasury)} <span class="faint">of {fmtN(pr.graduate_at)} NEAR</span></div>
      <div class="bar" aria-label="treasury progress"><span style="width:{Math.min(100, (Number(B(st.treasury)) / Number(B(pr.graduate_at))) * 100)}%"></span></div>
      <p class="fine">At {fmtN(pr.graduate_at)} NEAR the contract opens the pool with all of it, plus as many new BEFEWER as have been mined. Anyone can push it through the 5 steps.</p>
      <ol class="steps">
        {#each ['Wrap the NEAR', 'Create the pool', 'Send the NEAR', 'Send the BEFEWER', 'Add the liquidity'] as s, i}
          <li class:done={dex.step > i} class:now={dex.step === i && dex.busy}>{s}</li>
        {/each}
      </ol>
    {/if}
    {#if loadErr}<p class="faint small">Could not read the pool right now: {loadErr}</p>{/if}
  </section>

  <!-- buybacks -->
  <section class="card block">
    <h2>Buybacks</h2>
    <div class="grid">
      <div><div class="eyebrow">Burned</div><div class="v num burn"><Icon name="flame" size={16} /> {fmt(dex.bought_burned)} <span class="faint">BEFEWER</span></div></div>
      <div><div class="eyebrow">Spent</div><div class="v num">{fmtN(dex.bought_near)} <span class="faint">NEAR</span></div><div class="faint small">{dex.buybacks} buyback{dex.buybacks === 1 ? '' : 's'}{oldCount ? ` (${oldCount === dex.buybacks ? 'all' : oldCount} under the old rule)` : ''} · average {p4(priceOf(B(dex.bought_near), B(dex.bought_burned)))} NEAR per BEFEWER</div></div>
      <div><div class="eyebrow">Next</div>
        {#if !open}<div class="v">after the pool opens</div>
        {:else if dex.busy}<div class="v">in flight now</div>
        {:else if buyNow < MIN_BUYBACK}<div class="v">waiting for the treasury</div><div class="faint small">1/365 of it is {fmtN(buyNow, 5)} NEAR; buybacks start at 0.1 (a treasury of 36.5 NEAR)</div>
        {:else if nextIn > 0}<div class="v num">in {hm(nextIn)}</div><div class="faint small">{fmtN(buyNow)} NEAR (1/365 of the treasury)</div>
        {:else}<div class="v num">due now</div><div class="faint small">{fmtN(buyNow)} NEAR (1/365 of the treasury)</div>{/if}
      </div>
      <div><div class="eyebrow">Price limit</div><div class="v num">{open ? p4(Number(B(dex.buyback_ceiling)) / 1e24) : '—'} <span class="faint">NEAR per BEFEWER</span></div><div class="faint small">25% above the last buyback's price; 25% more after a refused one</div></div>
    </div>
    <p class="fine">Every {everyMin} minutes anyone can make the contract spend 1/365 of the treasury's NEAR on BEFEWER from the pool and burn all of it, as long as that 1/365 is at least 0.1 NEAR (so gas stays small). It never pays more than the price limit, so pumping the price just before a buyback gets it refused: the NEAR waits for the next one. The keeper calls it when it is due.</p>
    {#if buys?.length}
      <table class="tab">
        <thead><tr><th>When</th><th class="r">NEAR used</th><th class="r">BEFEWER burned</th><th class="r">Price</th></tr></thead>
        <tbody>
          {#each buys as b, i}
            {#if i === firstOld}<tr class="divider"><td colspan="4">Old rule below: every 10 minutes, up to 0.5 NEAR each (until {when(cut)})</td></tr>{/if}
            <tr class:old={isOld(b)}>
              <td>{when(b.at)}</td>
              {#if B(b.spent) === 0n}<td class="r faint" colspan="3">refused (price above the limit): its {fmtN(b.near_in)} NEAR waits as wNEAR for the next one</td>
              {:else}
                <td class="r num">{fmtN(b.spent)}{#if B(b.spent) < B(b.near_in)}<span class="faint sub">of {fmtN(b.near_in)} sent</span>{/if}</td>
                <td class="r num">{B(b.burned) > 0n ? fmt(b.burned) : '…'}</td>
                <td class="r num">{B(b.burned) > 0n ? p4(priceOf(B(b.spent), B(b.burned))) : '—'}</td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
    {#if earlier > 0}<p class="faint small">{earlier} earlier buyback{earlier === 1 ? ' is' : 's are'} in the totals above but not listed (old rule too): the contract started keeping the list on Nov 7.</p>{/if}
    {#if buys && !buys.length && !earlier}<p class="faint small">No buybacks yet.</p>{/if}
  </section>

  <!-- treasury NEAR -->
  <section class="card block">
    <h2>Where the treasury's NEAR went</h2>
    <p class="fine">It collects {100 - (pr.reveal_bounty_bps ?? 0) / 100}% of every bet's fee (the other {(pr.reveal_bounty_bps ?? 0) / 100}% pays whoever reveals the bet: the player's own page or a keeper), the bigger side's extra stake, and bets that were never opened. Players' balances are never part of it.</p>
    <table class="tab books">
      <tbody>
        <tr class="sum"><td>Collected so far</td><td class="r num">{fmtN(st.treasury_in)}</td></tr>
        {#each nearRows as r}
          <tr><td>{r.k}{#if r.note}<span class="faint sub">{r.note}</span>{/if}</td><td class="r num">{fmtN(r.v)}</td></tr>
        {/each}
      </tbody>
    </table>
    <p class="check small" class:bad={nearLeft !== 0n}>{nearLeft === 0n ? '✓ The rows add up to what was collected.' : `${fmtN(nearLeft)} NEAR is not explained by the rows above.`}</p>
  </section>

  <!-- BEFEWER -->
  <section class="card block">
    <h2>Every BEFEWER</h2>
    <table class="tab books">
      <tbody>
        <tr class="sum"><td>Issued so far<span class="faint sub">of {fmt(st.max_supply)} max; issuance stops there</span></td><td class="r num">{fmt(st.issued, 2)}</td></tr>
        <tr><td>Pool seed<span class="faint sub">minted once when the pool opened</span></td><td class="r num">{fmt(dex.seed, 2)}</td></tr>
        <tr><td>Mined by streaks<span class="faint sub">{fmt(st.unrefined_total, 2)} still unrefined in the game, {fmt(st.claimed, 2)} claimed to wallets; claiming paid {fmt(st.refine_fees, 2)} in refining fees to the other holders</span></td><td class="r num">{fmt(st.mined, 2)}</td></tr>
        <tr><td>Waiting in the pot<span class="faint sub">for the next streak winner</span></td><td class="r num">{fmt(st.pot, 2)}</td></tr>
      </tbody>
    </table>
    <table class="tab books">
      <tbody>
        <tr class="sum"><td>In circulation<span class="faint sub">{open ? `${fmt(poolTok, 2)} in the pool, the rest in wallets` : 'in wallets'}</span></td><td class="r num">{fmt(st.total_supply, 2)}</td></tr>
        <tr><td>Pool seed</td><td class="r num">{fmt(dex.seed, 2)}</td></tr>
        <tr><td>Claimed to wallets<span class="faint sub">mined BEFEWER enters circulation only when claimed</span></td><td class="r num">{fmt(st.claimed, 2)}</td></tr>
        <tr><td>Burned by buybacks</td><td class="r num burn">−{fmt(st.total_burned, 2)}</td></tr>
      </tbody>
    </table>
    <p class="check small" class:bad={!issuedOk || !supplyOk}>
      {issuedOk && supplyOk ? '✓ Both tables add up: issued = seed + mined + pot, and in circulation = seed + claimed − burned.' : 'These do not add up right now (a round or a claim may be half-way); reload in a few seconds.'}
      {#if fmt(back) !== '0'}<span class="faint">({fmt(back)} BEFEWER of rounding and unheld refining fees went back to the pot and was mined again, so it counts once.)</span>{/if}
    </p>
  </section>
{/if}

<style>
  .ph { margin: 4px 0 16px }
  .ph h1 { font-size: 30px; font-weight: 800 }
  .ph p { margin: 4px 0 0 }
  .block { padding: 18px; margin-bottom: 16px }
  .block h2 { font-size: 18px; margin: 0 0 12px }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap }
  .price { font-size: 28px; font-weight: 800; margin: 4px 0 2px }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px 18px; margin-top: 14px }
  .v { font-size: 17px; font-weight: 700; display: flex; align-items: center; gap: 5px; flex-wrap: wrap }
  .small { font-size: 12.5px }
  .fine { font-size: 13.5px; color: var(--fg-2); line-height: 1.5; margin: 12px 0 0 }
  .burn { color: var(--burn, #e07a5f) }
  .bar { height: 8px; border-radius: 4px; background: var(--surface); overflow: hidden; margin: 10px 0 }
  .bar span { display: block; height: 100%; background: var(--brand) }
  .steps { margin: 10px 0 0; padding-left: 20px; color: var(--fg-3); font-size: 14px; display: grid; gap: 4px }
  .steps .done { color: var(--fg) } .steps .done::marker { content: '✓  ' }
  .steps .now { color: var(--brand); font-weight: 700 }
  .tab { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 12px }
  .tab th { font-size: 11.5px; color: var(--fg-3); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; text-align: left; padding: 4px 8px 4px 0 }
  .tab td { padding: 7px 8px 7px 0; border-top: 1px solid var(--line-soft); vertical-align: top }
  .tab .r { text-align: right; white-space: nowrap }
  .tab th.r { white-space: normal }
  .tab td.r.faint { white-space: normal; text-align: left }
  .tab .sub { display: block; font-size: 12px; white-space: normal }
  .books tr.sum td { font-weight: 700 }
  .tab tr.divider td { padding: 10px 0 6px; font-size: 12px; font-weight: 700; color: var(--fg-3); text-transform: uppercase; letter-spacing: 0.05em; border-top: 2px solid var(--line) }
  .tab tr.old td { color: var(--fg-2) }
  .check { margin: 10px 0 0; color: var(--good, #8fbf7f) }
  .check.bad { color: var(--burn, #e07a5f) }
  .empty { padding: 30px; text-align: center; color: var(--fg-2) }
</style>
