<script lang="ts">
  import { onMount } from 'svelte'
  import { game, start, fmt, fmtN, short, openWallet } from './game.svelte'
  import WalletModal from './lib/WalletModal.svelte'
  import Icon from './lib/Icon.svelte'
  import Toasts from './lib/Toasts.svelte'
  import Play from './pages/Play.svelte'
  import Rounds from './pages/Rounds.svelte'
  import Autopilot from './pages/Autopilot.svelte'
  import Me from './pages/Me.svelte'
  import How from './pages/How.svelte'

  const TABS = [
    { id: 'play', label: 'Play', icon: 'play' },
    { id: 'rounds', label: 'Rounds', icon: 'rounds' },
    { id: 'autopilot', label: 'Autopilot', icon: 'bot' },
    { id: 'me', label: 'Me', icon: 'user' },
    { id: 'how', label: 'How it works', short: 'How', icon: 'info' },
  ]
  const route = () => (location.hash.replace(/^#\/?/, '').split('/')[0] || 'play')
  let page = $state(route())
  onMount(() => {
    start()
    const on = () => { page = route(); window.scrollTo({ top: 0 }) }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  })
</script>

<header class="top">
  <div class="bar">
    <a class="brand" href="#/" aria-label="BEFEWER home">
      <svg width="30" height="30" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#26231f" /><circle cx="41" cy="31" r="14" fill="#5f5a53" /><circle cx="20" cy="37" r="7.5" fill="var(--brand)" /></svg>
      <span class="word">BE<b>FEWER</b></span>
    </a>
    <nav class="tabs-top" aria-label="Main">
      {#each TABS as t}
        <a href="#/{t.id === 'play' ? '' : t.id}" class:on={page === t.id} aria-current={page === t.id ? 'page' : undefined}>{t.label}</a>
      {/each}
    </nav>
    <div class="right">
      <span class="pill testnet" title="Testnet NEAR and BEFEWER are free and have no monetary value">Testnet</span>
      {#if game.session?.kind !== 'wallet'}<button class="pill connect" onclick={openWallet}>Connect wallet</button>{/if}
      {#if game.me}
        <a class="pill bal num" href="#/me" title={game.session?.accountId}>{fmtN(game.me.balance, 3)} <span class="faint">NEAR</span>{#if BigInt(game.me.tokens) + BigInt(game.me.unrefined) + BigInt(game.me.refined) > 0n} · {fmt(BigInt(game.me.tokens) + BigInt(game.me.unrefined) + BigInt(game.me.refined))} <span class="faint">BEFEWER</span>{/if}</a>
      {/if}
    </div>
  </div>
</header>

{#if game.error}<div class="offline">{game.error}</div>{/if}

<main>
  {#if !game.ready}
    <div class="skeleton">
      <div class="sk sk1"></div><div class="sk sk2"></div><div class="sk sk3"></div>
    </div>
  {:else if page === 'rounds'}<Rounds />
  {:else if page === 'autopilot'}<Autopilot />
  {:else if page === 'me'}<Me />
  {:else if page === 'how'}<How />
  {:else}<Play />{/if}
  <WalletModal />
</main>

<nav class="tabs-bottom" aria-label="Main">
  {#each TABS as t}
    <a href="#/{t.id === 'play' ? '' : t.id}" class:on={page === t.id} aria-current={page === t.id ? 'page' : undefined}>
      <Icon name={t.icon} size={22} /><span>{t.short ?? t.label}</span>
    </a>
  {/each}
</nav>

<Toasts />

<style>
  .top { position: sticky; top: 0; z-index: 40; backdrop-filter: saturate(140%) blur(14px); -webkit-backdrop-filter: saturate(140%) blur(14px); background: rgba(22, 20, 18, 0.78); border-bottom: 1px solid var(--line-soft) }
  .bar { max-width: 1120px; margin: 0 auto; height: 60px; padding: 0 16px; display: flex; align-items: center; gap: 20px }
  .brand { display: flex; align-items: center; gap: 10px; color: var(--fg); text-decoration: none }
  .word { font-weight: 800; letter-spacing: 0.04em; font-size: 15px; color: var(--fg-2) }
  .word b { color: var(--fg); font-weight: 800 }
  .tabs-top { display: none; gap: 4px }
  .tabs-top a { padding: 8px 12px; border-radius: 10px; color: var(--fg-2); font-weight: 600; font-size: 14px; text-decoration: none }
  .tabs-top a:hover { color: var(--fg); background: var(--surface) }
  .tabs-top a.on { color: var(--fg); background: var(--surface-2) }
  .right { margin-left: auto; display: flex; gap: 8px; align-items: center }
  .testnet { color: var(--brand); border-color: rgba(232, 182, 94, 0.35); background: rgba(232, 182, 94, 0.08) }
  .bal { color: var(--fg); text-decoration: none }
  main { max-width: 1120px; margin: 0 auto; padding: 20px 16px calc(var(--nav-h) + 40px + env(safe-area-inset-bottom)) }
  .tabs-bottom { position: fixed; left: 0; right: 0; bottom: 0; z-index: 40; height: calc(var(--nav-h) + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom); display: grid; grid-template-columns: repeat(5, 1fr); background: rgba(27, 25, 22, 0.92); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-top: 1px solid var(--line-soft) }
  .tabs-bottom a { display: grid; place-items: center; align-content: center; gap: 3px; color: var(--fg-3); font-size: 11px; font-weight: 600; text-decoration: none }
  .tabs-bottom a.on { color: var(--brand) }
  @media (min-width: 860px) {
    .tabs-top { display: flex }
    .tabs-bottom { display: none }
    main { padding-bottom: 60px }
  }
  .offline { max-width: 1120px; margin: 12px auto 0; padding: 10px 16px; border-radius: 12px; background: var(--err-bg); border: 1px solid var(--err-line); color: var(--err-fg); font-size: 14px }
  .skeleton { display: grid; gap: 16px }
  .sk { border-radius: var(--r-lg); background: linear-gradient(90deg, var(--surface) 0%, var(--surface-2) 50%, var(--surface) 100%); background-size: 200% 100%; animation: sh 1.4s linear infinite }
  .sk1 { height: 260px } .sk2 { height: 140px } .sk3 { height: 200px }
  @keyframes sh { to { background-position: -200% 0 } }
  .connect { cursor: pointer; border: 1px solid var(--line); background: var(--surface-2); color: var(--fg) }
  @media (max-width: 520px) { .connect { font-size: 12px; padding: 4px 9px } }
</style>
