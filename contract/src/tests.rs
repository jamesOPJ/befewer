use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult};

const N: u128 = NEAR;
const T: u128 = TOKEN;
const MIN: u64 = 60_000_000_000; // one minute in ns
const G: u64 = 1_000 * MIN; // genesis
const C: u64 = 10 * MIN; // commit window
const R: u64 = 5 * MIN; // reveal window
const START: u128 = 10 * N; // game balance every test player starts with
const BIG: u128 = 1_000_000 * N; // contract NEAR balance in most tests (so the treasury is fully spendable)

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn me() -> AccountId {
    acc("befewer.testnet")
}
fn dex() -> AccountId {
    acc("dex.testnet")
}
fn wnear() -> AccountId {
    acc("wrap.testnet")
}

fn ctx_full(who: &AccountId, now: u64, deposit: u128, balance: u128, results: Vec<PromiseResult>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(me())
        .predecessor_account_id(who.clone())
        .signer_account_id(who.clone())
        .block_timestamp(now)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_yoctonear(balance));
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), results);
}
fn ctx(who: &AccountId, now: u64) {
    ctx_full(who, now, 0, BIG, vec![]);
}
/// Context for a callback (predecessor = the contract) that sees one promise result.
fn callback(now: u64, result: PromiseResult) {
    ctx_full(&me(), now, 0, BIG, vec![result]);
}
fn ok_json<T: near_sdk::serde::Serialize>(v: T) -> PromiseResult {
    PromiseResult::Successful(serde_json::to_vec(&v).unwrap())
}

fn params() -> Params {
    Params {
        genesis_ns: U64(G),
        commit_ns: U64(C),
        reveal_ns: U64(R),
        max_stake_bps: 2500,
        min_stake: U128(N / 100),
        fee_bps: 500,
        reward_per_round: U128(T),
        max_supply: U128(1_000 * T),
        streak_min: 3,
        graduate_at: U128(5 * N),
        dex: dex(),
        wnear: wnear(),
        pool_fee: 30,
        buyback_max: U128(N),
        buyback_every_ns: U64(MIN),
        refine_fee_bps: 1000,
        reveal_bounty_bps: 8000,
    }
}

fn setup_with(p: Params) -> Contract {
    ctx(&acc("deployer.testnet"), G - MIN);
    // fresh chain state: testing_env! carries storage over, so wipe it for each new contract
    near_sdk::mock::with_mocked_blockchain(|b| {
        b.take_storage();
    });
    ctx(&acc("deployer.testnet"), G - MIN);
    Contract::new(
        p,
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Be Fewer".into(),
            symbol: "BEFEWER".into(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 18,
        },
    )
}
fn setup() -> Contract {
    setup_with(params())
}

/// Time inside round r's commit window / reveal window / after it.
fn t_commit(r: u64) -> u64 {
    G + r * C + MIN
}
fn t_reveal(r: u64) -> u64 {
    G + (r + 1) * C + MIN
}
fn t_after(r: u64) -> u64 {
    G + (r + 1) * C + R + MIN
}

fn salt(who: &AccountId, r: u64) -> String {
    format!("salt-{}-{}-0123456789abcdef", who, r)
}
fn hash_hex(who: &AccountId, r: u64, side: &str, salt: &str) -> String {
    env::sha256(commit_preimage(who, 0, r, side, salt).as_bytes()).iter().map(|b| format!("{:02x}", b)).collect()
}
fn fee(x: u128) -> u128 {
    x * 500 / 10_000
}
/// Reveal reward: 80% of the fee, paid to whoever reveals.
fn bounty(x: u128) -> u128 {
    fee(x) * 8000 / 10_000
}
/// What a bet costs in fees when the player reveals it itself (it gets the reward back).
fn cost(x: u128) -> u128 {
    fee(x) - bounty(x)
}
/// NEAR held for an open bet's storage (no ciphertext), returned when it is booked.
fn st(who: &AccountId) -> u128 {
    commit_storage(who, 0)
}

/// Deposit START (plus the one-time storage fee) for `who`.
fn join(c: &mut Contract, who: &AccountId) {
    ctx_full(who, G - MIN, START + STORAGE_FEE, BIG, vec![]);
    c.deposit(None);
}
fn commit(c: &mut Contract, who: &AccountId, r: u64, side: &str, amount: u128) {
    ctx(who, t_commit(r));
    let s = salt(who, r);
    let got = c.commit(U64(r), None, U128(amount), hash_hex(who, r, side, &s), None);
    assert_eq!(got.0, r);
}
fn reveal(c: &mut Contract, who: &AccountId, r: u64, side: &str) {
    ctx(who, t_reveal(r));
    c.reveal(U64(r), None, side.into(), salt(who, r), None);
}
/// NEAR a void round's record locks for good (ROUND_RECORD_BYTES x 1e19), and a revealed bet's
/// part of it (split by stake over the round's revealed stake).
const REC: u128 = 291 * 10_000_000_000_000_000_000;
fn rec(stake: u128, revealed: u128) -> u128 {
    (U256::from(REC) * U256::from(stake) / U256::from(revealed)).as_u128()
}
fn bal(c: &Contract, who: &AccountId) -> u128 {
    c.get_player(who.clone()).balance.0
}
fn tokens(c: &Contract, who: &AccountId) -> u128 {
    c.ft_balance_of(who.clone()).0
}
fn donate(c: &mut Contract, amount: u128, now: u64) {
    ctx_full(&acc("donor.testnet"), now, amount, BIG, vec![]);
    c.donate();
}

/// NEAR: every deposited yocto is in a game balance, in escrow, held for bets' storage, paid
/// as a slot fee, or went to the treasury. `players` must list every account that deposited
/// (START each).
/// BEFEWER: balances add up to the supply; supply + burned = everything minted; every mined
/// token is unrefined, claimed, owed as refined, or back in the pot; issuance capped.
fn check_invariants(c: &Contract, players: &[AccountId], donated: u128) {
    let s = c.get_status();
    let sum: u128 = players.iter().map(|p| bal(c, p)).sum();
    assert_eq!(sum, s.balances_total.0, "player balances add up to balances_total");
    let deposited = players.len() as u128 * START;
    let slot_fees = s.storage_fees.0 - players.len() as u128 * STORAGE_FEE;
    assert_eq!(
        s.balances_total.0 + s.escrow.0 + s.storage_held.0 + slot_fees + s.miner_lines.0 + s.treasury_in.0 - donated,
        deposited,
        "NEAR conserved: balances + escrow + storage held + slot fees + miner lines + round inflows = deposits"
    );
    let holders: u128 = players.iter().map(|p| tokens(c, p)).sum::<u128>() + tokens(c, &me()) + tokens(c, &dex());
    assert_eq!(holders, s.total_supply.0, "token balances add up to total supply");
    assert_eq!(s.total_supply.0 + s.total_burned.0, s.claimed.0 + s.dex.seed.0, "supply + burned = minted (claims + seed)");
    let unrefined: u128 = players.iter().map(|p| c.get_player(p.clone()).unrefined.0).sum();
    assert!(unrefined <= s.unrefined_total.0 && s.unrefined_total.0 - unrefined <= 1_000, "unrefined (pending included) adds up: {} vs {}", unrefined, s.unrefined_total.0);
    let owed: u128 = players.iter().map(|p| c.get_player(p.clone()).refined.0).sum();
    let accounted = s.unrefined_total.0 + s.claimed.0 + owed + s.refine_to_pot.0 + s.dust_to_pot.0;
    assert!(accounted <= s.mined.0 && s.mined.0 - accounted <= 1_000, "mining credits conserved (up to rounding dust): mined {} accounted {}", s.mined.0, accounted);
    assert!(s.issued.0 + s.refine_to_pot.0 + s.dust_to_pot.0 >= s.mined.0 + s.pot.0 + s.dex.seed.0, "issued covers mined + pot + seed");
    assert!(s.issued.0 - s.total_burned.0 <= s.max_supply.0, "never more than the cap exists at once");
}

// ---------------- deposits and withdrawals ----------------

#[test]
fn deposit_charges_the_storage_fee_once() {
    let mut c = setup();
    let a = acc("alice.testnet");
    ctx_full(&a, G, N, BIG, vec![]);
    assert_eq!(c.deposit(None).0, N - STORAGE_FEE);
    ctx_full(&a, G, N, BIG, vec![]);
    assert_eq!(c.deposit(None).0, 2 * N - STORAGE_FEE);
    let p = c.get_player(a.clone());
    assert!(p.registered);
    assert_eq!(c.storage_balance_of(a).is_some(), true, "registered for BEFEWER too");
    assert_eq!(c.get_status().storage_fees.0, STORAGE_FEE);
}

#[test]
fn deposit_for_someone_else() {
    let mut c = setup();
    let (sponsor, guest) = (acc("faucet.testnet"), acc("guest.testnet"));
    ctx_full(&sponsor, G, N / 2, BIG, vec![]);
    c.deposit(Some(guest.clone()));
    assert_eq!(bal(&c, &guest), N / 2 - STORAGE_FEE);
    assert_eq!(bal(&c, &sponsor), 0);
}

#[test]
#[should_panic(expected = "first deposit must be more than 0.01 NEAR")]
fn first_deposit_must_cover_storage() {
    let mut c = setup();
    let a = acc("alice.testnet");
    ctx_full(&a, G, STORAGE_FEE, BIG, vec![]);
    c.deposit(None);
}

#[test]
fn withdraw_and_failed_withdraw_is_put_back() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    ctx(&a, G);
    let _ = c.withdraw(Some(U128(2 * N)), None);
    assert_eq!(bal(&c, &a), START - 2 * N);
    callback(G, PromiseResult::Successful(vec![]));
    c.on_withdraw(a.clone(), U128(2 * N));
    assert_eq!(bal(&c, &a), START - 2 * N, "a successful transfer stays withdrawn");
    ctx(&a, G);
    let _ = c.withdraw(None, None);
    assert_eq!(bal(&c, &a), 0);
    callback(G, PromiseResult::Failed);
    c.on_withdraw(a.clone(), U128(START - 2 * N));
    assert_eq!(bal(&c, &a), START - 2 * N, "a failed transfer is credited back");
    assert_eq!(c.get_status().balances_total.0, START - 2 * N);
}

#[test]
#[should_panic(expected = "not enough NEAR")]
fn cannot_withdraw_more_than_the_balance() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    ctx(&a, G);
    let _ = c.withdraw(Some(U128(START + 1)), None);
}

// ---------------- the game ----------------

#[test]
fn minority_wins_double_and_fees_plus_imbalance_go_to_the_treasury() {
    let mut c = setup();
    let (a, b, ch) = (acc("alice.testnet"), acc("bob.testnet"), acc("charlie.testnet"));
    for p in [&a, &b, &ch] {
        join(&mut c, p);
    }
    commit(&mut c, &a, 0, "A", N);
    commit(&mut c, &b, 0, "B", 2 * N);
    commit(&mut c, &ch, 0, "B", N / 2);
    assert_eq!(c.get_status().escrow.0, 3 * N + N / 2 + fee(3 * N + N / 2));
    assert_eq!(bal(&c, &a), START - N - fee(N) - st(&a), "stake + fee + the bet's storage left the balance");
    assert_eq!(c.get_status().storage_held.0, st(&a) + st(&b) + st(&ch));
    let open = c.get_player(a.clone()).open;
    assert!(open[0].side.is_none(), "nobody's side is on chain during the commit window");

    reveal(&mut c, &a, 0, "A");
    reveal(&mut c, &b, 0, "B");
    reveal(&mut c, &ch, 0, "B");
    ctx(&a, t_after(0));
    for p in [&a, &b, &ch] {
        assert_eq!(c.claim(Some(p.clone()), None), 1);
    }
    // each revealed its own bet, so each got the reveal reward (80% of its fee) back
    assert_eq!(bal(&c, &a), START - N - cost(N) + 2 * N, "winner: 2x the stake, fee paid, storage back");
    assert_eq!(bal(&c, &b), START - 2 * N - cost(2 * N));
    assert_eq!(bal(&c, &ch), START - N / 2 - cost(N / 2));
    assert_eq!(c.get_status().storage_held.0, 0, "all storage returned once booked");
    let r = c.get_round(U64(0));
    assert_eq!(r.outcome.as_deref(), Some("A"));
    let fees = cost(N) + cost(2 * N) + cost(N / 2);
    assert_eq!(r.to_treasury.0, fees + (2 * N + N / 2 - N), "treasury gets the fees (after reveal rewards) + |A - B|");
    let s = c.get_status();
    assert_eq!(s.treasury.0, r.to_treasury.0);
    assert_eq!(s.escrow.0, 0);
    check_invariants(&c, &[a, b, ch], 0);
}

#[test]
#[should_panic(expected = "per-round cap")]
fn stake_cap_enforced() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    commit(&mut c, &a, 0, "A", START / 4 + 1);
}

