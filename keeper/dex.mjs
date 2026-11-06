// Manual DEX operations against a BEFEWER v4 contract (the runner does graduate/buyback on its own).
// usage: FEWER_CONTRACT=v4.befewer.testnet node dex.mjs status
//        ... node dex.mjs donate <near>          (from befewer.testnet into the treasury)
//        ... node dex.mjs graduate               (advance the pool opening by one step)
//        ... node dex.mjs buyback
//        ... node dex.mjs swap <near> [account]  (buy BEFEWER on the DEX as a normal user would)
//        ... node dex.mjs pool                   (show the DEX pool)
import { loadAccount, view, provider, NEAR, fmt, fmtN, log, sleep } from './lib.mjs'

const CONTRACT = process.env.FEWER_CONTRACT || 'v5.befewer.testnet'
const ROOT = 'befewer.testnet'
const KEEPER = `keeper.${ROOT}`
const GAS = 300_000_000_000_000n
const [cmd, a1, a2] = process.argv.slice(2)
const near = x => (BigInt(Math.round(Number(x) * 1e6)) * NEAR) / 1_000_000n

function failure(res) {
  const all = [res.status, ...(res.receipts_outcome || []).map(r => r.outcome.status)]
  const f = all.find(s => s && s.Failure)
  return f ? JSON.stringify(f.Failure).slice(0, 400) : null
}
function logs(res) {
  return (res.receipts_outcome || []).flatMap(r => r.outcome.logs).filter(l => !l.startsWith('EVENT_JSON:{"standard":"nep141"'))
}
async function show() {
  const s = await view(CONTRACT, 'get_status')
  const d = s.dex
  console.log(`${CONTRACT}: treasury ${fmtN(s.treasury)} NEAR (spendable ${fmtN(s.treasury_spendable)}, opens pool at ${fmtN(s.graduate_at)})`)
  console.log(`  pool: ${d.stage}${d.busy ? ' (step in flight)' : ''}  pool_id ${d.pool_id ?? '-'}  NEAR in pool ${fmtN(d.near_amount)}  seed ${fmt(d.seed)} BEFEWER  LP shares ${d.shares}`)
  console.log(`  buybacks ${d.buybacks}: spent ${fmtN(d.bought_near)} NEAR, burned ${fmt(d.bought_burned)} BEFEWER, held wNEAR ${fmtN(d.held_wnear)}`)
  console.log(`  BEFEWER supply ${fmt(s.total_supply)} (issued ${fmt(s.issued)} of ${fmt(s.max_supply)}, mined ${fmt(s.mined)}, pot ${fmt(s.pot)}, burned ${fmt(s.total_burned)})`)
  return s
}
async function send(signer, receiverId, methodName, args, deposit = 0n) {
  const res = await loadAccount(signer).callFunctionRaw({ contractId: receiverId, methodName, args, gas: GAS, deposit })
  const f = failure(res)
  log(`${signer} -> ${receiverId}.${methodName}`, f ? `FAILED ${f}` : 'ok', 'tx', res.transaction.hash)
  for (const l of logs(res)) console.log('   ', l.slice(0, 300))
  return res
}

if (cmd === 'status') await show()
else if (cmd === 'donate') await send(ROOT, CONTRACT, 'donate', {}, near(a1))
else if (cmd === 'graduate') {
  await send(KEEPER, CONTRACT, 'graduate', {})
  await sleep(3000)
  await show()
} else if (cmd === 'buyback') {
  await send(KEEPER, CONTRACT, 'buyback', {})
  await sleep(4000)
  await show()
} else if (cmd === 'pool') {
  const s = await view(CONTRACT, 'get_status')
  if (s.dex.pool_id == null) console.log('no pool yet')
  else console.log(JSON.stringify(await view(s.dex.dex, 'get_pool', { pool_id: s.dex.pool_id }), null, 2))
} else if (cmd === 'swap') {
  // a user buying BEFEWER: register for the token, wrap NEAR, swap through the pool in one ft_transfer_call
  const who = a2 || ROOT
  const s = await view(CONTRACT, 'get_status')
  const amount = near(a1)
  const reg = await view(CONTRACT, 'storage_balance_of', { account_id: who })
  if (!reg) await send(who, CONTRACT, 'storage_deposit', { account_id: who, registration_only: true }, near(0.00125))
  const wreg = await view(s.dex.wnear, 'storage_balance_of', { account_id: who })
  if (!wreg) await send(who, s.dex.wnear, 'storage_deposit', { account_id: who, registration_only: true }, near(0.00125))
  await send(who, s.dex.wnear, 'near_deposit', {}, amount)
  const before = BigInt(await view(CONTRACT, 'ft_balance_of', { account_id: who }))
  const msg = JSON.stringify({ actions: [{ pool_id: s.dex.pool_id, token_in: s.dex.wnear, token_out: CONTRACT, amount_in: amount.toString(), min_amount_out: '1' }] })
  await send(who, s.dex.wnear, 'ft_transfer_call', { receiver_id: s.dex.dex, amount: amount.toString(), msg }, 1n)
  await sleep(3000)
  const after = BigInt(await view(CONTRACT, 'ft_balance_of', { account_id: who }))
  log(`${who} bought ${fmt(after - before)} BEFEWER for ${fmtN(amount)} NEAR`)
} else {
  console.log('commands: status | donate <near> | graduate | buyback | swap <near> [account] | pool')
}
