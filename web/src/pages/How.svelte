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
  // years to the cap if every round is played: cap / per-round x round length
  const capYears = $derived(pr && BigInt(pr.reward_per_round) > 0n ? (Number(BigInt(pr.max_supply) / BigInt(pr.reward_per_round)) * mins) / (365 * 86400) : 0)
  // the worked example: a 0.1 NEAR bet, with this contract's fee and reveal reward
  const bountyPct = $derived((pr?.reveal_bounty_bps ?? 0) / 100)
  const treasuryPct = $derived(100 - (pr?.reveal_bounty_bps ?? 0) / 100) // of each revealed bet's fee
  const ex = $derived.by(() => {
    const stake = 0.1, fee = (stake * (pr?.fee_bps ?? 0)) / 10_000
    const record = 0.00291 // a round's record: 291 bytes of storage
    return { stake, fee, bounty: (fee * (pr?.reveal_bounty_bps ?? 0)) / 10_000, record, share: (record * stake) / 4 }
  })
  const n = (x: number) => (Math.round(x * 1e6) / 1e6).toString()
</script>

<section class="hero">
  <div class="eyebrow">What $BEFEWER is</div>
  <h1>Hard money, mined by the minority.</h1>
  <p class="lede"><b>$BEFEWER is a store of value on NEAR</b>: a token with a fixed cap that nobody can mint for themselves. The game is only how it gets mined. Be on the side with less NEAR {need} rounds in a row, and a share of the new coins is yours.</p>
</section>

<section class="card block">
  <h2>Why it is built to hold value</h2>
  <div class="facts">
    <div class="fact"><Icon name="lock" /><div><b>Never more than {fmt(pr?.max_supply ?? '0')}.</b> {fmt(pr?.reward_per_round ?? '0')} BEFEWER is added to the pot each round (one every {Math.round(mins / 60)} minutes), so the cap is reached after about {capYears.toFixed(1)} years at the earliest (every burn pushes it later). Like ORE, the cap counts what exists: BEFEWER burned by buybacks can be mined again, so mining never ends.</div></div>
    <div class="fact"><Icon name="users" /><div><b>No premine, no team share.</b> Supply started at zero, and every coin is mined by a winning streak. The only other mint was the one-time pool seed, paired with the treasury's NEAR as pool liquidity that can never be withdrawn.</div></div>
    <div class="fact"><Icon name="bolt" /><div><b>Mining costs something.</b> Coins come only from streaks, and every bet pays a fee. Like proof of work, except the work is reading the crowd.</div></div>
    <div class="fact"><Icon name="shield" /><div><b>The game's revenue backs it.</b> Its {treasuryPct}% of every fee and the bigger side's extra stake fill the treasury. It opened a NEAR pool whose liquidity can never be taken out, and keeps buying BEFEWER there and burning it: a steady buyer paid for by the game. A burned coin is out of supply until mining earns it again (<a href="#/pool">see the pool</a>).</div></div>
    <div class="fact"><Icon name="spark" /><div><b>Holding pays.</b> Claiming mined coins to a wallet costs {(pr?.refine_fee_bps ?? 0) / 100}%, shared by everyone still holding theirs unclaimed.</div></div>
  </div>
  <p class="muted small note">On testnet, NEAR and BEFEWER are free and worth nothing. The rules are the ones a mainnet launch would use.</p>
</section>

<h2 class="sec">The game is how it is mined</h2>
<p class="secp">Every round asks a question with two answers. The answer with <b>less NEAR</b> on it wins: every bet on it earns <b>+100%</b> (bet 0.1, get 0.2 back). Win {need} rounds in a row and you start mining <b>$BEFEWER</b>.</p>