#[test]
fn stake_cap_exact_is_ok() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    commit(&mut c, &a, 0, "A", START / 4);
}

#[test]
#[should_panic(expected = "below min_stake")]
fn min_stake_enforced() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    commit(&mut c, &a, 0, "A", N / 100 - 1);
}

#[test]
#[should_panic(expected = "not enough NEAR for the stake, the fee and the bet's storage")]
fn the_fee_must_fit_in_the_balance() {
    let mut p = params();
    p.max_stake_bps = 10_000; // allow betting everything, so the fee is what does not fit
    let mut c = setup_with(p);
    let a = acc("alice.testnet");
    join(&mut c, &a);
    commit(&mut c, &a, 0, "A", START);
}

#[test]
#[should_panic(expected = "deposit NEAR first")]
fn commit_needs_a_deposit() {
    let mut c = setup();
    let a = acc("alice.testnet");
    commit(&mut c, &a, 0, "A", N);
}

#[test]
#[should_panic(expected = "already bet in this round")]
fn one_commit_per_round() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    commit(&mut c, &a, 0, "A", N);
    commit(&mut c, &a, 0, "B", N);
}

#[test]
#[should_panic(expected = "hash does not match")]
fn reveal_wrong_side_fails() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    commit(&mut c, &a, 0, "A", N);
    reveal(&mut c, &a, 0, "B");
}

#[test]
#[should_panic(expected = "hash does not match")]
fn commit_hash_is_bound_to_account() {
    // bob copies alice's hash: he cannot reveal it as his own
    let mut c = setup();
    let (a, b) = (acc("alice.testnet"), acc("bob.testnet"));
    join(&mut c, &a);
    join(&mut c, &b);
    let s = salt(&a, 0);
    let h = hash_hex(&a, 0, "A", &s);
    ctx(&b, t_commit(0));
    c.commit(U64(0), None, U128(N), h, None);
    ctx(&b, t_reveal(0));
    c.reveal(U64(0), None, "A".into(), s, None);
}

#[test]
#[should_panic(expected = "not opened yet")]
fn reveal_too_early_fails() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    commit(&mut c, &a, 0, "A", N);
    ctx(&a, t_commit(0));
    c.reveal(U64(0), None, "A".into(), salt(&a, 0), None);
}

#[test]
#[should_panic(expected = "reveal window is closed")]
fn reveal_too_late_fails() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    commit(&mut c, &a, 0, "A", N);
    ctx(&a, t_after(0));
    c.reveal(U64(0), None, "A".into(), salt(&a, 0), None);
}

#[test]
fn tie_voids_refunds_stake_and_fee_and_unrevealed_goes_to_the_treasury() {
    let mut c = setup();
    let (a, b, ch) = (acc("alice.testnet"), acc("bob.testnet"), acc("charlie.testnet"));
    for p in [&a, &b, &ch] {
        join(&mut c, p);
    }
    commit(&mut c, &a, 0, "A", N);
    commit(&mut c, &b, 0, "B", N);
    commit(&mut c, &ch, 0, "A", N / 2); // never revealed
    reveal(&mut c, &a, 0, "A");
    reveal(&mut c, &b, 0, "B");
    ctx(&a, t_after(0));
    c.settle(U64(0));
    for p in [&a, &b, &ch] {
        c.claim(Some(p.clone()), None);
    }
    assert_eq!(c.get_round(U64(0)).outcome.as_deref(), Some("void"));
    assert_eq!(bal(&c, &a), START - REC / 2, "void: stake and fee come back, minus half the round's record");
    assert_eq!(bal(&c, &b), START - REC / 2);
    assert_eq!(bal(&c, &ch), START - N / 2 - fee(N / 2), "unrevealed: stake and fee are lost");
    assert_eq!(c.get_status().treasury.0, N / 2 + fee(N / 2));
    assert_eq!(c.get_player(ch.clone()).forfeits, 1);
    check_invariants(&c, &[a, b, ch], 0);
}

#[test]
fn one_sided_round_is_refunded() {
    let mut c = setup();
    let (a, b) = (acc("alice.testnet"), acc("bob.testnet"));
    join(&mut c, &a);
    join(&mut c, &b);
    commit(&mut c, &a, 0, "A", N);
    commit(&mut c, &b, 0, "A", N / 3);
    reveal(&mut c, &a, 0, "A");
    reveal(&mut c, &b, 0, "A");
    ctx(&a, t_after(0));
    c.claim(Some(a.clone()), None);
    c.claim(Some(b.clone()), None);
    // everything back except the round's record, split by stake (3:1)
    assert_eq!(bal(&c, &a), START - rec(N, N + N / 3));
    assert_eq!(bal(&c, &b), START - rec(N / 3, N + N / 3));
    assert!(REC - rec(N, N + N / 3) - rec(N / 3, N + N / 3) <= 1, "the two parts make up the record");
    assert_eq!(c.get_status().treasury.0, 0);
    check_invariants(&c, &[a, b], 0);
}

#[test]
fn claim_waits_for_reveal_end_and_anyone_can_claim_for_you() {
    let mut c = setup();
    let (a, b, keeper) = (acc("alice.testnet"), acc("bob.testnet"), acc("keeper.testnet"));
    join(&mut c, &a);
    join(&mut c, &b);
    commit(&mut c, &a, 0, "A", N);
    commit(&mut c, &b, 0, "B", 2 * N);
    reveal(&mut c, &a, 0, "A");
    reveal(&mut c, &b, 0, "B");
    ctx(&keeper, t_reveal(0));
    assert_eq!(c.claim(Some(a.clone()), None), 0, "nothing claimable before the reveal window ends");
    ctx(&keeper, t_after(0));
    assert_eq!(c.claim(Some(a.clone()), None), 1);
    assert_eq!(bal(&c, &a), START + N - cost(N), "won N, paid the fee, got the reveal reward back");
    assert_eq!(bal(&c, &keeper), 0);
}

#[test]
fn rounds_overlap_commit_next_while_revealing_previous() {
    let mut c = setup();
    let (a, b) = (acc("alice.testnet"), acc("bob.testnet"));
    join(&mut c, &a);
    join(&mut c, &b);
    commit(&mut c, &a, 0, "A", N);
    commit(&mut c, &b, 0, "B", 2 * N);
    // t_reveal(0) is inside round 1's commit window
    ctx(&a, t_reveal(0));
    let st = c.get_status();
    assert_eq!(st.commit_round.0, 1);
    assert_eq!(st.reveal_round.map(|x| x.0), Some(0));
    let s = salt(&a, 1);
    assert_eq!(c.commit(U64(1), None, U128(N), hash_hex(&a, 1, "B", &s), None).0, 1);
    c.reveal(U64(0), None, "A".into(), salt(&a, 0), None);
}

#[test]
fn streaks_and_records() {
    let mut c = setup();
    let (a, b, ch) = (acc("alice.testnet"), acc("bob.testnet"), acc("charlie.testnet"));
    for p in [&a, &b, &ch] {
        join(&mut c, p);
    }
    // alice is in the minority in rounds 0 and 1, then the majority in round 2
    for (r, sa) in [(0u64, "A"), (1, "B"), (2, "A")] {
        let other = if sa == "A" { "B" } else { "A" };
        let (bob_side, ch_side) = if r < 2 { (other, other) } else { (sa, other) };
        commit(&mut c, &a, r, sa, N);
        commit(&mut c, &b, r, bob_side, N + N / 2);
        commit(&mut c, &ch, r, ch_side, N + N / 5);
        reveal(&mut c, &a, r, sa);
        reveal(&mut c, &b, r, bob_side);
        reveal(&mut c, &ch, r, ch_side);
    }
    ctx(&a, t_after(2));
    c.claim(Some(a.clone()), None);
    let p = c.get_player(a.clone());
    assert_eq!((p.wins, p.losses, p.streak, p.best_streak), (2, 1, 0, 2));
    let s = c.get_status();
    assert_eq!(s.best_streak, 2);
    assert_eq!(s.best_streak_holder, Some(a.clone()));
    c.claim(Some(b.clone()), None);
    c.claim(Some(ch.clone()), None);
    check_invariants(&c, &[a, b, ch], 0);
}

#[test]
fn a_slot_books_its_finished_bets_when_it_bets_again() {
    // more than MAX_OPEN_ROUNDS bets in a row never hits the limit: each bet books the
    // finished ones first (nobody calls claim)
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    for r in 0..=(MAX_OPEN_ROUNDS as u64) + 2 {
        commit(&mut c, &a, r, "A", N / 100);
        assert!(c.get_player(a.clone()).open.len() <= 2);
    }
    check_invariants(&c, &[a], 0);
}

// ---------------- hedging ----------------

/// The hole the fee closes: one person betting the same amount on both sides (two accounts).
/// Without a fee that is free; with it, every hedged round costs exactly both fees.
#[test]
fn hedging_both_sides_costs_exactly_the_two_fees() {
    let (h1, h2) = (acc("hedge-a.testnet"), acc("hedge-b.testnet"));
    let (o1, o2) = (acc("o1.testnet"), acc("o2.testnet"));
    let x = N / 2;
    // (others on A, others on B): A wins in the first two, B in the third
    for (oa, ob) in [(N, 2 * N), (N, N + N / 5), (2 * N, N)] {
        let mut c = setup();
        for p in [&h1, &h2, &o1, &o2] {
            join(&mut c, p);
        }
        commit(&mut c, &h1, 0, "A", x);
        commit(&mut c, &h2, 0, "B", x);
        commit(&mut c, &o1, 0, "A", oa);
        commit(&mut c, &o2, 0, "B", ob);
        for (p, s) in [(&h1, "A"), (&h2, "B"), (&o1, "A"), (&o2, "B")] {
            reveal(&mut c, p, 0, s);
        }
        ctx(&h1, t_after(0));
        for p in [&h1, &h2, &o1, &o2] {
            c.claim(Some(p.clone()), None);
        }
        let net = (bal(&c, &h1) + bal(&c, &h2)) as i128 - 2 * START as i128;
        assert_eq!(net, -2 * cost(x) as i128, "hedged round costs both fees (net of the reveal rewards they got back), whichever side wins");
        check_invariants(&c, &[h1.clone(), h2.clone(), o1.clone(), o2.clone()], 0);
    }
}

/// Hedging alone (nobody else plays) voids the round: free, but it never builds a streak.
#[test]
fn hedging_alone_is_free_but_never_mines() {
    let mut c = setup();
    let (h1, h2) = (acc("hedge-a.testnet"), acc("hedge-b.testnet"));
    join(&mut c, &h1);
    join(&mut c, &h2);
    for r in 0..5u64 {
        commit(&mut c, &h1, r, "A", N);
        commit(&mut c, &h2, r, "B", N);
        reveal(&mut c, &h1, r, "A");
        reveal(&mut c, &h2, r, "B");
    }
    ctx(&h1, t_after(4));
    c.claim(Some(h1.clone()), None);
    c.claim(Some(h2.clone()), None);
    assert_eq!(bal(&c, &h1) + bal(&c, &h2), 2 * START - 5 * REC, "void rounds refund everything but their records");
    assert_eq!(c.get_player(h1.clone()).streak, 0, "a void is not a win");
    assert_eq!(c.get_status().mined.0, 0);
    assert_eq!(c.get_status().pot.0, 5 * T, "the pot keeps growing for the next real streak");
}

/// A whale with two accounts commits on both sides, waits until everyone else has
/// revealed, then reveals whichever subset pays best (unrevealed = lost). With the exact-2x
/// payout and the fee, the best it can do is never more than a blind bet on the difference.
#[test]
fn hedging_with_two_accounts_never_beats_betting_the_difference() {
    let (w1, w2) = (acc("whale1.testnet"), acc("whale2.testnet"));
    let others = [acc("o1.testnet"), acc("o2.testnet"), acc("o3.testnet")];
    let m = N / 100;
    let cases: [(u128, u128, [(&str, u128); 3]); 4] = [
        (100, 100, [("A", 120), ("B", 200), ("B", 50)]),
        (200, 100, [("A", 30), ("B", 40), ("A", 10)]),
        (100, 30, [("A", 250), ("B", 10), ("B", 5)]),
        (50, 50, [("A", 1), ("B", 2), ("B", 1)]),
    ];
    for (ca, cb, bets) in cases {
        let mut best: i128 = i128::MIN;
        for (ra, rb) in [(true, true), (true, false), (false, true), (false, false)] {
            let mut c = setup();
            for p in [&w1, &w2].into_iter().chain(others.iter()) {
                join(&mut c, p);
            }
            commit(&mut c, &w1, 0, "A", ca * m);
            commit(&mut c, &w2, 0, "B", cb * m);
            for (o, (side, amt)) in others.iter().zip(bets.iter()) {
                commit(&mut c, o, 0, side, amt * m);
                reveal(&mut c, o, 0, side);
            }
            if ra {
                reveal(&mut c, &w1, 0, "A");
            }
            if rb {
                reveal(&mut c, &w2, 0, "B");
            }
            ctx(&w1, t_after(0));
            c.claim(Some(w1.clone()), None);
            c.claim(Some(w2.clone()), None);
            let net = (bal(&c, &w1) + bal(&c, &w2)) as i128 - 2 * START as i128;
            best = best.max(net);
            let mut all = vec![w1.clone(), w2.clone()];
            all.extend(others.iter().cloned());
            check_invariants(&c, &all, 0);
        }
        let diff = (ca as i128 - cb as i128).abs() * m as i128;
        assert!(best <= diff, "hedge net {} beat the difference bet {}", best, diff);
    }
}

