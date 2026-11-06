// Autopilot rules: "If <condition> then bet <pick> with <stake>".
// Pure functions only. Every lookup goes through `Lookup`, which only ever answers about
// rounds BEFORE the one being decided, so neither the live autopilot nor the backtest can see
// the result they are betting on. "My last bet" comes from `Me`, which is built from bets that
// had already settled (live) or from the replay's own earlier bets (backtest).
export type Side = 'A' | 'B'
export type Outcome = 'A' | 'B' | 'void'
export type Who = Side | 'any'
export type Cond =
  | { kind: 'always' }
  | { kind: 'last'; winner: Who } // the most recent finished round before this one
  | { kind: 'streak'; winner: Who; n: number } // the last n finished rounds were all won by the same side
  | { kind: 'tally'; winner: Side; k: number; n: number } // `winner` won at least k of the last n finished rounds
  | { kind: 'margin'; mode: 'lopsided' | 'close'; winner: Who } // the round before: smaller side under 30% / at least 40%
  | { kind: 'question'; winner: Who } // the last time this same question was asked
  | { kind: 'mine'; result: 'won' | 'lost' | 'void' } // my most recent settled bet
export type Pick = 'A' | 'B' | 'same' | 'other' | 'random' | 'skip'
/** fixed = N BEFEWER every time (DCA); pct = share of balance; martingale = base, doubled after
 *  each loss in a row; paroli = base, doubled after each win, back to base after 3 wins. */
export type Unit = 'fixed' | 'pct' | 'martingale' | 'paroli'
export type Rule = { cond: Cond; pick: Pick; unit: Unit; amount: number }
export type Decision = { side: Side; unit: Unit; amount: number; rule: number } | { skip: true; rule: number | null }
export const MAX_PCT = 25 // the contract caps a bet at 25% of the balance
export const LOPSIDED = 0.3
export const CLOSE = 0.4
const MAX_DOUBLINGS = 6

/** My own recent record: the last settled bet and the current run of wins or losses (voids don't break it). */
export type Me = { last: { side: Side; outcome: Outcome } | null; wins: number; losses: number }
export const NOBODY: Me = { last: null, wins: 0, losses: 0 }

/** Build `Me` from settled bets, newest first. */
export function meFrom(bets: { side: Side; outcome: Outcome }[]): Me {
  if (!bets.length) return NOBODY
  let wins = 0, losses = 0
  for (const b of bets) {
    if (b.outcome === 'void') continue
    const won = b.outcome === b.side
    if (won && losses === 0) wins++
    else if (!won && wins === 0) losses++
    else break
  }
  return { last: { side: bets[0].side, outcome: bets[0].outcome }, wins, losses }
}
function nextMe(me: Me, side: Side, outcome: Outcome): Me {
  if (outcome === 'void') return { ...me, last: { side, outcome } }
  const won = outcome === side
  return { last: { side, outcome }, wins: won ? me.wins + 1 : 0, losses: won ? 0 : me.losses + 1 }
}

/** Rules saved by older versions used { pct }; read them as a percentage stake. */
export function normalizeRule(r: any): Rule {
  if (r && r.unit && typeof r.amount === 'number') return r as Rule
  return { cond: r.cond, pick: r.pick, unit: 'pct', amount: typeof r.pct === 'number' ? r.pct : 5 }
}

/** BEFEWER a rule would stake with balance `bal`, after the contract's 25% cap. 0 = can't bet. */
export function stakeFor(unit: Unit, amount: number, bal: number, me: Me = NOBODY): number {
  const cap = Math.floor((bal * MAX_PCT) / 100)
  if (cap < 1) return 0
  let want: number
  if (unit === 'pct') want = Math.floor((bal * Math.max(1, Math.min(MAX_PCT, amount))) / 100)
  else if (unit === 'martingale') want = Math.floor(amount) * 2 ** Math.min(me.losses, MAX_DOUBLINGS)
  else if (unit === 'paroli') want = Math.floor(amount) * 2 ** (me.wins % 3)
  else want = Math.floor(amount)
  return Math.max(1, Math.min(want, cap))
}

export interface Lookup {
  /** finished rounds before r (r-1, r-2, ...), newest first, skipping rounds nobody played */
  recent(r: number, n: number): { round: number; outcome: Outcome }[]
  /** earlier rounds with the same question (r-100, r-200, ...), newest first, finished only */
  sameQuestion(r: number, max: number): number[]
  outcome(r: number): Outcome | null
  /** share of revealed coins on each side of a finished round */
  split(r: number): { a: number; b: number } | null
}

/** Deterministic per-round coin so a "random" pick doesn't change every time the page repaints. */
export function coin(r: number, salt = 0): Side {
  let x = (r * 2654435761 + salt * 40503 + 12345) >>> 0
  x ^= x >>> 15
  x = Math.imul(x, 2246822519) >>> 0
  x ^= x >>> 13
  return x & 1 ? 'A' : 'B'
}

