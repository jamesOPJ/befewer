// node --test keeper/test/opener.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stanzaRound, orderForOpening, stillSealed } from '../opener.mjs'

// a minimal armored age file with a tlock stanza for drand round `r`
const sealedFor = r => '-----BEGIN AGE ENCRYPTED FILE-----\n' +
  Buffer.from(`age-encryption.org/v1\n-> tlock ${r} 52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971\nxx\n--- yy\n`).toString('base64') +
  '\n-----END AGE ENCRYPTED FILE-----\n'

test('stanzaRound reads the drand round a timelock opens at', () => {
  assert.equal(stanzaRound(sealedFor(1234567)), 1234567)
  assert.equal(stanzaRound('not a timelock'), null)
})

test('order: every account before anyone\'s second bet; aimed at the expected round first', () => {
  const c = (a, slot, r) => ({ account_id: a, slot, sealed: sealedFor(r) })
  const flood = [0, 1, 2, 3].map(i => c('junk', i, 100)) // one account, four bets
  const honest = [c('alice', 0, 100), c('bob', 0, 100)]
  const odd = [c('mallory', 0, 999)] // aimed at another drand round
  const q = orderForOpening([...odd, ...flood, ...honest], 100)
  assert.deepEqual(q.slice(0, 3).map(x => x.account_id).sort(), ['alice', 'bob', 'junk'], 'one bet per account first')
  assert.equal(q.at(-1).account_id, 'mallory', 'the wrong drand round goes last')
})

test('stillSealed drops bets revealed (or booked) since the first read', () => {
  const items = [{ account_id: 'a', slot: 0 }, { account_id: 'a', slot: 1 }, { account_id: 'b', slot: 0 }, { account_id: 'c', slot: 0 }]
  const chain = [{ account_id: 'a', slot: 0, side: null }, { account_id: 'a', slot: 1, side: 'A' }, { account_id: 'b', slot: 0, side: null }]
  const { keep, dropped } = stillSealed(items, chain)
  assert.deepEqual(keep.map(x => `${x.account_id}:${x.slot}`), ['a:0', 'b:0'])
  assert.equal(dropped, 2)
})