// ---------------- mining ----------------

/// alice (1 NEAR on A) vs two others (1 NEAR each on B): alice wins every round.
fn play_alice_minority(c: &mut Contract, rounds: std::ops::Range<u64>, a: &AccountId, extra: Option<(&AccountId, u128)>) {
    let (b1, b2) = (acc("b1.testnet"), acc("b2.testnet"));
    for r in rounds {
        commit(c, a, r, "A", N);
        commit(c, &b1, r, "B", N);
        commit(c, &b2, r, "B", N);
        if let Some((e, amt)) = extra {
            commit(c, e, r, "A", amt);
        }
        reveal(c, a, r, "A");
        reveal(c, &b1, r, "B");
        reveal(c, &b2, r, "B");
        if let Some((e, _)) = extra {
            reveal(c, e, r, "A");
        }
    }
}

#[test]
fn third_win_in_a_row_mines_the_whole_pot() {
    let mut c = setup();
    let (a, b1, b2) = (acc("alice.testnet"), acc("b1.testnet"), acc("b2.testnet"));
    for p in [&a, &b1, &b2] {
        join(&mut c, p);
    }
    play_alice_minority(&mut c, 0..3, &a, None);
    // nobody called claim: each reveal paid out alice's previous round first, so her streak
    // was current when the shares were fixed
    let open = c.get_player(a.clone()).open;
    let last = open.iter().find(|o| o.round.0 == 2).unwrap();
    assert_eq!(last.streak_if_win, 3);
    assert_eq!(last.shares.0, N / SHARE_UNIT, "1 share per milli-NEAR at the minimum streak");
    assert_eq!(c.get_status().mined.0, 0, "wins 1 and 2 mined nothing");
    ctx(&a, t_after(2));
    for p in [&a, &b1, &b2] {
        c.claim(Some(p.clone()), None);
    }
    let s = c.get_status();
    assert_eq!(c.get_player(a.clone()).unrefined.0, 3 * T, "rounds 0 and 1 rolled over into round 2's pot");
    assert_eq!(tokens(&c, &a), 0, "mined BEFEWER stays unrefined in the game until claimed");
    assert_eq!(c.get_player(a.clone()).mined.0, 3 * T);
    assert_eq!((s.mined.0, s.pot.0, s.issued.0), (3 * T, 0, 3 * T));
    assert_eq!(c.get_round(U64(2)).reward.0, 3 * T);
    check_invariants(&c, &[a, b1, b2], 0);
}

#[test]
fn longer_streaks_and_bigger_stakes_get_bigger_shares() {
    let mut c = setup();
    let (a, e, b1, b2) = (acc("alice.testnet"), acc("eve.testnet"), acc("b1.testnet"), acc("b2.testnet"));
    for p in [&a, &e, &b1, &b2] {
        join(&mut c, p);
    }
    play_alice_minority(&mut c, 0..1, &a, None);
    // eve joins alice on A from round 1 with half the stake
    play_alice_minority(&mut c, 1..4, &a, Some((&e, N / 2)));
    ctx(&a, t_after(3));
    for p in [&a, &e, &b1, &b2] {
        c.claim(Some(p.clone()), None);
    }
    // round 2: alice's 3rd win takes the 3-token pot alone (eve is on her 2nd)
    // round 3: pot of 1 token split 2 shares x 1000 (alice, streak 4) : 1 share x 500 (eve, streak 3)
    assert_eq!(c.get_player(a.clone()).unrefined.0, 3 * T + T * 2000 / 2500);
    assert_eq!(c.get_player(e.clone()).unrefined.0, T * 500 / 2500);
    let r3 = c.get_round(U64(3));
    assert_eq!((r3.reward.0, r3.reward_shares.0), (T, 2500));
    check_invariants(&c, &[a, e, b1, b2], 0);
}

#[test]
fn a_loss_resets_the_streak_and_the_shares() {
    let mut c = setup();
    let (a, b1, b2) = (acc("alice.testnet"), acc("b1.testnet"), acc("b2.testnet"));
    for p in [&a, &b1, &b2] {
        join(&mut c, p);
    }
    play_alice_minority(&mut c, 0..2, &a, None);
    // round 2: alice joins the majority and loses
    commit(&mut c, &a, 2, "B", N);
    commit(&mut c, &b1, 2, "B", N);
    commit(&mut c, &b2, 2, "A", N);
    reveal(&mut c, &a, 2, "B");
    reveal(&mut c, &b1, 2, "B");
    reveal(&mut c, &b2, 2, "A");
    play_alice_minority(&mut c, 3..4, &a, None);
    let o = c.get_player(a.clone()).open;
    assert_eq!(o.iter().find(|x| x.round.0 == 3).unwrap().streak_if_win, 1);
    ctx(&a, t_after(3));
    for p in [&a, &b1, &b2] {
        c.claim(Some(p.clone()), None);
    }
    // b2's round-2 win was its first: nobody has mined, the 4 tokens are all in the pot
    assert_eq!(c.get_status().mined.0, 0);
    assert_eq!(c.get_status().pot.0, 4 * T);
}

/// Win, skip a round, win, a void round, win: the streak is 3 and the last win mines.
#[test]
fn skipped_and_void_rounds_keep_the_streak() {
    let mut c = setup();
    let (a, b1, b2) = (acc("alice.testnet"), acc("b1.testnet"), acc("b2.testnet"));
    for p in [&a, &b1, &b2] {
        join(&mut c, p);
    }
    play_alice_minority(&mut c, 0..1, &a, None);
    // round 1: alice sits out (only b1 and b2 play)
    commit(&mut c, &b1, 1, "A", N);
    commit(&mut c, &b2, 1, "B", 2 * N);
    reveal(&mut c, &b1, 1, "A");
    reveal(&mut c, &b2, 1, "B");
    play_alice_minority(&mut c, 2..3, &a, None);
    // round 3: everyone on A -> void, money back
    for p in [&a, &b1] {
        commit(&mut c, p, 3, "A", N);
        reveal(&mut c, p, 3, "A");
    }
    play_alice_minority(&mut c, 4..5, &a, None);
    let o = c.get_player(a.clone()).open;
    let last = o.iter().find(|x| x.round.0 == 4).unwrap();
    assert_eq!(last.streak_if_win, 3, "the skip and the void did not break the streak");
    assert!(last.shares.0 > 0);
    ctx(&a, t_after(4));
    for p in [&a, &b1, &b2] {
        c.claim(Some(p.clone()), None);
    }
    let p = c.get_player(a.clone());
    assert_eq!((p.wins, p.voids, p.streak), (3, 1, 3));
    assert!(c.get_player(a.clone()).unrefined.0 > 0, "the third win mined");
    check_invariants(&c, &[a, b1, b2], 0);
}

/// Win, win, then a bet that never gets revealed: it counts as given up and resets the streak.
#[test]
fn an_unrevealed_bet_resets_the_streak() {
    let mut c = setup();
    let (a, b1, b2) = (acc("alice.testnet"), acc("b1.testnet"), acc("b2.testnet"));
    for p in [&a, &b1, &b2] {
        join(&mut c, p);
    }
    play_alice_minority(&mut c, 0..2, &a, None);
    commit(&mut c, &a, 2, "A", N); // never revealed
    commit(&mut c, &b1, 2, "A", N);
    commit(&mut c, &b2, 2, "B", N + N / 2);
    reveal(&mut c, &b1, 2, "A");
    reveal(&mut c, &b2, 2, "B");
    play_alice_minority(&mut c, 3..4, &a, None);
    let o = c.get_player(a.clone()).open;
    assert_eq!(o.iter().find(|x| x.round.0 == 3).unwrap().streak_if_win, 1);
    ctx(&a, t_after(3));
    c.claim(Some(a.clone()), None);
    let p = c.get_player(a.clone());
    assert_eq!((p.wins, p.forfeits, p.streak), (3, 1, 1));
}

#[test]
fn issuance_stops_at_max_supply() {
    let mut p = params();
    p.max_supply = U128(T * 5 / 2);
    let mut c = setup_with(p);
    let (a, b1, b2) = (acc("alice.testnet"), acc("b1.testnet"), acc("b2.testnet"));
    for p in [&a, &b1, &b2] {
        join(&mut c, p);
    }
    play_alice_minority(&mut c, 0..5, &a, None);
    ctx(&a, t_after(4));
    for p in [&a, &b1, &b2] {
        c.claim(Some(p.clone()), None);
    }
    let s = c.get_status();
    assert_eq!(s.issued.0, T * 5 / 2);
    assert_eq!(c.get_round(U64(2)).emission.0, T / 2);
    assert_eq!(c.get_round(U64(3)).emission.0, 0);
    assert_eq!(c.get_player(a.clone()).unrefined.0, T * 5 / 2);
    check_invariants(&c, &[a, b1, b2], 0);
}

#[test]
fn burned_befewer_can_be_mined_again() {
    // like ORE: the cap limits what exists at once, so a burn makes room for new mining
    let mut p = params();
    p.max_supply = U128(T * 5 / 2);
    let mut c = setup_with(p);
    let (a, b1, b2) = (acc("alice.testnet"), acc("b1.testnet"), acc("b2.testnet"));
    for p in [&a, &b1, &b2] {
        join(&mut c, p);
    }
    play_alice_minority(&mut c, 0..5, &a, None);
    ctx(&a, t_after(4));
    c.claim(Some(a.clone()), None);
    assert_eq!(c.get_round(U64(4)).emission.0, 0, "at the cap nothing new is added");
    // alice claims her 2.5 to the wallet (10% refining fee to the pot: nobody else holds) and burns 2
    assert_eq!(claim_tokens(&mut c, &a, None), T * 9 / 4);
    ctx_full(&a, t_after(4), 1, BIG, vec![]);
    c.ft_transfer(me(), U128(2 * T), None);
    assert_eq!(c.get_status().total_burned.0, 2 * T);
    // the next rounds add BEFEWER to the pot again, one per round, until the cap is full again
    for p in [&b1, &b2] {
        ctx_full(p, t_after(4), 10 * N, BIG, vec![]);
        c.deposit(None); // they lost every round so far
    }
    play_alice_minority(&mut c, 6..9, &a, None);
    ctx(&a, t_after(8));
    c.claim(Some(a.clone()), None);
    let emitted: u128 = (6..9u64).map(|r| c.get_round(U64(r)).emission.0).sum();
    assert_eq!(emitted, 2 * T, "the 2 burned come back through mining, then it stops at the cap again");
    let s = c.get_status();
    assert_eq!(s.issued.0 - s.total_burned.0, T * 5 / 2, "exactly the cap exists");
    check_invariants(&c, &[a, b1, b2], 20 * N); // (the extra deposits, passed where donations go)
}

#[test]
fn mul_div_is_exact_and_does_not_overflow() {
    assert_eq!(mul_div(10, 1, 3), 3);
    assert_eq!(mul_div(1_000_000 * T, 999_999, 1_000_000), 999_999 * T);
    let big = u128::MAX / 2;
    assert_eq!(mul_div(big, 7, 7), big);
}

// ---------------- refining (claiming mined BEFEWER) ----------------

/// Credit unrefined BEFEWER to a registered account the way mining does.
fn give_unrefined(c: &mut Contract, who: &AccountId, amount: u128) {
    let mut p = c.players.get(who).cloned().unwrap_or_default();
    c.checkpoint(&mut p);
    p.unrefined += amount;
    p.mined += amount;
    c.unrefined_total += amount;
    c.mined += amount;
    c.issued += amount; // as if emitted into a round's reward
    c.players.insert(who.clone(), p);
}
fn claim_tokens(c: &mut Contract, who: &AccountId, bps: Option<u16>) -> u128 {
    ctx(who, G);
    c.claim_befewer(bps, None).0
}
fn view_p(c: &Contract, who: &AccountId) -> PlayerView {
    c.get_player(who.clone())
}

