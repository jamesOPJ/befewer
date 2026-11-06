//! BEFEWER v4: a minority game played with NEAR that mines a capped NEP-141 token.
//!
//! Every round, players commit a hidden bet of NEAR on side A or B (commit-reveal, with an
//! optional drand timelock so a keeper can reveal for them). After the reveal window the side
//! with LESS revealed stake wins:
//!   * winners get exactly 2x their stake back (the bet fee is not refunded),
//!   * losers lose their stake,
//!   * every bet pays a fee on top of its stake (`fee_bps`),
//!   * fees, the imbalance |A - B| and unrevealed stakes go to the treasury,
//!   * a tie or an empty side voids the round: revealed stakes AND fees are refunded.
//!
//! Mining: each settled round adds `reward_per_round` BEFEWER to a pot. A win that makes a
//! streak of `streak_min` or more wins in a row earns shares in the pot: a streak of
//! `streak_min` is 1 share per milli-NEAR staked, `streak_min + 1` is 2 shares, and so on. The
//! pot is split among that round's winners by shares; if nobody qualifies it rolls over.
//! Nothing else ever mints BEFEWER and issuance stops at `max_supply`.
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

/// Max number of rounds an account can have committed-but-unclaimed at once.
pub const MAX_OPEN_ROUNDS: usize = 8;
const BPS: u128 = 10_000;
pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// One BEFEWER (18 decimals).
pub const TOKEN: u128 = 1_000_000_000_000_000_000;
/// Charged once, on an account's first deposit: pays for its game record and token registration.
pub const STORAGE_FEE: u128 = NEAR / 100;
/// NEAR the treasury never spends, on top of what the contract owes players and its storage.
pub const SAFETY_RESERVE: u128 = NEAR;
/// Smallest buyback worth sending.
pub const MIN_BUYBACK: u128 = NEAR / 100;
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

const fn tgas(n: u64) -> Gas {
    Gas::from_tgas(n)
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
}

