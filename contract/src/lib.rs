//! FEWER — a NEP-141 memecoin whose daily ritual is a stake-weighted minority game.
//!
//! Every round, holders commit a hidden bet on side A or B (commit-reveal). After the
//! reveal window, the side with LESS revealed stake wins:
//!   * winners get exactly 2x their stake back,
//!   * losers lose their stake,
//!   * whatever the losers lost beyond the winners' 1x profit is burned (|A - B| per round),
//!   * unrevealed commits are burned in full,
//!   * a tie or an empty side voids the round: revealed stakes are refunded.
//!
//! All parameters are fixed in `new` and there is no owner, no admin method and no mint
//! after launch. The total supply is minted once, into the faucet reserve.

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
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault,
    PromiseOrValue,
};

/// Max number of rounds an account can have committed-but-unclaimed at once.
pub const MAX_OPEN_ROUNDS: usize = 8;
const BPS: u128 = 10_000;

pub const SIDE_NONE: u8 = 0;
pub const SIDE_A: u8 = 1;
pub const SIDE_B: u8 = 2;
pub const OUTCOME_VOID: u8 = 3;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Token,
    Rounds,
    Commits,
    Players,
    FaucetClaimed,
    RoundPlayers,
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
    /// Max stake per round, in basis points of the account's balance at commit time.
    pub max_stake_bps: u16,
    /// Smallest allowed stake.
    pub min_stake: U128,
    /// Tokens handed out per account by `faucet` (once per account).
    pub faucet_amount: U128,
}