#[test]
fn claiming_alone_costs_10_percent_and_the_fee_goes_back_to_the_pot() {
    let mut c = setup();
    let (a, b1, b2) = (acc("alice.testnet"), acc("b1.testnet"), acc("b2.testnet"));
    for p in [&a, &b1, &b2] {
        join(&mut c, p);
    }
    play_alice_minority(&mut c, 0..3, &a, None);
    ctx(&a, t_after(2)); // rounds finished but nobody called claim: claim_befewer pays them first
    assert_eq!(c.claim_befewer(None, None).0, 3 * T * 9 / 10);
    let s = c.get_status();
    assert_eq!(tokens(&c, &a), 3 * T * 9 / 10);
    assert_eq!((s.refine_fees.0, s.refine_to_pot.0, s.pot.0), (3 * T / 10, 3 * T / 10, 3 * T / 10));
    assert_eq!(view_p(&c, &a).unrefined.0, 0);
    check_invariants(&c, &[a, b1, b2], 0);
}

#[test]
fn the_refining_fee_is_shared_pro_rata_and_refined_is_claimed_without_a_fee() {
    let mut c = setup();
    let (x, y, z) = (acc("x.testnet"), acc("y.testnet"), acc("z.testnet"));
    for p in [&x, &y, &z] {
        join(&mut c, p);
    }
    give_unrefined(&mut c, &x, 6 * T);
    give_unrefined(&mut c, &y, 3 * T);
    give_unrefined(&mut c, &z, T);
    // x claims everything: 6 - 10% = 5.4; the 0.6 fee splits 3:1 between y and z
    assert_eq!(claim_tokens(&mut c, &x, None), 54 * T / 10);
    assert_eq!(view_p(&c, &y).refined.0, 45 * T / 100);
    assert_eq!(view_p(&c, &z).refined.0, 15 * T / 100);
    // y claims half its unrefined: 1.5 - 0.15 fee + its 0.45 refined (no fee on that) = 1.8
    assert_eq!(claim_tokens(&mut c, &y, Some(5_000)), 18 * T / 10);
    // the 0.15 fee goes to the OTHER holders only: z gets all of it, y none of its own fee
    assert_eq!(view_p(&c, &y).refined.0, 0);
    assert_eq!(view_p(&c, &z).refined.0, 30 * T / 100);
    assert_eq!(view_p(&c, &y).unrefined.0, 15 * T / 10);
    let s = c.get_status();
    assert_eq!(s.refine_fees.0, 75 * T / 100);
    assert_eq!(s.refine_to_pot.0, 0);
    check_invariants(&c, &[x, y, z], 0);
}

#[test]
fn holding_unrefined_earns_from_a_claim_made_before_it_was_mined_only_if_already_held() {
    let mut c = setup();
    let (x, y) = (acc("x.testnet"), acc("y.testnet"));
    join(&mut c, &x);
    join(&mut c, &y);
    give_unrefined(&mut c, &x, 2 * T);
    give_unrefined(&mut c, &y, 2 * T);
    claim_tokens(&mut c, &x, None); // 0.2 fee -> all to y
    assert_eq!(view_p(&c, &y).refined.0, 2 * T / 10);
    // x mines again later: it must not get a share of the fee charged before
    give_unrefined(&mut c, &x, T);
    assert_eq!(view_p(&c, &x).refined.0, 0);
    check_invariants(&c, &[x, y], 0);
}

#[test]
#[should_panic(expected = "nothing to claim")]
fn claiming_nothing_fails() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    claim_tokens(&mut c, &a, None);
}

// ---------------- v6: slots, lazy bookkeeping, reveal rewards ----------------

fn hash_slot(who: &AccountId, slot: u32, r: u64, side: &str, salt: &str) -> String {
    env::sha256(commit_preimage(who, slot, r, side, salt).as_bytes()).iter().map(|b| format!("{:02x}", b)).collect()
}
fn salt_s(who: &AccountId, slot: u32, r: u64) -> String {
    format!("salt-{}-{}-{}-0123456789abcdef", who, slot, r)
}
fn commit_s(c: &mut Contract, who: &AccountId, slot: u32, r: u64, side: &str, amount: u128) {
    ctx(who, t_commit(r));
    c.commit(U64(r), Some(slot), U128(amount), hash_slot(who, slot, r, side, &salt_s(who, slot, r)), None);
}
fn reveal_s(c: &mut Contract, by: &AccountId, who: &AccountId, slot: u32, r: u64, side: &str) {
    ctx(by, t_reveal(r));
    c.reveal(U64(r), Some(slot), side.into(), salt_s(who, slot, r), Some(who.clone()));
}
/// `by` reveals `who`'s slot-0 bet made with the plain `commit` helper.
fn reveal_by(c: &mut Contract, by: &AccountId, who: &AccountId, r: u64, side: &str) {
    ctx(by, t_reveal(r));
    c.reveal(U64(r), None, side.into(), salt(who, r), Some(who.clone()));
}
fn new_slot(c: &mut Contract, who: &AccountId) -> u32 {
    ctx(who, G);
    c.open_slot()
}

#[test]
fn a_refining_fee_is_never_divided_by_dust() {
    // audit finding 1: with the other holders down to 1 yocto, the fee used to be divided by 1
    // and the index pushed toward u128::MAX, after which every claim overflowed
    let mut c = setup();
    let (m, d) = (acc("mallory.testnet"), acc("dust.testnet"));
    join(&mut c, &m);
    join(&mut c, &d);
    give_unrefined(&mut c, &m, 10 * T);
    give_unrefined(&mut c, &d, 10_000_000_000); // 1e-8 BEFEWER: the step would still fit in u128
    let ix = c.refine_index;
    assert_eq!(claim_tokens(&mut c, &m, Some(5_000)), 45 * T / 10);
    assert_eq!(c.refine_index, ix, "others hold less than 1 BEFEWER: the index does not move");
    assert_eq!(c.get_status().refine_to_pot.0, T / 2, "the fee went to the pot");
    // the last holder can always claim everything
    assert_eq!(claim_tokens(&mut c, &m, None), 45 * T / 10);
    assert_eq!(view_p(&c, &d).refined.0, 0);
    check_invariants(&c, &[m, d], 0);
}

#[test]
fn a_dominant_holder_cannot_get_its_own_refining_fee_back() {
    // audit finding 5: claiming 99.99% used to share the fee with the claimant's own 0.01%
    let mut c = setup();
    let w = acc("whale.testnet");
    join(&mut c, &w);
    give_unrefined(&mut c, &w, 10 * T);
    let first = claim_tokens(&mut c, &w, Some(9_999));
    let rest = claim_tokens(&mut c, &w, None);
    assert_eq!(first + rest, 9 * T, "90% either way: the 10% fee never comes back");
    assert_eq!(c.get_status().refine_to_pot.0, T, "nobody else holds unrefined BEFEWER: the fee went to the pot");
    check_invariants(&c, &[w], 0);
}

#[test]
fn refundable_slot_fees_are_not_spendable_by_the_treasury() {
    // audit finding 7: an open slot's fee left the owed total, so a balance-limited treasury
    // could spend it and the refund on close_slot would then come out of players' NEAR
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    donate(&mut c, 3 * N, now_g());
    ctx(&a, now_g());
    let s = c.get_status();
    let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
    let held = s.balances_total.0 + s.escrow.0 + s.storage_held.0 + s.storage_fees.0 + storage + SAFETY_RESERVE + N;
    ctx_full(&a, now_g(), 0, held, vec![]);
    assert_eq!(c.get_status().treasury_spendable.0, N);
    for _ in 0..20 {
        let _ = c.open_slot();
    }
    ctx_full(&a, now_g(), 0, held, vec![]);
    let storage2 = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
    assert!(c.get_status().treasury_spendable.0 <= N - (storage2 - storage), "20 slot fees did not become spendable");
}

#[test]
fn slots_bet_independently_share_the_balance_and_closing_refunds_the_fee() {
    let mut c = setup();
    let (a, o) = (acc("alice.testnet"), acc("other.testnet"));
    join(&mut c, &a);
    join(&mut c, &o);
    let s1 = new_slot(&mut c, &a);
    let s2 = new_slot(&mut c, &a);
    assert_eq!((s1, s2), (1, 2));
    assert_eq!(bal(&c, &a), START - 2 * SLOT_FEE);
    // same round, same account: slot 1 on A, slot 2 on B (the contract allows one bet per slot)
    commit_s(&mut c, &a, s1, 0, "A", N);
    commit_s(&mut c, &a, s2, 0, "B", N);
    commit_s(&mut c, &o, 0, 0, "B", N);
    reveal_s(&mut c, &a, &a, s1, 0, "A");
    reveal_s(&mut c, &a, &a, s2, 0, "B");
    reveal_s(&mut c, &o, &o, 0, 0, "B");
    ctx(&a, t_after(0));
    c.claim(None, Some(s1));
    c.claim(None, Some(s2));
    let p = c.get_player(a.clone());
    let v1 = p.slots.iter().find(|x| x.slot == s1).unwrap();
    let v2 = p.slots.iter().find(|x| x.slot == s2).unwrap();
    assert_eq!((v1.wins, v1.streak, v2.losses, v2.streak), (1, 1, 1, 0), "each slot keeps its own record");
    // won N on slot 1, lost N on slot 2: the account pays the two fees net of its reveal rewards
    assert_eq!(bal(&c, &a), START - 2 * SLOT_FEE - 2 * cost(N));
    ctx(&a, t_after(0));
    c.close_slot(s2);
    assert_eq!(bal(&c, &a), START - SLOT_FEE - 2 * cost(N), "closing a slot refunds its fee");
    assert!(c.get_player(a.clone()).slots.iter().all(|x| x.slot != s2));
    check_invariants(&c, &[a, o], 0);
}

#[test]
#[should_panic(expected = "slot 0 cannot be closed")]
fn slot_zero_cannot_be_closed() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    ctx(&a, G);
    c.close_slot(0);
}

#[test]
#[should_panic(expected = "has a bet in a round that has not finished")]
fn a_slot_with_a_running_bet_cannot_be_closed() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    let s1 = new_slot(&mut c, &a);
    commit_s(&mut c, &a, s1, 0, "A", N);
    ctx(&a, t_reveal(0));
    c.close_slot(s1);
}

#[test]
#[should_panic(expected = "no such slot")]
fn betting_from_a_slot_that_does_not_exist_fails() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    commit_s(&mut c, &a, 5, 0, "A", N);
}

/// One slot always on A, one always on B: whichever side runs three in a row, its slot mines.
#[test]
fn an_a_slot_and_a_b_slot_always_carry_the_winning_run() {
    let mut c = setup();
    let (a, b1, b2) = (acc("alice.testnet"), acc("b1.testnet"), acc("b2.testnet"));
    for p in [&a, &b1, &b2] {
        join(&mut c, p);
    }
    let (sa, sb) = (new_slot(&mut c, &a), new_slot(&mut c, &a));
    // others make A the smaller side three times in a row
    for r in 0..3u64 {
        commit_s(&mut c, &a, sa, r, "A", N / 10);
        commit_s(&mut c, &a, sb, r, "B", N / 10);
        commit(&mut c, &b1, r, "B", N);
        commit(&mut c, &b2, r, "A", N / 2);
        reveal_s(&mut c, &a, &a, sa, r, "A");
        reveal_s(&mut c, &a, &a, sb, r, "B");
        reveal(&mut c, &b1, r, "B");
        reveal(&mut c, &b2, r, "A");
    }
    ctx(&b1, t_after(2));
    c.settle_due(); // anyone settles; nobody books
    let p = c.get_player(a.clone());
    let va = p.slots.iter().find(|x| x.slot == sa).unwrap();
    assert_eq!(va.open.iter().find(|o| o.round.0 == 2).unwrap().streak_if_win, 3);
    // b2 also won three in a row on A: the 3-token pot splits by stake, 0.1 vs 0.5 NEAR
    assert_eq!(p.unrefined.0, 3 * T * 100 / 600, "the A slot's share, shown before booking");
    assert_eq!(c.get_player(b2.clone()).unrefined.0, 3 * T * 500 / 600);
    let vb = p.slots.iter().find(|x| x.slot == sb).unwrap();
    assert!(vb.open.iter().all(|o| o.mined.0 == 0), "the B slot lost every round");
    check_invariants(&c, &[a, b1, b2], 0);
}

#[test]
fn views_show_settled_results_before_they_are_booked_and_booking_matches() {
    let mut c = setup();
    let (a, b) = (acc("alice.testnet"), acc("bob.testnet"));
    join(&mut c, &a);
    join(&mut c, &b);
    commit(&mut c, &a, 0, "A", N);
    commit(&mut c, &b, 0, "B", 2 * N);
    reveal(&mut c, &a, 0, "A");
    reveal(&mut c, &b, 0, "B");
    // round 0 finishes; b bets in round 2, which settles round 0 (b is booked, a is not)
    commit(&mut c, &b, 2, "A", N / 10);
    assert!(c.get_round(U64(0)).settled, "a later bet settled the finished round");
    let before = bal(&c, &a);
    let v = c.get_player(a.clone());
    assert_eq!(v.open[0].result.as_deref(), Some("win"));
    assert_eq!(v.pending_near.0, 2 * N + st(&a), "pending = 2x the stake + the storage back");
    // a's next bet books round 0 before taking the new stake
    commit(&mut c, &a, 2, "B", N / 10);
    assert_eq!(bal(&c, &a), before + v.pending_near.0 - N / 10 - fee(N / 10) - st(&a));
    check_invariants(&c, &[a, b], 0);
}

