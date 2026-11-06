<script lang="ts">
  import { clock } from '../game.svelte'
  // A ring that drains as the window closes, with the time left in the middle.
  let { left, total, caption = '', size = 92, tone = 'var(--brand)' }: { left: number; total: number; caption?: string; size?: number; tone?: string } = $props()
  const R = 42
  const C = 2 * Math.PI * R
  const frac = $derived(total > 0 ? Math.max(0, Math.min(1, left / total)) : 0)
  const urgent = $derived(left > 0 && left < 15000)
</script>

<div class="ring" style="width:{size}px;height:{size}px" role="timer" aria-label="{clock(left)} {caption}">
  <svg viewBox="0 0 100 100" width={size} height={size}>
    <circle cx="50" cy="50" r={R} class="track" />
    <circle cx="50" cy="50" r={R} class="bar" style="stroke:{urgent ? 'var(--burn)' : tone};stroke-dasharray:{C};stroke-dashoffset:{C * (1 - frac)}" />
  </svg>
  <div class="mid">
    <div class="t num" class:urgent>{clock(left)}</div>
    {#if caption}<div class="c">{caption}</div>{/if}
  </div>
</div>

<style>
  .ring { position: relative; flex: none }
  svg { transform: rotate(-90deg) }
  circle { fill: none; stroke-width: 6 }
  .track { stroke: var(--line) }
  .bar { stroke-linecap: round; transition: stroke-dashoffset 0.25s linear, stroke 0.3s }
  .mid { position: absolute; inset: 0; display: grid; place-content: center; text-align: center }
  .t { font-size: 22px; font-weight: 700; letter-spacing: -0.02em }
  .t.urgent { color: var(--burn) }
  .c { font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-3); margin-top: 1px }
</style>
