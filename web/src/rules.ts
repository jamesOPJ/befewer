// Autopilot rules: "If <condition> then bet <pick> with <pct>% of my balance".
// Pure functions only. Every lookup goes through `Lookup`, which only ever answers about
// rounds BEFORE the one being decided, so neither the live autopilot nor the backtest can see
// the result they are betting on.
export type Side = 'A' | 'B'
export type Outcome = 'A' | 'B' | 'void'
export type Who = Side | 'any'
export type Cond =
  | { kind: 'always' }
  | { kind: 'last'; winner: Who } // the most recent finished round before this one
  | { kind: 'streak'; winner: Who; n: number } // the last n finished rounds were all won by the same side
  | { kind: 'question'; winner: Who } // the last time this same question was asked
export type Pick = 'A' | 'B' | 'same' | 'other' | 'random' | 'skip'
export type Rule = { cond: Cond; pick: Pick; pct: number }
export type Decision = { side: Side; pct: number; rule: number } | { skip: true; rule: number | null }

export interface Lookup {
  /** finished rounds before r (r-1, r-2, ...), newest first, skipping rounds nobody played */
  recent(r: number, n: number): { round: number; outcome: Outcome }[]
  /** earlier rounds with the same question (r-100, r-200, ...), newest first, finished only */
  sameQuestion(r: number, max: number): number[]
  outcome(r: number): Outcome | null
}

/** Deterministic per-round coin so a "random" pick doesn't change every time the page repaints. */
export function coin(r: number, salt = 0): Side {
  let x = (r * 2654435761 + salt * 40503 + 12345) >>> 0
  x ^= x >>> 15
  x = Math.imul(x, 2246822519) >>> 0
  x ^= x >>> 13
  return x & 1 ? 'A' : 'B'
}

/** The side a condition talks about if it holds for round r, else null. 'always' holds with no side. */
function matches(c: Cond, r: number, L: Lookup): { ok: boolean; side: Side | null } {
  const hit = (o: Outcome | null | undefined, w: Who) =>
    o === 'A' || o === 'B' ? (w === 'any' || w === o ? { ok: true, side: o as Side } : { ok: false, side: null }) : { ok: false, side: null }
  switch (c.kind) {
    case 'always':
      return { ok: true, side: null }
    case 'last':
      return hit(L.recent(r, 1)[0]?.outcome, c.winner)
    case 'streak': {
      const n = Math.max(1, Math.min(20, Math.floor(c.n)))
      const rec = L.recent(r, n)
      if (rec.length < n) return { ok: false, side: null }
      const first = rec[0].outcome
      if (first === 'void' || !rec.every(x => x.outcome === first)) return { ok: false, side: null }
      return hit(first, c.winner)
    }
    case 'question': {
      const t = L.sameQuestion(r, 1)[0]
      return t === undefined ? { ok: false, side: null } : hit(L.outcome(t), c.winner)
    }
  }
}

export function decide(rules: Rule[], r: number, L: Lookup): Decision {
  for (let i = 0; i < rules.length; i++) {
    const { cond, pick, pct } = rules[i]
    const m = matches(cond, r, L)
    if (!m.ok) continue
    if (pick === 'skip') return { skip: true, rule: i }
    let side: Side
    if (pick === 'A' || pick === 'B') side = pick
    else if (pick === 'random' || !m.side) side = coin(r, i)
    else side = pick === 'same' ? m.side : m.side === 'A' ? 'B' : 'A'
    return { side, pct: Math.max(1, Math.min(25, Math.round(pct))), rule: i }
  }
  return { skip: true, rule: null }
}

export type Backtest = { rounds: number; bets: number; wins: number; losses: number; voids: number; skips: number; start: number; end: number }

/** Replay `rules` over finished rounds from..to, starting with `start` coins, compounding.
 *  Assumes your own bet would not have changed which side was smaller. */
export function backtest(rules: Rule[], from: number, to: number, L: Lookup, start = 1000): Backtest {
  const bt: Backtest = { rounds: 0, bets: 0, wins: 0, losses: 0, voids: 0, skips: 0, start, end: start }
  let bal = start
  for (let t = from; t <= to; t++) {
    const o = L.outcome(t)
    if (!o) continue // nobody played that round
    bt.rounds++
    const d = decide(rules, t, guard(L, t))
    if ('skip' in d) { bt.skips++; continue }
    const stake = Math.max(1, Math.floor((bal * d.pct) / 100))
    if (stake > bal) { bt.skips++; continue }
    bt.bets++
    if (o === 'void') bt.voids++
    else if (o === d.side) { bt.wins++; bal += stake }
    else { bt.losses++; bal -= stake }
  }
  bt.end = bal
  return bt
}

/** A view of the history that refuses to answer about round `r` or later. */
export function guard(L: Lookup, r: number): Lookup {
  const check = (t: number) => {
    if (t >= r) throw new Error(`lookahead: asked about round ${t} while deciding round ${r}`)
  }
  const before = (q: number) => {
    if (q > r) throw new Error(`lookahead: asked about rounds before ${q} while deciding round ${r}`)
  }
  return {
    recent: (q, n) => { before(q); const out = L.recent(q, n); out.forEach(x => check(x.round)); return out },
    sameQuestion: (q, max) => { before(q); const out = L.sameQuestion(q, max); out.forEach(check); return out },
    outcome: t => { check(t); return L.outcome(t) },
  }
}

export const PRESETS: { name: string; about: string; rules: Rule[] }[] = [
  { name: 'Echo', about: 'bet that the last smaller side wins again', rules: [
    { cond: { kind: 'last', winner: 'any' }, pick: 'same', pct: 5 },
    { cond: { kind: 'always' }, pick: 'random', pct: 5 }] },
  { name: 'Flip', about: 'bet the crowd over-corrects', rules: [
    { cond: { kind: 'last', winner: 'any' }, pick: 'other', pct: 5 },
    { cond: { kind: 'always' }, pick: 'random', pct: 5 }] },
  { name: 'Streak breaker', about: 'after 3 wins in a row for one side, bet the other', rules: [
    { cond: { kind: 'streak', winner: 'any', n: 3 }, pick: 'other', pct: 10 },
    { cond: { kind: 'always' }, pick: 'skip', pct: 5 }] },
  { name: 'Remember the question', about: 'bet against whatever won this question last time', rules: [
    { cond: { kind: 'question', winner: 'any' }, pick: 'other', pct: 5 },
    { cond: { kind: 'always' }, pick: 'random', pct: 2 }] },
]