#[test]
fn rounds_settle_in_order_when_anyone_bets() {
    let mut c = setup();
    let (a, b, z) = (acc("alice.testnet"), acc("bob.testnet"), acc("zed.testnet"));
    for p in [&a, &b, &z] {
        join(&mut c, p);
    }
    for r in 0..3u64 {
        commit(&mut c, &a, r, "A", N);
        commit(&mut c, &b, r, "B", 3 * N / 2);
        reveal(&mut c, &a, r, "A");
        reveal(&mut c, &b, r, "B");
    }
    // zed never played those rounds; its bet in round 5 settles rounds 0..2, oldest first
    commit(&mut c, &z, 5, "A", N / 10);
    let st = c.get_status();
    assert_eq!(st.unsettled, 1, "only zed's own round 5 is still waiting");
    assert_eq!(st.rounds_settled.0, 3);
    for r in 0..3u64 {
        assert!(c.get_round(U64(r)).settled);
    }
    assert_eq!(st.treasury.0, 3 * (cost(N) + cost(3 * N / 2) + N / 2), "all three rounds paid the treasury");
    check_invariants(&c, &[a, b, z], 0);
}

/// A split that does not divide evenly leaves a remainder: once everyone booked, it goes back
/// to the pot instead of sitting in the unrefined total forever.
#[test]
fn the_rounding_remainder_of_a_split_goes_back_to_the_pot() {
    let mut c = setup();
    let (a, e, b1, b2) = (acc("alice.testnet"), acc("eve.testnet"), acc("b1.testnet"), acc("b2.testnet"));
    for p in [&a, &e, &b1, &b2] {
        join(&mut c, p);
    }
    // alice (1 NEAR) and eve (0.3 NEAR) both win rounds 0..2: 3 tokens split 1000:300 shares
    play_alice_minority(&mut c, 0..3, &a, Some((&e, 3 * N / 10)));
    ctx(&a, t_after(2));
    for p in [&a, &e, &b1, &b2] {
        c.claim(Some(p.clone()), None);
    }
    let pa = 3 * T * 1000 / 1300;
    let pe = 3 * T * 300 / 1300;
    let dust = 3 * T - pa - pe;
    assert!(dust > 0, "the split does not divide evenly");
    let s = c.get_status();
    assert_eq!((s.dust_to_pot.0, s.pot.0), (dust, dust));
    assert_eq!(s.unrefined_total.0, pa + pe);
    check_invariants(&c, &[a, e, b1, b2], 0);
}

/// Rounds nobody touched pile up; one call settles several, oldest first.
#[test]
fn settle_due_catches_up_on_several_rounds() {
    let mut c = setup();
    let (a, z) = (acc("alice.testnet"), acc("zed.testnet"));
    join(&mut c, &a);
    join(&mut c, &z);
    for r in 0..3u64 {
        commit(&mut c, &a, r, "A", N / 10); // never revealed
    }
    // alice's round-2 bet settled round 0; rounds 1 and 2 wait for anyone
    assert_eq!(c.get_status().unsettled, 2);
    commit(&mut c, &z, 6, "A", N / 10);
    let st = c.get_status();
    assert_eq!((st.unsettled, st.rounds_settled.0), (1, 3), "zed's bet settled both, leaving only its own round");
    check_invariants(&c, &[a, z], 0);
}

/// The fix for lazy bookkeeping: a mined share collects refining fees from the moment its round
/// settles, even while its owner has not come back to book it.
#[test]
fn an_unbooked_mined_share_still_collects_refining_fees() {
    let mut c = setup();
    let (a, b1, b2, x) = (acc("alice.testnet"), acc("b1.testnet"), acc("b2.testnet"), acc("x.testnet"));
    for p in [&a, &b1, &b2, &x] {
        join(&mut c, p);
    }
    play_alice_minority(&mut c, 0..3, &a, None); // alice mines 3 tokens in round 2, books nothing
    ctx(&b1, t_after(2));
    c.settle_due();
    assert_eq!(c.get_status().unrefined_total.0, 3 * T, "counted as unrefined the moment it was mined");
    give_unrefined(&mut c, &x, 3 * T);
    // x claims all: the 0.3 fee splits evenly between x's... nothing (x leaves) and alice's 3
    claim_tokens(&mut c, &x, None);
    assert_eq!(c.get_player(a.clone()).refined.0, 3 * T / 10, "alice's unbooked share got the whole fee");
    // alice comes back and books: she keeps exactly that
    ctx(&a, t_after(2));
    c.claim(None, None);
    let p = c.get_player(a.clone());
    assert_eq!((p.unrefined.0, p.refined.0), (3 * T, 3 * T / 10));
    check_invariants(&c, &[a, b1, b2, x], 0);
}

#[test]
fn a_registered_keeper_earns_the_reveal_reward_an_unregistered_one_does_not() {
    let mut c = setup();
    let (a, b, k, stranger) = (acc("alice.testnet"), acc("bob.testnet"), acc("keeper.testnet"), acc("stranger.testnet"));
    for p in [&a, &b, &k] {
        join(&mut c, p);
    }
    commit(&mut c, &a, 0, "A", N);
    commit(&mut c, &b, 0, "B", 2 * N);
    reveal_by(&mut c, &k, &a, 0, "A");
    reveal_by(&mut c, &stranger, &b, 0, "B");
    assert_eq!(bal(&c, &k), START + bounty(N), "the keeper got 80% of alice's fee");
    assert_eq!(bal(&c, &stranger), 0, "no game balance: no reward (the fee stays with the round)");
    ctx(&a, t_after(0));
    c.claim(Some(a.clone()), None);
    c.claim(Some(b.clone()), None);
    assert_eq!(bal(&c, &a), START + N - fee(N), "revealed by someone else: alice pays the whole fee");
    let r = c.get_round(U64(0));
    assert_eq!(r.to_treasury.0, fee(N) - bounty(N) + fee(2 * N) + N);
    check_invariants(&c, &[a, b, k], 0);
}

#[test]
fn a_void_round_refunds_the_stake_and_the_fee_minus_the_reveal_reward() {
    let mut c = setup();
    let (a, k) = (acc("alice.testnet"), acc("keeper.testnet"));
    join(&mut c, &a);
    join(&mut c, &k);
    commit(&mut c, &a, 0, "A", N); // alone: one-sided, void
    reveal_by(&mut c, &k, &a, 0, "A");
    ctx(&a, t_after(0));
    c.claim(None, None);
    assert_eq!(bal(&c, &a), START - bounty(N) - REC, "back: all but the keeper's reward and (alone) the whole round record");
    assert_eq!(bal(&c, &k), START + bounty(N));
    check_invariants(&c, &[a, k], 0);
}

#[test]
fn reveal_many_skips_bad_items_instead_of_failing() {
    let mut c = setup();
    let (a, b, k) = (acc("alice.testnet"), acc("bob.testnet"), acc("keeper.testnet"));
    for p in [&a, &b, &k] {
        join(&mut c, p);
    }
    commit(&mut c, &a, 0, "A", N);
    commit(&mut c, &b, 0, "B", 2 * N);
    ctx(&k, t_reveal(0));
    let item = |who: &AccountId, side: &str, salt: String| RevealItem { round: U64(0), slot: 0, account_id: who.clone(), side: side.into(), salt };
    let items = vec![
        item(&a, "B", salt(&a, 0)),
        item(&a, "A", "wrong-salt-0123456789".into()),
        item(&a, "A", salt(&a, 0)),
        item(&a, "A", salt(&a, 0)),
        item(&b, "B", salt(&b, 0)),
    ];
    assert_eq!(c.reveal_many(items), 5);
    let r = c.get_round(U64(0));
    assert_eq!((r.reveals_a, r.reveals_b), (1, 1));
    assert_eq!(bal(&c, &k), START + bounty(N) + bounty(2 * N));
}

#[test]
fn reveal_many_stops_when_gas_runs_low() {
    let mut c = setup();
    let (a, k) = (acc("alice.testnet"), acc("keeper.testnet"));
    join(&mut c, &a);
    join(&mut c, &k);
    commit(&mut c, &a, 0, "A", N);
    let mut b = VMContextBuilder::new();
    b.current_account_id(me()).predecessor_account_id(k.clone()).block_timestamp(t_reveal(0))
        .account_balance(NearToken::from_yoctonear(BIG)).prepaid_gas(Gas::from_tgas(10));
    testing_env!(b.build());
    let items = vec![RevealItem { round: U64(0), slot: 0, account_id: a.clone(), side: "A".into(), salt: salt(&a, 0) }];
    assert_eq!(c.reveal_many(items), 0, "less than the margin left: nothing attempted, caller retries");
}

#[test]
fn withdraw_books_the_listed_slots_first() {
    let mut c = setup();
    let (a, b) = (acc("alice.testnet"), acc("bob.testnet"));
    join(&mut c, &a);
    join(&mut c, &b);
    let s1 = new_slot(&mut c, &a);
    commit_s(&mut c, &a, s1, 0, "A", N);
    commit(&mut c, &b, 0, "B", 2 * N);
    reveal_s(&mut c, &a, &a, s1, 0, "A");
    reveal(&mut c, &b, 0, "B");
    ctx(&a, t_after(0));
    let _ = c.withdraw(None, Some(vec![0, s1]));
    // everything left the game: the win from slot 1 was booked first
    assert_eq!(bal(&c, &a), 0);
    let p = c.get_player(a.clone());
    assert!(p.slots.iter().all(|x| x.open.is_empty()) && p.pending_near.0 == 0, "nothing left unbooked");
    assert_eq!(c.get_status().balances_total.0, bal(&c, &b));
}

// ---------------- treasury safety ----------------

#[test]
fn the_treasury_never_spends_player_money() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    commit(&mut c, &a, 0, "A", N);
    donate(&mut c, 3 * N, t_commit(0));
    ctx(&a, t_commit(0)); // a fresh context: same storage_usage as the ones below
    let s = c.get_status();
    let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
    let owed = s.balances_total.0 + s.escrow.0 + s.storage_held.0 + s.storage_fees.0 + storage + SAFETY_RESERVE;
    // the contract really holds only 1 NEAR more than it owes: only that 1 NEAR is spendable
    ctx_full(&a, t_commit(0), 0, owed + N, vec![]);
    assert_eq!(c.get_status().treasury_spendable.0, N);
    ctx_full(&a, t_commit(0), 0, owed - 1, vec![]);
    assert_eq!(c.get_status().treasury_spendable.0, 0);
}

#[test]
fn befewer_sent_to_the_contract_is_burned() {
    let mut c = setup();
    let (a, b1, b2) = (acc("alice.testnet"), acc("b1.testnet"), acc("b2.testnet"));
    for p in [&a, &b1, &b2] {
        join(&mut c, p);
    }
    play_alice_minority(&mut c, 0..3, &a, None);
    ctx(&a, t_after(2));
    c.claim_befewer(None, None); // 3 unrefined -> 2.7 in the wallet (alone, so the 0.3 fee goes to the pot)
    ctx_full(&a, t_after(2), 1, BIG, vec![]);
    c.ft_transfer(me(), U128(T), None);
    let s = c.get_status();
    assert_eq!(tokens(&c, &a), 27 * T / 10 - T);
    assert_eq!((s.total_supply.0, s.total_burned.0), (27 * T / 10 - T, T));
    assert_eq!(tokens(&c, &me()), 0);
}

// ---------------- graduation and buybacks ----------------

fn now_g() -> u64 {
    G + 100 * MIN
}

/// Walk all graduation steps with successful DEX replies. Returns the contract.
fn graduated(donation: u128) -> Contract {
    let mut c = setup();
    donate(&mut c, donation, now_g());
    let k = acc("keeper.testnet");
    // 0: wrap the NEAR
    ctx(&k, now_g());
    let _ = c.graduate();
    assert!(c.get_status().dex.busy);
    callback(now_g(), PromiseResult::Successful(vec![]));
    c.on_graduate(STEP_START, None);
    // 1: register at the DEX (the pool is created later, together with its liquidity)
    ctx(&k, now_g());
    let _ = c.graduate();
    callback(now_g(), PromiseResult::Successful(vec![]));
    c.on_graduate(STEP_REGISTER, None);
    // 2: deposit the wNEAR
    let near_amount = c.get_status().dex.near_amount.0;
    ctx(&k, now_g());
    let _ = c.graduate();
    callback(now_g(), ok_json(U128(near_amount)));
    c.on_graduate(STEP_SEND_NEAR, None);
    // 3: mint + deposit the seed
    ctx(&k, now_g());
    let _ = c.graduate();
    let seed = c.get_status().dex.seed.0;
    assert_eq!(tokens(&c, &dex()), seed, "the seed sits with the DEX");
    callback(now_g(), ok_json(U128(seed)));
    c.on_graduate(STEP_SEND_TOKEN, None);
    // 4: learn the next pool id (7), then create pool 7 and fill it in one receipt
    ctx(&k, now_g());
    let _ = c.graduate();
    callback(now_g(), ok_json(7u64));
    let _ = c.on_pool_count();
    callback(now_g(), ok_json(U128(1_000_000)));
    c.on_graduate(STEP_ADD_LIQUIDITY, Some(7));
    c
}

