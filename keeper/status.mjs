// Print the live state of a BEFEWER contract: phase, supply, burns, recent rounds, NPC wallets.
// usage: FEWER_CONTRACT=v3.befewer.testnet node status.mjs
import { view, fmt } from './lib.mjs'
const C = process.env.FEWER_CONTRACT || 'v3.befewer.testnet'
const s = await view(C, 'get_status')
const now = Number(BigInt(s.now) / 1_000_000n)
const left = t => `${Math.max(0, Math.round((Number(BigInt(t) / 1_000_000n) - now) / 1000))}s`
console.log(`${C}  commit round ${s.commit_round} (closes in ${left(s.commit_ends_at)})` + (s.reveal_round != null ? `  reveal round ${s.reveal_round} (closes in ${left(s.reveal_ends_at)})` : ''))
console.log(`supply ${fmt(s.total_supply)} / ${fmt(s.initial_supply)}  burned ${fmt(s.total_burned)}  escrow ${fmt(s.escrow)}  rounds settled ${s.rounds_settled}  best streak ${s.best_streak} ${s.best_streak_holder ?? ''}`)
for (const r of await view(C, 'get_rounds', { from: s.commit_round, limit: 6 }))
  console.log(`  round ${r.round}: ${r.commits} commits ${fmt(r.committed)}  A ${fmt(r.revealed_a)} (${r.reveals_a})  B ${fmt(r.revealed_b)} (${r.reveals_b})  ${r.settled ? `-> ${r.outcome}, burned ${fmt(r.burned)}` : 'open'}  claims ${r.claims}`)
for (const n of ['coin', 'echo', 'flip', 'whale']) {
  const p = await view(C, 'get_player', { account_id: `npc-${n}.befewer.testnet` })
  console.log(`  npc-${n}: ${fmt(p.balance)} BEFEWER  W${p.wins} L${p.losses} V${p.voids} F${p.forfeits}  streak ${p.streak} (best ${p.best_streak})  open ${p.open.map(o => o.round + (o.side ? ':' + o.side : ':sealed')).join(',')}`)
}
