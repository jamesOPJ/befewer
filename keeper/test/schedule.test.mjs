// node --test keeper/test/schedule.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { revealStartMs, pinnedParams, CLOCK_SLACK_MS } from '../schedule.mjs'

const C = 'v6.befewer.testnet'
const p = pinnedParams(C)
const G = Number(BigInt(p.genesis_ns) / 1_000_000n), W = Number(BigInt(p.commit_ns) / 1_000_000n)
const startOf = r => G + (r + 1) * W

test('the published contracts are pinned in the build', () => {
  for (const c of ['v6.befewer.testnet', 'v6t.befewer.testnet', 'v7t.befewer.testnet']) assert.ok(pinnedParams(c), c)
  assert.equal(pinnedParams('someone-else.testnet'), null)
})

test('reveal start comes from the pinned launch parameters, whatever the RPC says about time', () => {
  const r = 1000, now = startOf(r) - 100_000 // 80 s into the 180 s betting window
  assert.equal(revealStartMs(C, r, { ...p }, now), startOf(r))
  assert.equal(revealStartMs(C, r, null, now), startOf(r), 'no RPC parameters needed for a pinned contract')
})

test('an RPC that answers other launch parameters is refused (it would move the timelock)', () => {
  const r = 1000, now = startOf(r) - 100_000
  const early = { genesis_ns: String(BigInt(p.genesis_ns) - 170_000_000_000n), commit_ns: p.commit_ns } // opens 170 s early
  assert.throws(() => revealStartMs(C, r, early, now), /differ from the published ones/)
})

test('a wrong round number cannot move the timelock either', () => {
  const r = 1000, now = startOf(r) - 100_000
  assert.throws(() => revealStartMs(C, r - 1, { ...p }, now), /not the round taking bets/, 'the round before: its reveal started 80 s ago')
  assert.throws(() => revealStartMs(C, r + 1, { ...p }, now), /not the round taking bets/, 'the round after')
  // a device clock a few seconds off still works, right at the window's edges
  assert.equal(revealStartMs(C, r, { ...p }, startOf(r) - W - CLOCK_SLACK_MS + 1), startOf(r))
  assert.equal(revealStartMs(C, r, { ...p }, startOf(r) + CLOCK_SLACK_MS - 1), startOf(r))
})

test('a contract that is not pinned uses the RPC parameters, still checked against the clock', () => {
  const q = { genesis_ns: '1700000000000000000000', commit_ns: '60000000000' }
  const g = 1_700_000_000_000_000, start = g + 6 * 60_000
  assert.equal(revealStartMs('other.testnet', 5, q, start - 30_000), start)
  assert.throws(() => revealStartMs('other.testnet', 5, q, start + 120_000), /not the round taking bets/)
  assert.throws(() => revealStartMs('other.testnet', 5, null, start), /not loaded/)
})
