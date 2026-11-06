<script lang="ts">
  import { slide } from 'svelte/transition'
  import Icon from '../lib/Icon.svelte'
  import Equity from '../lib/Equity.svelte'
  import { label } from '../questions'
  import { backtest, PRESETS, type Rule, type Cond, type Pick, type Unit } from '../rules'
  import { game, commitRound, lookup, saveRules, setAutopilot } from '../game.svelte'

  const WINDOW = 60
  const rules = $derived(game.ap.rules)
  const bt = $derived.by(() => {
    game.history
    const cur = commitRound()
    return backtest($state.snapshot(game.ap.rules) as Rule[], Math.max(0, cur - WINDOW), cur - 1, lookup, 1000)
  })
  const presetBt = $derived.by(() => {
    game.history
    const cur = commitRound()
    return PRESETS.map(p => backtest(p.rules, Math.max(0, cur - WINDOW), cur - 1, lookup, 1000))
  })

  const KINDS: [Cond['kind'], string][] = [['last', 'the round before'], ['streak', 'the last few rounds'], ['question', 'last time this question was asked'], ['always', 'anything else']]
  function picksFor(c: Cond): [Pick, string][] {
    return c.kind === 'always'
      ? [['A', 'A'], ['B', 'B'], ['random', 'a random side'], ['skip', 'nothing (skip)']]
      : [['same', 'that same side'], ['other', 'the other side'], ['A', 'A'], ['B', 'B'], ['random', 'a random side'], ['skip', 'nothing (skip)']]
  }
  function winners(c: Cond): [string, string][] {
    const all = c.kind === 'streak'
    return [['A', all ? 'were all won by A' : 'was won by A'], ['B', all ? 'were all won by B' : 'was won by B'], ['any', all ? 'were all won by one side' : 'had a winner']]
  }
  const commit = () => saveRules()

  function setKind(i: number, v: Cond['kind']) {
    const r = game.ap.rules[i]
    const w = 'winner' in r.cond ? r.cond.winner : 'any'
    r.cond = v === 'always' ? { kind: 'always' } : v === 'streak' ? { kind: 'streak', winner: w, n: 3 } : ({ kind: v, winner: w } as Cond)
    if (v === 'always' && (r.pick === 'same' || r.pick === 'other')) r.pick = 'random'
    commit()
  }
  function add() {
    const at = game.ap.rules.length && game.ap.rules[game.ap.rules.length - 1].cond.kind === 'always' ? game.ap.rules.length - 1 : game.ap.rules.length
    game.ap.rules.splice(at, 0, { cond: { kind: 'last', winner: 'any' }, pick: 'other', unit: 'fixed', amount: 10 })
    commit()
  }
  function del(i: number) { game.ap.rules.splice(i, 1); commit() }
  function moveRule(i: number, d: number) {
    const j = i + d
    if (j < 0 || j >= game.ap.rules.length) return
    const t = game.ap.rules[i]; game.ap.rules[i] = game.ap.rules[j]; game.ap.rules[j] = t
    commit()
  }
  function use(i: number) { game.ap.rules = structuredClone(PRESETS[i].rules); commit() }
  const fmtN = (v: number) => v.toLocaleString('en-US')
  const FIXED = [1, 2, 5, 10, 20, 50, 100]
  const PCTS = [1, 2, 5, 10, 25]
  function setStake(i: number, v: string) {
    const [u, n] = v.split(':')
    game.ap.rules[i].unit = (u === 'p' ? 'pct' : 'fixed') as Unit
    game.ap.rules[i].amount = Number(n)
    commit()
  }
  const net = (b: { end: number; start: number }) => b.end - b.start
  const tone = (v: number) => (v > 0 ? 'good' : v < 0 ? 'burn' : '')
  const signed = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '±') + fmtN(Math.abs(v))
  const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago` }
</script>

<header class="ph">
  <div>
    <h1>Autopilot</h1>
    <p class="muted">Write rules, see how they would have done, then let them bet for you. Rules only read rounds that already finished.</p>
  </div>
</header>

<section class="card run" class:on={game.ap.on}>
  <div class="run-l">
    <div class="status"><span class="led"></span>{game.ap.on ? 'Running in this tab' : 'Off'}</div>
    <p class="small muted">{game.ap.on ? 'Each round, once the previous round has finished, your rules decide and place a sealed bet. Keep this page open.' : 'Turn it on to let your rules place a bet every round while this page is open.'}</p>
  </div>
  <label class="switch">
    <input type="checkbox" checked={game.ap.on} onchange={e => setAutopilot((e.currentTarget as HTMLInputElement).checked)} aria-label="Run autopilot" />
    <span class="track"><span class="knob"></span></span>
  </label>
</section>

<div class="cols">
  <div class="col">
    <section class="card block">
      <div class="bh"><h2>Your rules</h2><span class="faint small">checked top to bottom · first match decides</span></div>
      <ol class="rules">
        {#each rules as r, i (i)}
          <li class="rule" transition:slide={{ duration: 160 }}>
            <span class="n">{i + 1}</span>
            <div class="sentence">
              <span class="w">{r.cond.kind === 'always' ? 'For' : 'If'}</span>
              <select aria-label="Condition" value={r.cond.kind} onchange={e => setKind(i, (e.currentTarget as HTMLSelectElement).value as Cond['kind'])}>
                {#each KINDS as [v, t]}<option value={v}>{t}</option>{/each}
              </select>
              {#if r.cond.kind === 'streak'}
                <select aria-label="How many rounds" value={String(r.cond.n)} onchange={e => { if (r.cond.kind === 'streak') r.cond.n = Number((e.currentTarget as HTMLSelectElement).value); commit() }}>
                  {#each [2, 3, 4, 5, 6] as n}<option value={String(n)}>{n} rounds</option>{/each}
                </select>
              {/if}
              {#if r.cond.kind !== 'always'}
                <select aria-label="Winner" value={r.cond.winner} onchange={e => { if (r.cond.kind !== 'always') r.cond.winner = (e.currentTarget as HTMLSelectElement).value as any; commit() }}>
                  {#each winners(r.cond) as [v, t]}<option value={v}>{t}</option>{/each}
                </select>
              {/if}
              <span class="w">→ bet</span>
              <select aria-label="Bet" value={r.pick} onchange={e => { r.pick = (e.currentTarget as HTMLSelectElement).value as Pick; commit() }}>
                {#each picksFor(r.cond) as [v, t]}<option value={v}>{t}</option>{/each}
              </select>
              {#if r.pick !== 'skip'}
                <span class="w">with</span>
                <select aria-label="Stake" value={`${r.unit === 'pct' ? 'p' : 'f'}:${r.amount}`} onchange={e => setStake(i, (e.currentTarget as HTMLSelectElement).value)}>
                  {#each FIXED as n}<option value={`f:${n}`}>{n} BEFEWER</option>{/each}
                  {#if r.unit === 'fixed' && !FIXED.includes(r.amount)}<option value={`f:${r.amount}`}>{r.amount} BEFEWER</option>{/if}
                  <optgroup label="Share of my balance">
                    {#each PCTS as n}<option value={`p:${n}`}>{n}% of balance</option>{/each}
                    {#if r.unit === 'pct' && !PCTS.includes(r.amount)}<option value={`p:${r.amount}`}>{r.amount}% of balance</option>{/if}
                  </optgroup>
                </select>
              {/if}
            </div>
            <div class="ops">
              <button class="ic" onclick={() => moveRule(i, -1)} disabled={i === 0} aria-label="Move rule {i + 1} up"><Icon name="up" size={16} /></button>
              <button class="ic" onclick={() => moveRule(i, 1)} disabled={i === rules.length - 1} aria-label="Move rule {i + 1} down"><Icon name="down" size={16} /></button>
              <button class="ic" onclick={() => del(i)} aria-label="Remove rule {i + 1}"><Icon name="trash" size={16} /></button>
            </div>
          </li>
        {/each}
      </ol>
      <div class="foot"><button class="btn small" onclick={add}><Icon name="plus" size={16} /> Add a rule</button><span class="faint small">If no rule fits, the round is skipped.</span></div>
    </section>

    <section class="card block">
      <div class="bh"><h2>Start from a strategy</h2></div>
      <div class="presets">
        {#each PRESETS as p, i}
          {@const b = presetBt[i]}
          <button class="preset" onclick={() => use(i)}>
            <span class="pn">{p.name}</span>
            <span class="pa small muted">{p.about}</span>
            {#if b.rounds}<span class="pr small num">staked {fmtN(b.staked)} → <b class={tone(net(b))}>{signed(net(b))}</b> <span class="faint">· last {b.rounds} rounds</span></span>{/if}
            <span class="use small">Use this</span>
          </button>
        {/each}
      </div>
    </section>
  </div>

  <div class="col">
    <section class="card block">
      <div class="bh"><h2>Replay on the last {bt.rounds} rounds</h2></div>
      {#if bt.rounds}
        <div class="kpis">
          <div><div class="eyebrow">Net</div><div class="kv num {tone(net(bt))}">{signed(net(bt))}</div><div class="faint small">1,000 → {fmtN(bt.end)}</div></div>
          <div><div class="eyebrow">Staked</div><div class="kv num">{fmtN(bt.staked)}</div><div class="faint small">{bt.bets} bets · {bt.skips} skipped</div></div>
          <div><div class="eyebrow">Won / lost</div><div class="kv num"><span class="good">{bt.wins}</span> / <span class="burn">{bt.losses}</span></div><div class="faint small">{bt.voids} void</div></div>
        </div>
        <Equity curve={bt.curve} />
        <p class="faint small">Replays your rules round by round using only what was known before each round. Assumes your own bet would not have changed which side was smaller.</p>
        <details class="tbl">
          <summary>Every round in the replay</summary>
          <table>
            <thead><tr><th>Round</th><th>Rules bet</th><th>Smaller side</th><th>Balance</th></tr></thead>
            <tbody>
              {#each [...bt.curve].reverse() as s}
                <tr><td class="num">#{s.round}</td><td>{s.side ? `${s.stake} on ${label(s.round, s.side)}` : 'skip'}</td><td>{s.outcome === 'void' ? 'void' : label(s.round, s.outcome)}</td><td class="num">{fmtN(s.bal)}</td></tr>
              {/each}
            </tbody>
          </table>
        </details>
      {:else}
        <p class="muted">No finished rounds to replay yet.</p>
      {/if}
    </section>

    <section class="card block">
      <div class="bh"><h2>Activity</h2><span class="faint small">this tab</span></div>
      {#if game.ap.log.length}
        <ul class="log">
          {#each game.ap.log as l}
            <li class={l.kind}><span class="num faint">#{l.round}</span><span>{l.text}</span><span class="faint small">{ago(l.at)}</span></li>
          {/each}
        </ul>
      {:else}
        <p class="muted small">Nothing yet. {game.ap.on ? 'The first decision happens once the previous round finishes.' : 'Turn the autopilot on to start.'}</p>
      {/if}
    </section>
  </div>
</div>

<style>
  .ph { margin: 4px 0 16px }
  .ph h1 { font-size: 30px; font-weight: 800 }
  .ph p { margin: 4px 0 0; max-width: 640px }
  .small { font-size: 13px }
  .run { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 20px; margin-bottom: 16px }
  .run.on { border-color: rgba(140, 187, 127, 0.4); background: linear-gradient(90deg, rgba(140, 187, 127, 0.07), transparent 60%), var(--surface) }
  .run p { margin: 4px 0 0 }
  .status { display: flex; align-items: center; gap: 8px; font-weight: 750 }
  .led { width: 9px; height: 9px; border-radius: 50%; background: var(--fg-3) }
  .run.on .led { background: var(--good); box-shadow: 0 0 0 4px rgba(140, 187, 127, 0.18) }
  .switch { position: relative; flex: none; cursor: pointer }
  .switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer }
  .track { display: block; width: 54px; height: 32px; border-radius: 16px; background: var(--surface-3); border: 1px solid var(--line); transition: background 0.2s var(--ease) }
  .knob { position: absolute; top: 4px; left: 4px; width: 24px; height: 24px; border-radius: 50%; background: var(--fg); transition: transform 0.2s var(--ease) }
  .switch input:checked + .track { background: var(--good) }
  .switch input:checked + .track .knob { transform: translateX(22px); background: #0f1a0c }
  .switch input:focus-visible + .track { outline: 2px solid var(--brand); outline-offset: 2px }
  .cols { display: grid; gap: 16px }
  @media (min-width: 980px) { .cols { grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); align-items: start } }
  .col { display: grid; gap: 16px; min-width: 0 }
  .block { padding: 18px 20px; min-width: 0; overflow: hidden }
  .bh { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 10px }
  .bh h2 { font-size: 17px; font-weight: 750 }
  .rules { list-style: none; margin: 0; padding: 0 }
  .rule { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; gap: 10px; padding: 12px 0; border-top: 1px solid var(--line-soft) }
  .rule:first-child { border-top: 0 }
  .n { width: 24px; height: 24px; border-radius: 8px; display: grid; place-items: center; font-size: 12px; font-weight: 800; color: var(--brand); background: rgba(232, 182, 94, 0.1); margin-top: 6px }
  .sentence { display: flex; flex-wrap: wrap; gap: 6px 6px; align-items: center; font-size: 15px; line-height: 1.4 }
  .w { color: var(--fg-2) }
  .ops { display: flex; gap: 2px; align-self: start }
  .ic { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 8px; border: 0; background: none; color: var(--fg-3); cursor: pointer }
  .ic:hover:not(:disabled) { background: var(--surface-2); color: var(--fg) }
  .ic:disabled { opacity: 0.3; cursor: default }
  @media (max-width: 520px) { .rule { grid-template-columns: 26px minmax(0, 1fr) } .ops { grid-column: 2 } .block { padding: 16px } }
  .foot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 10px }
  .presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px }
  .preset { display: grid; gap: 4px; text-align: left; padding: 14px; border-radius: 14px; border: 1px solid var(--line); background: var(--surface-2); cursor: pointer; color: var(--fg); transition: border-color 0.15s var(--ease) }
  .preset:hover { border-color: var(--fg-3) }
  .pn { font-weight: 750 }
  .use { color: var(--brand); font-weight: 650; margin-top: 4px }
  .kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 8px }
  .kv { font-size: 22px; font-weight: 800; margin-top: 2px }
  details.tbl { margin-top: 8px }
  details.tbl summary { cursor: pointer; color: var(--fg-2); font-size: 14px }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px }
  th, td { text-align: left; padding: 6px 6px; border-bottom: 1px solid var(--line-soft); overflow-wrap: anywhere }
  th { color: var(--fg-3); font-weight: 600 }
  .log { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px }
  .log li { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 10px; font-size: 14px; padding: 8px 10px; border-radius: 10px; background: var(--surface-2) }
  .log li.err { background: var(--err-bg); color: var(--err-fg) }
</style>
