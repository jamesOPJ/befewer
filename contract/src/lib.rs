//! BEFEWER v6: a minority game played with NEAR that mines a capped NEP-141 token.
//!
//! Every round, players commit a hidden bet of NEAR on side A or B (commit-reveal, with an
//! optional drand timelock so anyone can reveal for them). An account can run any number of
//! slots: independent bettors with their own bet each round and their own streak, sharing the
//! account's NEAR balance and mined BEFEWER. After the reveal window the side
//! with LESS revealed stake wins:
//!   * winners get exactly 2x their stake back (the bet fee is not refunded),
//!   * losers lose their stake,
//!   * every bet pays a fee on top of its stake (`fee_bps`),
//!   * fees, the imbalance |A - B| and unrevealed stakes go to the treasury,
//!   * whoever reveals a bet gets `reveal_bounty_bps` of its fee (keepers get paid for the gas),
//!   * a tie or an empty side voids the round: revealed stakes and fees are refunded, minus the
//!     reveal reward already paid.
//!
//! Bookkeeping is lazy: a round settles (outcome, treasury, pot) when any later bet or reveal
//! comes in, or via `settle_due`; each slot's own bets are booked into the account when that
//! slot bets again, on a withdraw/claim, or by anyone calling `claim`. Views show settled but
//! unbooked results.
//!
//! Mining: each settled round adds `reward_per_round` BEFEWER to a pot. A win that makes a
//! slot's streak of `streak_min` or more wins in a row earns shares in the pot: a streak of
//! `streak_min` is 1 share per milli-NEAR staked, `streak_min + 1` is 2 shares, and so on. The
//! pot is split among that round's winners by shares; if nobody qualifies it rolls over.
//! Nothing else ever mints BEFEWER and issuance stops at `max_supply`.
//!
//! Refining (like ORE's unrefined ORE): mined BEFEWER stays in the game as "unrefined". Claiming
//! it to the wallet (`claim_befewer`) costs `refine_fee_bps` (10%) of the unrefined part, and that
//! fee is shared pro rata among everyone still holding unrefined BEFEWER, as "refined" BEFEWER
//! that is claimed without a fee. If nobody else holds any, the fee goes back to the mining pot.
//!
//! The treasury: once it holds `graduate_at` NEAR, anyone can call `graduate` (step by step)
//! to open a wNEAR/BEFEWER pool on the DEX (Ref Finance) with all of it plus as many new
//! BEFEWER as have been mined so far. The LP shares stay with this contract, which has no
//! method to withdraw them. After that, `buyback` spends the treasury in small batches buying
//! BEFEWER from that pool, and every BEFEWER that reaches this contract is burned.
//!
//! All parameters are fixed in `new`: there is no owner and no admin method.

use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};

/// Max number of unfinished bets a slot can have at once.
pub const MAX_OPEN_ROUNDS: usize = 8;
/// Storage held by each extra slot (refunded when the slot is closed).
pub const SLOT_FEE: u128 = NEAR / 500;
/// `reveal_many` stops when less gas than this is left.
pub const REVEAL_GAS_MARGIN: u64 = 20_000_000_000_000;
/// Rounds `settle_due` settles per call, and how far `settle` may catch up at once.
pub const SETTLE_PER_CALL: u32 = 4;
pub const SETTLE_CATCH_UP: u32 = 50;
const BPS: u128 = 10_000;
pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// One BEFEWER (18 decimals).
pub const TOKEN: u128 = 1_000_000_000_000_000_000;
/// Charged once, on an account's first deposit: pays for its game record and token registration.
pub const STORAGE_FEE: u128 = NEAR / 100;
/// NEAR the treasury never spends, on top of what the contract owes players and its storage.
pub const SAFETY_RESERVE: u128 = NEAR;
/// Smallest buyback worth sending.
/// Each buyback spends 1/BUYBACK_PARTS of the spendable treasury (at most `buyback_max`), and
/// only if that is at least MIN_BUYBACK: a smaller buy would mostly pay gas. So buybacks start
/// once the treasury holds 36.5 NEAR, and run at most once per `buyback_every_ns`.
pub const MIN_BUYBACK: u128 = NEAR / 10;
pub const BUYBACK_PARTS: u128 = 365;
/// The most a buyback pays per BEFEWER: 25% above the last buyback's price, and 25% more after
/// each one the pool refused. Someone pumping the price right before a buyback (to sell into
/// it) gets the swap refused instead.
pub const BUYBACK_CEILING_BPS: u128 = 12_500;
const BUYBACK_CEILING_KEY: &[u8] = b"__bc";
/// A refining fee is shared only if the other holders hold at least this much unrefined
/// BEFEWER; otherwise it goes to the pot. (Dividing a fee by a dust amount would push the
/// index toward u128::MAX, after which every claim would overflow.)
pub const REFINE_MIN_OTHERS: u128 = TOKEN;
/// Bytes a round's record keeps on chain for good: key 9 + Round 242 + 40 per-record overhead.
/// A void round brings the treasury nothing, so its revealed bets pay for it, split by stake.
pub const ROUND_RECORD_BYTES: u128 = 291;
/// Shares count stakes in milli-NEAR, so `pot * shares` always fits in u128.
pub const SHARE_UNIT: u128 = NEAR / 1_000;

pub const SIDE_NONE: u8 = 0;
pub const SIDE_A: u8 = 1;
pub const SIDE_B: u8 = 2;
pub const OUTCOME_VOID: u8 = 3;

// DEX graduation steps (see `graduate`).
pub const STEP_START: u8 = 0; // waiting for the treasury to reach `graduate_at`
pub const STEP_REGISTER: u8 = 1; // NEAR wrapped: register at the DEX and create the pool
pub const STEP_SEND_NEAR: u8 = 2; // pool exists: deposit the wNEAR
pub const STEP_SEND_TOKEN: u8 = 3; // deposit the BEFEWER seed
pub const STEP_ADD_LIQUIDITY: u8 = 4; // both deposited: add liquidity
pub const STEP_DONE: u8 = 5; // pool open, buybacks enabled

// NEAR the graduation spends on registrations and storage (any excess is refunded by the DEX).
const WNEAR_STORAGE: u128 = 1_250_000_000_000_000_000_000; // 0.00125 NEAR
const DEX_STORAGE: u128 = NEAR / 10;
const DEX_POOL_STORAGE: u128 = NEAR / 10;
const DEX_LP_STORAGE: u128 = NEAR / 20;
pub const GRADUATION_COST: u128 = WNEAR_STORAGE + DEX_STORAGE + DEX_POOL_STORAGE + DEX_LP_STORAGE;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

uint::construct_uint! {
    /// 256-bit integer for the refining accumulator (fee * SCALE can exceed u128).
    pub struct U256(4);
}
/// Fixed-point scale of the refining accumulator (`refine_index`).
pub const REFINE_SCALE: u128 = 1_000_000_000_000_000_000_000_000; // 1e24

const fn tgas(n: u64) -> Gas {
    Gas::from_tgas(n)
}

/// Who mined in a round: the revealed bets that would mine if their side wins, one list per
/// side, kept in raw storage under its own prefix (outside the contract state, so it was added
/// to the live contract without a migration). Settling keeps the winning side's list only if
/// that round mined, and removes the rest.
const MINERS_PREFIX: &[u8] = b"__mn";
/// Bets listed by name per round and side (all of them are counted).
pub const MINERS_LISTED: usize = 100;

#[near(serializers = [borsh])]
#[derive(Default)]
pub struct MinerList {
    /// Mining bets on this side, and the accounts they came from.
    pub bets: u32,
    pub players: u32,
    /// Sum of their shares: equals the round's `reward_shares` only if every one was recorded.
    pub shares: u128,
    /// (account, slot, streak, shares), the first MINERS_LISTED.
    pub list: Vec<(AccountId, u32, u32, u128)>,
}

pub fn miners_key(r: u64, side: u8) -> Vec<u8> {
    let mut k = MINERS_PREFIX.to_vec();
    k.extend_from_slice(&r.to_le_bytes());
    k.push(side);
    k
}
/// The last BUYBACKS_KEPT buybacks, oldest first: (started at ns, wNEAR sent to the pool, wNEAR
/// the pool took, BEFEWER that came back and was burned). Raw storage outside the contract
/// state, like the miner lists (added to the live contract without a migration).
const BUYBACKS_KEY: &[u8] = b"__bb";
pub const BUYBACKS_KEPT: usize = 100;
type BuybackLog = Vec<(u64, u128, u128, u128)>;
fn buybacks_read() -> BuybackLog {
    env::storage_read(BUYBACKS_KEY).map(|v| near_sdk::borsh::from_slice(&v).expect("buyback log")).unwrap_or_default()
}
fn buybacks_write(log: &BuybackLog) {
    env::storage_write(BUYBACKS_KEY, &near_sdk::borsh::to_vec(log).expect("buyback log"));
}
/// Change the newest entry (the buyback in flight: buybacks never overlap).
fn buybacks_update_last(f: impl FnOnce(&mut (u64, u128, u128, u128))) {
    let mut log = buybacks_read();
    if let Some(last) = log.last_mut() {
        f(last);
        buybacks_write(&log);
    }
}

/// The price ceiling for the next buyback, yoctoNEAR per 1 BEFEWER (0 = not set yet).
fn ceiling_read() -> u128 {
    env::storage_read(BUYBACK_CEILING_KEY).and_then(|v| v.try_into().ok()).map(u128::from_le_bytes).unwrap_or(0)
}
fn ceiling_write(v: u128) {
    env::storage_write(BUYBACK_CEILING_KEY, &v.to_le_bytes());
}
/// yoctoNEAR per 1 BEFEWER for `near` spent on `tokens`, times BUYBACK_CEILING_BPS.
fn ceiling_from(near: u128, tokens: u128) -> u128 {
    if tokens == 0 {
        return 0;
    }
    let v = U256::from(near) * U256::from(TOKEN) * U256::from(BUYBACK_CEILING_BPS) / (U256::from(tokens) * U256::from(BPS));
    if v > U256::from(u128::MAX) { u128::MAX } else { v.as_u128() }
}
/// Once the newest buyback has both its NEAR and its BEFEWER, its price sets the next ceiling.
fn reprice_from_last() {
    if let Some(&(_, _, spent, burned)) = buybacks_read().last() {
        if spent > 0 && burned > 0 {
            ceiling_write(ceiling_from(spent, burned));
        }
    }
}