#[test]
#[should_panic(expected = "the treasury needs")]
fn graduation_waits_for_the_threshold() {
    let mut c = setup();
    donate(&mut c, 5 * N - 1, now_g());
    ctx(&acc("keeper.testnet"), now_g());
    let _ = c.graduate();
}

#[test]
fn graduation_opens_the_pool_with_the_treasury_and_a_seed_equal_to_mined() {
    let c = graduated(6 * N);
    let s = c.get_status();
    assert_eq!(s.dex.stage, "open");
    assert_eq!(s.dex.pool_id, Some(7));
    assert_eq!(s.dex.near_amount.0, 6 * N - GRADUATION_COST);
    assert_eq!(s.dex.seed.0, T, "nothing mined yet: the seed is the 1-token minimum");
    assert_eq!(s.treasury.0, 0, "the whole spendable treasury went into the pool");
    assert_eq!(s.dex.shares.0, 1_000_000);
    assert_eq!(s.issued.0, T, "the seed counts against max_supply");
}

#[test]
fn a_failed_graduation_step_is_retried_and_a_failed_wrap_refunds_the_treasury() {
    let mut c = setup();
    donate(&mut c, 6 * N, now_g());
    let k = acc("keeper.testnet");
    ctx(&k, now_g());
    let _ = c.graduate();
    callback(now_g(), PromiseResult::Failed);
    c.on_graduate(STEP_START, None);
    let s = c.get_status();
    assert_eq!((s.dex.step, s.treasury.0, s.dex.busy), (STEP_START, 6 * N, false));
    // try again, succeed, then fail creating the pool: stays on that step
    ctx(&k, now_g());
    let _ = c.graduate();
    callback(now_g(), PromiseResult::Successful(vec![]));
    c.on_graduate(STEP_START, None);
    ctx(&k, now_g());
    let _ = c.graduate();
    callback(now_g(), PromiseResult::Failed);
    c.on_graduate(STEP_REGISTER, None);
    assert_eq!(c.get_status().dex.step, STEP_REGISTER);
    assert_eq!(c.get_status().dex.pool_id, None);
}

/// Steps 0-3 of the pool opening, leaving step 4 (create + fill) to the caller.
fn ready_to_add_liquidity() -> Contract {
    let mut c = setup();
    donate(&mut c, 6 * N, now_g());
    let k = acc("keeper.testnet");
    for (step, res) in [(STEP_START, PromiseResult::Successful(vec![])), (STEP_REGISTER, PromiseResult::Successful(vec![]))] {
        ctx(&k, now_g());
        let _ = c.graduate();
        callback(now_g(), res);
        c.on_graduate(step, None);
    }
    let near_amount = c.get_status().dex.near_amount.0;
    ctx(&k, now_g());
    let _ = c.graduate();
    callback(now_g(), ok_json(U128(near_amount)));
    c.on_graduate(STEP_SEND_NEAR, None);
    ctx(&k, now_g());
    let _ = c.graduate();
    callback(now_g(), ok_json(U128(T)));
    c.on_graduate(STEP_SEND_TOKEN, None);
    assert_eq!(c.get_status().dex.step, STEP_ADD_LIQUIDITY);
    c
}

