<script lang="ts">
  import Icon from '../lib/Icon.svelte'
  import { CONTRACT, EXPLORER } from '../chain'
  import { QUESTIONS } from '../questions'
  import { game, fmt, fmtN, NPCS } from '../game.svelte'

  const st = $derived(game.status)
  const pr = $derived(game.params)
  const feePct = $derived((pr?.fee_bps ?? 0) / 100)
  const need = $derived(pr?.streak_min ?? 3)
  const everyMin = $derived(pr ? Math.round(Number(BigInt(pr.buyback_every_ns) / 1_000_000_000n) / 60) : 0)
  const mins = $derived(game.params ? Number(BigInt(game.params.commit_ns) / 1_000_000_000n) : 0)
  const revealS = $derived(game.params ? Number(BigInt(game.params.reveal_ns) / 1_000_000_000n) : 0)
</script>

<section class="hero">
  <div class="eyebrow">How it works</div>
  <h1>Be fewer.</h1>
  <p class="lede">A sealed-bid minority game played with NEAR that mines a capped token. Every round asks a question with two answers. The answer with <b>less NEAR</b> on it wins: every bet on it earns <b>+100%</b> (bet 0.1, get 0.2 back). Win {need} rounds in a row and you start mining <b>$BEFEWER</b>.</p>
</section>

