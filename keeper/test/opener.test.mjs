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

// ---- the worker pool: every open() settles, whatever happens to a worker ----
import { createOpener } from '../opener.mjs'
const flaky = new URL('./fixtures/flaky-worker.mjs', import.meta.url)
const settled = (p, ms) => Promise.race([p.then(v => ['ok', v], e => ['err', e.message]), new Promise(r => setTimeout(() => r(['never']), ms))])

test('a worker that dies fails only its own jobs and is replaced', async () => {
  const o = createOpener(2, { script: flaky, timeoutMs: 5_000 })
  try {
    // slot 0 gets "die", slot 1 gets "b": the second must still answer
    const [a, b] = await Promise.all([settled(o.open('die'), 3000), settled(o.open('b'), 3000)])
    assert.equal(a[0], 'err', 'the job on the dead worker is rejected (it used to wait forever)')
    assert.deepEqual(b, ['ok', 'ok:b'])
    // both slots work again afterwards (the dead one was replaced)
    const again = await Promise.all([settled(o.open('c'), 3000), settled(o.open('d'), 3000)])
    assert.deepEqual(again, [['ok', 'ok:c'], ['ok', 'ok:d']])
  } finally { await o.close() }
})

test('a worker that throws is replaced too', async () => {
  const o = createOpener(1, { script: flaky, timeoutMs: 5_000 })
  try {
    assert.equal((await settled(o.open('throw'), 3000))[0], 'err')
    assert.deepEqual(await settled(o.open('e'), 3000), ['ok', 'ok:e'])
  } finally { await o.close() }
})

test('a job that never answers times out, and the stuck worker is replaced', async () => {
  const o = createOpener(1, { script: flaky, timeoutMs: 1500 }) // (a fresh worker thread takes a few 100 ms to start)
  try {
    assert.deepEqual(await settled(o.open('hang'), 5000), ['err', 'timelock not opened in time'])
    assert.deepEqual(await settled(o.open('f'), 5000), ['ok', 'ok:f'])
  } finally { await o.close() }
})
