<script lang="ts">
  import { fmt } from '../game.svelte'
  import { label } from '../questions'
  import type { RoundV } from '../chain'
  // Two orbs whose AREA is the BEFEWER revealed on each answer. The smaller orb is the minority:
  // its bets win +100%. The gap between them is what burns.
  let { round, compact = false }: { round: RoundV; compact?: boolean } = $props()
  const r = $derived(Number(round.round))
  const a = $derived(Number(BigInt(round.revealed_a) / 10n ** 15n) / 1000)
  const b = $derived(Number(BigInt(round.revealed_b) / 10n ** 15n) / 1000)
  const big = $derived(Math.max(a, b, 1e-9))
  const k = (x: number) => (x <= 0 ? 0 : Math.max(0.14, Math.sqrt(x / big)))
  const total = $derived(a + b)
  const pct = (x: number) => (total > 0 ? Math.round((x / total) * 100) : 0)
  const outcome = $derived(round.settled ? round.outcome : null)
  const H = $derived(compact ? 150 : 190)
  const R = $derived(compact ? 50 : 64)
</script>

<div class="orbs" class:compact>
  <svg viewBox="0 0 320 {H}" width="100%" height={H} role="img" aria-label="{label(r, 'A')}: {fmt(round.revealed_a)}; {label(r, 'B')}: {fmt(round.revealed_b)}">
    {#each [['A', a, 86], ['B', b, 234]] as [side, v, cx]}
      {@const s = side as 'A' | 'B'}
      {@const win = outcome === s}
      {@const lose = outcome && outcome !== 'void' && outcome !== s}
      <g class="orb {s}" class:win class:lose>
        <circle cx={cx as number} cy={H / 2} r={R} class="ghost" />
        <circle cx={cx as number} cy={H / 2} r={R} class="fill" style="transform:scale({k(v as number)})" />
        {#if win}<circle cx={cx as number} cy={H / 2} r={R} class="halo" style="transform:scale({k(v as number) + 0.12})" />{/if}
      </g>
    {/each}
  </svg>
  <div class="legend">
    {#each [['A', a, round.revealed_a, round.reveals_a], ['B', b, round.revealed_b, round.reveals_b]] as [side, v, raw, n]}
      {@const s = side as 'A' | 'B'}
      <div class="lg">
        <div class="ans"><span class="letter {s}">{s}</span>{label(r, s)}</div>
        <div class="amt num">{fmt(raw as string)} <span class="faint">· {pct(v as number)}% · {n} bet{n === 1 ? '' : 's'}</span></div>
        {#if outcome === s}<div class="tag good">smaller side · wins +100%</div>
        {:else if outcome && outcome !== 'void'}<div class="tag burn">bigger side · loses</div>{/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .orbs { width: 100% }
  svg { display: block; overflow: visible }
  .ghost { fill: none; stroke: var(--line); stroke-dasharray: 3 5 }
  .fill { transform-box: fill-box; transform-origin: center; transition: transform 0.9s var(--ease) }
  .A .fill { fill: var(--a-soft); stroke: var(--a); stroke-width: 2 }
  .B .fill { fill: var(--b-soft); stroke: var(--b); stroke-width: 2 }
  .win.A .fill { fill: rgba(189, 135, 57, 0.32) }
  .win.B .fill { fill: rgba(94, 152, 216, 0.32) }
  .lose .fill { opacity: 0.55; stroke-dasharray: 4 4 }
  .halo { fill: none; stroke-width: 1.5; transform-box: fill-box; transform-origin: center; animation: pulse 2.4s var(--ease) infinite }
  .A .halo { stroke: var(--a) }
  .B .halo { stroke: var(--b) }
  @keyframes pulse { 0%, 100% { opacity: 0.25 } 50% { opacity: 0.9 } }
  .legend { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 4px }
  .lg { text-align: center; min-width: 0 }
  .ans { font-weight: 700; font-size: 17px; overflow-wrap: anywhere }
  .letter.A { color: var(--a) } .letter.B { color: var(--b) }
  .letter { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 6px; font-size: 12px; margin-right: 6px; border: 1px solid currentColor; vertical-align: 2px }
  .amt { font-size: 14px; color: var(--fg); margin-top: 2px }
  .tag { font-size: 12px; font-weight: 700; margin-top: 4px; letter-spacing: 0.02em }
  .compact .ans { font-size: 15px }
</style>
