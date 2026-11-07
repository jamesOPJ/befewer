// node --test web/test/rules.test.ts   (Node 22+ strips the types)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, backtest, runsAtLeast, cleanPattern, SLOT_SETS, guard, coin, stakeFor, maxStake, normalizeRule, meFrom, NOBODY, PRESETS, type Lookup, type Outcome, type Rule } from '../src/rules.ts'

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

test('stake is 1..100% of balance, at most what the balance pays with the fee and storage', () => {
  assert.equal((decide([{ cond: { kind: 'always' }, pick: 'A', unit: 'pct', amount: 90 }], 1, history({})) as any).amount, 90, 'no 25% cap any more')
  assert.equal((decide([{ cond: { kind: 'always' }, pick: 'A', unit: 'pct', amount: 150 }], 1, history({})) as any).amount, 100)
  assert.equal((decide([{ cond: { kind: 'always' }, pick: 'A', unit: 'pct', amount: 0 }], 1, history({})) as any).amount, 1)
  assert.equal(stakeFor('fixed', 10, 1000), 10)
  assert.equal(maxStake(1000), 951, '(1000 - 1 chip of storage) / 1.05 for the 5% fee')
  assert.equal(stakeFor('fixed', 2000, 1000), 951, 'a stake never exceeds what the balance can pay')
  assert.equal(stakeFor('pct', 10, 1000), 100)
  assert.equal(stakeFor('pct', 100, 1000), 951, 'all in = everything the balance can pay')
  assert.equal(stakeFor('fixed', 10, 3), 1, '3 chips still pay the smallest bet')
  assert.equal(stakeFor('fixed', 1, 2), 0, '2 chips do not cover a chip, its fee and the storage')
  assert.equal(stakeFor('fixed', 10, 1000, NOBODY, 3), 3, 'the live autopilot passes the exact cap')
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

test('win streaks are counted like the contract: skips and voids do not break them', () => {
  // bets on A only when the round number is not 3 (round 3 is skipped)
  const rules: Rule[] = [{ cond: { kind: 'always' }, pick: 'A', unit: 'fixed', amount: 5 }]
  // W W (skip-free here) void W L W W W W L W
  const L = history({ 1: 'A', 2: 'A', 3: 'void', 4: 'A', 5: 'B', 6: 'A', 7: 'A', 8: 'A', 9: 'A', 10: 'B', 11: 'A' })
  const bt = backtest(rules, 1, 11, L, 1000, 500)
  assert.equal(bt.bestStreak, 4)
  assert.deepEqual([bt.runs[1] ?? 0, bt.runs[2] ?? 0, bt.runs[3] ?? 0, bt.runs[4] ?? 0], [1, 0, 1, 1], 'runs of 3 (ended by a loss), 4, and 1 (still going)')
  assert.equal(runsAtLeast(bt, 3), 2)
  // rounds that would mine: the 3rd win in a row (round 4), the 3rd and 4th (rounds 8, 9)
  assert.deepEqual(bt.curve.filter(s => s.mined).map(s => s.round), [4, 8, 9])
  assert.equal(bt.mines, 3)
  assert.deepEqual(bt.curve.map(s => s.streak), [1, 2, 2, 3, 0, 1, 2, 3, 4, 0, 1])
})

test('a skipped round keeps the streak (and the round it skipped can be a loss for others)', () => {
  // skip whenever A won the last 2 rounds, otherwise bet A
  const rules: Rule[] = [{ cond: { kind: 'tally', winner: 'A', k: 2, n: 2 }, pick: 'skip', unit: 'fixed', amount: 5 }, { cond: { kind: 'always' }, pick: 'A', unit: 'fixed', amount: 5 }]
  // r1 A win (1), r2 A win (2), r3 skipped (B won: would have been a loss), r4 A win (3: mines)
  const bt = backtest(rules, 1, 4, history({ 1: 'A', 2: 'A', 3: 'B', 4: 'A' }), 1000, 0)
  assert.deepEqual(bt.curve.map(s => [s.side, s.streak]), [['A', 1], ['A', 2], [null, 2], ['A', 3]])
  assert.deepEqual(bt.curve.filter(s => s.mined).map(s => s.round), [4])
})

test('loop follows its pattern by round number', () => {
  const rules: Rule[] = [{ cond: { kind: 'always' }, pick: 'loop', unit: 'fixed', amount: 1, pattern: 'AAB' }]
  const sides = [9, 10, 11, 12].map(r => (decide(rules, r, history({})) as any).side)
  assert.deepEqual(sides, ['A', 'A', 'B', 'A'], 'round mod 3: 9->0 A, 10->1 A, 11->2 B, 12->0 A')
  assert.equal(cleanPattern('a b x a'), 'ABA')
})

test('loop with rest sits out the rest of the cycle after a loss', () => {
  const rules: Rule[] = [{ cond: { kind: 'always' }, pick: 'loop', unit: 'fixed', amount: 5, pattern: 'AAA', rest: true }]
  // rounds 0..5: B wins round 1 -> loss; rounds 2 skipped (same cycle 0..2); round 3 starts a new cycle
  const L = history({ 0: 'A', 1: 'B', 2: 'A', 3: 'A', 4: 'A', 5: 'A' })
  const bt = backtest(rules, 0, 5, L, 1000, 0)
  assert.deepEqual(bt.curve.map(s => s.side), ['A', 'A', null, 'A', 'A', 'A'])
  assert.deepEqual(bt.curve.filter(s => s.mined).map(s => s.round), [5], 'the new cycle wins 3 in a row (rounds 3, 4, 5)')
})

test('the 8 sequences: every 3-round cycle exactly one slot wins three in a row', () => {
  const set = SLOT_SETS.find(x => x.slots.length === 8)!
  // any outcomes: here B, A, A then A, B, A
  const L = history({ 0: 'B', 1: 'A', 2: 'A', 3: 'A', 4: 'B', 5: 'A' })
  let mines = 0
  for (const s of set.slots) mines += backtest(s.rules, 0, 5, L, 1000, 0).mines
  assert.equal(mines, 2)
})

test('a saved rule with an unknown pick loads as skip', () => {
  assert.equal(normalizeRule({ cond: { kind: 'always' }, pick: 'both', unit: 'fixed', amount: 5 }).pick, 'skip')
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
  assert.equal(m(9, 100), 94, 'six doublings of 2 = 128, more than 100 chips can pay: capped at 94')
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
