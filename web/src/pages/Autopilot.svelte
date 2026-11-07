<script lang="ts">
  import { slide } from 'svelte/transition'
  import Icon from '../lib/Icon.svelte'
  import Equity from '../lib/Equity.svelte'
  import { label } from '../questions'
  import { backtest, runsAtLeast, describe, chipsText, cleanPattern, PRESETS, PRESET_GROUPS, SLOT_SETS, type Rule, type Cond, type Pick, type Unit, type Backtest } from '../rules'
  import { game, commitRound, lookup, saveRules, setAutopilot, draftDirty, putDraftLive, discardDraft, toast, lane, addLane, removeLane, useSlotSet, todayNet, fmtN as fmtNear } from '../game.svelte'

  const WINDOW = 60
  // replays count chips of 0.01 NEAR and pay the contract's fee on every bet
  const fee = () => game.params?.fee_bps ?? 0
  const need = () => game.params?.streak_min ?? 3 // wins in a row before a win mines
  /** win runs by length: 1, 2, 3, 4, 5+ */
  const ordinal = (n: number) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th')
  const roundsText = (n: number) => `${n} round${n === 1 ? '' : 's'}`
  const runRows = (b: Backtest) => [1, 2, 3, 4].map(k => [String(k), b.runs[k] ?? 0] as [string, number]).concat([['5+', runsAtLeast(b, 5)]])
  const L = $derived(game.ap.lanes[game.ap.sel] ?? game.ap.lanes[0])
  const rules = $derived(L.draft)
  const bt = $derived.by(() => {
    game.history
    const cur = commitRound()
    return backtest($state.snapshot(lane().draft) as Rule[], Math.max(0, cur - WINDOW), cur - 1, lookup, 1000, fee(), need())
  })
  const btLive = $derived.by(() => {
    game.history
    const cur = commitRound()
    return backtest($state.snapshot(lane().live) as Rule[], Math.max(0, cur - WINDOW), cur - 1, lookup, 1000, fee(), need())
  })
  const dirty = $derived(JSON.stringify(lane().draft) !== JSON.stringify(lane().live))
  let confirmLive = $state(false)
  function goLive() { putDraftLive(); confirmLive = false; toast('ok', game.ap.on ? 'New rules are running from the next round.' : 'New rules saved as the running rules.') }
  // every lane's running rules replayed on the same rounds, added up
  const btAll = $derived.by(() => {
    game.history
    const cur = commitRound()
    const list = game.ap.lanes.map(l => backtest($state.snapshot(l.live) as Rule[], Math.max(0, cur - WINDOW), cur - 1, lookup, 1000, fee(), need()))
    return { net: list.reduce((t, b) => t + b.end - b.start, 0), staked: list.reduce((t, b) => t + b.staked, 0), mines: list.reduce((t, b) => t + b.mines, 0), n: list.length }
  })
  const setBt = $derived.by(() => {
    game.history
    const cur = commitRound()
    return SLOT_SETS.map(set => {
      const list = set.slots.map(x => backtest(x.rules, Math.max(0, cur - WINDOW), cur - 1, lookup, 1000, fee(), need()))
      return { net: list.reduce((t, b) => t + b.end - b.start, 0), staked: list.reduce((t, b) => t + b.staked, 0), mines: list.reduce((t, b) => t + b.mines, 0), rounds: list[0]?.rounds ?? 0 }
    })
  })
  const today = $derived.by(() => { game.history; game.resultsBySlot; return todayNet() })
  function setBudget(on: boolean, near: number) { game.ap.budget.on = on; game.ap.budget.near = Math.max(0.01, Math.round(near * 100) / 100); saveRules() }
  function useSet(i: number) { useSlotSet(i); toast('info', `${SLOT_SETS[i].name}: ${SLOT_SETS[i].slots.length} slots set up. Each extra slot holds 0.002 NEAR of storage when it first bets.`) }
  const presetBt = $derived.by(() => {
    game.history
    const cur = commitRound()
    return PRESETS.map(p => backtest(p.rules, Math.max(0, cur - WINDOW), cur - 1, lookup, 1000, fee(), need()))
  })

  const KINDS: [Cond['kind'], string][] = [
    ['last', 'the round before'], ['margin', 'the round before was'], ['streak', 'the last few rounds'], ['tally', 'over the last rounds'],
    ['question', 'last time this question was asked'], ['mine', 'my last bet'], ['always', 'anything else'],
  ]
  function picksFor(c: Cond): [Pick, string][] {
    const loop: [Pick, string] = ['loop', 'a fixed pattern (loop)']
    if (c.kind === 'always') return [['A', 'A'], ['B', 'B'], ['random', 'a random side'], loop, ['skip', 'nothing (skip)']]
    const same = c.kind === 'mine' ? 'the side I picked' : 'that same side'
    return [['same', same], ['other', 'the other side'], ['A', 'A'], ['B', 'B'], ['random', 'a random side'], loop, ['skip', 'nothing (skip)']]
  }
  function winners(c: Cond): [string, string][] {
    if (c.kind === 'margin') return [['any', 'whoever won it'], ['A', 'and A won it'], ['B', 'and B won it']]
    const all = c.kind === 'streak'
    return [['A', all ? 'were all won by A' : 'was won by A'], ['B', all ? 'were all won by B' : 'was won by B'], ['any', all ? 'were all won by one side' : 'had a winner']]
  }
  const commit = () => saveRules()

  function setKind(i: number, v: Cond['kind']) {
    const r = lane().draft[i]
    const w = 'winner' in r.cond ? r.cond.winner : 'any'
    r.cond =
      v === 'always' ? { kind: 'always' }
      : v === 'streak' ? { kind: 'streak', winner: w, n: 3 }
      : v === 'tally' ? { kind: 'tally', winner: w === 'B' ? 'B' : 'A', k: 4, n: 6 }
      : v === 'margin' ? { kind: 'margin', mode: 'lopsided', winner: w }
      : v === 'mine' ? { kind: 'mine', result: 'lost' }
      : ({ kind: v, winner: w } as Cond)
    if (v === 'always' && (r.pick === 'same' || r.pick === 'other')) r.pick = 'random'
    commit()
  }
  function add() {
    const at = lane().draft.length && lane().draft[lane().draft.length - 1].cond.kind === 'always' ? lane().draft.length - 1 : lane().draft.length
    lane().draft.splice(at, 0, { cond: { kind: 'last', winner: 'any' }, pick: 'other', unit: 'fixed', amount: 10 })
    commit()
  }
  function del(i: number) { lane().draft.splice(i, 1); commit() }
  function moveRule(i: number, d: number) {
    const j = i + d
    if (j < 0 || j >= lane().draft.length) return
    const t = lane().draft[i]; lane().draft[i] = lane().draft[j]; lane().draft[j] = t
    commit()
  }
  function use(i: number) { lane().draft = structuredClone(PRESETS[i].rules); commit(); toast('info', `${PRESETS[i].name} loaded into the draft. Put it live when you're ready.`) }
  const fmtN = (v: number) => (v / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })
  const FIXED = [1, 2, 5, 10, 20, 50, 100]
  const PCTS = [1, 2, 5, 10, 25]
  const BASES = [1, 2, 5, 10]
  const CODE: Record<Unit, string> = { fixed: 'f', pct: 'p', martingale: 'm', paroli: 'r' }
  const UNIT: Record<string, Unit> = { f: 'fixed', p: 'pct', m: 'martingale', r: 'paroli' }
  function setStake(i: number, v: string) {
    const [u, n] = v.split(':')
    lane().draft[i].unit = UNIT[u]
    lane().draft[i].amount = Number(n)
    commit()
  }
  const has = (r: Rule, unit: Unit, list: number[]) => r.unit !== unit || list.includes(r.amount)
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
  <div class="run-top">
    <div class="run-l">
      <div class="status"><span class="led"></span>{game.ap.on ? 'Running in this tab' : 'Off'}</div>
      <p class="small muted">{game.ap.on ? 'Each round, once the previous round has finished, the running rules decide and place a sealed bet. Keep this page open.' : 'Turn it on to let the running rules place a bet every round while this page is open.'}</p>
    </div>
    <label class="switch">
      <input type="checkbox" checked={game.ap.on} onchange={e => setAutopilot((e.currentTarget as HTMLInputElement).checked)} aria-label="Run autopilot" />
      <span class="track"><span class="knob"></span></span>
    </label>
  </div>
  <div class="live-rules">
    <div class="eyebrow">Running rules{game.ap.lanes.length > 1 ? ` · ${game.ap.lanes.length} slots, each bets on its own` : ''}</div>
    {#each game.ap.lanes as l}
      {#if game.ap.lanes.length > 1}<div class="lane-h small"><b>{l.name}</b></div>{/if}
      <ol>{#each l.live as lr}<li>{describe(lr)}</li>{:else}<li class="faint">no rules: this slot does not bet</li>{/each}</ol>
    {/each}
    <div class="budget small">
      <label><input type="checkbox" checked={game.ap.budget.on} onchange={e => setBudget((e.currentTarget as HTMLInputElement).checked, game.ap.budget.near)} /> Daily budget: stop for the day after losing</label>
      <input type="number" min="0.01" step="0.1" aria-label="Daily budget in NEAR" value={game.ap.budget.near} onchange={e => setBudget(game.ap.budget.on, Number((e.currentTarget as HTMLInputElement).value))} /> NEAR
      <span class="faint">· today {today >= 0n ? '+' : '−'}{fmtNear(today >= 0n ? today : -today)} NEAR{game.ap.budget.on && -today >= BigInt(Math.round(game.ap.budget.near * 1e6)) * 10n ** 18n ? ' · paused until tomorrow' : ''}</span>
    </div>
  </div>
</section>

<div class="cols">
  <div class="col">
    <section class="card block">
      <div class="lanes" role="tablist" aria-label="Slots">
        {#each game.ap.lanes as l, i}
          <button role="tab" aria-selected={game.ap.sel === i} class:on={game.ap.sel === i} onclick={() => (game.ap.sel = i)}>{l.name}<span class="faint">{i === 0 ? ' · slot 0' : l.slot != null ? ` · slot ${l.slot}` : ' · new'}</span></button>
        {/each}
        <button class="add" onclick={() => addLane()} aria-label="Add a slot"><Icon name="plus" size={14} /> Slot</button>
      </div>
      <div class="bh"><h2>Draft rules{game.ap.lanes.length > 1 ? ` · ${L.name}` : ''}</h2><span class="faint small">checked top to bottom · first match decides</span></div>
      {#if game.ap.sel > 0}
        <div class="lanebar small">
          <label>Name <input aria-label="Slot name" value={L.name} onchange={e => { L.name = (e.currentTarget as HTMLInputElement).value.slice(0, 24) || L.name; commit() }} /></label>
          <button class="btn small ghost" onclick={() => removeLane(game.ap.sel)}>Stop using this slot</button>
        </div>
      {/if}
      <div class="draftbar" class:dirty>
        {#if dirty}
          <span><b>Draft.</b> Changes here don't affect the running rules{game.ap.on ? ', which keep betting' : ''}.</span>
          {#if confirmLive}
            <span class="acts"><button class="btn small" onclick={() => (confirmLive = false)}>Cancel</button><button class="btn small primary" onclick={goLive}>Yes, run these</button></span>
          {:else}
            <span class="acts"><button class="btn small ghost" onclick={() => { discardDraft(); toast('info', 'Draft reset to the running rules.') }}>Discard</button><button class="btn small primary" onclick={() => (confirmLive = true)}>Put these rules live</button></span>
          {/if}
        {:else}
          <span class="faint">Same as the running rules. Edit freely: nothing changes until you put a draft live.</span>
        {/if}
      </div>
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
              {#if r.cond.kind === 'margin'}
                <select aria-label="Margin" value={r.cond.mode} onchange={e => { if (r.cond.kind === 'margin') r.cond.mode = (e.currentTarget as HTMLSelectElement).value as any; commit() }}>
                  <option value="lopsided">a blowout (smaller side under 30%)</option>
                  <option value="close">close (smaller side 40%+)</option>
                </select>
              {/if}
              {#if r.cond.kind === 'tally'}
                <select aria-label="Side" value={r.cond.winner} onchange={e => { if (r.cond.kind === 'tally') r.cond.winner = (e.currentTarget as HTMLSelectElement).value as any; commit() }}>
                  <option value="A">A</option><option value="B">B</option>
                </select>
                <span class="w">won at least</span>
                <select aria-label="At least" value={String(r.cond.k)} onchange={e => { if (r.cond.kind === 'tally') { r.cond.k = Number((e.currentTarget as HTMLSelectElement).value); if (r.cond.k > r.cond.n) r.cond.n = r.cond.k } commit() }}>
                  {#each [2, 3, 4, 5, 6, 7] as n}<option value={String(n)}>{n}</option>{/each}
                </select>
                <span class="w">of the last</span>
                <select aria-label="Of the last" value={String(r.cond.n)} onchange={e => { if (r.cond.kind === 'tally') { r.cond.n = Number((e.currentTarget as HTMLSelectElement).value); if (r.cond.k > r.cond.n) r.cond.k = r.cond.n } commit() }}>
                  {#each [3, 4, 5, 6, 8, 10] as n}<option value={String(n)}>{n} rounds</option>{/each}
                </select>
              {/if}
              {#if r.cond.kind === 'mine'}
                <select aria-label="My last result" value={r.cond.result} onchange={e => { if (r.cond.kind === 'mine') r.cond.result = (e.currentTarget as HTMLSelectElement).value as any; commit() }}>
                  <option value="won">won</option><option value="lost">lost</option><option value="void">was refunded</option>
                </select>
              {/if}
              {#if r.cond.kind === 'last' || r.cond.kind === 'streak' || r.cond.kind === 'question' || r.cond.kind === 'margin'}
                <select aria-label="Winner" value={r.cond.winner} onchange={e => { if ('winner' in r.cond) (r.cond as any).winner = (e.currentTarget as HTMLSelectElement).value; commit() }}>
                  {#each winners(r.cond) as [v, t]}<option value={v}>{t}</option>{/each}
                </select>
              {/if}
              <span class="w">→ bet</span>
              <select aria-label="Bet" value={r.pick} onchange={e => { r.pick = (e.currentTarget as HTMLSelectElement).value as Pick; if (r.pick === 'loop') { r.pattern = cleanPattern(r.pattern); r.rest = !!r.rest } commit() }}>
                {#each picksFor(r.cond) as [v, t]}<option value={v}>{t}</option>{/each}
              </select>
              {#if r.pick === 'loop'}
                <input class="pat" aria-label="Pattern of A and B" maxlength="8" value={r.pattern ?? 'A'} oninput={e => { const el = e.currentTarget as HTMLInputElement; el.value = el.value.toUpperCase().replace(/[^AB]/g, '') }} onchange={e => { r.pattern = cleanPattern((e.currentTarget as HTMLInputElement).value); commit() }} />
                <label class="rest small"><input type="checkbox" checked={!!r.rest} onchange={e => { r.rest = (e.currentTarget as HTMLInputElement).checked; commit() }} /> after a loss, wait for the next cycle</label>
              {/if}
              {#if r.pick !== 'skip'}
                <span class="w">with</span>
                <select aria-label="Stake" value={`${CODE[r.unit]}:${r.amount}`} onchange={e => setStake(i, (e.currentTarget as HTMLSelectElement).value)}>
                  <optgroup label="The same amount every time">
                    {#each FIXED as n}<option value={`f:${n}`}>{chipsText(n)}</option>{/each}
                    {#if !has(r, 'fixed', FIXED)}<option value={`f:${r.amount}`}>{chipsText(r.amount)}</option>{/if}
                  </optgroup>
                  <optgroup label="Share of my balance">
                    {#each PCTS as n}<option value={`p:${n}`}>{n}% of balance</option>{/each}
                    {#if !has(r, 'pct', PCTS)}<option value={`p:${r.amount}`}>{r.amount}% of balance</option>{/if}
                  </optgroup>
                  <optgroup label="Double after a loss (martingale)">
                    {#each BASES as n}<option value={`m:${n}`}>{chipsText(n)}, doubled after each loss</option>{/each}
                    {#if !has(r, 'martingale', BASES)}<option value={`m:${r.amount}`}>{chipsText(r.amount)}, doubled after each loss</option>{/if}
                  </optgroup>
                  <optgroup label="Double after a win (paroli)">
                    {#each BASES as n}<option value={`r:${n}`}>{chipsText(n)}, doubled after each win</option>{/each}
                    {#if !has(r, 'paroli', BASES)}<option value={`r:${r.amount}`}>{chipsText(r.amount)}, doubled after each win</option>{/if}
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
      <div class="bh"><h2>Start from a strategy</h2><span class="faint small">loads into the draft</span></div>
      {#each PRESET_GROUPS as g}
      <div class="pg eyebrow">{g}</div>
      <div class="presets">
        {#each PRESETS.filter(x => x.group === g) as p}
          {@const i = PRESETS.indexOf(p)}
          {@const b = presetBt[i]}
          <button class="preset" onclick={() => use(i)}>
            <span class="pn">{p.name}</span>
            <span class="pa small muted">{p.about}</span>
            {#if b.rounds}<span class="pr small num">staked {fmtN(b.staked)} → <b class={tone(net(b))}>{signed(net(b))}</b> <span class="faint">· last {b.rounds} rounds</span></span>
              <span class="pr small num">best streak <b>{b.bestStreak}</b> · {need()}+ in a row: <b>{runsAtLeast(b, need())}</b> <span class="faint">· mined in {roundsText(b.mines)}</span></span>{/if}
            <span class="use small">Load into draft</span>
          </button>
        {/each}
      </div>
      {/each}
      <div class="pg eyebrow">Several slots at once</div>
      <div class="presets">
        {#each SLOT_SETS as set, i}
          {@const b = setBt[i]}
          <button class="preset" onclick={() => useSet(i)}>
            <span class="pn">{set.name} <span class="faint small">· {set.slots.length} slots</span></span>
            <span class="pa small muted">{set.about}</span>
            {#if b.rounds}<span class="pr small num">staked {fmtN(b.staked)} → <b class={tone(b.net)}>{signed(b.net)}</b> · <b class="gold">mined in {roundsText(b.mines)}</b> <span class="faint">· last {b.rounds} rounds</span></span>{/if}
            <span class="use small">Set up these slots</span>
          </button>
        {/each}
      </div>
    </section>
  </div>

  <div class="col">
    <section class="card block">
      <div class="bh"><h2>Replay on the last {bt.rounds} rounds</h2><span class="faint small">{dirty ? 'draft' : 'running rules'}</span></div>
      {#if bt.rounds}
        <div class="kpis">
          <div><div class="eyebrow">Net</div><div class="kv num {tone(net(bt))}">{signed(net(bt))}</div><div class="faint small">10 → {fmtN(bt.end)} NEAR</div></div>
          <div><div class="eyebrow">Staked</div><div class="kv num">{fmtN(bt.staked)}</div><div class="faint small">{bt.bets} bets · {bt.skips} skipped</div></div>
          <div><div class="eyebrow">Won / lost</div><div class="kv num"><span class="good">{bt.wins}</span> / <span class="burn">{bt.losses}</span></div><div class="faint small">{bt.voids} void</div></div>
          <div><div class="eyebrow">Longest streak</div><div class="kv num gold">{bt.bestStreak}</div><div class="faint small">{need()}+ in a row: {runsAtLeast(bt, need())} · mined in {roundsText(bt.mines)}</div></div>
        </div>
        {#if bt.wins}
          <div class="runs small" aria-label="Win streaks by length">
            <span class="faint">Win streaks</span>
            {#each runRows(bt) as [len, n]}<span class="runchip" class:mine={len === '5+' || Number(len) >= need()} class:zero={n === 0}>{len} in a row: <b class="num">{n}</b></span>{/each}
          </div>
        {/if}
        {#if btAll.n > 1}
          <div class="vs-live small">All {btAll.n} slots' running rules together: <b class={tone(btAll.net)}>{signed(btAll.net)}</b> NEAR · staked {fmtN(btAll.staked)} · <b class="gold">mined in {roundsText(btAll.mines)}</b></div>
        {/if}
        {#if dirty}
          <div class="vs-live small">Draft <b class={tone(net(bt))}>{signed(net(bt))}</b> <span class="faint">vs</span> running rules <b class={tone(net(btLive))}>{signed(net(btLive))}</b> <span class="faint">on the same rounds</span></div>
        {/if}
        <Equity curve={bt.curve} />
        <p class="faint small">Replays your rules round by round from 10 NEAR, using only what was known before each round and paying the {fee() / 100}% fee on every bet. Assumes your own bet would not have changed which side was smaller. Streaks count like the contract: a win adds 1, a loss resets, a void or a skipped round changes nothing. From the {ordinal(need())} win in a row, each win mines a share of that round's pot.</p>
        <details class="tbl">
          <summary>Every round in the replay</summary>
          <table>
            <thead><tr><th>Round</th><th>Rules bet</th><th>Smaller side</th><th>Streak</th><th>Balance</th></tr></thead>
            <tbody>
              {#each [...bt.curve].reverse() as s}
                <tr><td class="num">#{s.round}</td><td>{s.side ? `${fmtN(s.stake)} on ${label(s.round, s.side)}` : 'skip'}</td><td>{s.outcome === 'void' ? 'void' : label(s.round, s.outcome)}</td><td class="num">{s.side ? s.streak : ''}{s.mined ? ' · mines' : ''}</td><td class="num">{fmtN(s.bal)}</td></tr>
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
  .run { display: grid; gap: 12px; padding: 16px 20px; margin-bottom: 16px }
  .run-top { display: flex; align-items: center; justify-content: space-between; gap: 16px }
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
  .run-l { min-width: 0 }
  .live-rules { min-width: 0; padding: 10px 14px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--line-soft) }
  .live-rules ol { margin: 4px 0 0; padding-left: 18px; font-size: 13.5px; color: var(--fg-2); display: grid; gap: 2px }
  .draftbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; padding: 10px 12px; border-radius: 12px; font-size: 13.5px; background: var(--surface-2); border: 1px solid var(--line-soft); margin-bottom: 6px }
  .draftbar.dirty { background: rgba(232, 182, 94, 0.08); border-color: rgba(232, 182, 94, 0.35) }
  .draftbar .acts { display: flex; gap: 6px }
  .vs-live { margin: 2px 0 8px; color: var(--fg-2) }
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
  .pg { margin: 14px 0 8px }
  .pg:first-of-type { margin-top: 2px }
  .presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px }
  .preset { display: grid; gap: 4px; text-align: left; padding: 14px; border-radius: 14px; border: 1px solid var(--line); background: var(--surface-2); cursor: pointer; color: var(--fg); transition: border-color 0.15s var(--ease) }
  .preset:hover { border-color: var(--fg-3) }
  .pn { font-weight: 750 }
  .use { color: var(--brand); font-weight: 650; margin-top: 4px }
  .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 8px }
  @media (max-width: 520px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)) } }
  .runs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 4px 0 10px }
  .lanes { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px }
  .lanes button { padding: 5px 11px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface-2); color: var(--fg-2); font-size: 13px; cursor: pointer }
  .lanes button.on { background: var(--fg); color: var(--bg); border-color: var(--fg) }
  .lanes .add { display: inline-flex; align-items: center; gap: 4px; border-style: dashed }
  .lanebar { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin: -4px 0 10px }
  .lanebar input { width: 140px }
  .lane-h { margin-top: 6px }
  .pat { width: 88px; text-transform: uppercase; font-family: inherit; letter-spacing: 0.08em }
  .rest { display: inline-flex; gap: 6px; align-items: center; color: var(--fg-2) }
  .budget { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line) }
  .budget input[type='number'] { width: 76px }
  .runchip { white-space: nowrap; display: inline-flex; gap: 4px; align-items: baseline; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface-2); color: var(--fg-2) }
  .runchip.mine { border-color: rgba(232, 182, 94, 0.45); color: var(--fg) }
  .runchip.zero { opacity: 0.5 }
  .gold { color: var(--brand) }
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
