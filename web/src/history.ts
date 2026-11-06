// Round history kept in the browser: every played round we have seen, by round number.
// The rule engine and the backtest read ONLY from here, and only rounds before the one being
// decided, so a rule can never peek at the result it is betting on.
import { view, type RoundV } from './chain'
import { QUESTIONS } from './questions'

export type Outcome = 'A' | 'B' | 'void'
const byId = new Map<number, RoundV>()
let deepLoaded = false

/** Merge rounds we just fetched (newest views win). */
export function remember(list: RoundV[]) {
  for (const r of list) byId.set(Number(r.round), r)
}

/** First call: walk back ~300 rounds so per-question history and backtests have data. */
export async function loadDeep(fromRound: number) {
  if (deepLoaded) return
  deepLoaded = true
  let from = fromRound
  const stop = Math.max(0, fromRound - 320)
  while (from >= stop) {
    const page = await view<RoundV[]>('get_rounds', { from: String(from), limit: 50 })
    remember(page)
    if (!page.length) break
    const oldest = Number(page[page.length - 1].round)
    if (oldest <= stop || page.length < 50) break
    from = oldest - 1
  }
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