#[near(serializers = [borsh])]
#[derive(Default, Clone)]
pub struct Round {
    pub committed: u128,
    pub revealed_a: u128,
    pub revealed_b: u128,
    pub commits: u32,
    pub reveals_a: u32,
    pub reveals_b: u32,
    pub claims: u32,
    pub settled: bool,
    /// SIDE_A / SIDE_B (winning side) or OUTCOME_VOID. SIDE_NONE until settled.
    pub outcome: u8,
    pub burned: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Commit {
    pub hash: [u8; 32],
    pub amount: u128,
    pub side: u8,
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
    /// Rounds with a commit that has not been claimed yet, ascending.
    pub open_rounds: Vec<u64>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
    params: Params,
    initial_supply: u128,
    /// Tokens still available to `faucet`. Held in the contract's own FT balance.
    faucet_reserve: u128,
    /// Stakes currently held for unclaimed commits/payouts. Held in the contract's FT balance.
    escrow: u128,
    rounds: LookupMap<u64, Round>,
    commits: LookupMap<(u64, AccountId), Commit>,
    /// Accounts that committed in a round, so keepers can enumerate commits to reveal.
    /// Removed once every commit of the round is claimed.
    round_players: LookupMap<u64, Vec<AccountId>>,
    players: LookupMap<AccountId, Player>,
    faucet_claimed: LookupSet<AccountId>,
    total_burned: u128,
    rounds_settled: u64,
    best_streak: u32,
    best_streak_holder: Option<AccountId>,
    biggest_burn: u128,
    biggest_burn_round: Option<u64>,
}

// ---------- JSON views ----------

#[near(serializers = [json])]
pub struct RoundView {
    pub round: U64,
    pub commit_starts_at: U64,
    pub reveal_starts_at: U64,
    pub reveal_ends_at: U64,
    pub committed: U128,
    pub revealed_a: U128,
    pub revealed_b: U128,
    pub commits: u32,
    pub reveals_a: u32,
    pub reveals_b: u32,
    pub claims: u32,
    pub settled: bool,
    /// "A", "B", "void", or null while unsettled.
    pub outcome: Option<String>,
    pub burned: U128,
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
    pub initial_supply: U128,
    pub total_supply: U128,
    pub total_burned: U128,
    pub faucet_reserve: U128,
    pub escrow: U128,
    pub rounds_settled: U64,
    pub best_streak: u32,
    pub best_streak_holder: Option<AccountId>,
    pub biggest_burn: U128,
    pub biggest_burn_round: Option<U64>,
}

#[near(serializers = [json])]
pub struct OpenCommitView {
    pub round: U64,
    pub amount: U128,
    /// "A", "B", or null if not revealed yet.
    pub side: Option<String>,
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
    pub balance: U128,
    pub faucet_claimed: bool,
    pub streak: u32,
    pub best_streak: u32,
    pub wins: u32,
    pub losses: u32,
    pub voids: u32,
    pub forfeits: u32,
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

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    log!(
        "EVENT_JSON:{}",
        json!({"standard": "fewer", "version": "1.0.0", "event": event, "data": [data]})
    );
}

#[near]
impl Contract {
    #[init]
    pub fn new(total_supply: U128, params: Params, metadata: FungibleTokenMetadata) -> Self {
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
        require!(params.min_stake.0 > 0, "min_stake must be > 0");
        let me = env::current_account_id();
        let mut token = FungibleToken::new(StorageKey::Token);
        token.internal_register_account(&me);
        token.internal_deposit(&me, total_supply.0);
        FtMint { owner_id: &me, amount: total_supply, memo: Some("launch: entire supply into the faucet reserve") }
            .emit();
        Self {
            token,
            metadata,
            params,
            initial_supply: total_supply.0,
            faucet_reserve: total_supply.0,
            escrow: 0,
            rounds: LookupMap::new(StorageKey::Rounds),
            commits: LookupMap::new(StorageKey::Commits),
            round_players: LookupMap::new(StorageKey::RoundPlayers),
            players: LookupMap::new(StorageKey::Players),
            faucet_claimed: LookupSet::new(StorageKey::FaucetClaimed),
            total_burned: 0,
            rounds_settled: 0,
            best_streak: 0,
            best_streak_holder: None,
            biggest_burn: 0,
            biggest_burn_round: None,
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

    // ---------- faucet ----------

    /// Claim the one-time faucet allocation. Registers the caller for the token if needed;
    /// the contract pays that storage. No attached deposit, so a function-call key works.
    pub fn faucet(&mut self) -> U128 {
        let who = env::predecessor_account_id();
        require!(!self.faucet_claimed.contains(&who), "faucet already claimed by this account");
        let amount = self.params.faucet_amount.0.min(self.faucet_reserve);
        require!(amount > 0, "faucet reserve is empty");
        if self.token.accounts.get(&who).is_none() {
            self.token.internal_register_account(&who);
        }
        self.faucet_claimed.insert(who.clone());
        self.faucet_reserve -= amount;
        self.token.internal_transfer(&env::current_account_id(), &who, amount, Some("faucet".into()));
        amount.into()
    }

    // ---------- the game ----------

    /// Lock `amount` into the round currently taking commits, hidden behind
    /// `hash = sha256("fewer:<account>:<round>:<A|B>:<salt>")` as lowercase hex.
    /// `sealed` (optional) is the drand timelock ciphertext of "<A|B>:<salt>" so that a
    /// keeper can reveal for the player; without it the player must reveal manually.
    /// No attached deposit, so the app's function-call key can sign it without a popup.
    /// `round` must be the round currently taking commits: the hash binds the round, so a
    /// commit that lands after the window closed is refused instead of silently moving to
    /// the next round (where it could never be revealed).
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
        let balance = self.token.accounts.get(&who).unwrap_or_else(|| {
            env::panic_str("account is not registered for FEWER: claim the faucet or storage_deposit first")
        });
        let cap = balance * (self.params.max_stake_bps as u128) / BPS;
        require!(
            amount <= cap,
            format!("stake above the per-round cap of {} bps of your balance", self.params.max_stake_bps)
        );
        let key = (r, who.clone());
        require!(!self.commits.contains_key(&key), "already committed in this round");
        let mut player = self.players.get(&who).cloned().unwrap_or_default();
        require!(player.open_rounds.len() < MAX_OPEN_ROUNDS, "too many unclaimed rounds: call claim first");

        self.token.internal_transfer(&who, &env::current_account_id(), amount, Some(format!("commit round {}", r)));
        self.escrow += amount;
        let has_sealed = sealed.is_some();
        self.commits.insert(key, Commit { hash, amount, side: SIDE_NONE, sealed });
        self.round_players.entry(r).or_default().push(who.clone());
        player.open_rounds.push(r);
        self.players.insert(who.clone(), player);
        let round = self.rounds.entry(r).or_default();
        round.committed += amount;
        round.commits += 1;
        emit("commit", json!({"account_id": who, "round": U64(r), "amount": U128(amount), "sealed": has_sealed}));
        U64(r)
    }

    /// Reveal a commit during its round's reveal window. Anyone can reveal for anyone
    /// (`account_id`, default: caller): the hash binds account, round, side and salt, so
    /// only the side that was committed can ever be revealed.
    pub fn reveal(&mut self, round: U64, side: String, salt: String, account_id: Option<AccountId>) {
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let now = env::block_timestamp();
        let r = round.0;
        require!(now >= self.round_reveal_start(r), "reveal window has not opened yet");
        require!(now < self.round_reveal_end(r), "reveal window is closed");
        require!(salt.len() >= 16 && salt.len() <= 128, "salt must be 16..128 characters");
        let s = parse_side(&side);
        let key = (r, who.clone());
        let c = self.commits.get_mut(&key).unwrap_or_else(|| env::panic_str("no commit for this round"));
        require!(c.side == SIDE_NONE, "already revealed");
        let digest = env::sha256(commit_preimage(&who, r, &side, &salt).as_bytes());
        require!(digest.as_slice() == c.hash.as_slice(), "hash does not match side+salt");
        c.side = s;
        c.sealed = None;
        let amount = c.amount;
        let round = self.rounds.get_mut(&r).expect("round exists when a commit exists");
        if s == SIDE_A {
            round.revealed_a += amount;
            round.reveals_a += 1;
        } else {
            round.revealed_b += amount;
            round.reveals_b += 1;
        }
        emit(
            "reveal",
            json!({"account_id": who, "round": U64(r), "side": side, "amount": U128(amount),
                   "by": env::predecessor_account_id()}),
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
        let (outcome, obligations) = if a == 0 || b == 0 || a == b {
            (OUTCOME_VOID, a + b)
        } else if a < b {
            (SIDE_A, 2 * a)
        } else {
            (SIDE_B, 2 * b)
        };
        // committed = revealed + unrevealed >= a + b >= obligations (since winner stake <= loser stake).
        let burned = round.committed - obligations;
        round.settled = true;
        round.outcome = outcome;
        round.burned = burned;
        let committed = round.committed;
        self.escrow -= burned;
        self.rounds_settled += 1;
        if burned > 0 {
            let me = env::current_account_id();
            self.token.internal_withdraw(&me, burned);
            self.total_burned += burned;
            let memo = format!("round {} imbalance + unrevealed", r);
            FtBurn { owner_id: &me, amount: U128(burned), memo: Some(&memo) }.emit();
            if burned > self.biggest_burn {
                self.biggest_burn = burned;
                self.biggest_burn_round = Some(r);
            }
        }
        emit(
            "settle",
            json!({"round": U64(r), "outcome": side_str(outcome), "revealed_a": U128(a), "revealed_b": U128(b),
                   "committed": U128(committed), "burned": U128(burned)}),
        );
    }

    /// Pay out every settle-able open round of `account_id` (default: caller), oldest first.
    /// Anyone can call it for anyone: payouts only ever go to the committing account.
    /// Returns the number of rounds claimed.
    pub fn claim(&mut self, account_id: Option<AccountId>) -> u32 {
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let Some(mut player) = self.players.get(&who).cloned() else { return 0 };
        let now = env::block_timestamp();
        let mut done = 0u32;
        while let Some(&r) = player.open_rounds.first() {
            if now < self.round_reveal_end(r) {
                break; // rounds are ascending: nothing later is claimable either
            }
            self.internal_settle(r);
            let c = self.commits.remove(&(r, who.clone())).expect("open round has a commit");
            let outcome = self.rounds.get(&r).map(|x| x.outcome).unwrap_or(OUTCOME_VOID);
            let (result, payout) = if c.side == SIDE_NONE {
                player.forfeits += 1;
                player.streak = 0;
                ("forfeit", 0)
            } else if outcome == OUTCOME_VOID {
                player.voids += 1;
                ("void", c.amount)
            } else if c.side == outcome {
                player.wins += 1;
                player.streak += 1;
                player.best_streak = player.best_streak.max(player.streak);
                ("win", 2 * c.amount)
            } else {
                player.losses += 1;
                player.streak = 0;
                ("loss", 0)
            };
            if payout > 0 {
                self.escrow -= payout;
                let me = env::current_account_id();
                if self.token.accounts.get(&who).is_some() {
                    self.token.internal_transfer(&me, &who, payout, Some(format!("round {} {}", r, result)));
                } else {
                    // The account unregistered from the token meanwhile: its payout is burned.
                    self.token.internal_withdraw(&me, payout);
                    self.total_burned += payout;
                    let memo = format!("round {} payout to unregistered account", r);
                    FtBurn { owner_id: &me, amount: U128(payout), memo: Some(&memo) }.emit();
                }
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
                       "streak": player.streak}),
            );
            player.open_rounds.remove(0);
            done += 1;
        }
        self.players.insert(who, player);
        done
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
        StatusView {
            now: U64(now),
            commit_round: U64(cr),
            commit_ends_at: U64(self.round_reveal_start(cr)),
            reveal_round: reveal_round.map(U64),
            reveal_ends_at: reveal_round.map(|r| U64(self.round_reveal_end(r))),
            initial_supply: U128(self.initial_supply),
            total_supply: U128(self.token.total_supply),
            total_burned: U128(self.total_burned),
            faucet_reserve: U128(self.faucet_reserve),
            escrow: U128(self.escrow),
            rounds_settled: U64(self.rounds_settled),
            best_streak: self.best_streak,
            best_streak_holder: self.best_streak_holder.clone(),
            biggest_burn: U128(self.biggest_burn),
            biggest_burn_round: self.biggest_burn_round.map(U64),
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
            revealed_a: U128(x.revealed_a),
            revealed_b: U128(x.revealed_b),
            commits: x.commits,
            reveals_a: x.reveals_a,
            reveals_b: x.reveals_b,
            claims: x.claims,
            settled: x.settled,
            outcome: if x.settled { side_str(x.outcome) } else { None },
            burned: U128(x.burned),
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
                    side: side_str(c.side),
                })
            })
            .collect();
        PlayerView {
            balance: U128(self.token.accounts.get(&account_id).unwrap_or(0)),
            faucet_claimed: self.faucet_claimed.contains(&account_id),
            account_id,
            streak: p.streak,
            best_streak: p.best_streak,
            wins: p.wins,
            losses: p.losses,
            voids: p.voids,
            forfeits: p.forfeits,
            open,
        }
    }
}

// ---------- NEP-141 / NEP-145 / NEP-148 plumbing ----------

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
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
