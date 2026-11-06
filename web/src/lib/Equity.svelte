<script lang="ts">
  import type { Step } from '../rules'
  import { label } from '../questions'
  // Balance after each replayed round. One series, so no legend: the card title names it.
  // Values are chips of 0.01 NEAR. Dashed reference = the 10 NEAR you start with. Hover/touch shows the round under the cursor.
  let { curve, start = 1000 }: { curve: Step[]; start?: number } = $props()
  let w = $state(320)
  const h = 170
  const pad = { l: 44, r: 56, t: 14, b: 22 }
  const pts = $derived([{ round: curve[0]?.round ?? 0, bal: start } as { round: number; bal: number }, ...curve.map(c => ({ round: c.round, bal: c.bal }))])
  const lo = $derived(Math.min(start, ...pts.map(p => p.bal)))
  const hi = $derived(Math.max(start, ...pts.map(p => p.bal)))
  const span = $derived(Math.max(1, hi - lo))
  const x = (i: number) => pad.l + (i / Math.max(1, pts.length - 1)) * (w - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - (v - lo) / span) * (h - pad.t - pad.b)
  const path = $derived(pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.bal).toFixed(1)}`).join(''))
  const end = $derived(pts[pts.length - 1]?.bal ?? start)
  let hover = $state<number | null>(null)
  function move(e: PointerEvent) {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect()
    const px = e.clientX - r.left
    const i = Math.round(((px - pad.l) / Math.max(1, w - pad.l - pad.r)) * (pts.length - 1))
    hover = Math.max(1, Math.min(pts.length - 1, i))
  }
  const step = $derived(hover != null ? curve[hover - 1] : null)
  const fmtN = (v: number) => (v / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })
</script>

<div class="eq" bind:clientWidth={w}>
  <svg width="100%" height={h} viewBox="0 0 {w} {h}" role="img" aria-label="Balance replay: {fmtN(start)} to {fmtN(end)} over {curve.length} rounds"
    onpointermove={move} onpointerleave={() => (hover = null)} onpointerdown={move}>
    <line x1={pad.l} x2={w - pad.r} y1={y(start)} y2={y(start)} class="ref" />
    <text x={pad.l - 6} y={y(start) + 4} class="ax" text-anchor="end">{fmtN(start)}</text>
    {#if hi !== start}<text x={pad.l - 6} y={y(hi) + 4} class="ax" text-anchor="end">{fmtN(hi)}</text>{/if}
    {#if lo !== start}<text x={pad.l - 6} y={y(lo) + 4} class="ax" text-anchor="end">{fmtN(lo)}</text>{/if}
    <text x={pad.l} y={h - 4} class="ax">#{pts[0].round}</text>
    <text x={w - pad.r} y={h - 4} class="ax" text-anchor="end">#{pts[pts.length - 1].round}</text>
    <path d={path} class="line" class:down={end < start} />
    <circle cx={x(pts.length - 1)} cy={y(end)} r="4" class="endpt" class:down={end < start} />
    <text x={x(pts.length - 1) + 8} y={y(end) + 4} class="endlbl">{fmtN(end)}</text>
    {#if hover != null}
      <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={h - pad.b} class="cross" />
      <circle cx={x(hover)} cy={y(pts[hover].bal)} r="4.5" class="hov" />
    {/if}
  </svg>
  {#if step}
    <div class="tip" style="left:{Math.min(Math.max(x(hover!), 90), w - 90)}px">
      <b>Round {step.round}</b> · {step.side === 'both' ? `bet ${fmtN(step.stake)} NEAR on each side` : step.side ? `bet ${fmtN(step.stake)} NEAR on ${label(step.round, step.side)}` : 'skipped'}{step.mined ? ' · mines' : ''} ·
      {step.outcome === 'void' ? 'void' : `${label(step.round, step.outcome)} was smaller`} → <b>{fmtN(step.bal)}</b>
    </div>
  {/if}
</div>

<style>
  .eq { position: relative; width: 100%; min-width: 0; touch-action: pan-y }
  svg { display: block; cursor: crosshair }
  .ref { stroke: var(--fg-3); stroke-dasharray: 4 4; stroke-width: 1 }
  .ax { fill: var(--fg-3); font-size: 11px; font-variant-numeric: tabular-nums }
  .line { fill: none; stroke: var(--good); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round }
  .line.down { stroke: var(--burn) }
  .endpt { fill: var(--good); stroke: var(--surface); stroke-width: 2 }
  .endpt.down { fill: var(--burn) }
  .endlbl { fill: var(--fg); font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums }
  .cross { stroke: var(--fg-2); stroke-width: 1 }
  .hov { fill: var(--fg); stroke: var(--surface); stroke-width: 2 }
  .tip { position: absolute; top: -6px; transform: translate(-50%, -100%); background: var(--surface-3); border: 1px solid var(--line); border-radius: 10px; padding: 6px 10px; font-size: 12.5px; width: max-content; max-width: min(300px, 86vw); pointer-events: none; box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35) }
</style>
