<script lang="ts">
  import { fly } from 'svelte/transition'
  import { game, dismiss } from '../game.svelte'
  import Icon from './Icon.svelte'
</script>

<div class="toasts" aria-live="polite">
  {#each game.toasts as t (t.id)}
    <div class="toast {t.kind}" transition:fly={{ y: 16, duration: 220 }}>
      <Icon name={t.kind === 'err' ? 'x' : t.kind === 'ok' ? 'check' : 'info'} size={18} />
      <span>{t.text}</span>
      {#if t.action}<button class="act" onclick={() => { t.action!.run(); dismiss(t.id) }}>{t.action.label}</button>{/if}
      <button class="close" onclick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
    </div>
  {/each}
</div>

<style>
  .toasts { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(var(--nav-h) + 14px + env(safe-area-inset-bottom)); z-index: 50; display: grid; gap: 8px; width: min(520px, calc(100vw - 24px)) }
  @media (min-width: 860px) { .toasts { bottom: 24px } }
  .toast { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 14px; background: var(--surface-3); border: 1px solid var(--line); box-shadow: 0 12px 30px rgba(0, 0, 0, 0.4); font-size: 14px; line-height: 1.45 }
  .toast.ok { border-color: rgba(140, 187, 127, 0.45) }
  .toast.ok :global(svg) { color: var(--good) }
  .toast.err { background: var(--err-bg); border-color: var(--err-line); color: var(--err-fg) }
  .toast span { flex: 1 }
  .act { background: none; border: 1px solid var(--line); border-radius: 8px; color: var(--fg); font-weight: 700; padding: 2px 10px; cursor: pointer }
  .close { background: none; border: 0; color: var(--fg-3); font-size: 20px; line-height: 1; cursor: pointer; padding: 0 2px }
</style>
