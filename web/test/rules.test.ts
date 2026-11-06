// node --test web/test/rules.test.ts   (Node 22+ strips the types)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, backtest, guard, coin, stakeFor, normalizeRule, PRESETS, type Lookup, type Outcome, type Rule } from '../src/rules.ts'

const Q = 100 // questions in the list
function history(outcomes: Record<number, Outcome>): Lookup {
  const outcome = (r: number) => outcomes[r] ?? null
  return {
    outcome,
    recent(r, n) {
      const out: { round: number; outcome: Outcome }[] = []
      for (let t = r - 1; t >= 0 && out.length < n; t--) if (outcome(t)) out.push({ round: t, outcome: outcome(t)! })
      return out
    },
    sameQuestion(r, max) {
      const out: number[] = []
      for (let t = r - Q; t >= 0 && out.length < max; t -= Q) if (outcome(t)) out.push(t)
      return out
    },
  }
}

test('last round: same / other / specific side', () => {
  const L = history({ 9: 'A' })
  assert.deepEqual(decide([{ cond: { kind: 'last', winner: 'any' }, pick: 'same', unit: 'pct', amount: 5 }], 10, L), { side: 'A', unit: 'pct', amount: 5, rule: 0 })
  assert.deepEqual(decide([{ cond: { kind: 'last', winner: 'any' }, pick: 'other', unit: 'pct', amount: 5 }], 10, L), { side: 'B', unit: 'pct', amount: 5, rule: 0 })
  assert.deepEqual(decide([{ cond: { kind: 'last', winner: 'B' }, pick: 'A', unit: 'pct', amount: 5 }], 10, L), { skip: true, rule: null })
})

test('the last round skips rounds nobody played, and a void never matches', () => {
  assert.equal((decide([{ cond: { kind: 'last', winner: 'A' }, pick: 'B', unit: 'pct', amount: 5 }], 10, history({ 6: 'A' })) as any).side, 'B')
  assert.deepEqual(decide([{ cond: { kind: 'last', winner: 'any' }, pick: 'same', unit: 'pct', amount: 5 }], 10, history({ 9: 'void', 8: 'A' })), { skip: true, rule: null })
})

test('streak needs n finished rounds all won by the same side', () => {
  const r: Rule[] = [{ cond: { kind: 'streak', winner: 'any', n: 3 }, pick: 'other', unit: 'pct', amount: 10 }]
  assert.deepEqual(decide(r, 10, history({ 9: 'A', 8: 'A', 7: 'A' })), { side: 'B', unit: 'pct', amount: 10, rule: 0 })
  assert.deepEqual(decide(r, 10, history({ 9: 'A', 8: 'B', 7: 'A' })), { skip: true, rule: null })
  assert.deepEqual(decide(r, 10, history({ 9: 'A', 8: 'A' })), { skip: true, rule: null }, 'not enough history')
  assert.deepEqual(decide(r, 10, history({ 9: 'A', 8: 'void', 7: 'A', 6: 'A' })), { skip: true, rule: null }, 'a void breaks the streak')
})

test('same question looks exactly 100 rounds back', () => {
  const r: Rule[] = [{ cond: { kind: 'question', winner: 'any' }, pick: 'other', unit: 'pct', amount: 5 }]
  assert.deepEqual(decide(r, 230, history({ 130: 'B', 229: 'A' })), { side: 'A', unit: 'pct', amount: 5, rule: 0 })
  assert.deepEqual(decide(r, 230, history({ 30: 'A' })), { side: 'B', unit: 'pct', amount: 5, rule: 0 }, 'falls back to 200 rounds ago')
  assert.deepEqual(decide(r, 50, history({ 49: 'A' })), { skip: true, rule: null }, 'first time the question is asked')
})

test('first matching rule wins; skip and fallback', () => {
  const rules: Rule[] = [
    { cond: { kind: 'last', winner: 'B' }, pick: 'skip', unit: 'pct', amount: 5 },
    { cond: { kind: 'always' }, pick: 'A', unit: 'pct', amount: 7 },
  ]
  assert.deepEqual(decide(rules, 10, history({ 9: 'B' })), { skip: true, rule: 0 })
  assert.deepEqual(decide(rules, 10, history({ 9: 'A' })), { side: 'A', unit: 'pct', amount: 7, rule: 1 })
})