const NO = { ok: false, side: null } as const
/** Whether a condition holds for round r, and the side it talks about (null for 'always'). */
function matches(c: Cond, r: number, L: Lookup, me: Me): { ok: boolean; side: Side | null } {
  const hit = (o: Outcome | null | undefined, w: Who) =>
    o === 'A' || o === 'B' ? (w === 'any' || w === o ? { ok: true, side: o as Side } : NO) : NO
  switch (c.kind) {
    case 'always':
      return { ok: true, side: null }
    case 'last':
      return hit(L.recent(r, 1)[0]?.outcome, c.winner)
    case 'streak': {
      const n = Math.max(1, Math.min(20, Math.floor(c.n)))
      const rec = L.recent(r, n)
      if (rec.length < n) return NO
      const first = rec[0].outcome
      if (first === 'void' || !rec.every(x => x.outcome === first)) return NO
      return hit(first, c.winner)
    }
    case 'tally': {
      const n = Math.max(1, Math.min(20, Math.floor(c.n)))
      const k = Math.max(1, Math.min(n, Math.floor(c.k)))
      const rec = L.recent(r, n)
      if (rec.length < n) return NO
      return rec.filter(x => x.outcome === c.winner).length >= k ? { ok: true, side: c.winner } : NO
    }
    case 'margin': {
      const last = L.recent(r, 1)[0]
      if (!last || last.outcome === 'void') return NO
      const sp = L.split(last.round)
      if (!sp) return NO
      const small = Math.min(sp.a, sp.b)
      const fits = c.mode === 'lopsided' ? small < LOPSIDED : small >= CLOSE
      return fits ? hit(last.outcome, c.winner) : NO
    }
    case 'question': {
      const t = L.sameQuestion(r, 1)[0]
      return t === undefined ? NO : hit(L.outcome(t), c.winner)
    }
    case 'mine': {
      if (!me.last) return NO
      const { side, outcome } = me.last
      const res = outcome === 'void' ? 'void' : outcome === side ? 'won' : 'lost'
      return res === c.result ? { ok: true, side } : NO
    }
  }
}

export function decide(rules: Rule[], r: number, L: Lookup, me: Me = NOBODY): Decision {
  for (let i = 0; i < rules.length; i++) {
    const { cond, pick, unit, amount } = rules[i]
    const m = matches(cond, r, L, me)
    if (!m.ok) continue
    if (pick === 'skip') return { skip: true, rule: i }
    let side: Side
    if (pick === 'A' || pick === 'B') side = pick
    else if (pick === 'random' || !m.side) side = coin(r, i)
    else side = pick === 'same' ? m.side : m.side === 'A' ? 'B' : 'A'
    const amt = unit === 'pct' ? Math.max(1, Math.min(MAX_PCT, Math.round(amount))) : Math.max(1, Math.floor(amount))
    return { side, unit, amount: amt, rule: i }
  }
  return { skip: true, rule: null }
}

export type Step = { round: number; side: Side | null; outcome: Outcome; stake: number; bal: number }
export type Backtest = { rounds: number; bets: number; wins: number; losses: number; voids: number; skips: number; start: number; end: number; staked: number; curve: Step[] }

/** Replay `rules` over finished rounds from..to, starting with `start` coins. The replay keeps
 *  its own "my last bet" state from its own simulated bets. Assumes your own bet would not have
 *  changed which side was smaller. */
export function backtest(rules: Rule[], from: number, to: number, L: Lookup, start = 1000): Backtest {
  const bt: Backtest = { rounds: 0, bets: 0, wins: 0, losses: 0, voids: 0, skips: 0, start, end: start, staked: 0, curve: [] }
  let bal = start
  let me: Me = NOBODY
  for (let t = from; t <= to; t++) {
    const o = L.outcome(t)
    if (!o) continue // nobody played that round
    bt.rounds++
    const d = decide(rules, t, guard(L, t), me)
    const stake = 'skip' in d ? 0 : stakeFor(d.unit, d.amount, bal, me)
    if ('skip' in d || stake < 1) { bt.skips++; bt.curve.push({ round: t, side: null, outcome: o, stake: 0, bal }); continue }
    bt.bets++
    bt.staked += stake
    if (o === 'void') bt.voids++
    else if (o === d.side) { bt.wins++; bal += stake }
    else { bt.losses++; bal -= stake }
    me = nextMe(me, d.side, o)
    bt.curve.push({ round: t, side: d.side, outcome: o, stake, bal })
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
    split: t => { check(t); return L.split(t) },
  }
}

