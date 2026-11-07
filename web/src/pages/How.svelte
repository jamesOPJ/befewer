<script lang="ts">
  import Icon from '../lib/Icon.svelte'
  import { CONTRACT, EXPLORER } from '../chain'
  import { QUESTIONS } from '../questions'
  import { game, fmt, fmtN, NPCS } from '../game.svelte'

  const st = $derived(game.status)
  const pr = $derived(game.params)
  const feePct = $derived((pr?.fee_bps ?? 0) / 100)
  const need = $derived(pr?.streak_min ?? 3)
  const mins = $derived(game.params ? Number(BigInt(game.params.commit_ns) / 1_000_000_000n) : 0)
  const revealS = $derived(game.params ? Number(BigInt(game.params.reveal_ns) / 1_000_000_000n) : 0)
</script>

<section class="hero">
  <div class="eyebrow">What $BEFEWER is</div>
  <h1>Hard money, mined by the minority.</h1>
  <p class="lede"><b>$BEFEWER is a store of value on NEAR</b>: a token with a fixed cap that nobody can mint for themselves. The game is only how it gets mined. Be on the side with less NEAR {need} rounds in a row, and a share of the new coins is yours.</p>
</section>

<section class="card block">
  <h2>Why it is built to hold value</h2>
  <div class="facts">
    <div class="fact"><Icon name="lock" /><div><b>Capped at {fmt(pr?.max_supply ?? '0')}.</b> {fmt(pr?.reward_per_round ?? '0')} BEFEWER is added to the pot each round, and issuance stops at the cap.</div></div>
    <div class="fact"><Icon name="users" /><div><b>No premine, no team share.</b> Supply started at zero, and every coin is mined by a winning streak. The only other mint was the one-time pool seed, paired with the treasury's NEAR as pool liquidity that can never be withdrawn.</div></div>
    <div class="fact"><Icon name="bolt" /><div><b>Mining costs something.</b> Coins come only from streaks, and every bet pays a fee. Like proof of work, except the work is reading the crowd.</div></div>
    <div class="fact"><Icon name="shield" /><div><b>The game's revenue backs it.</b> Fees and the bigger side's extra stake fill the treasury. It opened a NEAR pool whose liquidity can never be taken out, and keeps buying BEFEWER there and burning it (<a href="#/pool">see the pool</a>).</div></div>
    <div class="fact"><Icon name="spark" /><div><b>Holding pays.</b> Claiming mined coins to a wallet costs {(pr?.refine_fee_bps ?? 0) / 100}%, shared by everyone still holding theirs unclaimed.</div></div>
  </div>
  <p class="muted small note">On testnet, NEAR and BEFEWER are free and worth nothing. The rules are the ones a mainnet launch would use.</p>
</section>

<h2 class="sec">The game is how it is mined</h2>
<p class="secp">Every round asks a question with two answers. The answer with <b>less NEAR</b> on it wins: every bet on it earns <b>+100%</b> (bet 0.1, get 0.2 back). Win {need} rounds in a row and you start mining <b>$BEFEWER</b>.</p>

