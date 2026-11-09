# $BEFEWER

A store-of-value token on NEAR that can only be obtained by playing a sealed-bid minority game:
bet NEAR on one of two answers, the answer with **less** NEAR on it wins double, and winning
3 rounds in a row mines the token. The game's revenue buys the token back and burns it.

Built for NEAR HACKATHON (2026-11-01 to 2026-11-14), tracks: Memecoins With Mechanics, Games With Real Economies.
NEAR **testnet** only.

| | |
|---|---|
| Live demo | https://befewer.com (no wallet needed: a free testnet account is created on your first bet) |
| Game + token contract | [`v6.befewer.testnet`](https://testnet.nearblocks.io/address/v6.befewer.testnet) (the BEFEWER NEP-141 token is the same account) |
| Token/NEAR pool | Ref Finance testnet pool [#2911](https://testnet.ref.finance/pool/2911) on `ref-finance-101.testnet` |
| Deployed code | sha256 `bac2340ec3321377010bfa66c2f08e254502614ed4f22933364e0d84c6fa56f7` = `contract/target/near/fewer.wasm` built from this repo |

## The problem

Most memecoins are minted up front, and the mechanism ends at the chart: nothing makes a coin cost
something to get, and whoever deployed it decides the supply. $BEFEWER has no premine and no team
share. Every coin is mined by out-guessing a crowd, each bet pays a fee, there are never more than
1,000,000 coins at once, and the fees fund a treasury that buys coins back from a pool whose
liquidity can never be withdrawn. The idea follows ORE on Solana (mining as a game, a refining fee
paid to holders, buyback and burn), rebuilt for NEAR as a different game.

## Try it: do X, see Y

All on https://befewer.com. Times are for the current parameters (a round every 3 minutes, 90-second reveal).

1. **Open the page.** You see this round's question, two answers, and a countdown to the end of betting.
2. **Tap an answer, then "Seal".** A testnet account `g<hex>.befewer.testnet` is created for you with
   0.3 NEAR in the game and 0.05 NEAR for gas. You see "Sealed in round N": your answer is stored only as a
   sha256 fingerprint plus a drand timelock that cannot be opened before betting closes.
3. **Keep the page open until betting closes.** The page reveals your bet itself (you get 80% of your fee
   back as the reveal reward). After the reveal window the round settles and you see "Your last round"
   with win, loss or void and the net NEAR. If you close the page, a keeper opens the timelock and reveals for you.
4. **Rounds tab.** Every round with both sides' NEAR and the result. The "Mined" filter shows the rounds that
   mined BEFEWER; opening one lists each bet that mined it, its stake, streak, shares and amount.
5. **Pool tab.** The treasury, the pool's live reserves and price (read from Ref Finance), every buyback,
   and two ledgers checked on the page: treasury NEAR collected = what it went to, and BEFEWER issued =
   pool seed + mined + pot.
6. **Autopilot tab.** Pick a strategy and tap "Run": it bets for you every round (on several "slots" at
   once if you like) and replays the strategy over past rounds. It runs only while the page is open; to keep
   it running without a browser, run the same rules on your own computer (see "Autopilot from a terminal").
7. **Me tab.** Your balance, results, slots, mined BEFEWER; "Withdraw" sends your NEAR to your testnet wallet.
8. **Check it on chain** without installing anything:

   ```sh
   curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"v6.befewer.testnet","method_name":"get_status","args_base64":"e30="}}' \
     | jq -r '.result.result | implode' | jq .
   ```

   Other views: `get_params`, `get_round {"round":"N"}`, `get_rounds {"from":"N","limit":10}`,
   `get_round_miners {"round":"N"}`, `get_player {"account_id":"..."}`, `get_buybacks`.

## Rules (enforced by the contract)

- **Rounds.** Betting is open for `commit_ns` (180 s), then the reveal window for `reveal_ns` (90 s). A bet is
  `sha256("fewer:<account>:<slot>:<round>:<A|B>:<salt>")` plus an optional drand timelock ciphertext of
  `<side>:<salt>` for round's reveal start (drand quicknet). Anyone holding the side and salt can reveal it.
- **Outcome.** The side with less revealed NEAR wins: each winning bet gets 2x its stake. A tie or a one-sided
  round is void: stake and fee come back, less the bet's part of the round's record storage (291 bytes, split by
  stake). Bets never revealed are forfeited. The bigger side's extra stake and forfeits go to the treasury.
- **Fee.** 5% per bet: 80% to whoever reveals it (the player's own page or a keeper), 20% to the treasury.
- **Mining.** Each settled round adds 1 BEFEWER to a pot. A win that completes 3+ wins in a row earns shares =
  stake in 0.001 NEAR x (streak - 2); the pot is split by shares, otherwise it rolls over. Mined BEFEWER is
  "unrefined" until claimed; claiming costs 10%, shared among the other holders of unrefined BEFEWER.
- **Supply.** At most 1,000,000 BEFEWER exist at once (issued minus burned). At one per round that is reached
  after about 5.7 years at the earliest; like ORE, burned BEFEWER can then be mined again.
- **Treasury.** At 5 NEAR spendable, the contract opens a wNEAR/BEFEWER pool on Ref Finance (pool created and
  filled in one receipt with `min_amounts`, so nobody can set its price in between) and keeps the LP shares
  for good: there is no method to remove liquidity. After that, buybacks spend 1/365 of the spendable treasury
  per day: the share builds up from the last buyback and is spent once it reaches 0.1 NEAR (at most every
  10 minutes, at most 0.5 NEAR at a time), paying at most 25% above the last buyback's price, and burns what it
  buys. A big inflow is spread out (half of it is spent after about 253 days), and a small treasury still buys
  now and then (12 NEAR: 0.1 NEAR about every 3 days).
- **Slots.** One account can run any number of independent bettors ("slots") from one balance.
- **Keepers.** Revealing, settling, opening the pool and buybacks are public methods. Anyone can run
  `keeper/run.mjs` with their own account and earn reveal rewards.
- **No admin methods.** Nothing can change the parameters or move a player's NEAR. On testnet the contract
  account still holds its deploy key (the code was upgraded in place during the hackathon); on mainnet the key
  would be deleted.

## Repository

```
contract/   Rust, near-sdk 5.30: the game, the NEP-141 token, mining, refining, the Ref Finance pool and buybacks
keeper/     Node 22: keeper (reveals, settles, pool, buybacks), demo bots, deploy/upgrade scripts
web/        Svelte 5 + Vite page and a small Node server (static files + the testnet guest faucet)
```

### Contract

```sh
cd contract
cargo test                                # 83 tests
cargo near build non-reproducible-wasm    # -> target/near/fewer.wasm
```

The tests play rounds in a mocked NEAR VM and check, after most scenarios, that player balances + escrow + held
storage + treasury inflows equal deposits and that token balances equal total supply. They cover settlement,
voids and forfeits, streaks and mining shares, refining, slots, storage deposits, the pool opening and buybacks
(with mocked cross-contract callbacks), and regression tests for the security findings below.

### Autopilot from a terminal

The page's Autopilot stops when the page closes (and slows down in a background tab, where it can reveal too
late and leave the reveal reward to a keeper). `keeper/autopilot.mjs` runs the same strategies with your own
account on your own computer. It seals each bet locally, reveals it itself when the window opens, and keeps
sides and salts in `~/.befewer/<contract>/<account>.json`, so no side leaves your computer before the reveal.

There is deliberately no server that runs strategies for players: to bet for you it would have to know your
side before betting closes, and whoever runs it would see every Autopilot's side, which is what wins a
minority game.

```sh
cd keeper && npm ci
node autopilot.mjs --list                                        # the strategies and slot sets
node autopilot.mjs --account you.testnet --strategy Echo --deposit 1   # key in ~/.near-credentials/testnet
FEWER_PRIVATE_KEY=ed25519:... node autopilot.mjs --account g<hex>.befewer.testnet --rules '[...]'
```

The page's Autopilot tab ("Runs only while this page is open") gives the last line ready to paste: the slots
that are switched on, their rules, and the account's key. Options: `--budget <NEAR>` (daily loss limit,
default 0.8), `--rounds <n>`, `--deposit <NEAR>`. Turn the page's Autopilot off for the same account.

### Keeper (anyone can run one)

```sh
cd keeper && npm ci
# the account's key must be in ~/.near-credentials/testnet/<account>.json (near-cli login writes it there)
FEWER_KEEPER_ONLY=1 FEWER_KEEPER_ACCOUNT=you.testnet node run.mjs
node --test test/opener.test.mjs          # 3 tests
```

It registers itself with a 0.02 NEAR game deposit (reveal rewards are paid into a game balance), opens timelocks
on worker threads (each drand round's beacon fetched and verified once; accounts served round-robin so one
account cannot crowd others out), and re-reads the round before paying for a reveal.

### Web

```sh
(cd keeper && npm ci)                     # the server reuses keeper/lib.mjs
cd web && npm ci
node --test test/rules.test.ts            # 27 tests of the autopilot rule engine (Node 22.18+)
npx vite build && PORT=5043 node server.mjs
```

The page talks to NEAR testnet RPCs directly. The server's guest faucet signs with a funded testnet account
(`befewer.testnet`, key read from `~/.near-credentials`); without that key, connect a testnet wallet
(Meteor, Intear or MyNearWallet) instead. End-to-end checks in `web/e2e/` need puppeteer
(`npm i -D puppeteer`), e.g. `node e2e/shots.cjs https://befewer.com/`.

## Security testing

Done during the hackathon on an isolated copy of the contract (`v6t.befewer.testnet`) plus a white-box review:

- Black-box attacks (private callbacks, fake token arrivals, overflowing amounts, acting for other accounts,
  duplicate reveals, storage deposits) were all refused.
- Fixed: a keeper could be crowded out with junk timelocks; the refining index could be pushed to u128::MAX
  and freeze claims; the pool opening could be front-run; buybacks could be sandwiched; a dominant holder could
  dodge the refining fee; refundable slot fees were counted as treasury money; void rounds' storage fell on the
  treasury; the guest faucet's rate limits could be bypassed with a forged Origin header. Each contract fix has
  a test that fails without it; the keeper and faucet fixes were checked with measurements and end-to-end runs
  (see the commit messages).
- Accepted: when nobody else plays, one account betting both sides can mine the round's emission cheaply.

## Made during the hackathon

Everything in this repository was written during NEAR HACKATHON: the first commit is from 2026-11-06 and there
is no code from before. The git history shows every step; the tag `hackathon-submission` marks the submitted
commit. The project does not exist on any other chain.

## Libraries, services and AI

- Contract: `near-sdk` 5.30, `near-contract-standards` 5.30 (NEP-141/145/148), `uint` 0.9.
- Keeper: `near-api-js`, `tlock-js`, `drand-client`.
- Web: Svelte 5, Vite, TypeScript, `near-api-js`, `@near-js/crypto`, `@near-js/transactions`,
  `@near-wallet-selector/core`, `-meteor-wallet`, `-intear-wallet`, `-my-near-wallet`, `tlock-js`, `drand-client`.
- Services: NEAR testnet RPCs (FastNEAR, dRPC, Intear), drand quicknet, Ref Finance testnet (`ref-finance-101.testnet`, `wrap.testnet`).
- The code was written with Claude Code (Anthropic) working under the author's direction; commits carry a
  `Co-Authored-By: Claude` line. Game design and every rule change were decided by the author.

## License

MIT, see [LICENSE](LICENSE).
