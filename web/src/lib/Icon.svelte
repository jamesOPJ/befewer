<script lang="ts">
  // Stroke icons on a 24px grid. Kept inline so the app ships no icon font.
  let { name, size = 20, stroke = 1.8 }: { name: string; size?: number; stroke?: number } = $props()
  const P: Record<string, string> = {
    play: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z',
    rounds: 'M4 6h16M4 12h16M4 18h10',
    bot: 'M12 3v3M7 9h10a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-4a3 3 0 0 1 3-3Zm2.5 5h.01M14.5 14h.01M9 21h6',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0',
    info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 8v5m0-8.5h.01',
    lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4.5V12l3 2',
    flame: 'M12 21c3.9 0 6.5-2.7 6.5-6.3 0-3.6-2.9-5.4-3.9-8.7-2 1.3-2.6 3.3-2.6 4.6C10.6 9 10 6.6 10.6 3 7.4 5.3 5.5 8.8 5.5 12.7 5.5 17.8 8.1 21 12 21Z',
    check: 'm5 12.5 4.5 4.5L19 7.5',
    x: 'M6 6l12 12M18 6 6 18',
    copy: 'M9 9h10v10H9zM5 15V5h10',
    shield: 'M12 3 5 6v5c0 4.6 3 8.3 7 10 4-1.7 7-5.4 7-10V6l-7-3Z',
    dice: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm3.5 4h.01M15.5 15.5h.01M12 12h.01',
    up: 'M12 19V5m-6 6 6-6 6 6',
    down: 'M12 5v14m6-6-6 6-6-6',
    plus: 'M12 5v14M5 12h14',
    trash: 'M5 7h14M10 11v6m4-6v6M8 7l1-3h6l1 3m-9 0 1 13h8l1-13',
    bolt: 'M13 3 5 14h6l-1 7 8-11h-6l1-7Z',
    chevron: 'm9 6 6 6-6 6',
    spark: 'M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
    chart: 'M4 19h16M7 15l3-4 3 2 5-7',
    eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Zm9.5-2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
    users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9a6 6 0 0 1 12 0m1.5-9.2a3 3 0 1 0-1.3-5.7M21 20a5 5 0 0 0-3.8-4.9',
  }
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={P[name] ?? P.info} />
</svg>