#[near(serializers = [borsh])]
#[derive(Default, Clone)]
pub struct Round {
    /// Sum of stakes committed (fees excluded).
    pub committed: u128,
    /// Sum of fees paid by commits.
    pub fees: u128,
    pub revealed_a: u128,
    pub revealed_b: u128,
    /// Fees of revealed commits (refunded if the round is void).
    pub revealed_fees: u128,
    /// Mining shares of revealed commits on each side.
    pub shares_a: u128,
    pub shares_b: u128,
    pub commits: u32,
    pub reveals_a: u32,
    pub reveals_b: u32,
    pub claims: u32,
    pub settled: bool,
    /// SIDE_A / SIDE_B (winning side) or OUTCOME_VOID. SIDE_NONE until settled.
    pub outcome: u8,
    /// NEAR this round sent to the treasury (fees + imbalance + unrevealed).
    pub to_treasury: u128,
    /// BEFEWER added to the pot when this round settled.
    pub emission: u128,
    /// BEFEWER (the whole pot) this round's winners split, by shares. 0 if nobody qualified.
    pub reward: u128,
    /// Shares on the winning side (the denominator of the split).
    pub reward_shares: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Commit {
    pub hash: [u8; 32],
    pub amount: u128,
    pub fee: u128,
    pub side: u8,
    /// Mining shares this commit earns if it wins (fixed at reveal from the streak so far).
    pub shares: u128,
    /// Streak this commit completes if it wins (0 until revealed).
    pub streak_if_win: u32,
    /// Optional drand timelock ciphertext of "<A|B>:<salt>", sealed to the drand round at
    /// this round's reveal start. Lets anyone reveal for the player once drand publishes
    /// that round. Dropped on reveal to free storage.
    pub sealed: Option<String>,
}

/// Longest accepted `sealed` ciphertext (tlock armored output is ~580 bytes).
pub const MAX_SEALED_LEN: usize = 1024;

#[near(serializers = [borsh])]
#[derive(Default, Clone)]
pub struct Player {
    pub streak: u32,
    pub best_streak: u32,
    pub wins: u32,
    pub losses: u32,
    pub voids: u32,
    pub forfeits: u32,
    /// BEFEWER this account has mined.
    pub mined: u128,
    /// Rounds with a commit that has not been claimed yet, ascending.
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
    /// Game balances in NEAR (yocto), credited by `deposit` and payouts.
    balances: LookupMap<AccountId, u128>,
    /// Sum of `balances`.
    balances_total: u128,
    /// NEAR (stakes + fees) held for unclaimed commits and payouts.
    escrow: u128,
    /// NEAR owned by the game, not yet spent on the pool or buybacks.
    treasury: u128,
    /// All NEAR that ever reached the treasury (rounds + donations).
    treasury_in: u128,
    storage_fees: u128,
    rounds: LookupMap<u64, Round>,
    commits: LookupMap<(u64, AccountId), Commit>,
    /// Accounts that committed in a round, so keepers can enumerate commits to reveal.
    /// Removed once every commit of the round is claimed.
    round_players: LookupMap<u64, Vec<AccountId>>,
    players: LookupMap<AccountId, Player>,
    // ---- mining ----
    /// BEFEWER waiting for the next round with qualifying winners.
    pot: u128,
    /// BEFEWER issued so far: pot + round rewards + the pool seed. Never above max_supply.
    issued: u128,
    /// BEFEWER minted to miners.
    mined: u128,
    total_burned: u128,
    rounds_settled: u64,
    best_streak: u32,
    best_streak_holder: Option<AccountId>,
    biggest_reward: u128,
    biggest_reward_round: Option<u64>,
    dex: Dex,
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
    /// One-time 0.01 NEAR fees paid by first deposits (kept for storage, never spent).
    pub storage_fees: U128,
    pub total_supply: U128,
    pub max_supply: U128,
    pub issued: U128,
    pub mined: U128,
    pub pot: U128,
    pub total_burned: U128,
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
    /// "A", "B", or null if not revealed yet.
    pub side: Option<String>,
    /// Streak this bet completes if it wins (known once revealed; 0 before).
    pub streak_if_win: u32,
    pub shares: U128,
}

#[near(serializers = [json])]
pub struct RoundCommitView {
    pub account_id: AccountId,
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
    pub streak: u32,
    pub best_streak: u32,
    pub wins: u32,
    pub losses: u32,
    pub voids: u32,
    pub forfeits: u32,
    pub mined: U128,
    pub open: Vec<OpenCommitView>,
}

fn side_str(side: u8) -> Option<String> {
    match side {
        SIDE_A => Some("A".into()),
        SIDE_B => Some("B".into()),
        OUTCOME_VOID => Some("void".into()),
        _ => None,
    }
}

fn parse_side(side: &str) -> u8 {
    match side {
        "A" => SIDE_A,
        "B" => SIDE_B,
        _ => env::panic_str("side must be \"A\" or \"B\""),
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

/// The exact preimage clients must hash: `fewer:<account>:<round>:<A|B>:<salt>`.
pub fn commit_preimage(account_id: &AccountId, round: u64, side: &str, salt: &str) -> String {
    format!("fewer:{}:{}:{}:{}", account_id, round, side, salt)
}

/// floor(a * b / c) for b <= c, without overflowing as long as (c - 1) * b fits in u128.
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
            treasury: 0,
            treasury_in: 0,
            storage_fees: 0,
            rounds: LookupMap::new(StorageKey::Rounds),
            commits: LookupMap::new(StorageKey::Commits),
            round_players: LookupMap::new(StorageKey::RoundPlayers),
            players: LookupMap::new(StorageKey::Players),
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
    /// deposit of an account pays a one-time 0.01 NEAR storage fee and registers it for BEFEWER.
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
    pub fn withdraw(&mut self, amount: Option<U128>) -> Promise {
        let who = env::predecessor_account_id();
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

    /// Treasury NEAR that can leave the contract without touching player funds, escrow,
    /// storage, or the safety reserve.
    fn spendable(&self) -> u128 {
        let balance = env::account_balance().as_yoctonear();
        let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        let owed = self.balances_total + self.escrow + storage + SAFETY_RESERVE;
        self.treasury.min(balance.saturating_sub(owed))
    }

    // ---------- the game ----------

    /// Lock `amount` of the caller's game NEAR (plus the fee) into the round currently taking
    /// commits, hidden behind `hash = sha256("fewer:<account>:<round>:<A|B>:<salt>")` (hex).
    /// `sealed` (optional) is the drand timelock ciphertext of "<A|B>:<salt>" so that a keeper
    /// can reveal for the player; without it the player must reveal manually.
    /// No attached deposit, so the app's function-call key can sign it without a popup.
    /// `round` must be the round currently taking commits: a commit that lands after the
    /// window closed is refused instead of silently moving to the next round.
    pub fn commit(&mut self, round: U64, amount: U128, hash: String, sealed: Option<String>) -> U64 {
        let who = env::predecessor_account_id();
        let now = env::block_timestamp();
        let r = self.commit_round_at(now);
        require!(round.0 == r, format!("round {} is not taking commits (current: {})", round.0, r));
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
        let cap = balance * (self.params.max_stake_bps as u128) / BPS;
        require!(
            amount <= cap,
            format!("stake above the per-round cap of {} bps of your balance", self.params.max_stake_bps)
        );
        let fee = amount * (self.params.fee_bps as u128) / BPS;
        require!(amount + fee <= balance, "not enough NEAR for the stake plus the fee");
        let key = (r, who.clone());
        require!(!self.commits.contains_key(&key), "already committed in this round");
        let mut player = self.players.get(&who).cloned().unwrap_or_default();
        require!(player.open_rounds.len() < MAX_OPEN_ROUNDS, "too many unclaimed rounds: call claim first");

        self.balances.insert(who.clone(), balance - amount - fee);
        self.balances_total -= amount + fee;
        self.escrow += amount + fee;
        let has_sealed = sealed.is_some();
        self.commits.insert(key, Commit { hash, amount, fee, side: SIDE_NONE, shares: 0, streak_if_win: 0, sealed });
        self.round_players.entry(r).or_default().push(who.clone());
        player.open_rounds.push(r);
        self.players.insert(who.clone(), player);
        let round = self.rounds.entry(r).or_default();
        round.committed += amount;
        round.fees += fee;
        round.commits += 1;
        emit(
            "commit",
            json!({"account_id": who, "round": U64(r), "amount": U128(amount), "fee": U128(fee), "sealed": has_sealed}),
        );
        U64(r)
    }

    /// Reveal a commit during its round's reveal window. Anyone can reveal for anyone
    /// (`account_id`, default: caller): the hash binds account, round, side and salt, so
    /// only the side that was committed can ever be revealed.
    /// Revealing first pays out the account's earlier rounds, so its streak is up to date: the
    /// mining shares this bet earns if it wins are fixed here.
    pub fn reveal(&mut self, round: U64, side: String, salt: String, account_id: Option<AccountId>) {
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let now = env::block_timestamp();
        let r = round.0;
        require!(now >= self.round_reveal_start(r), "reveal window has not opened yet");
        require!(now < self.round_reveal_end(r), "reveal window is closed");
        require!(salt.len() >= 16 && salt.len() <= 128, "salt must be 16..128 characters");
        let s = parse_side(&side);
        let key = (r, who.clone());
        {
            let c = self.commits.get(&key).unwrap_or_else(|| env::panic_str("no commit for this round"));
            require!(c.side == SIDE_NONE, "already revealed");
            let digest = env::sha256(commit_preimage(&who, r, &side, &salt).as_bytes());
            require!(digest.as_slice() == c.hash.as_slice(), "hash does not match side+salt");
        }
        // Every earlier round of this account has finished revealing (reveal_ns <= commit_ns),
        // so this settles all of them and leaves the streak exactly as it stands before round r.
        self.internal_claim(&who);
        let streak_before = self.players.get(&who).map(|p| p.streak).unwrap_or(0);
        let streak_if_win = streak_before + 1;
        let c = self.commits.get_mut(&key).expect("checked above");
        let shares = shares_for(c.amount, streak_if_win, self.params.streak_min);
        c.side = s;
        c.sealed = None;
        c.shares = shares;
        c.streak_if_win = streak_if_win;
        let (amount, fee) = (c.amount, c.fee);
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
        emit(
            "reveal",
            json!({"account_id": who, "round": U64(r), "side": side, "amount": U128(amount),
                   "streak_if_win": streak_if_win, "shares": U128(shares), "by": env::predecessor_account_id()}),
        );
    }

    /// Settle a round after its reveal window. Anyone can call; idempotent.
    pub fn settle(&mut self, round: U64) {
        self.internal_settle(round.0);
    }

    fn internal_settle(&mut self, r: u64) {
        require!(env::block_timestamp() >= self.round_reveal_end(r), "round is still open");
        let Some(round) = self.rounds.get_mut(&r) else { return };
        if round.settled {
            return;
        }
        let (a, b) = (round.revealed_a, round.revealed_b);
        let (outcome, obligations, win_shares) = if a == 0 || b == 0 || a == b {
            (OUTCOME_VOID, a + b + round.revealed_fees, 0)
        } else if a < b {
            (SIDE_A, 2 * a, round.shares_a)
        } else {
            (SIDE_B, 2 * b, round.shares_b)
        };
        // stakes + fees >= revealed stakes + revealed fees >= obligations
        // (the winning side's stake is at most the losing side's).
        let to_treasury = round.committed + round.fees - obligations;
        let emission = self.params.reward_per_round.0.min(self.params.max_supply.0 - self.issued);
        self.issued += emission;
        self.pot += emission;
        round.settled = true;
        round.outcome = outcome;
        round.to_treasury = to_treasury;
        round.emission = emission;
        if win_shares > 0 && self.pot > 0 {
            round.reward = self.pot;
            round.reward_shares = win_shares;
            self.pot = 0;
        }
        let (reward, committed) = (round.reward, round.committed);
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

    /// Pay out every settle-able open round of `account_id` (default: caller), oldest first:
    /// NEAR to the game balance, mined BEFEWER to the wallet. Anyone can call it for anyone:
    /// payouts only ever go to the committing account. Returns the number of rounds claimed.
    pub fn claim(&mut self, account_id: Option<AccountId>) -> u32 {
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        self.internal_claim(&who)
    }

    fn internal_claim(&mut self, who: &AccountId) -> u32 {
        let Some(mut player) = self.players.get(who).cloned() else { return 0 };
        let now = env::block_timestamp();
        let mut done = 0u32;
        while let Some(&r) = player.open_rounds.first() {
            if now < self.round_reveal_end(r) {
                break; // rounds are ascending: nothing later is claimable either
            }
            self.internal_settle(r);
            let c = self.commits.remove(&(r, who.clone())).expect("open round has a commit");
            let round = self.rounds.get(&r).cloned().expect("open round exists");
            let mut mined = 0u128;
            let (result, payout) = if c.side == SIDE_NONE {
                player.forfeits += 1;
                player.streak = 0;
                ("forfeit", 0)
            } else if round.outcome == OUTCOME_VOID {
                player.voids += 1;
                ("void", c.amount + c.fee)
            } else if c.side == round.outcome {
                player.wins += 1;
                player.streak += 1;
                player.best_streak = player.best_streak.max(player.streak);
                if c.shares > 0 && round.reward > 0 {
                    mined = mul_div(round.reward, c.shares, round.reward_shares);
                }
                ("win", 2 * c.amount)
            } else {
                player.losses += 1;
                player.streak = 0;
                ("loss", 0)
            };
            if payout > 0 {
                self.escrow -= payout;
                *self.balances.entry(who.clone()).or_insert(0) += payout;
                self.balances_total += payout;
            }
            if mined > 0 && self.token.accounts.get(who).is_some() {
                self.token.internal_deposit(who, mined);
                self.mined += mined;
                player.mined += mined;
                let memo = format!("round {} streak {}", r, player.streak);
                FtMint { owner_id: who, amount: U128(mined), memo: Some(&memo) }.emit();
            }
            if player.streak > self.best_streak {
                self.best_streak = player.streak;
                self.best_streak_holder = Some(who.clone());
            }
            let fully_claimed = match self.rounds.get_mut(&r) {
                Some(round) => {
                    round.claims += 1;
                    round.claims == round.commits
                }
                None => false,
            };
            if fully_claimed {
                self.round_players.remove(&r);
            }
            emit(
                "claim",
                json!({"account_id": who, "round": U64(r), "result": result, "payout": U128(payout),
                       "mined": U128(mined), "streak": player.streak}),
            );
            player.open_rounds.remove(0);
            done += 1;
        }
        self.players.insert(who.clone(), player);
        done
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
                    .function_call(
                        "add_simple_pool",
                        json!({"tokens": [wnear, me], "fee": self.params.pool_fee}).to_string().into_bytes(),
                        NearToken::from_yoctonear(DEX_POOL_STORAGE),
                        tgas(20),
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
            STEP_ADD_LIQUIDITY => Promise::new(dex).function_call(
                "add_liquidity",
                json!({"pool_id": self.dex.pool_id.expect("pool created"),
                       "amounts": [U128(self.dex.near_amount), U128(self.dex.seed)]})
                .to_string()
                .into_bytes(),
                NearToken::from_yoctonear(DEX_LP_STORAGE),
                tgas(30),
            ),
            _ => env::panic_str("unknown graduation step"),
        };
        self.dex.busy = true;
        emit("graduate_step", json!({"step": self.dex.step}));
        p.then(Self::ext(me).with_static_gas(tgas(15)).on_graduate(self.dex.step))
    }

    #[private]
    pub fn on_graduate(&mut self, step: u8) {
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
            STEP_REGISTER => match res.and_then(|v| serde_json::from_slice::<u64>(&v).ok()) {
                Some(pool_id) => {
                    self.dex.pool_id = Some(pool_id);
                    true
                }
                None => false,
            },
            // ft_transfer_call / ft_resolve_transfer return the amount the receiver kept
            STEP_SEND_NEAR => amount_of(res) == self.dex.near_amount,
            STEP_SEND_TOKEN => amount_of(res) == self.dex.seed,
            STEP_ADD_LIQUIDITY => match amount_opt(res) {
                Some(shares) if shares > 0 => {
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

    /// Spend up to `buyback_max` of the treasury buying BEFEWER from the pool. Anyone can call
    /// it once the pool is open, at most once per `buyback_every_ns`. The BEFEWER the pool
    /// sends back lands on this contract and is burned on arrival.
    pub fn buyback(&mut self) -> Promise {
        require!(self.dex.step == STEP_DONE, "the pool is not open yet");
        require!(!self.dex.busy, "a buyback is in flight");
        let now = env::block_timestamp();
        require!(now >= self.dex.last_buyback_ns + self.params.buyback_every_ns.0, "too soon since the last buyback");
        let me = env::current_account_id();
        let (dex, wnear) = (self.params.dex.clone(), self.params.wnear.clone());
        let held = self.dex.held_wnear;
        let fresh = if held >= self.params.buyback_max.0 {
            0
        } else {
            self.spendable().min(self.params.buyback_max.0 - held)
        };
        let fresh = if held + fresh < MIN_BUYBACK { 0 } else { fresh };
        let amount = held + fresh;
        require!(amount >= MIN_BUYBACK, "the treasury has less than 0.01 NEAR to spend");
        self.treasury -= fresh;
        self.dex.held_wnear = 0;
        self.dex.busy = true;
        self.dex.last_buyback_ns = now;
        let msg = json!({"actions": [{"pool_id": self.dex.pool_id.expect("pool open"), "token_in": wnear,
                                      "token_out": me, "amount_in": U128(amount), "min_amount_out": "1"}]})
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
            storage_fees: U128(self.storage_fees),
            total_supply: U128(self.token.total_supply),
            max_supply: self.params.max_supply,
            issued: U128(self.issued),
            mined: U128(self.mined),
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
                buybacks: d.buybacks,
                bought_near: U128(d.bought_near),
                bought_burned: U128(d.bought_burned),
            },
        }
    }

    pub fn get_round(&self, round: U64) -> RoundView {
        let r = round.0;
        let x = self.rounds.get(&r).cloned().unwrap_or_default();
        RoundView {
            round,
            commit_starts_at: U64(self.round_commit_start(r)),
            reveal_starts_at: U64(self.round_reveal_start(r)),
            reveal_ends_at: U64(self.round_reveal_end(r)),
            committed: U128(x.committed),
            fees: U128(x.fees),
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
        }
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
            .filter_map(|a| {
                self.commits.get(&(round.0, a.clone())).map(|c| RoundCommitView {
                    account_id: a.clone(),
                    amount: U128(c.amount),
                    side: side_str(c.side),
                    hash: c.hash.iter().map(|b| format!("{:02x}", b)).collect(),
                    sealed: c.sealed.clone(),
                })
            })
            .collect()
    }

    pub fn get_player(&self, account_id: AccountId) -> PlayerView {
        let p = self.players.get(&account_id).cloned().unwrap_or_default();
        let open = p
            .open_rounds
            .iter()
            .filter_map(|r| {
                self.commits.get(&(*r, account_id.clone())).map(|c| OpenCommitView {
                    round: U64(*r),
                    amount: U128(c.amount),
                    fee: U128(c.fee),
                    side: side_str(c.side),
                    streak_if_win: c.streak_if_win,
                    shares: U128(c.shares),
                })
            })
            .collect();
        PlayerView {
            balance: U128(self.balances.get(&account_id).copied().unwrap_or(0)),
            tokens: U128(self.token.accounts.get(&account_id).unwrap_or(0)),
            registered: self.balances.contains_key(&account_id),
            account_id,
            streak: p.streak,
            best_streak: p.best_streak,
            wins: p.wins,
            losses: p.losses,
            voids: p.voids,
            forfeits: p.forfeits,
            mined: U128(p.mined),
            open,
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
