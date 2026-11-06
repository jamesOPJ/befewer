// node --test web/test/rules.test.ts   (Node 22+ strips the types)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, backtest, guard, coin, stakeFor, normalizeRule, meFrom, NOBODY, PRESETS, type Lookup, type Outcome, type Rule } from '../src/rules.ts'

const Q = 100 // questions in the list
function history(outcomes: Record<number, Outcome>, splits: Record<number, number> = {}): Lookup {
  const outcome = (r: number) => outcomes[r] ?? null
  return {
    outcome,
    split: r => (splits[r] === undefined ? null : { a: splits[r], b: 1 - splits[r] }),
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

test('the replay pays the contract fee: win +stake-fee, loss -stake-fee, void free', () => {
  // fixed 10 chips, 5% fee: A wins (+9.5), B wins (-10.5), void (0), A wins (+9.5)
  const bt = backtest([{ cond: { kind: 'always' }, pick: 'A', unit: 'fixed', amount: 10 }], 1, 4, history({ 1: 'A', 2: 'B', 3: 'void', 4: 'A' }), 1000, 500)
  assert.equal(bt.end, 1000 + 9.5 - 10.5 + 9.5)
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

test('tally: a side won at least k of the last n finished rounds', () => {
  const r: Rule[] = [{ cond: { kind: 'tally', winner: 'A', k: 4, n: 6 }, pick: 'other', unit: 'fixed', amount: 10 }]
  const four = { 9: 'A', 8: 'B', 7: 'A', 6: 'A', 5: 'B', 4: 'A' } as Record<number, Outcome>
  assert.deepEqual(decide(r, 10, history(four)), { side: 'B', unit: 'fixed', amount: 10, rule: 0 })
  assert.deepEqual(decide(r, 10, history({ ...four, 4: 'B' })), { skip: true, rule: null }, 'only 3 of 6')
  assert.deepEqual(decide(r, 10, history({ 9: 'A', 8: 'A', 7: 'A', 6: 'A' })), { skip: true, rule: null }, 'not 6 rounds of history yet')
})

test('margin: blowout vs close, from the revealed split of the round before', () => {
  const blow: Rule[] = [{ cond: { kind: 'margin', mode: 'lopsided', winner: 'any' }, pick: 'other', unit: 'fixed', amount: 20 }]
  const close: Rule[] = [{ cond: { kind: 'margin', mode: 'close', winner: 'A' }, pick: 'same', unit: 'fixed', amount: 5 }]
  assert.deepEqual(decide(blow, 10, history({ 9: 'A' }, { 9: 0.2 })), { side: 'B', unit: 'fixed', amount: 20, rule: 0 })
  assert.deepEqual(decide(blow, 10, history({ 9: 'A' }, { 9: 0.45 })), { skip: true, rule: null })
  assert.deepEqual(decide(close, 10, history({ 9: 'A' }, { 9: 0.45 })), { side: 'A', unit: 'fixed', amount: 5, rule: 0 })
  assert.deepEqual(decide(close, 10, history({ 9: 'B' }, { 9: 0.55 })), { skip: true, rule: null }, 'close, but B won')
  assert.deepEqual(decide(blow, 10, history({ 9: 'void' }, { 9: 1 })), { skip: true, rule: null })
})

test('mine: my last bet won / lost / was refunded', () => {
  const r: Rule[] = [
    { cond: { kind: 'mine', result: 'won' }, pick: 'same', unit: 'fixed', amount: 10 },
    { cond: { kind: 'mine', result: 'lost' }, pick: 'other', unit: 'fixed', amount: 10 },
  ]
  const L = history({})
  assert.equal((decide(r, 5, L, meFrom([{ side: 'A', outcome: 'A' }])) as any).side, 'A')
  assert.equal((decide(r, 5, L, meFrom([{ side: 'A', outcome: 'B' }])) as any).side, 'B')
  assert.deepEqual(decide(r, 5, L, meFrom([{ side: 'A', outcome: 'void' }])), { skip: true, rule: null })
  assert.deepEqual(decide(r, 5, L, NOBODY), { skip: true, rule: null }, 'no bets yet')
})

test('meFrom counts the current run and skips refunds', () => {
  const lost2 = meFrom([{ side: 'A', outcome: 'B' }, { side: 'B', outcome: 'void' }, { side: 'B', outcome: 'A' }, { side: 'A', outcome: 'A' }])
  assert.deepEqual([lost2.losses, lost2.wins], [2, 0])
  const won1 = meFrom([{ side: 'B', outcome: 'B' }, { side: 'B', outcome: 'A' }])
  assert.deepEqual([won1.losses, won1.wins], [0, 1])
})

test('martingale doubles after each loss and resets after a win; paroli rides 3 wins', () => {
  const m = (losses: number, bal = 1000) => stakeFor('martingale', 2, bal, { last: null, wins: 0, losses })
  assert.deepEqual([m(0), m(1), m(2), m(3)], [2, 4, 8, 16])
  assert.equal(m(9, 100), 25, 'still capped at 25% of the balance')
  const p = (wins: number) => stakeFor('paroli', 5, 1000, { last: null, wins, losses: 0 })
  assert.deepEqual([p(0), p(1), p(2), p(3)], [5, 10, 20, 5])
  // replay: always A, martingale from 2; outcomes B, B, A, B -> stakes 2, 4, 8, then back to 2 after the win
  const bt = backtest([{ cond: { kind: 'always' }, pick: 'A', unit: 'martingale', amount: 2 }], 1, 4, history({ 1: 'B', 2: 'B', 3: 'A', 4: 'B' }))
  assert.deepEqual(bt.curve.map(s => s.stake), [2, 4, 8, 2])
  assert.equal(bt.end, 1000 - 2 - 4 + 8 - 2)
  // paroli replay: always A from 5; outcomes A, A, A, A, B -> 5, 10, 20, back to 5, 10
  const pb = backtest([{ cond: { kind: 'always' }, pick: 'A', unit: 'paroli', amount: 5 }], 1, 5, history({ 1: 'A', 2: 'A', 3: 'A', 4: 'A', 5: 'B' }))
  assert.deepEqual(pb.curve.map(s => s.stake), [5, 10, 20, 5, 10])
})

test('stick or switch uses the replay\'s own previous bet', () => {
  const stick = PRESETS.find(p => p.name === 'Stick or switch')!.rules
  // first bet is random (coin), afterwards: keep after win, switch after loss
  const bt = backtest(stick, 1, 4, history({ 1: 'A', 2: 'A', 3: 'B', 4: 'B' }))
  for (let i = 1; i < bt.curve.length; i++) {
    const prev = bt.curve[i - 1], cur = bt.curve[i]
    const won = prev.outcome === prev.side
    assert.equal(cur.side, won ? prev.side : prev.side === 'A' ? 'B' : 'A')
  }
})

test('the guard also refuses a peek at the split of the round being decided', () => {
  assert.throws(() => guard(history({ 3: 'A' }, { 3: 0.2 }), 3).split(3), /lookahead/)
})