fn miners_read(r: u64, side: u8) -> Option<MinerList> {
    env::storage_read(&miners_key(r, side)).map(|v| near_sdk::borsh::from_slice(&v).expect("miner list"))
}

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Token,
    Rounds,
    Commits,
    Players,
    RoundPlayers,
    Balances,
    Slots,
}

/// Launch parameters. Fixed forever once `new` runs.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Params {
    /// Start of round 0's commit window (ns since epoch).
    pub genesis_ns: U64,
    /// Length of a commit window. Round r commits during [g + r*C, g + (r+1)*C).
    pub commit_ns: U64,
    /// Length of a reveal window. Round r reveals during [g + (r+1)*C, g + (r+1)*C + R).
    pub reveal_ns: U64,
    /// Max stake per round, in basis points of the account's game balance at commit time.
    pub max_stake_bps: u16,
    /// Smallest allowed stake (yoctoNEAR).
    pub min_stake: U128,
    /// Fee paid on top of every stake, in basis points of the stake. Goes to the treasury.
    pub fee_bps: u16,
    /// BEFEWER added to the mining pot each time a round settles.
    pub reward_per_round: U128,
    /// Most BEFEWER that can ever be issued (mining + the pool seed).
    pub max_supply: U128,
    /// Wins in a row needed before a win earns mining shares.
    pub streak_min: u32,
    /// Treasury NEAR needed to open the DEX pool.
    pub graduate_at: U128,
    /// The DEX (a Ref Finance exchange contract).
    pub dex: AccountId,
    /// Wrapped NEAR token contract used by the DEX.
    pub wnear: AccountId,
    /// Pool fee in basis points (30 = 0.3%).
    pub pool_fee: u32,
    /// Most NEAR spent by one buyback.
    pub buyback_max: U128,
    /// Least time between two buybacks.
    pub buyback_every_ns: U64,
    /// Fee on claiming unrefined BEFEWER to the wallet, in basis points (1000 = 10%), shared
    /// among everyone still holding unrefined BEFEWER.
    pub refine_fee_bps: u16,
    /// Share of a bet's fee paid to whoever reveals it, in basis points of the fee (8000 = 80%).
    pub reveal_bounty_bps: u16,
}

