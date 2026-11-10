// When a round's reveal window opens, without trusting the RPC server for it.
//
// A bet is sealed with a drand timelock that opens at the round's reveal start. A page that took
// that moment from an RPC answer (get_status.commit_ends_at) could be told a moment well before
// betting closes by a dishonest RPC server: the ciphertext is public on chain, so that server
// could open it early, see the side, and bet the minority at the last second.
// So the moment is computed from the contract's launch parameters (they never change), and for
// the published deployments those come from this repository (deployments.json, in the build),
// not from the network. Other contracts fall back to the RPC's parameters, checked against this
// device's clock.
import deployments from './deployments.json' with { type: 'json' }

/** Launch parameters pinned for a contract in this build, or null. */
export function pinnedParams(contract) {
  const p = deployments[contract]?.params
  return p?.genesis_ns && p?.commit_ns ? { genesis_ns: String(p.genesis_ns), commit_ns: String(p.commit_ns) } : null
}

/** How far this device's clock may be off before sealing is refused. */
export const CLOCK_SLACK_MS = 30_000

/**
 * ms (Unix) at which round `round` of `contract` starts revealing: the earliest moment a bet in
 * that round may be opened. `rpcParams` is what get_params answered; `nowMs` the caller's clock.
 * Throws if the RPC's parameters differ from the pinned ones, or if `round` is not the round
 * taking bets at `nowMs`. For a pinned contract the result depends on `round` alone, and the
 * contract refuses a bet for any round but the current one, so a wrong round number from the
 * RPC only gets the bet rejected; the clock check is what protects contracts that are not pinned.
 */
export function revealStartMs(contract, round, rpcParams, nowMs = Date.now()) {
  const pinned = pinnedParams(contract)
  if (pinned && rpcParams && (String(rpcParams.genesis_ns) !== pinned.genesis_ns || String(rpcParams.commit_ns) !== pinned.commit_ns)) {
    throw new Error('The RPC server answered launch parameters that differ from the published ones for this contract. Not sealing a bet on its word.')
  }
  const p = pinned ?? rpcParams
  if (!p) throw new Error('The game parameters are not loaded yet.')
  const commitMs = Number(BigInt(p.commit_ns) / 1_000_000n)
  const start = Number((BigInt(p.genesis_ns) + BigInt(round + 1) * BigInt(p.commit_ns)) / 1_000_000n)
  if (nowMs >= start + CLOCK_SLACK_MS || nowMs < start - commitMs - CLOCK_SLACK_MS) {
    throw new Error(`Round ${round} is not the round taking bets by this device's clock. Check the clock (or the RPC server is off) and try again.`)
  }
  return start
}
