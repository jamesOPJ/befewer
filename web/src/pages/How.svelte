<script lang="ts">
  import Icon from '../lib/Icon.svelte'
  import { CONTRACT, EXPLORER } from '../chain'
  import { QUESTIONS } from '../questions'
  import { game, fmt, NPCS } from '../game.svelte'

  const st = $derived(game.status)
  const initial = $derived(BigInt(st?.initial_supply ?? '0'))
  const reserve = $derived(BigInt(st?.faucet_reserve ?? '0'))
  const handedOut = $derived(initial - reserve)
  const burned = $derived(BigInt(st?.total_burned ?? '0'))
  const burnPct = $derived(handedOut > 0n ? Number((burned * 10000n) / handedOut) / 100 : 0)
  const inHands = $derived(BigInt(st?.total_supply ?? '0') - reserve - BigInt(st?.escrow ?? '0'))
  const mins = $derived(game.params ? Number(BigInt(game.params.commit_ns) / 1_000_000_000n) : 0)
  const revealS = $derived(game.params ? Number(BigInt(game.params.reveal_ns) / 1_000_000_000n) : 0)
</script>

<section class="hero">
  <div class="eyebrow">How it works</div>
  <h1>Be fewer.</h1>
  <p class="lede">A memecoin whose daily ritual is a sealed-bid minority game. Every round asks a question with two answers. The answer that gets <b>fewer coins</b> doubles. The gap between the two sides burns.</p>
</section>

<section class="steps">
  <div class="card step"><span class="si"><Icon name="eye" size={22} /></span><h3>1 · Read the crowd</h3><p>Don't pick what you like. Pick the answer you think fewer coins will pick, knowing everyone else is trying to do the same.</p></div>
  <div class="card step"><span class="si"><Icon name="lock" size={22} /></span><h3>2 · Seal your bet</h3><p>Bet up to 25% of your balance. Your answer is sealed: the chain stores only a fingerprint, and a drand timelock keeps it shut until betting closes.</p></div>
  <div class="card step"><span class="si"><Icon name="flame" size={22} /></span><h3>3 · The smaller side doubles</h3><p>When the reveal ends, the side with less BEFEWER gets exactly 2× back. The other side loses its stake, and the difference between the two sides is burned.</p></div>
</section>

<section class="card block">
  <h2>Why nobody can cheat</h2>
  <div class="facts">
    <div class="fact"><Icon name="lock" /><div><b>Nobody sees sides early.</b> A bet is stored as sha256 of your account, the round, your answer and a random secret. It can't be reversed, and changing the answer changes the fingerprint.</div></div>
    <div class="fact"><Icon name="clock" /><div><b>It opens itself.</b> Your browser also locks the answer to a <a href="https://drand.love" target="_blank" rel="noopener">drand</a> round published when betting closes. After that anyone can open it and reveal it for you, but only to the answer you sealed. You never have to come back.</div></div>
    <div class="fact"><Icon name="shield" /><div><b>No owner, no admin.</b> Every rule above is enforced by the contract. Its parameters were fixed at launch and there is no method that can change them, mint more, or move anyone's coins.</div></div>
    <div class="fact"><Icon name="dice" /><div><b>Hedging doesn't pay.</b> Betting both sides from two accounts and revealing only the winner can never beat simply betting the difference, because a win pays exactly 2×. We checked 80,000 cases and the contract tests prove it.</div></div>
    <div class="fact"><Icon name="users" /><div><b>Whales are the crowd.</b> A big bet makes its own side bigger, so large holders win less often. Splitting coins across many accounts changes nothing: outcomes are weighted by coins, not by accounts.</div></div>
  </div>
</section>

<section class="card block">
  <h2>The token</h2>
  <p class="muted small">Everything was minted once at launch into the faucet reserve. Supply can only go down.</p>
  <div class="tok">
    <div><div class="eyebrow">Handed out</div><div class="v num">{fmt(handedOut)}</div><div class="faint small">by the faucet so far</div></div>
    <div><div class="eyebrow">Burned</div><div class="v num burn">{fmt(burned)}</div><div class="faint small">{burnPct}% of what was handed out</div></div>
    <div><div class="eyebrow">In players' hands</div><div class="v num">{fmt(inHands)}</div><div class="faint small">{fmt(st?.escrow ?? '0')} locked in bets</div></div>
    <div><div class="eyebrow">Rounds settled</div><div class="v num">{st?.rounds_settled ?? 0}</div><div class="faint small">longest streak {st?.best_streak ?? 0}</div></div>
  </div>
</section>

<section class="card block">
  <h2>Who you're playing against</h2>
  <p class="muted small">Four bots with their own testnet wallets keep every round alive. They follow the same rules as you, and you can copy their strategies on the Autopilot page.</p>
  <div class="npcs">
    {#each NPCS as n}
      {@const p = game.npcs[n.id]}
      <div class="npc">
        <div class="nh"><b>{n.name}</b>{#if p}<span class="num faint small">{fmt(p.balance)} BEFEWER</span>{/if}</div>
        <div class="small muted">{n.about}</div>
        {#if p}<div class="small num">Won {p.wins} · lost {p.losses} · streak {p.streak}</div>{/if}
      </div>
    {/each}
  </div>
</section>

<section class="card block">
  <h2>Check it yourself</h2>
  <ul class="links">
    <li>Contract: <a href="{EXPLORER}/address/{CONTRACT}" target="_blank" rel="noopener">{CONTRACT}</a> on NEAR testnet</li>
    <li>This demo runs a round every {Math.round(mins / 60) || mins} {mins >= 60 ? 'minutes' : 'seconds'} with a {revealS}-second reveal. The mechanic is designed for one round a day.</li>
    <li>Questions come from a fixed public list of {QUESTIONS.length}; round <i>r</i> uses question <i>r</i> mod {QUESTIONS.length}. The contract only knows A and B, so the wording can't change who wins.</li>
    <li>A fingerprint is <code>sha256("fewer:&lt;account&gt;:&lt;round&gt;:&lt;A|B&gt;:&lt;secret&gt;")</code>. After a round, every answer and secret is public, so anyone can recompute it.</li>
  </ul>
  <p class="note">Testnet demo built for NEAR HACKATHON. Testnet BEFEWER is free and has no monetary value. There is no token sale.</p>
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
</style>