#[near(serializers = [borsh])]
#[derive(Default, Clone)]
pub struct Round {
    /// Sum of stakes committed (fees excluded).
    pub committed: u128,
    /// Sum of fees paid by commits.
    pub fees: u128,
    /// Reveal rewards paid out of this round's fees to whoever revealed.
    pub bounties: u128,
    pub revealed_a: u128,
    pub revealed_b: u128,
    /// Fees of revealed commits (a void round refunds them, minus the reveal rewards).
    pub revealed_fees: u128,
    /// Mining shares of revealed commits on each side.
    pub shares_a: u128,
    pub shares_b: u128,
    pub commits: u32,
    pub reveals_a: u32,
    pub reveals_b: u32,
    /// Commits booked so far (paid out into their accounts).
    pub claims: u32,
    pub settled: bool,
    /// SIDE_A / SIDE_B (winning side) or OUTCOME_VOID. SIDE_NONE until settled.
    pub outcome: u8,
    /// NEAR this round sent to the treasury (fees net of reveal rewards + imbalance + unrevealed).
    pub to_treasury: u128,
    /// BEFEWER added to the pot when this round settled.
    pub emission: u128,
    /// BEFEWER (the whole pot) this round's winners split, by shares. 0 if nobody qualified.
    pub reward: u128,
    /// Shares on the winning side (the denominator of the split).
    pub reward_shares: u128,
    /// `refine_index` when the reward was mined: winners collect refined BEFEWER from here on,
    /// even if they book their share much later.
    pub reward_index: u128,
    /// Part of the reward already booked into winners' accounts.
    pub reward_booked: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Commit {
    pub hash: [u8; 32],
    pub amount: u128,
    pub fee: u128,
    /// Reveal reward paid out of the fee to whoever revealed (0 until revealed).
    pub bounty: u128,
    /// NEAR held from the player for this bet's storage; returned when the bet is booked.
    pub storage: u128,
    pub side: u8,
    /// Mining shares this commit earns if it wins (fixed at reveal from the slot's streak).
    pub shares: u128,
    /// Streak this commit completes if it wins (0 until revealed).
    pub streak_if_win: u32,
    /// Optional drand timelock ciphertext of "<A|B>:<salt>", sealed to the drand round at
    /// this round's reveal start. Lets anyone reveal for the player once drand publishes
    /// that round. Dropped on reveal.
    pub sealed: Option<String>,
}

/// Longest accepted `sealed` ciphertext (tlock armored output is ~580 bytes).
pub const MAX_SEALED_LEN: usize = 1024;

/// Per account: what all of its slots share (mined BEFEWER and refining).
/// The NEAR game balance lives in `balances`.
#[near(serializers = [borsh])]
#[derive(Default, Clone)]
pub struct Player {
    /// Slot ids handed out so far (0..slots); closed ones are gone from `slots`.
    pub slots: u32,
    /// BEFEWER this account has booked from mining.
    pub mined: u128,
    /// Mined BEFEWER still in the game (claiming it costs the refining fee).
    pub unrefined: u128,
    /// Share of other players' refining fees, booked at the last checkpoint (claimed without a fee).
    pub refined: u128,
    /// `refine_index` at the last checkpoint.
    pub refine_index: u128,
}

/// One independent bettor inside an account: at most one bet per round and its own streak.
#[near(serializers = [borsh])]
#[derive(Default, Clone)]
pub struct Slot {
    pub streak: u32,
    pub best_streak: u32,
    pub wins: u32,
    pub losses: u32,
    pub voids: u32,
    pub forfeits: u32,
    /// Rounds with a bet that has not been booked yet, ascending.
    pub open_rounds: Vec<u64>,
}

#[near(serializers = [borsh])]
#[derive(Default, Clone)]
pub struct Dex {
    pub step: u8,
    /// A step's cross-contract call is in flight.
    pub busy: bool,
    /// NEAR (as wNEAR) going into the pool.
    pub near_amount: u128,
    /// BEFEWER minted into the pool.
    pub seed: u128,
    pub seed_minted: bool,
    pub pool_id: Option<u64>,
    pub shares: u128,
    pub graduated_at_ns: u64,
    /// wNEAR the contract holds after a swap that did not go through (spent first next time).
    pub held_wnear: u128,
    pub last_buyback_ns: u64,
    pub buybacks: u32,
    /// NEAR spent buying BEFEWER.
    pub bought_near: u128,
    /// BEFEWER the pool sent back for it (all burned).
    pub bought_burned: u128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
    params: Params,
    /// Game balances in NEAR (yocto), credited by `deposit`, payouts and reveal rewards.
    balances: LookupMap<AccountId, u128>,
    /// Sum of `balances`.
    balances_total: u128,
    /// NEAR (stakes + fees, minus paid reveal rewards) held for bets not yet booked.
    escrow: u128,
    /// Players' NEAR held for the storage of their open bets (returned when booked).
    storage_held: u128,
    /// NEAR owned by the game, not yet spent on the pool or buybacks.
    treasury: u128,
    /// All NEAR that ever reached the treasury (rounds + donations).
    treasury_in: u128,
    /// One-time storage fees (first deposits) and slot fees (refunded when a slot closes).
    storage_fees: u128,
    rounds: LookupMap<u64, Round>,
    commits: LookupMap<(u64, AccountId, u32), Commit>,
    /// (account, slot) of every bet in a round, so keepers can enumerate bets to reveal.
    /// Removed once every bet of the round is booked.
    round_players: LookupMap<u64, Vec<(AccountId, u32)>>,
    players: LookupMap<AccountId, Player>,
    slots: LookupMap<(AccountId, u32), Slot>,
    /// Rounds with bets that are not settled yet, ascending. Settled strictly in this order.
    unsettled: Vec<u64>,
    /// Reveal rewards paid so far.
    bounties_paid: u128,
    // ---- mining ----
    /// BEFEWER waiting for the next round with qualifying winners.
    pot: u128,
    /// BEFEWER issued so far: pot + round rewards + the pool seed. Never above max_supply.
    issued: u128,
    /// BEFEWER mined by streaks (credited when their round settles).
    mined: u128,
    total_burned: u128,
    rounds_settled: u64,
    best_streak: u32,
    best_streak_holder: Option<AccountId>,
    biggest_reward: u128,
    biggest_reward_round: Option<u64>,
    dex: Dex,
    // ---- refining ----
    /// Unrefined BEFEWER: every account's booked unrefined + round rewards not booked yet.
    unrefined_total: u128,
    /// Refined BEFEWER per unit of unrefined, times REFINE_SCALE, accumulated since launch.
    refine_index: u128,
    /// Refining fees charged so far.
    refine_fees: u128,
    /// Of those, fees that went back to the pot because nobody else held unrefined BEFEWER.
    refine_to_pot: u128,
    /// Rounding remainders of reward splits, returned to the pot.
    dust_to_pot: u128,
    /// BEFEWER minted to wallets by claims (unrefined after the fee + refined).
    claimed: u128,
}

// ---------- JSON views ----------

#[near(serializers = [json])]
pub struct RoundView {
    pub round: U64,
    pub commit_starts_at: U64,
    pub reveal_starts_at: U64,
    pub reveal_ends_at: U64,
    pub committed: U128,
    pub fees: U128,
    pub bounties: U128,
    pub revealed_a: U128,
    pub revealed_b: U128,
    pub shares_a: U128,
    pub shares_b: U128,
    pub commits: u32,
    pub reveals_a: u32,
    pub reveals_b: u32,
    pub claims: u32,
    pub settled: bool,
    /// "A", "B", "void", or null while unsettled.
    pub outcome: Option<String>,
    pub to_treasury: U128,
    pub emission: U128,
    pub reward: U128,
    pub reward_shares: U128,
    pub reward_booked: U128,
    /// Bets that mined this round and the accounts they came from. Both 0 when nothing was
    /// mined, or when the round was played before the list was recorded (then `reward` > 0).
    pub miners: u32,
    pub mining_players: u32,
}

/// One buyback (`get_buybacks`). `spent` < `near_in`: the pool did not take it all (kept as
/// wNEAR for the next one); `spent` 0 with `burned` 0: the swap did not go through.
#[near(serializers = [json])]
pub struct BuybackView {
    pub at: U64,
    pub near_in: U128,
    pub spent: U128,
    pub burned: U128,
}

/// One bet that mined in a round (`get_round_miners`).
#[near(serializers = [json])]
pub struct MinerView {
    pub account_id: AccountId,
    pub slot: u32,
    /// The streak this win completed.
    pub streak: u32,
    pub shares: U128,
    /// Its part of the round's reward (unrefined BEFEWER).
    pub mined: U128,
}

#[near(serializers = [json])]
pub struct DexView {
    /// "waiting", "registering", "sending NEAR", "sending BEFEWER", "adding liquidity", "open".
    pub stage: String,
    pub step: u8,
    pub busy: bool,
    pub dex: AccountId,
    pub wnear: AccountId,
    pub pool_id: Option<u64>,
    pub near_amount: U128,
    pub seed: U128,
    pub shares: U128,
    pub graduated_at: U64,
    pub held_wnear: U128,
    pub next_buyback_at: U64,
    /// What a buyback would spend right now (1/365 of the treasury + held wNEAR); it runs at >= 0.1 NEAR.
    pub buyback_now: U128,
    /// Most a buyback pays per BEFEWER, in yoctoNEAR per 1 BEFEWER (0 before the pool opens).
    pub buyback_ceiling: U128,
    pub buybacks: u32,
    pub bought_near: U128,
    pub bought_burned: U128,
}

#[near(serializers = [json])]
pub struct StatusView {
    pub now: U64,
    /// Round currently taking commits.
    pub commit_round: U64,
    pub commit_ends_at: U64,
    /// Round currently taking reveals, if any.
    pub reveal_round: Option<U64>,
    pub reveal_ends_at: Option<U64>,
    pub treasury: U128,
    /// Part of the treasury that can be spent right now (keeps the safety reserve).
    pub treasury_spendable: U128,
    pub treasury_in: U128,
    pub graduate_at: U128,
    pub balances_total: U128,
    pub escrow: U128,
    /// Players' NEAR held for the storage of their open bets.
    pub storage_held: U128,
    /// One-time 0.01 NEAR fees paid by first deposits, plus slot fees (kept for storage).
    pub storage_fees: U128,
    /// Reveal rewards paid so far, and the share of the fee they take.
    pub bounties_paid: U128,
    pub reveal_bounty_bps: u16,
    /// Rounds with bets waiting to be settled (settled in order, by any bet or by `settle_due`).
    pub unsettled: u32,
    pub total_supply: U128,
    pub max_supply: U128,
    pub issued: U128,
    pub mined: U128,
    pub pot: U128,
    pub total_burned: U128,
    /// Mined BEFEWER still unrefined (in the game, not yet claimed).
    pub unrefined_total: U128,
    pub refine_fee_bps: u16,
    /// Refining fees charged so far, and the part that went back to the pot.
    pub refine_fees: U128,
    pub refine_to_pot: U128,
    pub dust_to_pot: U128,
    /// BEFEWER minted to wallets by claims.
    pub claimed: U128,
    pub rounds_settled: U64,
    pub best_streak: u32,
    pub best_streak_holder: Option<AccountId>,
    pub biggest_reward: U128,
    pub biggest_reward_round: Option<U64>,
    pub dex: DexView,
}

#[near(serializers = [json])]
pub struct OpenCommitView {
    pub round: U64,
    pub amount: U128,
    pub fee: U128,
    /// Reveal reward paid out of the fee (to whoever revealed).
    pub bounty: U128,
    /// NEAR held for this bet's storage, returned when it is booked.
    pub storage: U128,
    /// "A", "B", or null if not revealed yet.
    pub side: Option<String>,
    /// Streak this bet completes if it wins (known once revealed; 0 before).
    pub streak_if_win: u32,
    pub shares: U128,
    /// Once the round is settled but the bet is not booked yet: "win", "loss", "void" or
    /// "forfeit", what booking it will pay into the game balance (storage included) and the
    /// BEFEWER it mined. Booking happens on the slot's next bet, a withdraw/claim, or `claim`.
    pub result: Option<String>,
    pub payout: U128,
    pub mined: U128,
}

#[near(serializers = [json])]
pub struct SlotView {
    pub slot: u32,
    pub streak: u32,
    pub best_streak: u32,
    pub wins: u32,
    pub losses: u32,
    pub voids: u32,
    pub forfeits: u32,
    pub open: Vec<OpenCommitView>,
}

/// One reveal for `reveal_many`.
#[near(serializers = [json])]
pub struct RevealItem {
    pub round: U64,
    pub slot: u32,
    pub account_id: AccountId,
    pub side: String,
    pub salt: String,
}

#[near(serializers = [json])]
pub struct RoundCommitView {
    pub account_id: AccountId,
    pub slot: u32,
    pub amount: U128,
    /// "A", "B", or null if not revealed yet.
    pub side: Option<String>,
    /// The sha256 commitment (hex), so keepers can check a decrypted side+salt before sending.
    pub hash: String,
    pub sealed: Option<String>,
}

#[near(serializers = [json])]
pub struct PlayerView {
    pub account_id: AccountId,
    /// Game balance in NEAR (yocto).
    pub balance: U128,
    /// BEFEWER held.
    pub tokens: U128,
    /// Has deposited at least once (game record exists).
    pub registered: bool,
    /// Slot 0's record (the slot manual bets use), for convenience.
    pub streak: u32,
    pub best_streak: u32,
    pub wins: u32,
    pub losses: u32,
    pub voids: u32,
    pub forfeits: u32,
    pub open: Vec<OpenCommitView>,
    /// Slot ids handed out (0..slot_count; closed ones are missing from `slots`).
    pub slot_count: u32,
    /// The first 32 open slots.
    pub slots: Vec<SlotView>,
    /// Settled but not yet booked, over those slots: NEAR that booking will add (storage
    /// included) and BEFEWER mined.
    pub pending_near: U128,
    pub pending_mined: U128,
    /// BEFEWER booked from mining.
    pub mined: U128,
    /// Mined BEFEWER still in the game (claiming costs the refining fee on this part),
    /// pending mined BEFEWER included.
    pub unrefined: U128,
    /// Share of others' refining fees (claimed without a fee), pending part included.
    pub refined: U128,
}

fn side_str(side: u8) -> Option<String> {
    match side {
        SIDE_A => Some("A".into()),
        SIDE_B => Some("B".into()),
        OUTCOME_VOID => Some("void".into()),
        _ => None,
    }
}

fn parse_hash(hex: &str) -> [u8; 32] {
    require!(hex.len() == 64, "hash must be 64 hex characters (sha256)");
    let mut out = [0u8; 32];
    let b = hex.as_bytes();
    for i in 0..32 {
        let hi = (b[2 * i] as char).to_digit(16);
        let lo = (b[2 * i + 1] as char).to_digit(16);
        match (hi, lo) {
            (Some(h), Some(l)) => out[i] = (h * 16 + l) as u8,
            _ => env::panic_str("hash must be hex"),
        }
    }
    out
}

/// The exact preimage clients must hash: `fewer:<account>:<slot>:<round>:<A|B>:<salt>`.
pub fn commit_preimage(account_id: &AccountId, slot: u32, round: u64, side: &str, salt: &str) -> String {
    format!("fewer:{}:{}:{}:{}:{}", account_id, slot, round, side, salt)
}

/// NEAR held from the player for one bet's storage: the commit (keyed by the account id, with
/// the ciphertext) and its entry in the round's list, plus per-record overhead. Slightly more
/// than the bytes used; all of it comes back when the bet is booked.
pub fn commit_storage(account_id: &AccountId, sealed_len: usize) -> u128 {
    let bytes = 2 * account_id.as_str().len() + sealed_len + 260;
    bytes as u128 * env::storage_byte_cost().as_yoctonear()
}

/// floor(a * b / c) for b <= c, without overflowing as long as (c - 1) * b fits in u128.
/// A revealed bet's part of a void round's record storage: ROUND_RECORD_BYTES worth of NEAR,
/// split over the round's revealed stake.
pub fn void_record_share(round: &Round, amount: u128) -> u128 {
    let revealed = round.revealed_a + round.revealed_b;
    if revealed == 0 {
        return 0;
    }
    let fee = ROUND_RECORD_BYTES * env::storage_byte_cost().as_yoctonear();
    (U256::from(fee) * U256::from(amount.min(revealed)) / U256::from(revealed)).as_u128() // <= fee
}

pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    require!(c > 0 && b <= c, "mul_div: bad arguments");
    (a / c) * b + (a % c) * b / c
}

/// Mining shares for a winning stake that completes a streak of `streak` wins.
pub fn shares_for(stake: u128, streak: u32, streak_min: u32) -> u128 {
    if streak < streak_min {
        return 0;
    }
    (stake / SHARE_UNIT) * (streak - streak_min + 1) as u128
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    log!(
        "EVENT_JSON:{}",
        json!({"standard": "befewer", "version": "4.0.0", "event": event, "data": [data]})
    );
}

/// Result of the single promise this callback waits on, if it succeeded.
fn promise_ok() -> Option<Vec<u8>> {
    if env::promise_results_count() != 1 {
        return None;
    }
    env::promise_result_checked(0, 1_000).ok()
}