#[test]
fn the_pool_is_created_and_filled_in_one_receipt_with_min_amounts() {
    let mut c = ready_to_add_liquidity();
    let k = acc("keeper.testnet");
    ctx(&k, now_g());
    let _ = c.graduate();
    assert!(fn_call_args("add_simple_pool").is_empty(), "no pool yet: first the id it will get");
    assert_eq!(fn_call_args("get_number_of_pools").len(), 1);
    callback(now_g(), ok_json(41u64));
    let _ = c.on_pool_count();
    let receipts = near_sdk::test_utils::get_created_receipts();
    let batch = receipts
        .iter()
        .find(|r| r.actions.iter().any(|a| matches!(a, near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. } if method_name == b"add_simple_pool")))
        .expect("pool creation");
    let methods: Vec<String> = batch
        .actions
        .iter()
        .filter_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. } => Some(String::from_utf8(method_name.clone()).unwrap()),
            _ => None,
        })
        .collect();
    assert_eq!(methods, vec!["add_simple_pool", "add_liquidity"], "one receipt: it reverts as a whole");
    let near_amount = c.get_status().dex.near_amount.0;
    let args = fn_call_args("add_liquidity")[0].clone();
    assert!(args.contains(r#""pool_id":41"#), "{args}");
    assert!(args.contains(&format!(r#""min_amounts":["{}","{}"]"#, near_amount, T)), "{args}");
    callback(now_g(), ok_json(U128(5_000)));
    c.on_graduate(STEP_ADD_LIQUIDITY, Some(41));
    let s = c.get_status();
    assert_eq!((s.dex.stage.as_str(), s.dex.pool_id, s.dex.shares.0), ("open", Some(41), 5_000));
}

#[test]
fn if_someone_creates_a_pool_in_between_the_last_step_is_retried() {
    let mut c = ready_to_add_liquidity();
    let k = acc("keeper.testnet");
    ctx(&k, now_g());
    let _ = c.graduate();
    callback(now_g(), ok_json(41u64));
    let _ = c.on_pool_count();
    // pool 41 was someone else's by then: add_liquidity failed and the receipt reverted
    callback(now_g(), PromiseResult::Failed);
    c.on_graduate(STEP_ADD_LIQUIDITY, Some(41));
    let s = c.get_status();
    assert_eq!((s.dex.step, s.dex.busy, s.dex.pool_id), (STEP_ADD_LIQUIDITY, false, None));
    // shares without the pool id they were added to never count as open
    callback(now_g(), ok_json(U128(5_000)));
    c.on_graduate(STEP_ADD_LIQUIDITY, None);
    assert_eq!(c.get_status().dex.stage, "adding liquidity");
    // and a failed lookup also just waits for the next try
    ctx(&k, now_g());
    let _ = c.graduate();
    callback(now_g(), PromiseResult::Failed);
    let _ = c.on_pool_count();
    assert_eq!((c.get_status().dex.step, c.get_status().dex.busy), (STEP_ADD_LIQUIDITY, false));
}

#[test]
#[should_panic(expected = "in flight")]
fn one_graduation_step_at_a_time() {
    let mut c = setup();
    donate(&mut c, 6 * N, now_g());
    ctx(&acc("keeper.testnet"), now_g());
    let _ = c.graduate();
    let _ = c.graduate();
}

#[test]
fn a_refunded_seed_is_resent_not_minted_twice() {
    let mut c = setup();
    donate(&mut c, 6 * N, now_g());
    let k = acc("keeper.testnet");
    for (step, res) in [(STEP_START, PromiseResult::Successful(vec![])), (STEP_REGISTER, ok_json(3u64))] {
        ctx(&k, now_g());
        let _ = c.graduate();
        callback(now_g(), res);
        c.on_graduate(step, None);
    }
    let near_amount = c.get_status().dex.near_amount.0;
    ctx(&k, now_g());
    let _ = c.graduate();
    callback(now_g(), ok_json(U128(near_amount)));
    c.on_graduate(STEP_SEND_NEAR, None);
    ctx(&k, now_g());
    let _ = c.graduate();
    // the DEX refused: ft_resolve_transfer moved the seed back to us and reported 0 used
    ctx_full(&me(), now_g(), 0, BIG, vec![ok_json(U128(T))]); // ft_on_transfer said: all unused
    c.ft_resolve_transfer(me(), dex(), U128(T));
    callback(now_g(), ok_json(U128(0)));
    c.on_graduate(STEP_SEND_TOKEN, None);
    assert_eq!(c.get_status().dex.step, STEP_SEND_TOKEN);
    assert_eq!(tokens(&c, &me()), T);
    ctx(&k, now_g());
    let _ = c.graduate();
    let s = c.get_status();
    assert_eq!((s.issued.0, s.total_supply.0), (T, T), "retry re-sends the same seed");
    assert_eq!(tokens(&c, &dex()), T);
}

fn fn_call_args(method: &str) -> Vec<String> {
    near_sdk::test_utils::get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } if method_name == method.as_bytes() => {
                Some(String::from_utf8(args).unwrap())
            }
            _ => None,
        })
        .collect()
}

const DAY: u64 = DAY_NS;

#[test]
fn buyback_spends_1_365th_of_the_treasury_per_day_and_burns_what_comes_back() {
    let mut c = graduated(6 * N);
    donate(&mut c, 365 * N, now_g());
    let k = acc("keeper.testnet");
    let t = now_g() + DAY;
    ctx(&k, t);
    assert_eq!(c.get_status().dex.buyback_now.0, N, "365 NEAR spendable, a day since the pool opened: 1 NEAR");
    let ceiling = c.get_status().dex.buyback_ceiling.0;
    assert_eq!(ceiling, ceiling_from(6 * N - GRADUATION_COST, T), "first ceiling: 125% of the opening price");
    let _ = c.buyback();
    assert_eq!(c.get_status().treasury.0, 364 * N);
    let min_out = (U256::from(N) * U256::from(TOKEN) / U256::from(ceiling)).as_u128();
    assert!(fn_call_args("ft_transfer_call")[0].contains(&format!(r#"\"min_amount_out\":\"{}\""#, min_out)), "the swap pays at most the ceiling");
    callback(t, ok_json(U128(N)));
    c.on_buyback(U128(0), U128(N), Some(U64(0)));
    // the pool sends the bought BEFEWER to the contract: it is burned on arrival
    ctx_full(&dex(), t, 1, BIG, vec![]);
    c.ft_transfer(me(), U128(T / 10), None);
    let s = c.get_status();
    assert_eq!((s.dex.bought_near.0, s.dex.bought_burned.0, s.dex.buybacks), (N, T / 10, 1));
    assert_eq!(s.total_burned.0, T / 10);
    assert_eq!(s.total_supply.0, T - T / 10);
    assert_eq!(tokens(&c, &me()), 0);
    let log = c.get_buybacks();
    assert_eq!(log.len(), 1, "each buyback is listed");
    assert_eq!((log[0].at.0, log[0].near_in.0, log[0].spent.0, log[0].burned.0), (t, N, N, T / 10));
    assert_eq!(s.dex.buyback_ceiling.0, 125 * N / 10, "paid 10 NEAR per BEFEWER: next time at most 12.5");
}

#[test]
#[should_panic(expected = "wait until it reaches 0.1 NEAR")]
fn a_buyback_below_a_tenth_of_a_near_waits() {
    let mut c = graduated(6 * N);
    donate(&mut c, 3 * N, now_g()); // 3 NEAR at 1/365 a day: 0.1 NEAR after 12.2 days
    ctx(&acc("keeper.testnet"), now_g() + 12 * DAY);
    let _ = c.buyback();
}

#[test]
fn a_small_treasury_buys_back_once_its_share_has_built_up() {
    let mut c = graduated(6 * N);
    donate(&mut c, 3 * N, now_g());
    let k = acc("keeper.testnet");
    let due = now_g() + 365 * DAY / 30; // 0.1 NEAR * 365 days / 3 NEAR = 12.17 days (exactly)
    ctx(&k, now_g() + MIN);
    assert_eq!(c.get_status().dex.next_buyback_at.0, due, "12.2 days after the pool opened");
    ctx(&k, due - 1);
    assert!(c.get_status().dex.buyback_now.0 < MIN_BUYBACK, "a nanosecond early: not yet");
    ctx(&k, due);
    let share = c.get_status().dex.buyback_now.0;
    assert_eq!(share, MIN_BUYBACK);
    let _ = c.buyback();
    assert_eq!(c.get_status().treasury.0, 3 * N - share);
}

#[test]
fn the_share_starts_building_when_the_pool_opens() {
    let mut c = graduated(6 * N);
    donate(&mut c, 365 * N, now_g());
    ctx(&acc("keeper.testnet"), now_g() + 10 * MIN);
    // not since the contract was deployed (that would be the full buyback_max right away)
    assert_eq!(c.get_status().dex.buyback_now.0, 365 * N * (10 * MIN) as u128 / (365 * DAY as u128));
}

#[test]
fn a_big_inflow_is_spent_at_1_365th_a_day_not_per_buyback() {
    let mut c = graduated(6 * N);
    donate(&mut c, 3650 * N, now_g());
    let k = acc("keeper.testnet");
    // a keeper that checks every 10 minutes for a day and buys whenever it is due
    let mut buys = 0;
    let mut t = now_g();
    while t < now_g() + DAY {
        t += 10 * MIN;
        ctx(&k, t);
        let d = c.get_status().dex;
        if t < d.next_buyback_at.0 || d.buyback_now.0 < MIN_BUYBACK {
            continue;
        }
        let before = c.get_status().treasury.0;
        let _ = c.buyback();
        let fresh = before - c.get_status().treasury.0;
        callback(t, ok_json(U128(fresh)));
        c.on_buyback(U128(0), U128(fresh), Some(U64(0)));
        buys += 1;
    }
    let spent = 3650 * N - c.get_status().treasury.0;
    // 10 NEAR a day (3650 / 365), give or take the last unspent share; buying 1/365 per
    // buyback every 10 minutes would have spent 144 NEAR (buyback_max is 1 NEAR in tests)
    assert!(spent > 99 * N / 10 && spent <= 10 * N, "spent {} yoctoNEAR", spent);
    assert_eq!(buys, 72, "0.07 NEAR builds up per 10 minutes: one 0.14 NEAR buy every 20 minutes");
}

#[test]
fn a_long_wait_never_spends_more_than_the_treasury_or_buyback_max() {
    let mut c = graduated(6 * N);
    donate(&mut c, N / 2, now_g());
    let k = acc("keeper.testnet");
    ctx(&k, now_g() + 3 * 365 * DAY); // three years: 1.5x the treasury built up
    assert_eq!(c.get_status().dex.buyback_now.0, N / 2, "at most the spendable treasury");
    donate(&mut c, 3000 * N, now_g() + 3 * 365 * DAY);
    ctx(&k, now_g() + 3 * 365 * DAY);
    assert_eq!(c.get_status().dex.buyback_now.0, N, "at most buyback_max");
}

#[test]
fn a_treasury_too_small_to_ever_buy_shows_no_next_buyback() {
    let mut c = graduated(6 * N);
    donate(&mut c, N / 20, now_g());
    ctx(&acc("keeper.testnet"), now_g() + MIN);
    assert_eq!(c.get_status().dex.next_buyback_at.0, 0);
}

#[test]
#[should_panic(expected = "too soon")]
fn buybacks_are_rate_limited() {
    let mut c = graduated(6 * N);
    donate(&mut c, 365 * N, now_g());
    let k = acc("keeper.testnet");
    ctx(&k, now_g() + DAY);
    let _ = c.buyback();
    callback(now_g() + DAY, ok_json(U128(N)));
    c.on_buyback(U128(0), U128(N), Some(U64(0)));
    ctx(&k, now_g() + DAY + MIN / 2);
    let _ = c.buyback();
}

#[test]
fn a_refused_swap_keeps_the_wnear_and_raises_the_price_ceiling_by_a_quarter() {
    let mut c = graduated(6 * N);
    donate(&mut c, 365 * N, now_g());
    let k = acc("keeper.testnet");
    let t1 = now_g() + DAY;
    ctx(&k, t1);
    let ceil0 = c.get_status().dex.buyback_ceiling.0;
    let _ = c.buyback();
    callback(t1, ok_json(U128(0))); // the DEX refused (price above the ceiling): all came back as wNEAR
    c.on_buyback(U128(0), U128(N), Some(U64(0)));
    let s = c.get_status();
    assert_eq!((s.dex.held_wnear.0, s.dex.bought_near.0, s.treasury.0), (N, 0, 364 * N));
    assert_eq!(s.dex.buyback_ceiling.0, ceil0 * 5 / 4, "25% more next time");
    assert_eq!(c.get_buybacks()[0].spent.0, 0, "listed as not gone through");
    // next time it swaps the held wNEAR first (already buyback_max: nothing new from the treasury)
    let t2 = t1 + MIN;
    ctx(&k, t2);
    let _ = c.buyback();
    assert_eq!(c.get_status().treasury.0, 364 * N);
    callback(t2, PromiseResult::Failed); // and if the whole call fails
    c.on_buyback(U128(N), U128(0), Some(U64(t1)));
    let s = c.get_status();
    assert_eq!((s.dex.held_wnear.0, s.treasury.0), (N, 364 * N), "nothing is lost");
    assert_eq!(s.dex.next_buyback_at.0, t1 + MIN, "not even the time the share was building up");
}

#[test]
fn a_failed_buyback_keeps_the_share_built_up_so_far() {
    let mut c = graduated(6 * N);
    donate(&mut c, 365 * N, now_g());
    let k = acc("keeper.testnet");
    let t = now_g() + DAY;
    ctx(&k, t);
    let _ = c.buyback();
    callback(t, PromiseResult::Failed);
    c.on_buyback(U128(0), U128(N), Some(U64(0)));
    let s = c.get_status();
    assert_eq!((s.treasury.0, s.dex.buyback_now.0), (365 * N, N), "the NEAR and the day of share are both back");
    // a callback sent before the upgrade (no `last`) still settles
    ctx(&k, t);
    let _ = c.buyback();
    callback(t, PromiseResult::Failed);
    c.on_buyback(U128(0), U128(N), None);
    assert_eq!(c.get_status().treasury.0, 365 * N);
}

#[test]
fn the_buyback_list_keeps_the_last_100_newest_first_and_marks_swaps_that_failed() {
    let mut c = graduated(6 * N);
    donate(&mut c, 600_000 * N, now_g()); // 1.14 NEAR builds up per minute: every buy is buyback_max
    let k = acc("keeper.testnet");
    for i in 1..=(BUYBACKS_KEPT as u64 + 2) {
        let t = now_g() + i * MIN;
        ctx(&k, t);
        let _ = c.buyback();
        if i == BUYBACKS_KEPT as u64 + 2 {
            callback(t, PromiseResult::Failed); // the newest one does not go through
            c.on_buyback(U128(0), U128(N), Some(U64(t - MIN)));
        } else {
            callback(t, ok_json(U128(N))); // the pool took it all
            c.on_buyback(U128(0), U128(N), Some(U64(t - MIN)));
            ctx_full(&dex(), t, 1, BIG, vec![]);
            c.ft_transfer(me(), U128(T / 1000), None);
        }
    }
    let log = c.get_buybacks();
    assert_eq!(log.len(), BUYBACKS_KEPT);
    let (newest, next) = (&log[0], &log[1]);
    assert_eq!((newest.at.0, newest.spent.0, newest.burned.0), (now_g() + (BUYBACKS_KEPT as u64 + 2) * MIN, 0, 0));
    assert_eq!((next.at.0, next.spent.0, next.burned.0), (now_g() + (BUYBACKS_KEPT as u64 + 1) * MIN, N, T / 1000));
    assert_eq!(log[BUYBACKS_KEPT - 1].at.0, now_g() + 3 * MIN, "the two oldest dropped out");
    assert_eq!(c.get_status().dex.buybacks as usize, BUYBACKS_KEPT + 1, "the totals still count every swap that went through");
}

#[test]
#[should_panic(expected = "not open yet")]
fn no_buyback_before_the_pool_opens() {
    let mut c = setup();
    donate(&mut c, 3 * N, now_g());
    ctx(&acc("keeper.testnet"), now_g());
    let _ = c.buyback();
}

// ---------------- keepers and edge cases ----------------

#[test]
fn keeper_reveals_from_the_sealed_ciphertext() {
    let mut c = setup();
    let (a, b, keeper) = (acc("alice.testnet"), acc("bob.testnet"), acc("keeper.testnet"));
    join(&mut c, &a);
    join(&mut c, &b);
    for (who, side, amt) in [(&a, "A", N), (&b, "B", 2 * N)] {
        ctx(who, t_commit(0));
        let s = salt(who, 0);
        c.commit(U64(0), None, U128(amt), hash_hex(who, 0, side, &s), Some(format!("tlock-ciphertext-of-{}:{}", side, s)));
    }
    let list = c.get_round_commits(U64(0), 0, 10);
    assert_eq!(list.len(), 2);
    assert!(list.iter().all(|x| x.side.is_none() && x.sealed.is_some()));
    assert_eq!(list[0].hash, hash_hex(&a, 0, "A", &salt(&a, 0)), "view exposes the commitment");
    ctx(&keeper, t_reveal(0));
    c.reveal(U64(0), None, "A".into(), salt(&a, 0), Some(a.clone()));
    c.reveal(U64(0), None, "B".into(), salt(&b, 0), Some(b.clone()));
    let list = c.get_round_commits(U64(0), 0, 10);
    assert_eq!(list[0].side.as_deref(), Some("A"));
    assert!(list.iter().all(|x| x.sealed.is_none()), "ciphertext dropped on reveal");
    ctx(&keeper, t_after(0));
    c.claim(Some(a.clone()), None);
    c.claim(Some(b.clone()), None);
    assert_eq!(bal(&c, &a), START + N - fee(N));
    assert_eq!(bal(&c, &b), START - 2 * N - fee(2 * N));
    assert!(c.get_round_commits(U64(0), 0, 10).is_empty(), "round list removed once fully claimed");
    check_invariants(&c, &[a, b], 0);
}

#[test]
#[should_panic(expected = "hash does not match")]
fn keeper_cannot_reveal_a_different_side() {
    let mut c = setup();
    let (a, keeper) = (acc("alice.testnet"), acc("keeper.testnet"));
    join(&mut c, &a);
    commit(&mut c, &a, 0, "A", N);
    ctx(&keeper, t_reveal(0));
    c.reveal(U64(0), None, "B".into(), salt(&a, 0), Some(a.clone()));
}

#[test]
#[should_panic(expected = "sealed must be 1..1024 bytes")]
fn sealed_ciphertext_is_bounded() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    ctx(&a, t_commit(0));
    let s = salt(&a, 0);
    c.commit(U64(0), None, U128(N), hash_hex(&a, 0, "A", &s), Some("x".repeat(MAX_SEALED_LEN + 1)));
}

#[test]
#[should_panic(expected = "is not taking commits")]
fn late_commit_is_refused_not_moved_to_the_next_round() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    let s = salt(&a, 0);
    ctx(&a, G + C + 1); // round 0's window closed one nanosecond ago
    c.commit(U64(0), None, U128(N), hash_hex(&a, 0, "A", &s), None);
}

/// Pseudo-random play over many rounds: invariants hold after every step.
#[test]
fn random_play_keeps_invariants() {
    let mut c = setup();
    let players: Vec<AccountId> = (0..6).map(|i| acc(&format!("p{}.testnet", i))).collect();
    for p in &players {
        join(&mut c, p);
    }
    let mut seed: u64 = 42;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let min = N / 100;
    for r in 0..40u64 {
        let mut committed = vec![];
        for p in &players {
            if rnd() % 4 == 0 {
                continue;
            }
            let cap = bal(&c, p) / 4;
            if cap < min || c.get_player(p.clone()).open.len() >= MAX_OPEN_ROUNDS {
                continue;
            }
            let amt = min + (rnd() as u128 % (cap - min + 1));
            let side = if rnd() % 2 == 0 { "A" } else { "B" };
            commit(&mut c, p, r, side, amt);
            committed.push((p.clone(), side));
            check_invariants(&c, &players, 0);
        }
        for (p, side) in &committed {
            if rnd() % 10 == 0 {
                continue; // forfeit
            }
            reveal(&mut c, p, r, side);
        }
        if r % 3 == 2 {
            ctx(&players[0], t_after(r));
            for p in &players {
                c.claim(Some(p.clone()), None);
                check_invariants(&c, &players, 0);
            }
            // now and then someone claims part of its mined BEFEWER to the wallet
            for p in &players {
                let v = c.get_player(p.clone());
                if (v.unrefined.0 > 0 || v.refined.0 > 0) && rnd() % 3 == 0 {
                    ctx(p, t_after(r));
                    c.claim_befewer(Some((rnd() % 10_000 + 1) as u16), None);
                    check_invariants(&c, &players, 0);
                }
            }
        }
    }
    ctx(&players[0], t_after(50));
    for p in &players {
        c.claim(Some(p.clone()), None);
    }
    let s = c.get_status();
    assert_eq!(s.escrow.0, 0, "everything claimed -> nothing left in escrow");
    check_invariants(&c, &players, 0);
    assert!(s.treasury.0 > 0);
    assert!(s.mined.0 > 0, "40 random rounds should produce some 3-win streaks");
    assert!(s.refine_fees.0 > 0, "and some refining fees");
}

/// Three rounds where A is the smaller side: alice's two A slots and bob mine in round 2.
/// `wipe` drops round 2's list after alice reveals, as for a round played before the list existed.
fn three_a_rounds(wipe: bool) -> (Contract, [AccountId; 3], [u32; 2]) {
    let mut c = setup();
    let (a, b, cc) = (acc("alice.testnet"), acc("bob.testnet"), acc("carol.testnet"));
    for p in [&a, &b, &cc] {
        join(&mut c, p);
    }
    let (s1, s2) = (new_slot(&mut c, &a), new_slot(&mut c, &a));
    for r in 0..3u64 {
        commit_s(&mut c, &a, s1, r, "A", N / 10);
        commit_s(&mut c, &a, s2, r, "A", N / 5);
        commit(&mut c, &b, r, "A", N / 2);
        commit(&mut c, &cc, r, "B", N);
        reveal_s(&mut c, &a, &a, s1, r, "A");
        reveal_s(&mut c, &a, &a, s2, r, "A");
        if wipe && r == 2 {
            env::storage_remove(&miners_key(2, SIDE_A));
        }
        reveal(&mut c, &b, r, "A");
        reveal(&mut c, &cc, r, "B");
    }
    ctx(&cc, t_after(2));
    c.settle_due();
    (c, [a, b, cc], [s1, s2])
}

#[test]
fn each_round_records_who_mined_and_how_much() {
    let (mut c, [a, b, cc], [s1, s2]) = three_a_rounds(false);
    for r in 0..2u64 {
        assert_eq!(c.get_round(U64(r)).miners, 0, "streaks of 1 and 2 do not mine");
    }
    let v = c.get_round(U64(2));
    assert_eq!(v.reward.0, 3 * T);
    assert_eq!((v.miners, v.mining_players), (3, 2), "three bets from two accounts");
    let m = c.get_round_miners(U64(2));
    let got: Vec<(String, u32, u32, u128)> = m.iter().map(|x| (x.account_id.to_string(), x.slot, x.streak, x.mined.0)).collect();
    // shares = stake / 0.001 NEAR x (streak - 2): 100, 200 and 500 of 800
    assert_eq!(
        got,
        vec![
            (a.to_string(), s1, 3, 3 * T * 100 / 800),
            (a.to_string(), s2, 3, 3 * T * 200 / 800),
            (b.to_string(), 0, 3, 3 * T * 500 / 800),
        ]
    );
    // the list agrees with what each account is credited
    assert_eq!(c.get_player(a.clone()).unrefined.0, got[0].3 + got[1].3);
    assert_eq!(c.get_player(b.clone()).unrefined.0, got[2].3);
    assert!(env::storage_has_key(&miners_key(2, SIDE_A)), "the winners' list stays");

    // round 3: alice and bob carry their streaks onto A, which loses; nobody on B mines
    commit_s(&mut c, &a, s1, 3, "A", N / 10);
    commit(&mut c, &b, 3, "A", N / 2);
    commit(&mut c, &cc, 3, "B", N / 10);
    reveal_s(&mut c, &a, &a, s1, 3, "A");
    reveal(&mut c, &b, 3, "A");
    reveal(&mut c, &cc, 3, "B");
    assert!(env::storage_has_key(&miners_key(3, SIDE_A)), "listed while the round is open");
    ctx(&cc, t_after(3));
    c.settle_due();
    let v = c.get_round(U64(3));
    assert_eq!((v.outcome.as_deref(), v.reward.0, v.miners), (Some("B"), 0, 0));
    assert!(!env::storage_has_key(&miners_key(3, SIDE_A)), "a losing side's list is removed");
    assert!(c.get_round_miners(U64(3)).is_empty());
    check_invariants(&c, &[a, b, cc], 0);
}

#[test]
fn a_round_without_a_complete_list_shows_no_miner_count() {
    let (c, [a, b, cc], _) = three_a_rounds(true);
    let v = c.get_round(U64(2));
    assert_eq!(v.reward.0, 3 * T, "the round still mined");
    assert_eq!((v.miners, v.mining_players), (0, 0), "but who mined was not fully recorded");
    assert!(c.get_round_miners(U64(2)).is_empty());
    check_invariants(&c, &[a, b, cc], 0);
}

// ---------- storage that nobody paid for (Nov 9 audit) ----------

/// NEAR the chain would lock for everything the contract stores right now: every record's key
/// and value plus 40 bytes each. (`env::storage_usage()` is no use across test contexts, and
/// the maps keep their writes in memory until flushed.)
fn chain_storage_cost(c: &mut Contract) -> u128 {
    c.balances.flush();
    c.rounds.flush();
    c.commits.flush();
    c.round_players.flush();
    c.players.flush();
    c.slots.flush();
    let storage = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
    let bytes: usize = storage.iter().map(|(k, v)| k.len() + v.len() + 40).sum();
    let mut b = VMContextBuilder::new();
    b.current_account_id(me()).account_balance(NearToken::from_yoctonear(BIG));
    near_sdk::env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        vec![],
        storage,
        Default::default(),
        None,
    ));
    bytes as u128 * env::storage_byte_cost().as_yoctonear()
}

