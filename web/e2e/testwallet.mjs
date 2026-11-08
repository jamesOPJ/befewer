// Stand-in for a NEAR wallet in end-to-end tests: signs the plain transactions the page asks
// for (AddKey + deposit) with a testnet account's full-access key from ~/.near-credentials.
import fs from 'node:fs'
import os from 'node:os'
import { Account, JsonRpcProvider, KeyPairSigner, actions, PublicKey } from 'near-api-js'
export function makeSigner(accountId) {
  const key = JSON.parse(fs.readFileSync(`${os.homedir()}/.near-credentials/testnet/${accountId}.json`, 'utf8')).private_key
  const account = new Account(accountId, new JsonRpcProvider({ url: 'https://near-testnet.drpc.org' }), KeyPairSigner.fromSecretKey(key))
  const toAction = a => a.type === 'AddKey'
    ? actions.addFunctionCallAccessKey(PublicKey.fromString(a.publicKey), a.receiverId, a.methodNames, BigInt(a.allowance))
    : actions.functionCall(a.methodName, a.args, BigInt(a.gas), BigInt(a.deposit))
  const signed = []
  return {
    signed,
    async sign(json) {
      for (const tx of JSON.parse(json)) {
        const res = await account.signAndSendTransaction({ receiverId: tx.receiverId, actions: tx.actions.map(toAction) })
        const fail = [res.status, ...(res.receipts_outcome || []).map(r => r.outcome.status)].find(s => s && s.Failure)
        if (fail) return 'failed: ' + JSON.stringify(fail.Failure).slice(0, 200)
        signed.push({ receiverId: tx.receiverId, types: tx.actions.map(a => a.type), hash: res.transaction.hash })
      }
      return 'ok'
    },
  }
}