<section class="steps">
  <div class="card step"><span class="si"><Icon name="eye" size={22} /></span><h3>1 · Read the crowd</h3><p>Don't pick what you like. Pick the answer you think less NEAR will be on, knowing everyone else is trying to do the same.</p></div>
  <div class="card step"><span class="si"><Icon name="lock" size={22} /></span><h3>2 · Seal your bet</h3><p>Bet any amount from 0.01 NEAR that your game balance covers, plus a {feePct}% fee. Your answer is sealed: the chain stores only a fingerprint, and a drand timelock keeps it shut until betting closes.</p></div>
  <div class="card step"><span class="si"><Icon name="flame" size={22} /></span><h3>3 · The smaller side wins +100%</h3><p>When the reveal ends, everyone on the side with less NEAR gets their stake back plus the same amount again. The other side loses its stake. A tie or a one-sided round refunds everyone (minus the reveal reward, if someone else revealed your bet).</p></div>
  <div class="card step"><span class="si"><Icon name="spark" size={22} /></span><h3>4 · Streaks mine BEFEWER</h3><p>Each round adds {fmt(pr?.reward_per_round ?? '0')} BEFEWER to a pot. A win that completes {need} wins in a row takes a share of it: 1 share per 0.001 NEAR staked at {need} in a row, 2 at {need + 1}, and so on. If nobody qualifies, the pot rolls over. Mined BEFEWER stays unrefined in the game: claiming it to your wallet costs {(pr?.refine_fee_bps ?? 0) / 100}%, shared among everyone still holding unrefined BEFEWER (like ORE's refining fee).</p></div>
  <div class="card step"><span class="si"><Icon name="shield" size={22} /></span><h3>5 · The treasury backs the token</h3><p>Fees, the gap between the sides and unopened bets go to the treasury. At {fmtN(st?.graduate_at ?? '0')} NEAR it opens a BEFEWER/NEAR pool on Ref Finance and locks the pool shares forever. After that, every {pr ? Math.round(Number(BigInt(pr.buyback_every_ns) / 1_000_000_000n) / 60) : 0} minutes it buys BEFEWER from the pool with 1/365 of its NEAR (when that is at least 0.1 NEAR), never more than 25% above the last buyback's price, and burns it.</p></div>
</section>

<section class="card block">
  <h2>Why nobody can cheat</h2>
  <div class="facts">
    <div class="fact"><Icon name="lock" /><div><b>Nobody sees sides early.</b> A bet is stored as sha256 of your account, the round, your answer and a random secret. It can't be reversed, and changing the answer changes the fingerprint.</div></div>
    <div class="fact"><Icon name="bolt" /><div><b>Whoever reveals gets paid.</b> {(pr?.reveal_bounty_bps ?? 0) / 100}% of each bet's fee goes to whoever reveals it. If your page is open, it reveals your own bet and you keep that part; otherwise any keeper can earn it, so nobody depends on one server.</div></div>
    <div class="fact"><Icon name="users" /><div><b>One account, many slots.</b> An account can run any number of slots: independent bettors with their own bet each round and their own streak, sharing one balance. Each extra slot holds 0.002 NEAR of storage, refunded when it closes. The Autopilot runs one rule set per slot.</div></div>
    <div class="fact"><Icon name="clock" /><div><b>It opens itself.</b> Your browser also locks the answer to a <a href="https://drand.love" target="_blank" rel="noopener">drand</a> round published when betting closes. After that anyone can open it and reveal it for you, but only to the answer you sealed. You never have to come back.</div></div>
    <div class="fact"><Icon name="shield" /><div><b>No admin methods.</b> Every rule above is enforced by the contract, and it has no method that can change the rules or move anyone's NEAR. <i>On testnet the contract account still holds a deploy key, so the code can still be upgraded while the game is built; on mainnet that key will be deleted, after which nobody can change it.</i> Nothing mints BEFEWER except streak wins and the one-time pool seed, and issuance stops at {fmt(st?.max_supply ?? '0')}.</div></div>
    <div class="fact"><Icon name="dice" /><div><b>Farming streaks costs money.</b> Betting the same amount on both sides from two accounts always loses exactly both fees, whichever side wins. Betting against yourself alone voids the round: it only costs the round's record (0.0029 NEAR), but a void is not a win, so it never builds a streak. The contract tests check both.</div></div>
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
    <div><div class="eyebrow"><a href="#/pool">Pool</a></div><div class="v num">{st?.dex.stage === 'open' ? `#${st?.dex.pool_id}` : (st?.dex.stage ?? '—')}</div><div class="faint small">{st?.dex.buybacks ?? 0} buybacks · {fmt(st?.dex.bought_burned ?? '0')} BEFEWER burned</div></div>
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
    <li>A fingerprint is <code>sha256("fewer:&lt;account&gt;:&lt;slot&gt;:&lt;round&gt;:&lt;A|B&gt;:&lt;secret&gt;")</code>. After a round, every answer and secret is public, so anyone can recompute it.</li>
  </ul>
  <p class="note">Testnet demo built for NEAR HACKATHON. Testnet NEAR and testnet BEFEWER are free and have no monetary value. There is no token sale and no team allocation.</p>
</section>

<style>
  .hero { padding: 18px 2px 22px }
  .hero h1 { font-size: clamp(40px, 9vw, 64px); font-weight: 850; letter-spacing: -0.03em; margin: 4px 0 8px; color: var(--brand) }
  .lede { font-size: 18px; color: var(--fg-2); max-width: 680px; margin: 0; line-height: 1.55 }
  .lede b { color: var(--fg) }
  .sec { font-size: 22px; font-weight: 800; margin: 26px 2px 6px }
  .secp { color: var(--fg-2); max-width: 680px; margin: 0 2px 14px; line-height: 1.55 }
  .secp b { color: var(--fg) }
  .note { margin: 14px 0 0 }
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
