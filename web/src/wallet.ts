// Wallet login. A NEAR wallet signs in, then approves ONE batch: it adds a function-call key
// that this browser holds (limited to this game's betting methods, with a gas allowance) and
// deposits NEAR into the game. After that, bets are signed locally with that key: no popups.
// Redirect wallets (MyNearWallet) leave the page while approving, so the new key is saved as
// "pending" first and becomes the session once it shows up on chain.
import type { WalletSelector } from '@near-wallet-selector/core'
import { CONTRACT, NETWORK, provider, newKeyPair, type Session } from './chain'

/** What the browser's session key may call. `deposit` is not here: it needs attached NEAR,
 *  which a function-call key can never attach, so deposits always go through the wallet. */
export const SESSION_METHODS = ['commit', 'reveal', 'reveal_many', 'claim', 'claim_befewer', 'withdraw', 'open_slot', 'close_slot', 'settle_due']
/** Gas the session key may spend in total (about 3,000 bets). */
export const KEY_ALLOWANCE = 10n ** 24n
const GAS_30T = '30000000000000'

export const WALLETS = [
  { id: 'meteor-wallet', name: 'Meteor', about: 'browser extension or web wallet' },
  { id: 'intear-wallet', name: 'Intear', about: 'web wallet' },
  { id: 'my-near-wallet', name: 'MyNearWallet', about: 'opens the wallet site and comes back' },
]

/** Plain description of what the wallet is asked to sign (also what the e2e test wallet signs). */
export type PlainAction =
  | { type: 'AddKey'; publicKey: string; receiverId: string; methodNames: string[]; allowance: string }
  | { type: 'FunctionCall'; methodName: string; args: object; gas: string; deposit: string }
export type PlainTx = { receiverId: string; actions: PlainAction[] }

/** Test seam: an end-to-end test may define window.__befewerWallet; real visitors never have it. */
type TestWallet = { accountId: string; signAndSend(txs: PlainTx[]): Promise<void> }
const testWallet = (): TestWallet | null => (globalThis as any).__befewerWallet ?? null

// The selector and wallet modules load only when someone actually uses a wallet.
let selector: Promise<WalletSelector> | null = null
function getSelector() {
  selector ??= (async () => {
    const [{ setupWalletSelector }, { setupMeteorWallet }, { setupIntearWallet }, { setupMyNearWallet }] = await Promise.all([
      import('@near-wallet-selector/core'),
      import('@near-wallet-selector/meteor-wallet'),
      import('@near-wallet-selector/intear-wallet'),
      import('@near-wallet-selector/my-near-wallet'),
    ])
    return setupWalletSelector({ network: NETWORK as 'testnet', modules: [setupMeteorWallet(), setupIntearWallet(), setupMyNearWallet()] })
  })()
  return selector
}
/** Whether a wallet was picked in this browser before (only then is the selector worth loading). */
const usedWalletBefore = () => Object.keys(localStorage).some(k => k.startsWith('near-wallet-selector:selectedWalletId'))

/** Wallet-selector actions (built with the @near-js versions the selector itself uses). */
async function toActions(list: PlainAction[]) {
  const [{ actionCreators: A }, { PublicKey }] = await Promise.all([import('@near-js/transactions'), import('@near-js/crypto')])
  return list.map(a =>
    a.type === 'AddKey'
      ? A.addKey(PublicKey.fromString(a.publicKey), A.functionCallAccessKey(a.receiverId, a.methodNames, BigInt(a.allowance)))
      : A.functionCall(a.methodName, a.args, BigInt(a.gas), BigInt(a.deposit)),
  )
}

/** Sign in with a wallet; returns the account. Redirect wallets leave the page here. */
export async function connect(walletId: string): Promise<string> {
  const t = testWallet()
  if (t) return t.accountId
  const w = await (await getSelector()).wallet(walletId)
  const accounts = await w.signIn({ contractId: CONTRACT, methodNames: [] } as any)
  if (!accounts?.length) throw new Error('The wallet did not return an account.')
  return accounts[0].accountId
}

/** The account a wallet is signed in with (after a redirect, too), if any. */
export async function connectedAccount(): Promise<string | null> {
  const t = testWallet()
  if (t || !usedWalletBefore()) return null
  const s = await getSelector()
  return s.store.getState().accounts.find(a => a.active)?.accountId ?? null
}

async function signAndSend(txs: PlainTx[]) {
  const t = testWallet()
  if (t) return t.signAndSend(txs)
  const w = await (await getSelector()).wallet()
  const transactions = await Promise.all(txs.map(async x => ({ receiverId: x.receiverId, actions: await toActions(x.actions) })))
  await w.signAndSendTransactions({ transactions } as any)
}

const depositTx = (amount: bigint): PlainTx => ({
  receiverId: CONTRACT,
  actions: [{ type: 'FunctionCall', methodName: 'deposit', args: {}, gas: GAS_30T, deposit: amount.toString() }],
})

const PENDING = `fewer.pendingkey.${CONTRACT}`
/** One approval: add this browser's session key to `accountId`, and deposit `amount` (yocto). */
export async function setupSession(accountId: string, amount: bigint) {
  const kp = newKeyPair()
  localStorage.setItem(PENDING, JSON.stringify({ accountId, privateKey: kp.privateKey, publicKey: kp.publicKey, at: Date.now() }))
  const txs: PlainTx[] = [
    { receiverId: accountId, actions: [{ type: 'AddKey', publicKey: kp.publicKey, receiverId: CONTRACT, methodNames: SESSION_METHODS, allowance: KEY_ALLOWANCE.toString() }] },
  ]
  if (amount > 0n) txs.push(depositTx(amount))
  await signAndSend(txs)
}
export const hasPending = () => !!localStorage.getItem(PENDING)

/** If the pending session key is on chain now, it becomes the session (and stops being pending). */
export async function finishPendingSession(): Promise<Session | null> {
  let p: any
  try { p = JSON.parse(localStorage.getItem(PENDING) || 'null') } catch { p = null }
  if (!p) return null
  try {
    await (provider as any).query({ request_type: 'view_access_key', finality: 'optimistic', account_id: p.accountId, public_key: p.publicKey })
  } catch {
    // not there (yet). Give up on keys older than 15 minutes: the approval was cancelled.
    if (Date.now() - (p.at ?? 0) > 15 * 60_000) localStorage.removeItem(PENDING)
    return null
  }
  localStorage.removeItem(PENDING)
  return { accountId: p.accountId, privateKey: p.privateKey, kind: 'wallet' }
}

/** Deposit more NEAR into the game from the wallet (one approval). */
export async function depositFromWallet(amount: bigint) {
  await signAndSend([depositTx(amount)])
}

export async function disconnect() {
  localStorage.removeItem(PENDING)
  if (testWallet()) return
  try { await (await (await getSelector()).wallet()).signOut() } catch {}
}
