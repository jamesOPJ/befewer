// Round history kept in the browser: every played round we have seen, by round number.
// The rule engine and the backtest read ONLY from here, and only rounds before the one being
// decided, so a rule can never peek at the result it is betting on.
import { view, CONTRACT, type RoundV } from './chain'
import { QUESTIONS } from './questions'

export type Outcome = 'A' | 'B' | 'void'
const byId = new Map<number, RoundV>()
let deepLoaded = false

// Settled rounds never change (what the pages show of them), so they are kept in this browser:
// a reload shows the history at once and only asks the chain for rounds newer than the cache.
const CACHE = `fewer.rounds.v1.${CONTRACT}`
const KEEP = 500
try {
  for (const r of JSON.parse(localStorage.getItem(CACHE) || '[]') as RoundV[]) byId.set(Number(r.round), r)
} catch {}
let saveTimer: ReturnType<typeof setTimeout> | null = null
function saveSoon() {
  saveTimer ??= setTimeout(() => {
    saveTimer = null
    const settled = [...byId.values()].filter(r => r.settled).sort((a, b) => Number(b.round) - Number(a.round)).slice(0, KEEP)
    try { localStorage.setItem(CACHE, JSON.stringify(settled)) } catch {}
  }, 1500)
}
/** Newest settled round the cache held when the page opened (-1 if none): older ones are here. */
const cachedNewest = Math.max(-1, ...[...byId.values()].filter(r => r.settled).map(r => Number(r.round)))

/** Merge rounds we just fetched (newest views win). */
export function remember(list: RoundV[]) {
  for (const r of list) byId.set(Number(r.round), r)
  if (list.some(r => r.settled)) saveSoon()
}

/** First call: make sure ~320 rounds back are here (per-question history and backtests), asking
 *  only for the part newer than the cache, all pages at once. Resolves when they are in. */
export async function loadDeep(fromRound: number) {
  if (deepLoaded) return
  deepLoaded = true
  const stop = Math.max(0, fromRound - 320, cachedNewest - 50)
  const froms: number[] = []
  for (let from = fromRound; from >= stop; from -= 50) froms.push(from)
  await Promise.all(froms.map(from => view<RoundV[]>('get_rounds', { from: String(from), limit: 50 }).then(remember).catch(() => {})))
}

export function round(r: number): RoundV | undefined {
  return byId.get(r)
}

/** Smaller side of a settled round; null if nobody played it or it is not settled yet. */
export function outcome(r: number): Outcome | null {
  const x = byId.get(r)
  return x && x.settled && x.outcome ? x.outcome : null
}

/** Earlier rounds that asked the same question (r-100, r-200, ...), newest first, settled only. */
export function sameQuestion(r: number, max = 5): number[] {
  const out: number[] = []
  for (let t = r - QUESTIONS.length; t >= 0 && out.length < max; t -= QUESTIONS.length) if (outcome(t)) out.push(t)
  return out
}

/** Settled outcomes of the rounds just before r (r-1, r-2, ...), skipping rounds nobody played. */
export function recent(r: number, n: number): { round: number; outcome: Outcome }[] {
  const out: { round: number; outcome: Outcome }[] = []
  for (let t = r - 1; t >= 0 && out.length < n && r - t <= 400; t--) {
    const o = outcome(t)
    if (o) out.push({ round: t, outcome: o })
  }
  return out
}

/** Share of revealed coins on each side (0..1), or null if nothing was revealed. */
export function split(r: number): { a: number; b: number } | null {
  const x = byId.get(r)
  if (!x) return null
  const a = Number(BigInt(x.revealed_a) / 10n ** 15n)
  const b = Number(BigInt(x.revealed_b) / 10n ** 15n)
  return a + b > 0 ? { a: a / (a + b), b: b / (a + b) } : null
}
