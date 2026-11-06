// Print the live state of a BEFEWER v4 contract: phase, treasury, mining, pool, recent rounds, NPC wallets.
// usage: FEWER_CONTRACT=v4.befewer.testnet node status.mjs
import { view, fmt, fmtN } from './lib.mjs'
const C = process.env.FEWER_CONTRACT || 'v4.befewer.testnet'
const s = await view(C, 'get_status')
const now = Number(BigInt(s.now) / 1_000_000n)
const left = t => `${Math.max(0, Math.round((Number(BigInt(t) / 1_000_000n) - now) / 1000))}s`
console.log(`${C}  commit round ${s.commit_round} (closes in ${left(s.commit_ends_at)})` + (s.reveal_round != null ? `  reveal round ${s.reveal_round} (closes in ${left(s.reveal_ends_at)})` : ''))
console.log(`NEAR: players ${fmtN(s.balances_total)}  escrow ${fmtN(s.escrow)}  treasury ${fmtN(s.treasury)} (spendable ${fmtN(s.treasury_spendable)}, pool opens at ${fmtN(s.graduate_at)})  in total ${fmtN(s.treasury_in)}`)
console.log(`BEFEWER: supply ${fmt(s.total_supply)}  issued ${fmt(s.issued)} / ${fmt(s.max_supply)}  mined ${fmt(s.mined)}  pot ${fmt(s.pot)}  burned ${fmt(s.total_burned)}  best streak ${s.best_streak} ${s.best_streak_holder ?? ''}`)
const d = s.dex
console.log(`pool: ${d.stage}${d.busy ? ' (in flight)' : ''}  id ${d.pool_id ?? '-'}  NEAR ${fmtN(d.near_amount)} + ${fmt(d.seed)} BEFEWER  buybacks ${d.buybacks} spent ${fmtN(d.bought_near)} burned ${fmt(d.bought_burned)}`)
for (const r of await view(C, 'get_rounds', { from: s.commit_round, limit: 6 }))
  console.log(`  round ${r.round}: ${r.commits} commits ${fmtN(r.committed)}  A ${fmtN(r.revealed_a)} (${r.reveals_a})  B ${fmtN(r.revealed_b)} (${r.reveals_b})  ${r.settled ? `-> ${r.outcome}, treasury +${fmtN(r.to_treasury)}${BigInt(r.reward) > 0n ? `, mined ${fmt(r.reward)}` : ''}` : 'open'}  claims ${r.claims}`)
for (const n of ['coin', 'echo', 'flip', 'whale']) {
  const p = await view(C, 'get_player', { account_id: `npc-${n}.befewer.testnet` })
  console.log(`  npc-${n}: ${fmtN(p.balance)} NEAR  ${fmt(p.tokens)} BEFEWER  W${p.wins} L${p.losses} V${p.voids} F${p.forfeits}  streak ${p.streak} (best ${p.best_streak})  open ${p.open.map(o => o.round + (o.side ? ':' + o.side : ':sealed')).join(',')}`)
}