/// Round r: slots `mine` of `a` bet 0.01 on A, `a`'s slot 0 bets `big` on B; all revealed by `a`
/// and booked once the round is over.
fn hedge_round(c: &mut Contract, a: &AccountId, mine: &[u32], r: u64, big: u128) {
    for s in mine {
        commit_s(c, a, *s, r, "A", N / 100);
    }
    commit_s(c, a, 0, r, "B", big);
    for s in mine {
        reveal_s(c, a, a, *s, r, "A");
    }
    reveal_s(c, a, a, 0, r, "B");
    ctx(a, t_after(r));
    for s in mine.iter().chain([0u32].iter()) {
        c.claim(Some(a.clone()), Some(*s));
    }
}

#[test]
fn mining_bets_pay_for_their_lines_in_the_miner_list() {
    // the audit's attack: one long account id, many small bets on the minority side that all
    // mine. Each adds a line to the round's miner list, which stays on chain for good; before
    // the fix nobody paid for those lines, so they came out of the contract's own NEAR
    let mut c = setup();
    let a = acc(&"a".repeat(64));
    join(&mut c, &a);
    let mine: Vec<u32> = (0..40).map(|_| new_slot(&mut c, &a)).collect();
    hedge_round(&mut c, &a, &mine, 0, N);
    hedge_round(&mut c, &a, &mine, 1, N);
    let before = chain_storage_cost(&mut c);
    let balance_before = bal(&c, &a);
    hedge_round(&mut c, &a, &mine, 2, N);
    let grown = chain_storage_cost(&mut c) - before;
    ctx(&a, t_after(2));
    let s = c.get_status();
    assert_eq!(c.get_round(U64(2)).miners, 40, "all 40 bets mined");
    assert_eq!(s.miner_lines.0, 40 * miner_line_cost(&a), "each paid for its line");
    // what stays on chain besides the lines: the round's record and the list's header
    // (and, once, the 60-byte counter of what the lines paid)
    let fixed = (ROUND_RECORD_BYTES + 81 + 60) * env::storage_byte_cost().as_yoctonear();
    assert_eq!(grown, s.miner_lines.0 + fixed, "to the byte");
    assert!(grown > fixed && grown <= s.miner_lines.0 + fixed, "storage that stays ({grown}) is paid for ({} + {fixed})", s.miner_lines.0);
    // and the player got everything else back: 40 wins of 0.01, the 1 NEAR lost, the fees net
    // of the reveal rewards, minus the lines
    let n = 40u128;
    assert_eq!(bal(&c, &a), balance_before + n * (N / 100) - N - n * cost(N / 100) - cost(N) - s.miner_lines.0);
    check_invariants(&c, &[a], 0);
}

#[test]
fn a_win_that_does_not_mine_gets_its_whole_storage_deposit_back() {
    let mut c = setup();
    let (a, b) = (acc("alice.testnet"), acc("bob.testnet"));
    join(&mut c, &a);
    join(&mut c, &b);
    commit(&mut c, &a, 0, "A", N);
    commit(&mut c, &b, 0, "B", 2 * N);
    reveal(&mut c, &a, 0, "A");
    reveal(&mut c, &b, 0, "B");
    ctx(&a, t_after(0));
    c.claim(None, None);
    assert_eq!(bal(&c, &a), START + N - cost(N), "a streak of 1 does not mine: nothing kept");
    assert_eq!(c.get_status().miner_lines.0, 0);
}

#[test]
fn a_big_round_keeps_its_bets_in_small_pages() {
    // before: one list per round, rewritten whole by every commit (gas grew with the round)
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    let slots: Vec<u32> = std::iter::once(0).chain((0..149).map(|_| new_slot(&mut c, &a))).collect();
    let before = chain_storage_cost(&mut c);
    for s in &slots {
        commit_s(&mut c, &a, *s, 0, "A", N / 100);
    }
    let page = |i: u32| env::storage_read(&round_page_key(0, i)).map(|v| near_sdk::borsh::from_slice::<Vec<(AccountId, u32)>>(&v).unwrap().len());
    assert_eq!((page(0), page(1), page(2), page(3)), (Some(64), Some(64), Some(22), None));
    assert!(c.round_players.get(&0).is_none(), "the old single list is not used");
    // the keeper's view pages through all of them, in commit order
    let mut seen = vec![];
    for from in [0u32, 100] {
        let got = c.get_round_commits(U64(0), from, 100);
        seen.extend(got.iter().map(|x| x.slot));
    }
    assert_eq!(seen, slots);
    assert_eq!(c.get_round_commits(U64(0), 60, 10).iter().map(|x| x.slot).collect::<Vec<_>>(), slots[60..70].to_vec(), "across a page boundary");
    assert!(c.get_round_commits(U64(0), 150, 100).is_empty());
    // the storage deposits cover every byte the commits added
    let used = chain_storage_cost(&mut c) - before;
    ctx(&a, t_commit(0));
    assert!(used > 0 && used <= c.get_status().storage_held.0, "commits use {used}, deposits hold {}", c.get_status().storage_held.0);
    // one-sided: void. Once every bet is booked the pages are gone
    for s in &slots {
        reveal_s(&mut c, &a, &a, *s, 0, "A");
    }
    for s in &slots {
        ctx(&a, t_after(0)); // a fresh context each time: the logs of 150 claims do not fit in one
        c.claim(None, Some(*s));
    }
    assert_eq!((page(0), page(1), page(2)), (None, None, None));
    assert!(c.get_round_commits(U64(0), 0, 100).is_empty());
    check_invariants(&c, &[a], 0);
}

#[test]
fn a_round_that_started_with_the_old_single_list_finishes_with_it() {
    // the live contract was upgraded in place: rounds open at that moment have their bets in
    // `round_players`
    let mut c = setup();
    let (a, b) = (acc("alice.testnet"), acc("bob.testnet"));
    join(&mut c, &a);
    join(&mut c, &b);
    commit(&mut c, &a, 0, "A", N);
    // put alice's bet where the old code kept it
    c.round_players.insert(0, round_page_read(0, 0));
    env::storage_remove(&round_page_key(0, 0));
    commit(&mut c, &b, 0, "B", 2 * N);
    assert!(!env::storage_has_key(&round_page_key(0, 0)));
    let got: Vec<String> = c.get_round_commits(U64(0), 0, 100).iter().map(|x| x.account_id.to_string()).collect();
    assert_eq!(got, vec![a.to_string(), b.to_string()]);
    reveal(&mut c, &a, 0, "A");
    reveal(&mut c, &b, 0, "B");
    ctx(&a, t_after(0));
    c.claim(Some(a.clone()), None);
    c.claim(Some(b.clone()), None);
    assert!(c.round_players.get(&0).is_none());
    assert_eq!(bal(&c, &a), START + N - cost(N));
    check_invariants(&c, &[a, b], 0);
}

#[test]
fn betting_stops_before_player_funds_could_be_locked_as_storage() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    // the contract's NEAR covers its storage and what it owes players, to the yocto: fine
    ctx(&a, t_commit(0));
    let s = c.get_status();
    let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
    let owed = s.balances_total.0 + s.escrow.0 + s.storage_held.0 + s.storage_fees.0;
    ctx_full(&a, t_commit(0), 0, storage + owed, vec![]);
    let h = hash_hex(&a, 0, "A", &salt(&a, 0));
    c.commit(U64(0), None, U128(N), h, None);
    // one yocto short (storage nobody paid for ate into it): no new bets...
    ctx_full(&a, t_commit(1), 0, storage + owed - 1, vec![]);
    let h = hash_hex(&a, 1, "A", &salt(&a, 1));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.commit(U64(1), None, U128(N), h, None)));
    assert!(r.is_err(), "betting is paused");
    // ...but reveals, bookings and withdrawals still work
    ctx_full(&a, t_reveal(0), 0, storage + owed - 1, vec![]);
    c.reveal(U64(0), None, "A".into(), salt(&a, 0), None);
    ctx_full(&a, t_after(0), 0, storage + owed - 1, vec![]);
    let _ = c.withdraw(None, None);
    assert_eq!(bal(&c, &a), 0);
}

#[test]
#[should_panic(expected = "min_stake must be more than a round record's storage")]
fn min_stake_must_cover_a_void_rounds_record() {
    // a lone revealed bet in a void round pays the whole record (0.00291 NEAR) out of its
    // refund: with a smaller stake the refund would go below zero and the slot could never
    // be booked again
    let mut p = params();
    p.min_stake = U128(N / 500);
    setup_with(p);
}
