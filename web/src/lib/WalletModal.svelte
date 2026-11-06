<script lang="ts">
  import { fade, scale } from 'svelte/transition'
  import Icon from './Icon.svelte'
  import { game, closeWallet, pickWallet, approveWallet, short } from '../game.svelte'
  import { WALLETS, SESSION_METHODS } from '../wallet'
  import { CONTRACT } from '../chain'

  const AMOUNTS = [0.5, 1, 2]
  let amount = $state(1)
  const w = $derived(game.wallet)
</script>

{#if w.open}
  <div class="scrim" transition:fade={{ duration: 120 }} onclick={closeWallet} role="presentation"></div>
  <div class="dialog card" role="dialog" aria-modal="true" aria-labelledby="wl-h" transition:scale={{ start: 0.97, duration: 160 }}>
    <div class="dh">
      <h2 id="wl-h">{w.step === 'pick' || w.step === 'connecting' ? 'Connect a NEAR wallet' : 'Set up playing'}</h2>
      <button class="x" onclick={closeWallet} aria-label="Close"><Icon name="x" size={18} /></button>
    </div>

    {#if w.step === 'pick' || w.step === 'connecting'}
      <p class="muted small">Testnet only. Your wallet needs a little testnet NEAR.</p>
      <div class="list">
        {#each WALLETS as x}
          <button class="wallet" onclick={() => pickWallet(x.id)} disabled={w.step === 'connecting'}>
            <b>{x.name}</b><span class="faint small">{x.about}</span>
          </button>
        {/each}
      </div>
      {#if w.step === 'connecting'}<p class="small muted"><span class="spin"></span> Waiting for the wallet…</p>{/if}
    {:else}
      <p class="small">Signed in as <b class="num">{short(w.accountId ?? '')}</b>. One approval in your wallet does two things:</p>
      <ol class="small steps">
        <li><b>Adds a key for this game to your account</b>, kept in this browser. It can only call <code>{SESSION_METHODS.join(', ')}</code> on <code>{CONTRACT}</code>, with at most 1 NEAR of gas. It can't send your NEAR anywhere: withdrawals only go back to you. So bets don't need a popup.</li>
        <li><b>Deposits NEAR into your game balance.</b> The first deposit also pays a one-time 0.01 NEAR storage fee.</li>
      </ol>
      <div class="amounts" role="radiogroup" aria-label="Deposit">
        {#each AMOUNTS as a}
          <button role="radio" aria-checked={amount === a} class:on={amount === a} onclick={() => (amount = a)} disabled={w.step === 'approving'}>{a} NEAR</button>
        {/each}
      </div>
      <button class="btn primary go" onclick={() => approveWallet(amount)} disabled={w.step === 'approving'}>
        {#if w.step === 'approving'}<span class="spin"></span> Approve it in your wallet…{:else}Approve in wallet: add key + deposit {amount} NEAR{/if}
      </button>
    {/if}
    {#if w.error}<p class="err small">{w.error}</p>{/if}
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); z-index: 60 }
  .dialog { position: fixed; z-index: 61; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(440px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow-y: auto; padding: 20px; display: grid; gap: 12px }
  .dh { display: flex; justify-content: space-between; align-items: center; gap: 12px }
  .dh h2 { font-size: 19px; font-weight: 800 }
  .x { border: 0; background: transparent; color: var(--fg-3); cursor: pointer; padding: 6px }
  p { margin: 0 }
  .list { display: grid; gap: 8px }
  .wallet { display: grid; gap: 2px; text-align: left; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line); background: var(--surface-2); color: var(--fg); cursor: pointer }
  .wallet:hover:not(:disabled) { border-color: var(--fg-3) }
  .steps { margin: 0; padding-left: 18px; display: grid; gap: 6px; color: var(--fg-2); line-height: 1.45 }
  .steps code { font-size: 12px; overflow-wrap: anywhere }
  .amounts { display: flex; gap: 6px; flex-wrap: wrap }
  .amounts button { min-height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface-2); color: var(--fg-2); font-weight: 650; cursor: pointer }
  .amounts button.on { background: var(--fg); color: var(--bg); border-color: var(--fg) }
  .go { width: 100%; min-height: 48px }
  .err { color: var(--err-fg) }
  .spin { display: inline-block; width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255, 255, 255, 0.2); border-top-color: currentColor; animation: rot 0.8s linear infinite; vertical-align: -2px }
  @keyframes rot { to { transform: rotate(360deg) } }
</style>
