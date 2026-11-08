<script lang="ts">
  // Autopilot page: why it only runs while the page is open, why no server runs it for you,
  // and the terminal script that keeps it going without a browser.
  import Icon from './Icon.svelte'
  import { game, toast } from '../game.svelte'

  const REPO = 'https://github.com/jamesOPJ/befewer'
  const KEY = 'befewer.ap.offpage'
  let open = $state((() => { try { return localStorage.getItem(KEY) === '1' } catch { return false } })())
  function toggle(e: Event) {
    open = (e.currentTarget as HTMLDetailsElement).open
    try { localStorage.setItem(KEY, open ? '1' : '0') } catch {}
  }

  // the slots that are switched on, with the slot each one already uses (so its streak carries on)
  const lanes = $derived.by(() => {
    const acct = game.session?.accountId
    return game.ap.lanes
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.on !== false && l.live.length)
      .map(({ l, i }) => ({ name: l.name, slot: i === 0 ? 0 : l.owner === acct ? l.slot : null, rules: $state.snapshot(l.live) }))
  })
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const command = (key: string) => {
    const s = game.session
    const rules = lanes.length ? `--rules ${q(JSON.stringify(lanes))}` : '--strategy Echo'
    return s ? `FEWER_PRIVATE_KEY=${key} node autopilot.mjs --account ${s.accountId} ${rules}` : `node autopilot.mjs --account you.testnet ${rules}`
  }
  const shown = $derived(command(game.session ? game.session.privateKey.slice(0, 12) + '…' : ''))
  async function copy() {
    if (!game.session) return
    try {
      await navigator.clipboard.writeText(command(game.session.privateKey))
      toast('ok', "Command copied, with this account's key. Paste it in a terminal inside the keeper folder.")
    } catch {
      toast('err', 'Could not copy.')
    }
  }
</script>

<details class="card offpage" {open} ontoggle={toggle}>
  <summary>
    <Icon name="info" size={18} />
    <span class="ttl"><b>Runs only while this page is open</b><span class="small muted">What that means, and how to keep it running</span></span>
    <span class="chev"><Icon name="chevron" size={16} /></span>
  </summary>

  <div class="body">
    <section>
      <h3>With this page only</h3>
      <ul class="small">
        <li>Closing the tab or the browser, or the computer going to sleep, stops new bets.</li>
        <li>On a phone, switching apps or locking the screen pauses the page.</li>
        <li>In a background tab the browser slows the page down: it can miss a round, or reveal late, and then a keeper earns the reveal reward instead of you.</li>
        <li>Safe either way: sealed bets still settle (a keeper reveals them), and skipped rounds keep your streak.</li>
      </ul>
    </section>

    <section>
      <h3>Why no server runs it for you</h3>
      <p class="small">To bet for you, a server would have to know your side before betting closes. Whoever runs it, us included, would see every Autopilot player's side, and that is exactly what wins a minority game. So strategies only run on your own device: this page, or your own computer.</p>
    </section>

    <section>
      <h3>Run it on your computer</h3>
      <p class="small">A terminal script runs the slots that are switched on here, with the same rules and this account, and keeps going without a browser. It seals and reveals your bets itself, so your sides never leave your computer. Needs Node 22.18+ and git.</p>
      <pre class="small"><code>git clone {REPO} befewer
cd befewer/keeper && npm ci
{shown}</code></pre>
      {#if game.session}
        <div class="row">
          <button class="btn small primary" onclick={copy}>Copy the last line</button>
          <span class="small faint">{game.session.kind === 'wallet' ? "It includes this browser's game-only key: it can play and move NEAR from the game back to your wallet, nothing else." : "It includes this testnet account's key: anyone who has it controls the account. Don't share it."}</span>
        </div>
      {:else}
        <p class="small faint">Play once first: the command needs your account. Or use your own testnet account (its key in ~/.near-credentials) with <code>--strategy Echo</code>; <code>--list</code> shows the strategies.</p>
      {/if}
      <p class="small muted">Switch this page's Autopilot off while the script runs: a slot takes one bet per round. The script's bets count in your totals here, but their list of results stays in the terminal (a page only knows the sides it sealed itself).</p>
    </section>
  </div>
</details>

<style>
  .offpage { margin-bottom: 16px; padding: 0 }
  summary { display: flex; align-items: center; gap: 10px; padding: 14px 20px; cursor: pointer; list-style: none; color: var(--fg-2) }
  summary::-webkit-details-marker { display: none }
  .ttl { flex: 1; min-width: 0; display: grid; gap: 2px }
  .ttl b { color: var(--fg) }
  .chev { display: inline-grid; color: var(--fg-3); transition: transform 0.15s }
  details[open] .chev { transform: rotate(90deg) }
  .body { display: grid; gap: 16px; padding: 0 20px 18px }
  h3 { font-size: 15px; margin: 0 0 6px }
  ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; color: var(--fg-2) }
  p { margin: 0 0 8px; color: var(--fg-2) }
  pre { margin: 0 0 10px; padding: 10px 12px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--line); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg) }
  .row { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin-bottom: 8px }
  .small { font-size: 13px }
</style>
