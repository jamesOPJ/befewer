<script lang="ts">
  // Shown when the game balance cannot cover the smallest bet: says where the NEAR is and offers
  // to move it back from the wallet (guests sign it here; wallet accounts approve one deposit).
  import { game, fmtN, movable, moveToGame, toast, minToBet } from '../game.svelte'

  const me = $derived(game.me)
  const playable = $derived(me ? BigInt(me.balance) + BigInt(me.pending_near) : 0n)
  // a bet is at most 25% of the balance, so the 0.01 minimum needs 0.04 in the game
  const need = $derived(minToBet())
  const low = $derived(!!me && me.registered && playable < need)
  const back = $derived(movable())
  async function move() {
    try { await moveToGame() } catch (e: any) { toast('err', String(e.message || e)) }
  }
</script>

{#if low}
  <div class="low" role="status">
    <div>
      <b>Your game balance is {fmtN(playable)} NEAR</b>, too little to bet: a bet can be at most 25% of it, so the smallest bet needs {fmtN(need)} NEAR.
      {#if back > 0n}Your wallet holds {fmtN(BigInt(game.walletNear ?? '0'))} NEAR: move it back into the game to keep playing (0.1 stays in the wallet for gas).
      {:else if game.session?.kind === 'wallet'}Deposit more NEAR from your wallet on the Me page.
      {:else}Your wallet is empty too.{/if}
    </div>
    {#if back > 0n}<button class="btn small primary" onclick={move} disabled={!!game.busy}>Move {fmtN(back)} NEAR into the game</button>{/if}
  </div>
{/if}

<style>
  .low { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; justify-content: space-between; padding: 12px 14px; margin-bottom: 14px; border-radius: 14px; border: 1px solid rgba(232, 182, 94, 0.45); background: rgba(232, 182, 94, 0.08); font-size: 14px; line-height: 1.45 }
  .low div { flex: 1 1 260px }
</style>