<section class="steps">
  <div class="card step"><span class="si"><Icon name="eye" size={22} /></span><h3>1 · Read the crowd</h3><p>Don't pick what you like. Pick the answer you think less NEAR will be on, knowing everyone else is trying to do the same.</p></div>
  <div class="card step"><span class="si"><Icon name="lock" size={22} /></span><h3>2 · Seal your bet</h3><p>Bet up to 25% of your game balance, plus a {feePct}% fee. Your answer is sealed: the chain stores only a fingerprint, and a drand timelock keeps it shut until betting closes.</p></div>
  <div class="card step"><span class="si"><Icon name="flame" size={22} /></span><h3>3 · The smaller side wins +100%</h3><p>When the reveal ends, everyone on the side with less NEAR gets their stake back plus the same amount again. The other side loses its stake. A tie or a one-sided round refunds everyone, fee included.</p></div>
  <div class="card step"><span class="si"><Icon name="spark" size={22} /></span><h3>4 · Streaks mine BEFEWER</h3><p>Each round adds {fmt(pr?.reward_per_round ?? '0')} BEFEWER to a pot. A win that completes {need} wins in a row takes a share of it: 1 share per 0.001 NEAR staked at {need} in a row, 2 at {need + 1}, and so on. If nobody qualifies, the pot rolls over. Mined BEFEWER stays unrefined in the game: claiming it to your wallet costs {(pr?.refine_fee_bps ?? 0) / 100}%, shared among everyone still holding unrefined BEFEWER (like ORE's refining fee).</p></div>
  <div class="card step"><span class="si"><Icon name="shield" size={22} /></span><h3>5 · The treasury backs the token</h3><p>Fees, the gap between the sides and unopened bets go to the treasury. At {fmtN(st?.graduate_at ?? '0')} NEAR it opens a BEFEWER/NEAR pool on Ref Finance and locks the pool shares forever. After that it buys BEFEWER from the pool every {everyMin} minutes and burns it.</p></div>
</section>

<section class="card block">
  <h2>Why nobody can cheat</h2>
  <div class="facts">
    <div class="fact"><Icon name="lock" /><div><b>Nobody sees sides early.</b> A bet is stored as sha256 of your account, the round, your answer and a random secret. It can't be reversed, and changing the answer changes the fingerprint.</div></div>
    <div class="fact"><Icon name="clock" /><div><b>It opens itself.</b> Your browser also locks the answer to a <a href="https://drand.love" target="_blank" rel="noopener">drand</a> round published when betting closes. After that anyone can open it and reveal it for you, but only to the answer you sealed. You never have to come back.</div></div>
    <div class="fact"><Icon name="shield" /><div><b>No owner, no admin.</b> Every rule above is enforced by the contract. Its parameters were fixed at launch and there is no method that can change them or move anyone's NEAR. Nothing mints BEFEWER except streak wins and the one-time pool seed, and issuance stops at {fmt(st?.max_supply ?? '0')}.</div></div>
    <div class="fact"><Icon name="dice" /><div><b>Farming streaks costs money.</b> Betting the same amount on both sides from two accounts always loses exactly both fees, whichever side wins. Betting against yourself alone voids the round: free, but a void is not a win, so it never builds a streak. The contract tests check both.</div></div>
    <div class="fact"><Icon name="users" /><div><b>Whales are the crowd.</b> A big bet makes its own side bigger, so large players win less often. Splitting a stake across many accounts changes nothing: outcomes and mining shares are weighted by NEAR, not by accounts.</div></div>
    <div class="fact"><Icon name="lock" /><div><b>The treasury can't touch players' NEAR.</b> It only spends what is left after everything owed to players, the NEAR locked in bets, the contract's storage and a 1 NEAR safety reserve.</div></div>
  </div>
</section>

<section class="card block">
  <h2>The token and the treasury</h2>
  <p class="muted small">$BEFEWER started at zero supply. It is only ever mined by streaks (plus the one-time pool seed) and only ever burned by buybacks. "Supply now" counts BEFEWER claimed to wallets; mined BEFEWER still unrefined in the game is not in it yet.</p>
  <div class="tok">
    <div><div class="eyebrow">Supply now</div><div class="v num">{fmt(st?.total_supply ?? '0')}</div><div class="faint small">{fmt(st?.issued ?? '0')} of {fmt(st?.max_supply ?? '0')} issued</div></div>
    <div><div class="eyebrow">Mined</div><div class="v num">{fmt(st?.mined ?? '0')}</div><div class="faint small">{fmt(st?.unrefined_total ?? '0')} still unrefined · {fmt(st?.refine_fees ?? '0')} paid in refining fees · {fmt(st?.pot ?? '0')} in the pot</div></div>
    <div><div class="eyebrow">Treasury</div><div class="v num gold">{fmtN(st?.treasury ?? '0', 2)}</div><div class="faint small">NEAR · {fmtN(st?.treasury_in ?? '0', 2)} in so far</div></div>
    <div><div class="eyebrow">Pool</div><div class="v num">{st?.dex.stage === 'open' ? `#${st?.dex.pool_id}` : (st?.dex.stage ?? '—')}</div><div class="faint small">{st?.dex.buybacks ?? 0} buybacks · {fmt(st?.dex.bought_burned ?? '0')} BEFEWER burned</div></div>
  </div>
</section>

<section class="card block">
  <h2>Who you're playing against</h2>
  <p class="muted small">Four bots with their own testnet wallets keep every round alive. They follow the same rules as you, and you can copy their strategies on the Autopilot page.</p>
  <div class="npcs">
    {#each NPCS as n}
      {@const p = game.npcs[n.id]}
      <div class="npc">
        <div class="nh"><b>{n.name}</b>{#if p}<span class="num faint small">{fmtN(p.balance, 2)} NEAR · {fmt(BigInt(p.tokens) + BigInt(p.unrefined) + BigInt(p.refined))} BEFEWER</span>{/if}</div>
        <div class="small muted">{n.about}</div>
        {#if p}<div class="small num">Won {p.wins} · lost {p.losses} · streak {p.streak}</div>{/if}
      </div>
    {/each}
  </div>
</section>

<section class="card block">
  <h2>Check it yourself</h2>
  <ul class="links">
    <li>Contract (game + token): <a href="{EXPLORER}/address/{CONTRACT}" target="_blank" rel="noopener">{CONTRACT}</a> on NEAR testnet. DEX: Ref Finance <code>{pr?.dex ?? ''}</code>.</li>
    <li>This demo runs a round every {Math.round(mins / 60) || mins} {mins >= 60 ? 'minutes' : 'seconds'} with a {revealS}-second reveal. The mechanic is designed for one round a day.</li>
    <li>Questions come from a fixed public list of {QUESTIONS.length}; round <i>r</i> uses question <i>r</i> mod {QUESTIONS.length}. The contract only knows A and B, so the wording can't change who wins.</li>
    <li>A fingerprint is <code>sha256("fewer:&lt;account&gt;:&lt;round&gt;:&lt;A|B&gt;:&lt;secret&gt;")</code>. After a round, every answer and secret is public, so anyone can recompute it.</li>
  </ul>
  <p class="note">Testnet demo built for NEAR HACKATHON. Testnet NEAR and testnet BEFEWER are free and have no monetary value. There is no token sale and no team allocation.</p>
</section>

<style>
  .hero { padding: 18px 2px 22px }
  .hero h1 { font-size: clamp(40px, 9vw, 64px); font-weight: 850; letter-spacing: -0.03em; margin: 4px 0 8px; color: var(--brand) }
  .lede { font-size: 18px; color: var(--fg-2); max-width: 680px; margin: 0; line-height: 1.55 }
  .lede b { color: var(--fg) }
  .steps { display: grid; gap: 12px; margin-bottom: 16px }
  @media (min-width: 860px) { .steps { grid-template-columns: repeat(3, minmax(0, 1fr)) } }
  .step { padding: 18px }
  .step h3 { font-size: 16px; margin: 12px 0 6px }
  .step p { margin: 0; color: var(--fg-2); font-size: 14.5px; line-height: 1.55 }
  .si { width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center; background: rgba(232, 182, 94, 0.1); color: var(--brand) }
  .block { padding: 20px; margin-bottom: 16px }
  .block h2 { font-size: 18px; font-weight: 750; margin-bottom: 8px }
  .small { font-size: 13.5px }
  .facts { display: grid; gap: 14px; margin-top: 12px }
  .fact { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 12px; font-size: 15px; line-height: 1.55; color: var(--fg-2) }
  .fact b { color: var(--fg) }
  .fact :global(svg) { color: var(--brand); margin-top: 2px }
  .tok { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 12px }
  @media (min-width: 860px) { .tok { grid-template-columns: repeat(4, minmax(0, 1fr)) } }
  .v { font-size: 22px; font-weight: 800; margin-top: 2px; overflow-wrap: anywhere }
  .npcs { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; margin-top: 12px }
  .npc { padding: 12px 14px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--line-soft); display: grid; gap: 3px }
  .nh { display: flex; justify-content: space-between; gap: 8px }
  .links { margin: 8px 0 0; padding-left: 18px; display: grid; gap: 8px; color: var(--fg-2); font-size: 14.5px; line-height: 1.55 }
  code { font-family: var(--mono); font-size: 12.5px; background: var(--surface-2); padding: 1px 5px; border-radius: 5px; overflow-wrap: anywhere }
  .note { margin: 14px 0 0; padding: 10px 12px; border-radius: 10px; background: rgba(232, 182, 94, 0.07); border: 1px solid rgba(232, 182, 94, 0.25); font-size: 13.5px; color: var(--fg-2) }
  .gold { color: var(--brand) }
</style>