<section class="steps">
  <div class="card step"><span class="si"><Icon name="eye" size={22} /></span><h3>1 · Read the crowd</h3><p>Don't pick what you like. Pick the answer you think less NEAR will be on, knowing everyone else is trying to do the same.</p></div>
  <div class="card step"><span class="si"><Icon name="lock" size={22} /></span><h3>2 · Seal your bet</h3><p>Bet any amount from 0.01 NEAR that your game balance covers, plus a {feePct}% fee: {bountyPct}% of it goes to whoever reveals your bet (your own page if it is open, otherwise a keeper), {treasuryPct}% to the treasury. Your answer is sealed: the chain stores only a fingerprint, and a drand timelock keeps it shut until betting closes.</p></div>
  <div class="card step"><span class="si"><Icon name="flame" size={22} /></span><h3>3 · The smaller side wins +100%</h3><p>When the reveal ends, everyone on the side with less NEAR gets their stake back plus the same amount again. The other side loses its stake. A tie or a one-sided round refunds everyone (minus the reveal reward, if someone else revealed your bet).</p></div>
  <div class="card step"><span class="si"><Icon name="spark" size={22} /></span><h3>4 · Streaks mine BEFEWER</h3><p>Each round adds {fmt(pr?.reward_per_round ?? '0')} BEFEWER to a pot. A win that completes {need} wins in a row takes a share of it: 1 share per 0.001 NEAR staked at {need} in a row, 2 at {need + 1}, and so on. If nobody qualifies, the pot rolls over. Mined BEFEWER stays unrefined in the game: claiming it to your wallet costs {(pr?.refine_fee_bps ?? 0) / 100}%, shared among everyone still holding unrefined BEFEWER (like ORE's refining fee).</p></div>
  <div class="card step"><span class="si"><Icon name="shield" size={22} /></span><h3>5 · The treasury backs the token</h3><p>Its {treasuryPct}% of every fee, the gap between the sides and unopened bets go to the treasury. At {fmtN(st?.graduate_at ?? '0')} NEAR it opens a BEFEWER/NEAR pool on Ref Finance and locks the pool shares forever. After that it spends 1/365 of its spendable NEAR per day (what is left after everything the contract owes players and must keep for storage) buying BEFEWER from the pool, in buys of at least 0.1 NEAR (at most one every {pr ? Math.round(Number(BigInt(pr.buyback_every_ns) / 1_000_000_000n) / 60) : 0} minutes), never more than 25% above the last buyback's price, and burns it. A big inflow is spread over months, not spent in days.</p></div>
</section>

<section class="card block ex">
  <h2>One round, every way it can end</h2>
  <p class="muted small">Say the question is <b>Cats or dogs?</b> When betting closes, 3 NEAR is on Cats and 2 NEAR on Dogs. You bet {n(ex.stake)} NEAR on Dogs and pay the {feePct}% fee ({n(ex.fee)}). Whoever reveals your bet gets {bountyPct}% of that fee ({n(ex.bounty)}): your own page if it is open, otherwise a keeper.</p>
  <div class="outs">
    <div class="out win">
      <div class="oh">You win</div>
      <p>Dogs has less NEAR, so every bet on Dogs pays double.</p>
      <dl>
        <div><dt>Back</dt><dd class="num">{n(2 * ex.stake)} NEAR</dd></div>
        <div><dt>Net</dt><dd class="num good">+{n(ex.stake - ex.fee + ex.bounty)} NEAR <span class="faint">(+{n(ex.stake - ex.fee)} if a keeper revealed it)</span></dd></div>
        <div><dt>Streak</dt><dd>+1. At {need} in a row, this win mines BEFEWER</dd></div>
      </dl>
    </div>
    <div class="out lose">
      <div class="oh">You lose</div>
      <p>Had you picked Cats, the side with more NEAR: the stake pays the winners.</p>
      <dl>
        <div><dt>Back</dt><dd class="num">0</dd></div>
        <div><dt>Net</dt><dd class="num burn">−{n(ex.stake + ex.fee - ex.bounty)} NEAR <span class="faint">(−{n(ex.stake + ex.fee)} if a keeper revealed it)</span></dd></div>
        <div><dt>Streak</dt><dd>back to 0</dd></div>
      </dl>
    </div>
    <div class="out void">
      <div class="oh">Void</div>
      <p>A tie (2 against 2), or nobody on the other side: nobody wins, everyone is refunded.</p>
      <dl>
        <div><dt>Back</dt><dd class="num">{n(ex.stake + ex.fee - ex.share)} NEAR</dd></div>
        <div><dt>Net</dt><dd class="num">−{n(ex.share)} NEAR <span class="faint">(−{n(ex.bounty + ex.share)} if a keeper revealed it)</span></dd></div>
        <div><dt>Streak</dt><dd>unchanged (a void is not a win)</dd></div>
      </dl>
      <p class="faint small">Stake and fee come back, less your part of the round's record ({n(ex.record)} NEAR, split by stake: here 0.1 of 4 NEAR).</p>
    </div>
    <div class="out miss">
      <div class="oh">Never revealed</div>
      <p>Only if your page was closed, the timelock failed and no keeper opened it in time.</p>
      <dl>
        <div><dt>Back</dt><dd class="num">0</dd></div>
        <div><dt>Net</dt><dd class="num burn">−{n(ex.stake + ex.fee)} NEAR</dd></div>
        <div><dt>Streak</dt><dd>back to 0</dd></div>
      </dl>
    </div>
  </div>
  <p class="muted small">Where the NEAR goes: the Dogs bets (2 NEAR) are paid 4 NEAR, their own 2 plus 2 of the 3 on Cats. The extra 1 NEAR on Cats goes to the treasury. Of each fee, {bountyPct}% went to whoever revealed the bet (the player's page or a keeper) and {treasuryPct}% to the treasury. Every bet also holds a little NEAR for its storage, returned with the result in all four cases.</p>
</section>

<section class="card block">
  <h2>Why nobody can cheat</h2>
  <div class="facts">
    <div class="fact"><Icon name="lock" /><div><b>Nobody sees sides early.</b> A bet is stored as sha256 of your account, the round, your answer and a random secret. It can't be reversed, and changing the answer changes the fingerprint.</div></div>
    <div class="fact"><Icon name="bolt" /><div><b>Whoever reveals gets paid.</b> {(pr?.reveal_bounty_bps ?? 0) / 100}% of each bet's fee goes to whoever reveals it. If your page is open, it reveals your own bet and you keep that part; otherwise any keeper can earn it, so nobody depends on one server.</div></div>
    <div class="fact"><Icon name="users" /><div><b>One account, many slots.</b> An account can run any number of slots: independent bettors with their own bet each round and their own streak, sharing one balance. Each extra slot holds 0.002 NEAR of storage, refunded when it closes. The Autopilot runs one rule set per slot.</div></div>
    <div class="fact"><Icon name="bot" /><div><b>Your strategy stays with you.</b> The Autopilot runs in your own page, or in a script on your own computer (<code>keeper/autopilot.mjs</code>) to keep going without a browser. No server bets for players: it would have to know every side before betting closes.</div></div>
    <div class="fact"><Icon name="clock" /><div><b>It opens itself.</b> Your browser also locks the answer to a <a href="https://drand.love" target="_blank" rel="noopener">drand</a> round published when betting closes. After that anyone can open it and reveal it for you, but only to the answer you sealed. You never have to come back.</div></div>
    <div class="fact"><Icon name="shield" /><div><b>No admin methods.</b> Every rule above is enforced by the contract, and it has no method that can change the rules or move anyone's NEAR. <i>On testnet the contract account still holds a deploy key, so the code can still be upgraded while the game is built; on mainnet that key will be deleted, after which nobody can change it.</i> Nothing mints BEFEWER except streak wins and the one-time pool seed, and never more than {fmt(st?.max_supply ?? '0')} exist at once.</div></div>
    <div class="fact"><Icon name="dice" /><div><b>Farming streaks costs money.</b> Betting the same amount on both sides from two accounts always loses exactly both fees, whichever side wins. Betting against yourself alone voids the round: it only costs the round's record (0.0029 NEAR), but a void is not a win, so it never builds a streak. The contract tests check both.</div></div>
    <div class="fact"><Icon name="users" /><div><b>Whales are the crowd.</b> A big bet makes its own side bigger, so large players win less often. Splitting a stake across many accounts changes nothing: outcomes and mining shares are weighted by NEAR, not by accounts.</div></div>
    <div class="fact"><Icon name="lock" /><div><b>The treasury can't touch players' NEAR.</b> It only spends what is left after everything owed to players, the NEAR locked in bets, the contract's storage and a 1 NEAR safety reserve.</div></div>
  </div>
</section>

<section class="card block">
  <h2>Anyone can run a keeper</h2>
  <p class="muted small">The contract has no operator. Every job a server would do is a public method anyone can call, so the game keeps running as long as one keeper, or one open page, is around.</p>
  <div class="facts">
    <div class="fact"><Icon name="lock" /><div><b>Reveal sealed bets, get paid.</b> After betting closes, a keeper opens the drand timelocks of bets whose pages are closed and reveals them. Whoever reveals a bet first earns {(pr?.reveal_bounty_bps ?? 0) / 100}% of its fee in NEAR: 0.0004 NEAR on a 0.01 bet. Revealing many in one call costs about 0.0002 NEAR of gas each (one at a time costs more).</div></div>
    <div class="fact"><Icon name="clock" /><div><b>Public work.</b> Settling finished rounds nobody settled, opening the pool and running buybacks pay nothing; any keeper does them when they are due.</div></div>
    <div class="fact"><Icon name="users" /><div><b>More keepers, sooner reveals.</b> Keepers race for the reward, so bets open sooner and no single server matters. Your own open page is a keeper for your own bets.</div></div>
    <div class="fact"><Icon name="bolt" /><div><b>Run one.</b> Any NEAR account with a little NEAR: <code>FEWER_KEEPER_ONLY=1 FEWER_KEEPER_ACCOUNT=you.testnet node keeper/run.mjs</code> from the source. It registers itself with a 0.02 NEAR game deposit (rewards are paid into a game balance) and needs nothing from us.</div></div>
  </div>
</section>

<section class="card block">
  <h2>The token and the treasury</h2>
  <p class="muted small">$BEFEWER started at zero supply. It is only ever mined by streaks (plus the one-time pool seed) and only ever burned by buybacks. The live numbers (the treasury, the pool, buybacks, supply and where every NEAR and BEFEWER went) are all on the <a href="#/pool">Pool page</a>.</p>
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
    <li>This demo runs a round every {Math.round(mins / 60) || mins} {mins >= 60 ? 'minutes' : 'seconds'} with a {revealS}-second reveal. Mainnet keeps the same pace.</li>
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
  .npcs { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; margin-top: 12px }
  .npc { padding: 12px 14px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--line-soft); display: grid; gap: 3px }
  .nh { display: flex; justify-content: space-between; gap: 8px }
  .links { margin: 8px 0 0; padding-left: 18px; display: grid; gap: 8px; color: var(--fg-2); font-size: 14.5px; line-height: 1.55 }
  code { font-family: var(--mono); font-size: 12.5px; background: var(--surface-2); padding: 1px 5px; border-radius: 5px; overflow-wrap: anywhere }
  .note { margin: 14px 0 0; padding: 10px 12px; border-radius: 10px; background: rgba(232, 182, 94, 0.07); border: 1px solid rgba(232, 182, 94, 0.25); font-size: 13.5px; color: var(--fg-2) }
  .outs { display: grid; gap: 12px; margin: 14px 0 }
  @media (min-width: 860px) { .outs { grid-template-columns: repeat(2, minmax(0, 1fr)) } }
  .out { border: 1px solid var(--line-soft); border-radius: 14px; padding: 14px; background: var(--surface) }
  .out p { margin: 4px 0 8px; font-size: 14px; color: var(--fg-2); line-height: 1.5 }
  .oh { font-weight: 800; font-size: 16px }
  .out.win .oh { color: var(--good, #8fbf7f) } .out.lose .oh, .out.miss .oh { color: var(--burn, #e07a5f) }
  .out dl { display: grid; gap: 4px; margin: 0 }
  .out dl div { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 8px; font-size: 14px }
  .out dt { color: var(--fg-3); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; padding-top: 2px }
  .out dd { margin: 0 }
  .ex .good { color: var(--good, #8fbf7f) } .ex .burn { color: var(--burn, #e07a5f) }
</style>