#[near]
impl Contract {
    #[init]
    pub fn new(params: Params, metadata: FungibleTokenMetadata) -> Self {
        metadata.assert_valid();
        require!(metadata.spec == FT_METADATA_SPEC, "metadata.spec must be ft-1.0.0");
        require!(params.commit_ns.0 > 0, "commit_ns must be > 0");
        require!(
            params.reveal_ns.0 > 0 && params.reveal_ns.0 <= params.commit_ns.0,
            "reveal_ns must be in (0, commit_ns]"
        );
        require!(
            params.max_stake_bps > 0 && (params.max_stake_bps as u128) <= BPS,
            "max_stake_bps must be in (0, 10000]"
        );
        require!(params.min_stake.0 >= SHARE_UNIT, "min_stake must be at least 0.001 NEAR");
        require!(params.fee_bps <= 2_000, "fee_bps must be at most 2000 (20%)");
        require!(params.streak_min >= 1, "streak_min must be >= 1");
        require!(params.reward_per_round.0 > 0, "reward_per_round must be > 0");
        require!(params.max_supply.0 >= params.reward_per_round.0, "max_supply must be >= reward_per_round");
        require!(params.graduate_at.0 > GRADUATION_COST, "graduate_at must cover the graduation cost");
        require!(params.buyback_max.0 >= MIN_BUYBACK, "buyback_max must be >= 0.01 NEAR");
        require!(params.pool_fee > 0 && params.pool_fee <= 1_000, "pool_fee must be in (0, 1000]");
        require!(params.refine_fee_bps <= 5_000, "refine_fee_bps must be at most 5000 (50%)");
        require!(params.reveal_bounty_bps <= 10_000, "reveal_bounty_bps must be at most 10000 (the whole fee)");
        let me = env::current_account_id();
        let mut token = FungibleToken::new(StorageKey::Token);
        token.internal_register_account(&me);
        Self {
            token,
            metadata,
            params,
            balances: LookupMap::new(StorageKey::Balances),
            balances_total: 0,
            escrow: 0,
            storage_held: 0,
            treasury: 0,
            treasury_in: 0,
            storage_fees: 0,
            rounds: LookupMap::new(StorageKey::Rounds),
            commits: LookupMap::new(StorageKey::Commits),
            round_players: LookupMap::new(StorageKey::RoundPlayers),
            players: LookupMap::new(StorageKey::Players),
            slots: LookupMap::new(StorageKey::Slots),
            unsettled: vec![],
            bounties_paid: 0,
            pot: 0,
            issued: 0,
            mined: 0,
            total_burned: 0,
            rounds_settled: 0,
            best_streak: 0,
            best_streak_holder: None,
            biggest_reward: 0,
            biggest_reward_round: None,
            dex: Dex::default(),
            unrefined_total: 0,
            refine_index: 0,
            refine_fees: 0,
            refine_to_pot: 0,
            dust_to_pot: 0,
            claimed: 0,
        }
    }

    // ---------- time helpers ----------

    fn round_commit_start(&self, r: u64) -> u64 {
        self.params.genesis_ns.0 + r * self.params.commit_ns.0
    }
    fn round_reveal_start(&self, r: u64) -> u64 {
        self.round_commit_start(r + 1)
    }
    fn round_reveal_end(&self, r: u64) -> u64 {
        self.round_reveal_start(r) + self.params.reveal_ns.0
    }
    fn commit_round_at(&self, now: u64) -> u64 {
        require!(now >= self.params.genesis_ns.0, "the game has not started yet");
        (now - self.params.genesis_ns.0) / self.params.commit_ns.0
    }

    // ---------- NEAR in and out ----------

    /// Add the attached NEAR to the game balance of `account_id` (default: caller). The first
    /// deposit of an account pays a one-time 0.01 NEAR storage fee, registers it for BEFEWER and
    /// opens its slot 0.
    #[payable]
    pub fn deposit(&mut self, account_id: Option<AccountId>) -> U128 {
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let mut amount = env::attached_deposit().as_yoctonear();
        if !self.balances.contains_key(&who) {
            require!(amount > STORAGE_FEE, "the first deposit must be more than 0.01 NEAR (it pays for your game record)");
            amount -= STORAGE_FEE;
            self.storage_fees += STORAGE_FEE;
            if self.token.accounts.get(&who).is_none() {
                self.token.internal_register_account(&who);
            }
            self.balances.insert(who.clone(), 0);
            if !self.players.contains_key(&who) {
                self.players.insert(who.clone(), Player { slots: 1, refine_index: self.refine_index, ..Default::default() });
                self.slots.insert((who.clone(), 0), Slot::default());
            }
        }
        require!(amount > 0, "attach some NEAR to deposit");
        let b = self.balances.get_mut(&who).expect("registered above");
        *b += amount;
        let now = *b;
        self.balances_total += amount;
        emit("deposit", json!({"account_id": who, "amount": U128(amount), "by": env::predecessor_account_id()}));
        U128(now)
    }

    /// Send `amount` (default: everything) of the caller's game balance back to the caller.
    /// `book` lists slots whose finished bets should be booked first (default: slot 0), so
    /// winnings that were not booked yet are included.
    pub fn withdraw(&mut self, amount: Option<U128>, book: Option<Vec<u32>>) -> Promise {
        let who = env::predecessor_account_id();
        self.settle_due();
        for s in book.unwrap_or_else(|| vec![0]) {
            self.internal_book(&who, s);
        }
        let bal = self.balances.get(&who).copied().unwrap_or(0);
        let amount = amount.map(|a| a.0).unwrap_or(bal);
        require!(amount > 0, "nothing to withdraw");
        require!(amount <= bal, "not enough NEAR in your game balance");
        self.balances.insert(who.clone(), bal - amount);
        self.balances_total -= amount;
        emit("withdraw", json!({"account_id": who, "amount": U128(amount)}));
        Promise::new(who.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(tgas(5)).on_withdraw(who, U128(amount)))
    }

    /// Put the NEAR back if the transfer failed (for example: the account was deleted).
    #[private]
    pub fn on_withdraw(&mut self, account_id: AccountId, amount: U128) {
        if promise_ok().is_none() {
            let b = self.balances.entry(account_id.clone()).or_insert(0);
            *b += amount.0;
            self.balances_total += amount.0;
            emit("withdraw_failed", json!({"account_id": account_id, "amount": amount}));
        }
    }