/** Plain-English sentence for a rule (read-only views of the running rules). */
export function describe(r: Rule): string {
  const c = r.cond
  const won = (w: Who) => (w === 'any' ? 'one side' : w)
  const cond =
    c.kind === 'always' ? 'Otherwise'
    : c.kind === 'last' ? (c.winner === 'any' ? 'If the round before had a winner' : `If ${c.winner} won the round before`)
    : c.kind === 'streak' ? `If ${won(c.winner)} won the last ${c.n} rounds in a row`
    : c.kind === 'tally' ? `If ${c.winner} won at least ${c.k} of the last ${c.n} rounds`
    : c.kind === 'margin' ? `If the round before was ${c.mode === 'lopsided' ? 'a blowout (smaller side under 30%)' : 'close (smaller side 40%+)'}${c.winner === 'any' ? '' : ` and ${c.winner} won it`}`
    : c.kind === 'mine' ? `If my last bet ${c.result === 'void' ? 'was refunded' : c.result}`
    : c.winner === 'any' ? 'If this question was asked before' : `If ${c.winner} won this question last time`
  if (r.pick === 'skip') return `${cond} → skip the round`
  const pick = { same: 'that same side', other: 'the other side', A: 'A', B: 'B', random: 'a random side' }[r.pick]
  return `${cond} → bet ${pick}, ${stakeText(r.unit, r.amount)}`
}
export function stakeText(unit: Unit, amount: number): string {
  if (unit === 'pct') return `${amount}% of balance`
  if (unit === 'martingale') return `${amount} BEFEWER, doubled after each loss`
  if (unit === 'paroli') return `${amount} BEFEWER, doubled after each win (3 max)`
  return `${amount} BEFEWER`
}

const R = (cond: Cond, pick: Pick, amount = 10, unit: Unit = 'fixed'): Rule => ({ cond, pick, unit, amount })
const ALWAYS: Cond = { kind: 'always' }
export type Preset = { name: string; group: string; about: string; rules: Rule[] }
export const PRESET_GROUPS = ['Follow the crowd', 'Fade the crowd', 'Memory', 'Money management']
export const PRESETS: Preset[] = [
  { name: 'Echo', group: 'Follow the crowd', about: 'Bet 10 that the last smaller side wins again.',
    rules: [R({ kind: 'last', winner: 'any' }, 'same'), R(ALWAYS, 'random')] },
  { name: 'Momentum', group: 'Follow the crowd', about: 'If one side won 4 of the last 6 rounds, bet 10 on it again. Otherwise sit out.',
    rules: [R({ kind: 'tally', winner: 'A', k: 4, n: 6 }, 'A'), R({ kind: 'tally', winner: 'B', k: 4, n: 6 }, 'B'), R(ALWAYS, 'skip')] },
  { name: 'Flip', group: 'Fade the crowd', about: "Bet 10 that the crowd over-corrects to last round's smaller side.",
    rules: [R({ kind: 'last', winner: 'any' }, 'other'), R(ALWAYS, 'random')] },
  { name: 'Streak breaker', group: 'Fade the crowd', about: 'After 3 wins in a row for one side, bet 20 on the other. Otherwise sit out.',
    rules: [R({ kind: 'streak', winner: 'any', n: 3 }, 'other', 20), R(ALWAYS, 'skip')] },
  { name: 'Mean reversion', group: 'Fade the crowd', about: 'If one side won 4 of the last 6 rounds, bet 10 on the other. Otherwise sit out.',
    rules: [R({ kind: 'tally', winner: 'A', k: 4, n: 6 }, 'B'), R({ kind: 'tally', winner: 'B', k: 4, n: 6 }, 'A'), R(ALWAYS, 'skip')] },
  { name: 'Fade the blowout', group: 'Fade the crowd', about: "After a blowout (smaller side under 30%), the crowd piles onto last round's winner. Bet 20 against it.",
    rules: [R({ kind: 'margin', mode: 'lopsided', winner: 'any' }, 'other', 20), R(ALWAYS, 'skip')] },
  { name: 'Remember the question', group: 'Memory', about: 'Bet 10 against whatever won this question last time.',
    rules: [R({ kind: 'question', winner: 'any' }, 'other'), R(ALWAYS, 'random', 5)] },
  { name: 'Stick or switch', group: 'Memory', about: 'Keep my side after a win, switch after a loss. 10 each time.',
    rules: [R({ kind: 'mine', result: 'won' }, 'same'), R({ kind: 'mine', result: 'lost' }, 'other'), R(ALWAYS, 'random')] },
  { name: 'Steady DCA', group: 'Money management', about: '5 BEFEWER on a random side every single round. The baseline to beat.',
    rules: [R(ALWAYS, 'random', 5)] },
  { name: 'Martingale', group: 'Money management', about: 'Start at 2, double after every loss, back to 2 after a win. Risky: losing streaks hit the 25% cap.',
    rules: [R(ALWAYS, 'random', 2, 'martingale')] },
  { name: 'Paroli', group: 'Money management', about: 'Start at 5, double after every win, back to 5 after 3 wins or any loss.',
    rules: [R(ALWAYS, 'random', 5, 'paroli')] },
]