test('stake is clamped to 1..25% of balance', () => {
  assert.equal((decide([{ cond: { kind: 'always' }, pick: 'A', unit: 'pct', amount: 90 }], 1, history({})) as any).amount, 25)
  assert.equal((decide([{ cond: { kind: 'always' }, pick: 'A', unit: 'pct', amount: 0 }], 1, history({})) as any).amount, 1)
  assert.equal(stakeFor('fixed', 10, 1000), 10)
  assert.equal(stakeFor('fixed', 500, 1000), 250, 'a fixed stake is still capped at 25% of the balance')
  assert.equal(stakeFor('pct', 10, 1000), 100)
  assert.equal(stakeFor('fixed', 10, 3), 0, 'below 4 coins the 25% cap is under 1: cannot bet')
})

test('fixed stakes do not compound (DCA)', () => {
  const bt = backtest([{ cond: { kind: 'always' }, pick: 'A', unit: 'fixed', amount: 10 }], 1, 4, history({ 1: 'A', 2: 'B', 3: 'void', 4: 'A' }), 1000)
  assert.deepEqual([bt.bets, bt.wins, bt.losses, bt.voids, bt.staked, bt.end], [4, 2, 1, 1, 40, 1010])
})

test('rules saved by the old percentage-only version still load', () => {
  assert.deepEqual(normalizeRule({ cond: { kind: 'always' }, pick: 'A', pct: 7 }), { cond: { kind: 'always' }, pick: 'A', unit: 'pct', amount: 7 })
})

test('random picks are stable per round', () => {
  assert.equal(coin(42), coin(42))
  const sides = new Set(Array.from({ length: 50 }, (_, i) => coin(i)))
  assert.equal(sides.size, 2)
})

test('backtest compounds and counts', () => {
  // always A, 10%: rounds 1..4 are A, B, void, A
  const bt = backtest([{ cond: { kind: 'always' }, pick: 'A', unit: 'pct', amount: 10 }], 1, 4, history({ 1: 'A', 2: 'B', 3: 'void', 4: 'A' }), 1000)
  assert.deepEqual([bt.rounds, bt.bets, bt.wins, bt.losses, bt.voids], [4, 4, 2, 1, 1])
  // 1000 +100 = 1100, -110 = 990, void, +99 = 1089
  assert.equal(bt.end, 1089)
})

// The key property: a rule cannot see the round it bets on. A "perfect foresight" lookup that
// answers about round t while deciding t must be refused by the guard the backtest uses.
test('the backtest refuses any lookahead', () => {
  const real = history({ 1: 'A', 2: 'B', 3: 'A', 4: 'B' })
  const cheat: typeof real = { ...real, recent: (r, n) => real.recent(r + 1, n) } // peeks at round r itself
  assert.throws(() => backtest(PRESETS[0].rules, 1, 4, cheat), /lookahead/)
  assert.throws(() => guard(real, 3).outcome(3), /lookahead/)
  assert.doesNotThrow(() => backtest(PRESETS[0].rules, 1, 4, real))
})

test('with perfect foresight the guard would be the only thing stopping a 100% win rate', () => {
  // sanity: a rule that copies the CURRENT round's winner would win every bet; through the guard it cannot even run
  const real = history({ 1: 'A', 2: 'B', 3: 'A', 4: 'B', 5: 'A' })
  const foresight: typeof real = { ...real, recent: (r, n) => [{ round: r, outcome: real.outcome(r)! }, ...real.recent(r, n - 1)] }
  assert.throws(() => backtest([{ cond: { kind: 'last', winner: 'any' }, pick: 'same', unit: 'pct', amount: 5 }], 1, 5, foresight), /lookahead/)
})

test('presets are valid rules', () => {
  for (const p of PRESETS) assert.doesNotThrow(() => backtest(p.rules, 0, 300, history({ 5: 'A', 6: 'B', 105: 'A' })))
})
