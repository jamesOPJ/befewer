// Worker thread for opener.mjs: opens drand timelocks, fetching and verifying each drand
// round's beacon once and reusing it for every bet aimed at that round.
import { parentPort } from 'node:worker_threads'
import tlock from 'tlock-js'
import { fetchBeacon } from 'drand-client'

const { timelockDecrypt, mainnetClient } = tlock
const drand = mainnetClient() // drand quicknet, the chain the game's timelocks use
const verified = new Map() // drand round -> Promise<beacon>, verified by fetchBeacon(drand, ...)
const fast = {
  options: { ...drand.options, disableBeaconVerification: true }, // only ever given verified beacons
  chain: () => drand.chain(),
  get: r => {
    if (!verified.has(r)) verified.set(r, fetchBeacon(drand, r).catch(e => { verified.delete(r); throw e }))
    if (verified.size > 200) verified.delete(verified.keys().next().value)
    return verified.get(r)
  },
}
console.log = () => {} // tlock-js logs every beacon it receives

parentPort.on('message', async ({ id, sealed }) => {
  try {
    parentPort.postMessage({ id, pt: (await timelockDecrypt(sealed, fast)).toString() })
  } catch (e) {
    parentPort.postMessage({ id, err: String(e?.message ?? e).slice(0, 160) })
  }
})