    /// Give the attached NEAR to the treasury.
    #[payable]
    pub fn donate(&mut self) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach some NEAR to donate");
        self.treasury += amount;
        self.treasury_in += amount;
        emit("donate", json!({"account_id": env::predecessor_account_id(), "amount": U128(amount)}));
    }

    /// Treasury NEAR that can leave the contract without touching player funds, escrow, the
    /// NEAR held for bets' storage, storage itself, or the safety reserve.
    /// One buyback's part of the treasury: 1/BUYBACK_PARTS of the spendable NEAR.
    fn buyback_share(&self) -> u128 {
        self.spendable() / BUYBACK_PARTS
    }

    /// What a buyback may pay per BEFEWER now: the stored ceiling, else 125% of the newest priced
    /// buyback, of the average so far, or of the price the pool opened at.
    fn buyback_ceiling(&self) -> u128 {
        let c = ceiling_read();
        if c > 0 {
            return c;
        }
        if let Some(&(_, _, spent, burned)) = buybacks_read().iter().rev().find(|e| e.2 > 0 && e.3 > 0) {
            return ceiling_from(spent, burned);
        }
        if self.dex.bought_near > 0 && self.dex.bought_burned > 0 {
            return ceiling_from(self.dex.bought_near, self.dex.bought_burned);
        }
        ceiling_from(self.dex.near_amount, self.dex.seed)
    }

    fn spendable(&self) -> u128 {
        let balance = env::account_balance().as_yoctonear();
        let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        // storage_fees holds the refundable slot fees (and the one-time account fees, whose
        // storage is in `storage` already: counted twice, on the safe side)
        let owed = self.balances_total + self.escrow + self.storage_held + self.storage_fees + storage + SAFETY_RESERVE;
        self.treasury.min(balance.saturating_sub(owed))
    }

    // ---------- slots ----------

    /// Open another slot: an independent bettor inside this account (its own bet each round
    /// and its own streak; the NEAR balance and mined BEFEWER are shared). Costs SLOT_FEE of
    /// the game balance for storage, refunded by `close_slot`. Returns the new slot id.
    pub fn open_slot(&mut self) -> u32 {
        let who = env::predecessor_account_id();
        let mut p = self.players.get(&who).cloned().unwrap_or_else(|| env::panic_str("deposit NEAR first"));
        let bal = self.balances.get(&who).copied().unwrap_or(0);
        require!(bal >= SLOT_FEE, "a slot holds 0.002 NEAR for its storage (refunded when it is closed)");
        self.balances.insert(who.clone(), bal - SLOT_FEE);
        self.balances_total -= SLOT_FEE;
        self.storage_fees += SLOT_FEE;
        let id = p.slots;
        p.slots += 1;
        self.players.insert(who.clone(), p);
        self.slots.insert((who.clone(), id), Slot::default());
        emit("open_slot", json!({"account_id": who, "slot": id}));
        id
    }

    /// Close a slot (not slot 0) whose bets are all finished: books them, then refunds SLOT_FEE.
    pub fn close_slot(&mut self, slot: u32) {
        let who = env::predecessor_account_id();
        require!(slot != 0, "slot 0 cannot be closed");
        require!(self.slots.contains_key(&(who.clone(), slot)), "no such slot");
        self.settle_due();
        self.internal_book(&who, slot);
        let s = self.slots.get(&(who.clone(), slot)).cloned().expect("checked");
        require!(s.open_rounds.is_empty(), "the slot has a bet in a round that has not finished");
        self.slots.remove(&(who.clone(), slot));
        self.storage_fees -= SLOT_FEE;
        *self.balances.entry(who.clone()).or_insert(0) += SLOT_FEE;
        self.balances_total += SLOT_FEE;
        emit("close_slot", json!({"account_id": who, "slot": slot}));
    }

    // ---------- the game ----------

    /// From slot `slot` of the caller, lock `amount` of game NEAR (plus the fee, plus storage
    /// returned later) into the round currently taking commits, hidden behind
    /// `hash = sha256("fewer:<account>:<slot>:<round>:<A|B>:<salt>")` (hex). `sealed` (optional)
    /// is the drand timelock ciphertext of "<A|B>:<salt>", so anyone can reveal it in time.
    /// No attached deposit, so the app's function-call key can sign it without a popup.
    /// Committing also settles finished rounds and books this slot's finished bets first.
    pub fn commit(&mut self, round: U64, slot: Option<u32>, amount: U128, hash: String, sealed: Option<String>) -> U64 {
        let who = env::predecessor_account_id();
        let slot = slot.unwrap_or(0);
        let now = env::block_timestamp();
        let r = self.commit_round_at(now);
        require!(round.0 == r, format!("round {} is not taking commits (current: {})", round.0, r));
        self.settle_due();
        self.internal_book(&who, slot);
        let amount = amount.0;
        let hash = parse_hash(&hash);
        if let Some(s) = &sealed {
            require!(!s.is_empty() && s.len() <= MAX_SEALED_LEN, "sealed must be 1..1024 bytes");
        }
        require!(amount >= self.params.min_stake.0, "stake below min_stake");
        let balance = self
            .balances
            .get(&who)
            .copied()
            .unwrap_or_else(|| env::panic_str("no game balance: deposit NEAR first"));
        let mut s = self
            .slots
            .get(&(who.clone(), slot))
            .cloned()
            .unwrap_or_else(|| env::panic_str("no such slot: open_slot first"));
        let cap = balance * (self.params.max_stake_bps as u128) / BPS;
        require!(
            amount <= cap,
            format!("stake above the per-round cap of {} bps of your balance", self.params.max_stake_bps)
        );
        let fee = amount * (self.params.fee_bps as u128) / BPS;
        let storage = commit_storage(&who, sealed.as_ref().map(|x| x.len()).unwrap_or(0));
        require!(amount + fee + storage <= balance, "not enough NEAR for the stake, the fee and the bet's storage (returned later)");
        let key = (r, who.clone(), slot);
        require!(!self.commits.contains_key(&key), "this slot already bet in this round");
        require!(s.open_rounds.len() < MAX_OPEN_ROUNDS, "too many unfinished bets in this slot");

        self.balances.insert(who.clone(), balance - amount - fee - storage);
        self.balances_total -= amount + fee + storage;
        self.escrow += amount + fee;
        self.storage_held += storage;
        let has_sealed = sealed.is_some();
        self.commits.insert(key, Commit { hash, amount, fee, bounty: 0, storage, side: SIDE_NONE, shares: 0, streak_if_win: 0, sealed });
        self.round_players.entry(r).or_default().push((who.clone(), slot));
        s.open_rounds.push(r);
        self.slots.insert((who.clone(), slot), s);
        let round = self.rounds.entry(r).or_default();
        if round.commits == 0 {
            self.unsettled.push(r);
        }
        round.committed += amount;
        round.fees += fee;
        round.commits += 1;
        emit(
            "commit",
            json!({"account_id": who, "slot": slot, "round": U64(r), "amount": U128(amount), "fee": U128(fee),
                   "storage": U128(storage), "sealed": has_sealed}),
        );
        U64(r)
    }

    /// Reveal one bet during its round's reveal window. Anyone can reveal for anyone: the hash
    /// binds account, slot, round, side and salt, so only the committed side can be revealed.
    /// The revealer gets the reveal reward (`reveal_bounty_bps` of the bet's fee) in its game
    /// balance, if it has one. Revealing first books the slot's earlier bets, so its streak is
    /// current: the mining shares this bet earns if it wins are fixed here.
    pub fn reveal(&mut self, round: U64, slot: Option<u32>, side: String, salt: String, account_id: Option<AccountId>) {
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        self.settle_due();
        self.internal_reveal(round.0, slot.unwrap_or(0), &who, &side, &salt, true);
    }

    /// Reveal many bets in one call, as many as the attached gas allows. Bets that cannot be
    /// revealed (already revealed, wrong secret, window closed) are skipped, not fatal.
    /// Returns how many items were processed, so the caller can continue from there.
    pub fn reveal_many(&mut self, items: Vec<RevealItem>) -> u32 {
        self.settle_due();
        let mut done = 0u32;
        for it in items.iter() {
            let left = env::prepaid_gas().as_gas().saturating_sub(env::used_gas().as_gas());
            if left < REVEAL_GAS_MARGIN {
                break;
            }
            self.internal_reveal(it.round.0, it.slot, &it.account_id, &it.side, &it.salt, false);
            done += 1;
        }
        done
    }

    fn internal_reveal(&mut self, r: u64, slot: u32, who: &AccountId, side: &str, salt: &str, strict: bool) -> bool {
        macro_rules! fail {
            ($msg:expr) => {{
                if strict {
                    env::panic_str($msg)
                }
                return false;
            }};
        }
        let now = env::block_timestamp();
        if now < self.round_reveal_start(r) {
            fail!("reveal window has not opened yet");
        }
        if now >= self.round_reveal_end(r) {
            fail!("reveal window is closed");
        }
        if salt.len() < 16 || salt.len() > 128 {
            fail!("salt must be 16..128 characters");
        }
        let s = match side {
            "A" => SIDE_A,
            "B" => SIDE_B,
            _ => fail!("side must be \"A\" or \"B\""),
        };
        let key = (r, who.clone(), slot);
        match self.commits.get(&key) {
            None => fail!("no commit for this round"),
            Some(c) if c.side != SIDE_NONE => fail!("already revealed"),
            Some(c) => {
                let digest = env::sha256(commit_preimage(who, slot, r, side, salt).as_bytes());
                if digest.as_slice() != c.hash.as_slice() {
                    fail!("hash does not match side+salt");
                }
            }
        }
        // every earlier bet of this slot has finished revealing (reveal_ns <= commit_ns), so
        // this books all of them and leaves the streak exactly as it stands before round r
        self.internal_book(who, slot);
        let streak_before = self.slots.get(&(who.clone(), slot)).map(|x| x.streak).unwrap_or(0);
        let streak_if_win = streak_before + 1;
        let revealer = env::predecessor_account_id();
        let paid = self.balances.contains_key(&revealer);
        let c = self.commits.get_mut(&key).expect("checked above");
        let shares = shares_for(c.amount, streak_if_win, self.params.streak_min);
        let bounty = if paid { c.fee * (self.params.reveal_bounty_bps as u128) / BPS } else { 0 };
        c.side = s;
        c.sealed = None;
        c.shares = shares;
        c.streak_if_win = streak_if_win;
        c.bounty = bounty;
        let (amount, fee) = (c.amount, c.fee);
        if bounty > 0 {
            self.escrow -= bounty;
            *self.balances.get_mut(&revealer).expect("checked") += bounty;
            self.balances_total += bounty;
            self.bounties_paid += bounty;
        }
        let round = self.rounds.get_mut(&r).expect("round exists when a commit exists");
        if s == SIDE_A {
            round.revealed_a += amount;
            round.reveals_a += 1;
            round.shares_a += shares;
        } else {
            round.revealed_b += amount;
            round.reveals_b += 1;
            round.shares_b += shares;
        }
        round.revealed_fees += fee;
        round.bounties += bounty;
        if shares > 0 {
            let mut m = miners_read(r, s).unwrap_or_default();
            // a new account (past the listed ones, each unlisted bet counts as one)
            if !m.list.iter().any(|x| &x.0 == who) {
                m.players += 1;
            }
            m.bets += 1;
            m.shares += shares;
            if m.list.len() < MINERS_LISTED {
                m.list.push((who.clone(), slot, streak_if_win, shares));
            }
            env::storage_write(&miners_key(r, s), &near_sdk::borsh::to_vec(&m).expect("miner list"));
        }
        emit(
            "reveal",
            json!({"account_id": who, "slot": slot, "round": U64(r), "side": side, "amount": U128(amount),
                   "streak_if_win": streak_if_win, "shares": U128(shares), "by": revealer, "bounty": U128(bounty)}),
        );
        true
    }

    /// Settle every finished round that is waiting, oldest first (at most SETTLE_PER_CALL).
    /// Anyone can call it; every commit and reveal calls it too.
    pub fn settle_due(&mut self) -> u32 {
        let now = env::block_timestamp();
        let mut n = 0u32;
        while let Some(&r) = self.unsettled.first() {
            if now < self.round_reveal_end(r) || n >= SETTLE_PER_CALL {
                break;
            }
            self.settle_one(r);
            self.unsettled.remove(0);
            n += 1;
        }
        n
    }

    /// Settle a finished round (and the waiting rounds before it, in order). Idempotent.
    pub fn settle(&mut self, round: U64) {
        self.internal_settle(round.0);
    }

    fn internal_settle(&mut self, r: u64) {
        require!(env::block_timestamp() >= self.round_reveal_end(r), "round is still open");
        if self.rounds.get(&r).map(|x| x.settled).unwrap_or(true) {
            return;
        }
        // rounds settle strictly in order: the pot carries over from one to the next
        let mut n = 0u32;
        while let Some(&q) = self.unsettled.first() {
            if q > r {
                break;
            }
            require!(n < SETTLE_CATCH_UP, "too many rounds waiting to settle: call settle_due first");
            self.settle_one(q);
            self.unsettled.remove(0);
            n += 1;
        }
        self.settle_one(r);
    }

    fn settle_one(&mut self, r: u64) {
        let Some(round) = self.rounds.get_mut(&r) else { return };
        if round.settled {
            return;
        }
        let (a, b) = (round.revealed_a, round.revealed_b);
        let (outcome, obligations, win_shares) = if a == 0 || b == 0 || a == b {
            // void: revealed bets get their stake and fee back, minus the reveal rewards paid
            (OUTCOME_VOID, a + b + round.revealed_fees - round.bounties, 0)
        } else if a < b {
            (SIDE_A, 2 * a, round.shares_a)
        } else {
            (SIDE_B, 2 * b, round.shares_b)
        };
        // escrow for the round = stakes + fees - reveal rewards >= obligations
        let to_treasury = round.committed + round.fees - round.bounties - obligations;
        let emission = self.params.reward_per_round.0.min(self.params.max_supply.0 - self.issued);
        self.issued += emission;
        self.pot += emission;
        round.settled = true;
        round.outcome = outcome;
        round.to_treasury = to_treasury;
        round.emission = emission;
        if win_shares > 0 && self.pot > 0 {
            // mined now: it joins the unrefined total right away (and collects refining fees
            // from here on), whenever each winner books its share
            round.reward = self.pot;
            round.reward_shares = win_shares;
            round.reward_index = self.refine_index;
            self.mined += self.pot;
            self.unrefined_total += self.pot;
            self.pot = 0;
        }
        let (reward, committed) = (round.reward, round.committed);
        for side in [SIDE_A, SIDE_B] {
            if !(reward > 0 && side == outcome) {
                env::storage_remove(&miners_key(r, side));
            }
        }
        self.escrow -= to_treasury;
        self.treasury += to_treasury;
        self.treasury_in += to_treasury;
        self.rounds_settled += 1;
        if reward > self.biggest_reward {
            self.biggest_reward = reward;
            self.biggest_reward_round = Some(r);
        }
        emit(
            "settle",
            json!({"round": U64(r), "outcome": side_str(outcome), "revealed_a": U128(a), "revealed_b": U128(b),
                   "committed": U128(committed), "to_treasury": U128(to_treasury), "emission": U128(emission),
                   "reward": U128(reward), "pot": U128(self.pot)}),
        );
    }

    /// Book the finished bets of `account_id`'s slot `slot` (default: caller, slot 0): NEAR
    /// payouts and the bets' storage go to the game balance, mined BEFEWER to its unrefined
    /// balance (with the refined BEFEWER it collected since it was mined). Anyone can call it
    /// for anyone: everything only ever goes to that account. Returns the number of bets booked.
    pub fn claim(&mut self, account_id: Option<AccountId>, slot: Option<u32>) -> u32 {
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        self.settle_due();
        self.internal_book(&who, slot.unwrap_or(0))
    }

    fn internal_book(&mut self, who: &AccountId, slot: u32) -> u32 {
        let Some(mut s) = self.slots.get(&(who.clone(), slot)).cloned() else { return 0 };
        let mut p = self.players.get(who).cloned().unwrap_or_default();
        let now = env::block_timestamp();
        let mut done = 0u32;
        while let Some(&r) = s.open_rounds.first() {
            if now < self.round_reveal_end(r) {
                break; // rounds are ascending: nothing later is finished either
            }
            self.internal_settle(r);
            let c = self.commits.remove(&(r, who.clone(), slot)).expect("open round has a commit");
            let round = self.rounds.get(&r).cloned().expect("open round exists");
            let mut mined = 0u128;
            let (result, payout) = if c.side == SIDE_NONE {
                s.forfeits += 1;
                s.streak = 0;
                ("forfeit", 0)
            } else if round.outcome == OUTCOME_VOID {
                s.voids += 1;
                let share = void_record_share(&round, c.amount);
                self.storage_fees += share; // kept to pay for the round's record
                self.escrow -= share;
                ("void", c.amount + c.fee - c.bounty - share)
            } else if c.side == round.outcome {
                s.wins += 1;
                s.streak += 1;
                s.best_streak = s.best_streak.max(s.streak);
                if c.shares > 0 && round.reward > 0 {
                    mined = mul_div(round.reward, c.shares, round.reward_shares);
                }
                ("win", 2 * c.amount)
            } else {
                s.losses += 1;
                s.streak = 0;
                ("loss", 0)
            };
            self.escrow -= payout;
            self.storage_held -= c.storage;
            *self.balances.entry(who.clone()).or_insert(0) += payout + c.storage;
            self.balances_total += payout + c.storage;
            if mined > 0 {
                // already in unrefined_total since the round settled: book it to the account,
                // with the refined BEFEWER its share collected since then
                self.checkpoint(&mut p);
                p.unrefined += mined;
                let since = self.refine_index - round.reward_index;
                if since > 0 {
                    p.refined += (U256::from(mined) * U256::from(since) / U256::from(REFINE_SCALE)).as_u128();
                }
                p.mined += mined;
            }
            if s.streak > self.best_streak {
                self.best_streak = s.streak;
                self.best_streak_holder = Some(who.clone());
            }
            let rr = self.rounds.get_mut(&r).expect("exists");
            rr.claims += 1;
            rr.reward_booked += mined;
            if rr.claims == rr.commits {
                // everyone booked: the rounding remainder of the split goes back to the pot
                let dust = rr.reward - rr.reward_booked;
                if dust > 0 {
                    rr.reward_booked = rr.reward;
                    self.unrefined_total -= dust;
                    self.pot += dust;
                    self.dust_to_pot += dust;
                }
                self.round_players.remove(&r);
            }
            emit(
                "claim",
                json!({"account_id": who, "slot": slot, "round": U64(r), "result": result, "payout": U128(payout),
                       "storage": U128(c.storage), "mined": U128(mined), "streak": s.streak}),
            );
            s.open_rounds.remove(0);
            done += 1;
        }
        self.slots.insert((who.clone(), slot), s);
        if self.players.contains_key(who) || done > 0 {
            self.players.insert(who.clone(), p);
        }
        done
    }

    // ---------- refining ----------

    /// Book the account's share of refining fees charged since its last checkpoint.
    fn checkpoint(&self, p: &mut Player) {
        if p.unrefined > 0 && self.refine_index > p.refine_index {
            let gain = U256::from(p.unrefined) * U256::from(self.refine_index - p.refine_index) / U256::from(REFINE_SCALE);
            p.refined += gain.as_u128();
        }
        p.refine_index = self.refine_index;
    }

    /// Refined BEFEWER an account could claim right now from its booked unrefined balance.
    fn refined_now(&self, p: &Player) -> u128 {
        let mut q = p.clone();
        self.checkpoint(&mut q);
        q.refined
    }

    /// Claim the caller's mined BEFEWER to its wallet: `bps` (default 10000 = all) of the
    /// unrefined balance minus the refining fee, plus all refined BEFEWER (no fee). The fee is
    /// shared pro rata among the OTHER holders of unrefined BEFEWER (never the caller, for what
    /// it keeps); if they hold less than 1 BEFEWER, it goes back to the mining pot. `book` lists
    /// slots to book first (default: slot 0). Returns the amount minted.
    pub fn claim_befewer(&mut self, bps: Option<u16>, book: Option<Vec<u32>>) -> U128 {
        let who = env::predecessor_account_id();
        self.settle_due();
        for s in book.unwrap_or_else(|| vec![0]) {
            self.internal_book(&who, s);
        }
        let mut p = self.players.get(&who).cloned().unwrap_or_default();
        let bps = bps.unwrap_or(10_000) as u128;
        require!(bps >= 1 && bps <= 10_000, "bps must be 1..10000");
        require!(self.token.accounts.get(&who).is_some(), "register for BEFEWER first (storage_deposit)");
        self.checkpoint(&mut p);
        let take = p.unrefined * bps / BPS;
        let fee = take * (self.params.refine_fee_bps as u128) / BPS;
        let out = take - fee + p.refined;
        require!(out > 0, "nothing to claim");
        let refined_paid = p.refined;
        p.unrefined -= take;
        p.refined = 0;
        self.unrefined_total -= take;
        if fee > 0 {
            self.refine_fees += fee;
            // the claimant's own remaining unrefined BEFEWER does not share its fee
            let others = self.unrefined_total - p.unrefined;
            let index = if others >= REFINE_MIN_OTHERS {
                let step = U256::from(fee) * U256::from(REFINE_SCALE) / U256::from(others);
                if step > U256::from(u128::MAX) { None } else { self.refine_index.checked_add(step.as_u128()) }
            } else {
                None
            };
            match index {
                Some(ix) => {
                    self.refine_index = ix;
                    p.refine_index = ix; // the claimant moves past its own fee
                }
                None => {
                    self.pot += fee;
                    self.refine_to_pot += fee;
                }
            }
        }
        self.players.insert(who.clone(), p);
        self.token.internal_deposit(&who, out);
        self.claimed += out;
        FtMint { owner_id: &who, amount: U128(out), memo: Some("claimed mined BEFEWER") }.emit();
        emit(
            "claim_befewer",
            json!({"account_id": who, "unrefined": U128(take), "fee": U128(fee), "refined": U128(refined_paid), "minted": U128(out)}),
        );
        U128(out)
    }

    // ---------- the DEX: graduation and buybacks ----------

    /// Advance the pool opening by one step. Anyone can call it (keepers do); each step is one
    /// cross-contract call whose callback moves to the next step, or stays for a retry if the
    /// call failed. Step 0 needs the spendable treasury to reach `graduate_at`.
    pub fn graduate(&mut self) -> Promise {
        require!(self.dex.step < STEP_DONE, "the pool is already open");
        require!(!self.dex.busy, "a graduation step is in flight");
        let me = env::current_account_id();
        let (dex, wnear) = (self.params.dex.clone(), self.params.wnear.clone());
        let p = match self.dex.step {
            STEP_START => {
                let take = self.spendable();
                require!(
                    take >= self.params.graduate_at.0,
                    format!("the treasury needs {} yoctoNEAR spendable to open the pool (has {})", self.params.graduate_at.0, take)
                );
                self.treasury -= take;
                self.dex.near_amount = take - GRADUATION_COST;
                Promise::new(wnear)
                    .function_call(
                        "storage_deposit",
                        json!({"account_id": me, "registration_only": true}).to_string().into_bytes(),
                        NearToken::from_yoctonear(WNEAR_STORAGE),
                        tgas(10),
                    )
                    .function_call(
                        "near_deposit",
                        b"{}".to_vec(),
                        NearToken::from_yoctonear(self.dex.near_amount),
                        tgas(10),
                    )
            }
            STEP_REGISTER => {
                if self.token.accounts.get(&dex).is_none() {
                    self.token.internal_register_account(&dex);
                }
                Promise::new(dex)
                    .function_call(
                        "storage_deposit",
                        json!({"account_id": me, "registration_only": false}).to_string().into_bytes(),
                        NearToken::from_yoctonear(DEX_STORAGE),
                        tgas(10),
                    )
                    .function_call(
                        "register_tokens",
                        json!({"token_ids": [wnear, me]}).to_string().into_bytes(),
                        ONE_YOCTO,
                        tgas(10),
                    )
            }
            STEP_SEND_NEAR => Promise::new(wnear).function_call(
                "ft_transfer_call",
                json!({"receiver_id": dex, "amount": U128(self.dex.near_amount), "msg": ""}).to_string().into_bytes(),
                ONE_YOCTO,
                tgas(60),
            ),
            STEP_SEND_TOKEN => {
                if !self.dex.seed_minted {
                    let seed = self.mined.max(TOKEN).min(self.params.max_supply.0 - self.issued);
                    require!(seed > 0, "no BEFEWER left to seed the pool");
                    self.issued += seed;
                    self.dex.seed = seed;
                    self.dex.seed_minted = true;
                    self.token.internal_deposit(&me, seed);
                    FtMint { owner_id: &me, amount: U128(seed), memo: Some("pool seed") }.emit();
                }
                let seed = self.dex.seed;
                // ft_transfer_call from ourselves: move the tokens, then let the DEX book the deposit.
                self.token.internal_transfer(&me, &dex, seed, Some("pool seed".into()));
                Promise::new(dex.clone())
                    .function_call(
                        "ft_on_transfer",
                        json!({"sender_id": me, "amount": U128(seed), "msg": ""}).to_string().into_bytes(),
                        NearToken::from_yoctonear(0),
                        tgas(30),
                    )
                    .then(Self::ext(me.clone()).with_static_gas(tgas(10)).ft_resolve_transfer(me.clone(), dex, U128(seed)))
            }
            // The pool is created and filled in ONE receipt (on_pool_count), so nobody can add
            // liquidity to an empty pool in between and set its price. First learn its id.
            STEP_ADD_LIQUIDITY => {
                self.dex.busy = true;
                emit("graduate_step", json!({"step": self.dex.step}));
                return Promise::new(dex)
                    .function_call("get_number_of_pools", b"{}".to_vec(), NearToken::from_yoctonear(0), tgas(5))
                    .then(Self::ext(me).with_static_gas(tgas(90)).on_pool_count());
            }
            _ => env::panic_str("unknown graduation step"),
        };
        self.dex.busy = true;
        emit("graduate_step", json!({"step": self.dex.step}));
        p.then(Self::ext(me).with_static_gas(tgas(15)).on_graduate(self.dex.step, None))
    }

    /// Graduation step 4, second half: one receipt to the DEX that creates the pool (it gets id
    /// `count`) and adds all the liquidity to pool `count` with min_amounts = amounts. If anyone
    /// created a pool in between, `count` is not ours, add_liquidity fails and the whole receipt
    /// reverts (the pool creation too): the step is simply retried.
    #[private]
    pub fn on_pool_count(&mut self) -> PromiseOrValue<()> {
        let Some(pool_id) = promise_ok().and_then(|v| serde_json::from_slice::<u64>(&v).ok()) else {
            self.dex.busy = false;
            emit("graduate_result", json!({"step": STEP_ADD_LIQUIDITY, "ok": false, "now": self.dex.step}));
            return PromiseOrValue::Value(());
        };
        let me = env::current_account_id();
        let amounts = json!([U128(self.dex.near_amount), U128(self.dex.seed)]);
        PromiseOrValue::Promise(
            Promise::new(self.params.dex.clone())
                .function_call(
                    "add_simple_pool",
                    json!({"tokens": [self.params.wnear, me], "fee": self.params.pool_fee}).to_string().into_bytes(),
                    NearToken::from_yoctonear(DEX_POOL_STORAGE),
                    tgas(20),
                )
                .function_call(
                    "add_liquidity",
                    json!({"pool_id": pool_id, "amounts": amounts, "min_amounts": amounts}).to_string().into_bytes(),
                    NearToken::from_yoctonear(DEX_LP_STORAGE),
                    tgas(30),
                )
                .then(Self::ext(me).with_static_gas(tgas(15)).on_graduate(STEP_ADD_LIQUIDITY, Some(pool_id))),
        )
    }

    #[private]
    pub fn on_graduate(&mut self, step: u8, pool_id: Option<u64>) {
        self.dex.busy = false;
        let res = promise_ok();
        let ok = match step {
            STEP_START => {
                if res.is_none() {
                    // the NEAR came back as a refund: return it to the treasury
                    self.treasury += self.dex.near_amount + GRADUATION_COST;
                    self.dex.near_amount = 0;
                }
                res.is_some()
            }
            STEP_REGISTER => res.is_some(),
            // ft_transfer_call / ft_resolve_transfer return the amount the receiver kept
            STEP_SEND_NEAR => amount_of(res) == self.dex.near_amount,
            STEP_SEND_TOKEN => amount_of(res) == self.dex.seed,
            STEP_ADD_LIQUIDITY => match amount_opt(res) {
                Some(shares) if shares > 0 && pool_id.is_some() => {
                    self.dex.pool_id = pool_id;
                    self.dex.shares = shares;
                    self.dex.graduated_at_ns = env::block_timestamp();
                    true
                }
                _ => false,
            },
            _ => false,
        };
        if ok {
            self.dex.step = step + 1;
        }
        emit("graduate_result", json!({"step": step, "ok": ok, "now": self.dex.step}));
    }

    /// Buy BEFEWER from the pool with 1/365 of the treasury (see MIN_BUYBACK) and burn it on
    /// arrival. Anyone can call it once the pool is open, at most once per `buyback_every_ns`.
    /// The swap pays at most the price ceiling (see BUYBACK_CEILING_BPS); a refused swap keeps
    /// its NEAR as wNEAR for the next one.
    pub fn buyback(&mut self) -> Promise {
        require!(self.dex.step == STEP_DONE, "the pool is not open yet");
        require!(!self.dex.busy, "a buyback is in flight");
        let now = env::block_timestamp();
        require!(now >= self.dex.last_buyback_ns + self.params.buyback_every_ns.0, "too soon since the last buyback");
        let me = env::current_account_id();
        let (dex, wnear) = (self.params.dex.clone(), self.params.wnear.clone());
        let held = self.dex.held_wnear;
        let fresh = self.buyback_share().min(self.params.buyback_max.0.saturating_sub(held));
        let amount = held + fresh;
        require!(amount >= MIN_BUYBACK, format!("1/365 of the treasury is {} yoctoNEAR; buybacks wait until it reaches 0.1 NEAR", amount));
        let ceiling = self.buyback_ceiling();
        let min_out = if ceiling == 0 {
            1
        } else {
            let v = U256::from(amount) * U256::from(TOKEN) / U256::from(ceiling);
            if v > U256::from(u128::MAX) { u128::MAX } else { v.as_u128().max(1) }
        };
        self.treasury -= fresh;
        self.dex.held_wnear = 0;
        self.dex.busy = true;
        self.dex.last_buyback_ns = now;
        let msg = json!({"actions": [{"pool_id": self.dex.pool_id.expect("pool open"), "token_in": wnear,
                                      "token_out": me, "amount_in": U128(amount), "min_amount_out": U128(min_out)}]})
        .to_string();
        let mut p = Promise::new(wnear);
        if fresh > 0 {
            p = p.function_call("near_deposit", b"{}".to_vec(), NearToken::from_yoctonear(fresh), tgas(10));
        }
        p = p.function_call(
            "ft_transfer_call",
            json!({"receiver_id": dex, "amount": U128(amount), "msg": msg}).to_string().into_bytes(),
            ONE_YOCTO,
            tgas(80),
        );
        emit("buyback_start", json!({"amount": U128(amount), "from_treasury": U128(fresh), "from_held_wnear": U128(held)}));
        let mut log = buybacks_read();
        log.push((now, amount, 0, 0));
        if log.len() > BUYBACKS_KEPT {
            log.remove(0);
        }
        buybacks_write(&log);
        p.then(Self::ext(me).with_static_gas(tgas(15)).on_buyback(U128(held), U128(fresh)))
    }

    #[private]
    pub fn on_buyback(&mut self, held: U128, fresh: U128) {
        self.dex.busy = false;
        let res = promise_ok();
        let amount = held.0 + fresh.0;
        if res.is_none() {
            // The whole batch failed and reverted: near_deposit's NEAR came back as a refund
            // and the held wNEAR never left.
            self.treasury += fresh.0;
            self.dex.held_wnear += held.0;
            emit("buyback_result", json!({"ok": false, "spent": "0"}));
            return;
        }
        let spent = amount_of(res).min(amount);
        buybacks_update_last(|e| e.2 = spent);
        if spent > 0 {
            reprice_from_last();
        } else {
            // refused (most likely the price was above the ceiling): allow 25% more next time
            let c = self.buyback_ceiling();
            if c > 0 {
                let up = U256::from(c) * U256::from(BUYBACK_CEILING_BPS) / U256::from(BPS);
                ceiling_write(if up > U256::from(u128::MAX) { u128::MAX } else { up.as_u128() });
            }
        }
        // whatever the DEX did not take came back to us as wNEAR
        self.dex.held_wnear += amount - spent;
        self.dex.bought_near += spent;
        if spent > 0 {
            self.dex.buybacks += 1;
        }
        emit("buyback_result", json!({"ok": spent > 0, "spent": U128(spent)}));
    }

    /// BEFEWER that reaches this contract is burned on arrival.
    fn burn_arrival(&mut self, from: &AccountId, amount: u128) {
        let me = env::current_account_id();
        self.token.internal_withdraw(&me, amount);
        self.total_burned += amount;
        let from_pool = *from == self.params.dex;
        if from_pool {
            self.dex.bought_burned += amount;
            buybacks_update_last(|e| e.3 += amount);
            reprice_from_last();
        }
        let memo = if from_pool { "bought back from the pool" } else { "sent to the contract" };
        FtBurn { owner_id: &me, amount: U128(amount), memo: Some(memo) }.emit();
    }

    // ---------- views ----------

    pub fn get_params(&self) -> Params {
        self.params.clone()
    }

    pub fn get_status(&self) -> StatusView {
        let now = env::block_timestamp();
        let started = now >= self.params.genesis_ns.0;
        let cr = if started { self.commit_round_at(now) } else { 0 };
        let reveal_round = if started && cr > 0 && now < self.round_reveal_end(cr - 1) { Some(cr - 1) } else { None };
        let d = &self.dex;
        let stage = match d.step {
            STEP_START => "waiting",
            STEP_REGISTER => "registering",
            STEP_SEND_NEAR => "sending NEAR",
            STEP_SEND_TOKEN => "sending BEFEWER",
            STEP_ADD_LIQUIDITY => "adding liquidity",
            _ => "open",
        };
        StatusView {
            now: U64(now),
            commit_round: U64(cr),
            commit_ends_at: U64(self.round_reveal_start(cr)),
            reveal_round: reveal_round.map(U64),
            reveal_ends_at: reveal_round.map(|r| U64(self.round_reveal_end(r))),
            treasury: U128(self.treasury),
            treasury_spendable: U128(self.spendable()),
            treasury_in: U128(self.treasury_in),
            graduate_at: self.params.graduate_at,
            balances_total: U128(self.balances_total),
            escrow: U128(self.escrow),
            storage_held: U128(self.storage_held),
            storage_fees: U128(self.storage_fees),
            bounties_paid: U128(self.bounties_paid),
            reveal_bounty_bps: self.params.reveal_bounty_bps,
            unsettled: self.unsettled.len() as u32,
            total_supply: U128(self.token.total_supply),
            max_supply: self.params.max_supply,
            issued: U128(self.issued),
            mined: U128(self.mined),
            unrefined_total: U128(self.unrefined_total),
            refine_fee_bps: self.params.refine_fee_bps,
            refine_fees: U128(self.refine_fees),
            refine_to_pot: U128(self.refine_to_pot),
            dust_to_pot: U128(self.dust_to_pot),
            claimed: U128(self.claimed),
            pot: U128(self.pot),
            total_burned: U128(self.total_burned),
            rounds_settled: U64(self.rounds_settled),
            best_streak: self.best_streak,
            best_streak_holder: self.best_streak_holder.clone(),
            biggest_reward: U128(self.biggest_reward),
            biggest_reward_round: self.biggest_reward_round.map(U64),
            dex: DexView {
                stage: stage.into(),
                step: d.step,
                busy: d.busy,
                dex: self.params.dex.clone(),
                wnear: self.params.wnear.clone(),
                pool_id: d.pool_id,
                near_amount: U128(d.near_amount),
                seed: U128(d.seed),
                shares: U128(d.shares),
                graduated_at: U64(d.graduated_at_ns),
                held_wnear: U128(d.held_wnear),
                next_buyback_at: U64(if d.step == STEP_DONE { d.last_buyback_ns + self.params.buyback_every_ns.0 } else { 0 }),
                buyback_now: U128(if d.step == STEP_DONE {
                    d.held_wnear + self.buyback_share().min(self.params.buyback_max.0.saturating_sub(d.held_wnear))
                } else {
                    0
                }),
                buyback_ceiling: U128(if d.step == STEP_DONE { self.buyback_ceiling() } else { 0 }),
                buybacks: d.buybacks,
                bought_near: U128(d.bought_near),
                bought_burned: U128(d.bought_burned),
            },
        }
    }

    pub fn get_round(&self, round: U64) -> RoundView {
        let r = round.0;
        let x = self.rounds.get(&r).cloned().unwrap_or_default();
        let m = self.round_miners(r, &x);
        RoundView {
            round,
            commit_starts_at: U64(self.round_commit_start(r)),
            reveal_starts_at: U64(self.round_reveal_start(r)),
            reveal_ends_at: U64(self.round_reveal_end(r)),
            committed: U128(x.committed),
            fees: U128(x.fees),
            bounties: U128(x.bounties),
            revealed_a: U128(x.revealed_a),
            revealed_b: U128(x.revealed_b),
            shares_a: U128(x.shares_a),
            shares_b: U128(x.shares_b),
            commits: x.commits,
            reveals_a: x.reveals_a,
            reveals_b: x.reveals_b,
            claims: x.claims,
            settled: x.settled,
            outcome: if x.settled { side_str(x.outcome) } else { None },
            to_treasury: U128(x.to_treasury),
            emission: U128(x.emission),
            reward: U128(x.reward),
            reward_shares: U128(x.reward_shares),
            reward_booked: U128(x.reward_booked),
            miners: m.as_ref().map(|m| m.bets).unwrap_or(0),
            mining_players: m.as_ref().map(|m| m.players).unwrap_or(0),
        }
    }

    /// The last buybacks (at most BUYBACKS_KEPT), newest first. Buybacks made before this list
    /// existed (Nov 7) are only in the totals of `get_status().dex`.
    pub fn get_buybacks(&self) -> Vec<BuybackView> {
        buybacks_read()
            .into_iter()
            .rev()
            .map(|(at, near_in, spent, burned)| BuybackView { at: U64(at), near_in: U128(near_in), spent: U128(spent), burned: U128(burned) })
            .collect()
    }

    /// The bets that mined in a settled round (at most MINERS_LISTED, in reveal order) and what
    /// each one mined. Empty if the round mined nothing or was played before this was recorded.
    pub fn get_round_miners(&self, round: U64) -> Vec<MinerView> {
        let Some(x) = self.rounds.get(&round.0) else { return vec![] };
        let Some(m) = self.round_miners(round.0, x) else { return vec![] };
        m.list
            .into_iter()
            .map(|(account_id, slot, streak, shares)| MinerView {
                account_id,
                slot,
                streak,
                shares: U128(shares),
                mined: U128(mul_div(x.reward, shares, x.reward_shares)),
            })
            .collect()
    }

    /// The winners' list of a round that mined, if it is complete.
    fn round_miners(&self, r: u64, x: &Round) -> Option<MinerList> {
        if !x.settled || x.reward == 0 {
            return None;
        }
        miners_read(r, x.outcome).filter(|m| m.shares == x.reward_shares)
    }

    /// Rounds `from`, `from-1`, ... (newest first), skipping rounds nobody played.
    pub fn get_rounds(&self, from: U64, limit: u32) -> Vec<RoundView> {
        let mut out = vec![];
        let mut r = from.0 as i128;
        let mut scanned = 0;
        while r >= 0 && out.len() < limit.min(50) as usize && scanned < 500 {
            if self.rounds.contains_key(&(r as u64)) {
                out.push(self.get_round(U64(r as u64)));
            }
            r -= 1;
            scanned += 1;
        }
        out
    }

    /// Commits of a round in commit order, for keepers: who, how much, revealed side (if
    /// any) and the timelock ciphertext (only while unrevealed). Empty once fully claimed.
    pub fn get_round_commits(&self, round: U64, from_index: u32, limit: u32) -> Vec<RoundCommitView> {
        let Some(list) = self.round_players.get(&round.0) else { return vec![] };
        list.iter()
            .skip(from_index as usize)
            .take(limit.min(100) as usize)
            .filter_map(|(a, s)| {
                self.commits.get(&(round.0, a.clone(), *s)).map(|c| RoundCommitView {
                    account_id: a.clone(),
                    slot: *s,
                    amount: U128(c.amount),
                    side: side_str(c.side),
                    hash: c.hash.iter().map(|b| format!("{:02x}", b)).collect(),
                    sealed: c.sealed.clone(),
                })
            })
            .collect()
    }

    /// A bet as the views show it, with its result once the round is settled.
    fn commit_view(&self, who: &AccountId, slot: u32, r: u64) -> Option<(OpenCommitView, u128)> {
        let c = self.commits.get(&(r, who.clone(), slot))?;
        let round = self.rounds.get(&r);
        let (mut result, mut payout, mut mined, mut since) = (None, 0u128, 0u128, 0u128);
        if let Some(x) = round.filter(|x| x.settled) {
            let (res, pay) = if c.side == SIDE_NONE {
                ("forfeit", 0)
            } else if x.outcome == OUTCOME_VOID {
                ("void", c.amount + c.fee - c.bounty - void_record_share(x, c.amount))
            } else if c.side == x.outcome {
                ("win", 2 * c.amount)
            } else {
                ("loss", 0)
            };
            if res == "win" && c.shares > 0 && x.reward > 0 {
                mined = mul_div(x.reward, c.shares, x.reward_shares);
                since = self.refine_index - x.reward_index;
            }
            result = Some(res.to_string());
            payout = pay + c.storage;
        }
        let refined = if mined > 0 && since > 0 { (U256::from(mined) * U256::from(since) / U256::from(REFINE_SCALE)).as_u128() } else { 0 };
        Some((
            OpenCommitView {
                round: U64(r),
                amount: U128(c.amount),
                fee: U128(c.fee),
                bounty: U128(c.bounty),
                storage: U128(c.storage),
                side: side_str(c.side),
                streak_if_win: c.streak_if_win,
                shares: U128(c.shares),
                result,
                payout: U128(payout),
                mined: U128(mined),
            },
            refined,
        ))
    }

    fn slot_view(&self, who: &AccountId, slot: u32) -> Option<(SlotView, u128, u128, u128)> {
        let s = self.slots.get(&(who.clone(), slot))?;
        let (mut near, mut mined, mut refined) = (0u128, 0u128, 0u128);
        let open = s
            .open_rounds
            .iter()
            .filter_map(|r| self.commit_view(who, slot, *r))
            .map(|(o, rf)| {
                near += o.payout.0;
                mined += o.mined.0;
                refined += rf;
                o
            })
            .collect();
        Some((
            SlotView { slot, streak: s.streak, best_streak: s.best_streak, wins: s.wins, losses: s.losses, voids: s.voids, forfeits: s.forfeits, open },
            near,
            mined,
            refined,
        ))
    }

    /// Slots `from`.. of an account (up to `limit`, at most 50), skipping closed ones.
    pub fn get_slots(&self, account_id: AccountId, from: u32, limit: u32) -> Vec<SlotView> {
        let n = self.players.get(&account_id).map(|p| p.slots).unwrap_or(0);
        (from..n).filter_map(|i| self.slot_view(&account_id, i).map(|x| x.0)).take(limit.min(50) as usize).collect()
    }

    pub fn get_player(&self, account_id: AccountId) -> PlayerView {
        let p = self.players.get(&account_id).cloned().unwrap_or_default();
        let (mut near, mut mined, mut refined) = (0u128, 0u128, 0u128);
        let mut slots = vec![];
        for i in 0..p.slots {
            if slots.len() >= 32 {
                break;
            }
            if let Some((v, n, m, rf)) = self.slot_view(&account_id, i) {
                near += n;
                mined += m;
                refined += rf;
                slots.push(v);
            }
        }
        let main = slots.iter().find(|s| s.slot == 0);
        let (streak, best_streak, wins, losses, voids, forfeits) =
            main.map(|s| (s.streak, s.best_streak, s.wins, s.losses, s.voids, s.forfeits)).unwrap_or_default();
        let open = self.slot_view(&account_id, 0).map(|x| x.0.open).unwrap_or_default();
        PlayerView {
            balance: U128(self.balances.get(&account_id).copied().unwrap_or(0)),
            tokens: U128(self.token.accounts.get(&account_id).unwrap_or(0)),
            registered: self.balances.contains_key(&account_id),
            streak,
            best_streak,
            wins,
            losses,
            voids,
            forfeits,
            open,
            slot_count: p.slots,
            slots,
            pending_near: U128(near),
            pending_mined: U128(mined),
            mined: U128(p.mined),
            unrefined: U128(p.unrefined + mined),
            refined: U128(self.refined_now(&p) + refined),
            account_id,
        }
    }
}

/// Amount reported by ft_transfer_call / ft_resolve_transfer / add_liquidity (0 if failed).
fn amount_of(res: Option<Vec<u8>>) -> u128 {
    amount_opt(res).unwrap_or(0)
}
fn amount_opt(res: Option<Vec<u8>>) -> Option<u128> {
    res.and_then(|v| serde_json::from_slice::<U128>(&v).ok()).map(|x| x.0)
}

// ---------- NEP-141 / NEP-145 / NEP-148 plumbing ----------

#[near]
impl FungibleTokenCore for Contract {
    /// Standard transfer; BEFEWER sent to this contract itself is burned.
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        let to_me = receiver_id == env::current_account_id();
        let from = env::predecessor_account_id();
        self.token.ft_transfer(receiver_id, amount, memo);
        if to_me {
            self.burn_arrival(&from, amount.0);
        }
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            self.total_burned += burned;
        }
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        if let Some((_, balance)) = self.token.internal_storage_unregister(force) {
            self.total_burned += balance;
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests;
