// Opening players' drand timelocks fast enough that nobody can crowd a round out.
//
// One sealed bet takes ~250 ms to open the naive way (the drand beacon is fetched and its BLS
// signature verified again for every bet, on one thread). That is ~150 bets per reveal window,
// and anyone could fill a round with junk timelocks (cheap: the fee mostly comes back as the
// reveal reward) so the keeper runs out of time before it reaches other players' bets.
// So: each drand round's beacon is fetched and verified once (~50 ms per bet after that), the
// work is spread over worker threads, and the order is fair: every account's first bet before
// anyone's second, and timelocks aimed at the round an honest page uses come before the rest.
import { Worker } from 'node:worker_threads'

/** The drand round a sealed bet can be opened at (from its age "tlock" stanza), or null. */
export function stanzaRound(sealed) {
  try {
    const b64 = String(sealed).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
    const m = Buffer.from(b64, 'base64').toString('latin1').match(/-> tlock (\d+) /)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

/** Unrevealed sealed commits in the order to open them: aimed at the expected drand round
 *  (within `slack`) first, then the rest; inside each group, round-robin over accounts. */
export function orderForOpening(commits, expectedRound, slack = 3) {
  const fair = list => {
    const by = new Map()
    for (const c of list) (by.get(c.account_id) ?? by.set(c.account_id, []).get(c.account_id)).push(c)
    const queues = [...by.values()], out = []
    for (let i = 0; out.length < list.length; i++) for (const q of queues) if (q[i]) out.push(q[i])
    return out
  }
  const ok = [], odd = []
  for (const c of commits) {
    const dr = stanzaRound(c.sealed)
    ;(dr != null && Math.abs(dr - expectedRound) <= slack ? ok : odd).push(c)
  }
  return [...fair(ok), ...fair(odd)]
}

/** A pool of worker threads that open timelocks: open(sealed) -> "A:salt" text.
 *  Every open() settles: with the text, with the worker's error, or after `timeoutMs` (drand not
 *  answering, a worker stuck). A worker that dies or times out is replaced, and only the jobs it
 *  held fail. (Before, a dead worker stayed in the pool: its jobs never settled, and the keeper's
 *  loop waited on them forever.) */
export function createOpener(workers = 4, { timeoutMs = 8_000, script = new URL('./opener-worker.mjs', import.meta.url) } = {}) {
  const waiting = new Map() // job id -> { resolve, reject, slot, timer }
  const pool = []
  let next = 0, id = 0, closed = false
  const settle = (n, fn) => {
    const p = waiting.get(n)
    if (!p) return
    waiting.delete(n)
    clearTimeout(p.timer)
    fn(p)
  }
  const failSlot = (slot, err) => { for (const [n, p] of waiting) if (p.slot === slot) settle(n, q => q.reject(err)) }
  const spawn = slot => {
    const w = new Worker(script)
    pool[slot] = w
    w.on('message', m => settle(m.id, p => (m.err ? p.reject(new Error(m.err)) : p.resolve(m.pt))))
    const gone = err => {
      if (pool[slot] !== w) return // already replaced
      failSlot(slot, err)
      if (!closed) spawn(slot)
    }
    w.on('error', e => gone(e instanceof Error ? e : new Error(String(e))))
    w.on('exit', code => gone(new Error(`timelock worker exited (${code})`)))
  }
  for (let i = 0; i < workers; i++) spawn(i)
  return {
    open(sealed) {
      return new Promise((resolve, reject) => {
        const n = ++id, slot = next++ % workers
        const timer = setTimeout(() => {
          // the worker may be stuck on this job: replace it (its other jobs fail and can be retried)
          const w = pool[slot]
          settle(n, p => p.reject(new Error('timelock not opened in time')))
          if (pool[slot] === w && !closed) { failSlot(slot, new Error('timelock worker restarted')); spawn(slot); w.terminate().catch(() => {}) }
        }, timeoutMs)
        waiting.set(n, { resolve, reject, slot, timer })
        pool[slot].postMessage({ id: n, sealed })
      })
    },
    close: () => { closed = true; return Promise.all(pool.map(w => w.terminate())) },
  }
}

/** Of the reveal items, the ones whose bet is still sealed on chain (`commits`: a fresh
 *  get_round_commits read, which costs no gas). The rest were revealed by someone else since:
 *  sending them would only pay a transaction for nothing. */
export function stillSealed(items, commits) {
  const open = new Set(commits.filter(c => !c.side).map(c => `${c.account_id}:${c.slot}`))
  const keep = items.filter(x => open.has(`${x.account_id}:${x.slot}`))
  return { keep, dropped: items.length - keep.length }
}
