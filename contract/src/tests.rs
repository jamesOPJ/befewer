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
    env::sha256(commit_preimage(who, r, side, salt).as_bytes()).iter().map(|b| format!("{:02x}", b)).collect()
}
fn fee(x: u128) -> u128 {
    x * 500 / 10_000
}

/// Deposit START (plus the one-time storage fee) for `who`.
fn join(c: &mut Contract, who: &AccountId) {
    ctx_full(who, G - MIN, START + STORAGE_FEE, BIG, vec![]);
    c.deposit(None);
}
fn commit(c: &mut Contract, who: &AccountId, r: u64, side: &str, amount: u128) {
    ctx(who, t_commit(r));
    let s = salt(who, r);
    let got = c.commit(U64(r), U128(amount), hash_hex(who, r, side, &s), None);
    assert_eq!(got.0, r);
}
fn reveal(c: &mut Contract, who: &AccountId, r: u64, side: &str) {
    ctx(who, t_reveal(r));
    c.reveal(U64(r), side.into(), salt(who, r), None);
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

/// NEAR: every deposited yocto is in a game balance, in escrow, or went to the treasury.
/// BEFEWER: balances add up to the supply; supply + burned = everything minted; issuance capped.
fn check_invariants(c: &Contract, players: &[AccountId], donated: u128) {
    let s = c.get_status();
    let sum: u128 = players.iter().map(|p| bal(c, p)).sum();
    assert_eq!(sum, s.balances_total.0, "player balances add up to balances_total");
    let deposited = players.len() as u128 * START;
    assert_eq!(
        s.balances_total.0 + s.escrow.0 + s.treasury_in.0 - donated,
        deposited,
        "NEAR conserved: balances + escrow + round inflows = deposits"
    );
    let holders: u128 = players.iter().map(|p| tokens(c, p)).sum::<u128>() + tokens(c, &me()) + tokens(c, &dex());
    assert_eq!(holders, s.total_supply.0, "token balances add up to total supply");
    assert_eq!(s.total_supply.0 + s.total_burned.0, s.mined.0 + s.dex.seed.0, "supply + burned = minted");
    assert!(s.issued.0 >= s.mined.0 + s.pot.0 + s.dex.seed.0, "issued covers mined + pot + seed");
    assert!(s.issued.0 <= s.max_supply.0, "issuance never above the cap");
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
    let _ = c.withdraw(Some(U128(2 * N)));
    assert_eq!(bal(&c, &a), START - 2 * N);
    callback(G, PromiseResult::Successful(vec![]));
    c.on_withdraw(a.clone(), U128(2 * N));
    assert_eq!(bal(&c, &a), START - 2 * N, "a successful transfer stays withdrawn");
    ctx(&a, G);
    let _ = c.withdraw(None);
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
    let _ = c.withdraw(Some(U128(START + 1)));
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
    assert_eq!(bal(&c, &a), START - N - fee(N), "stake + fee left the balance");
    let open = c.get_player(a.clone()).open;
    assert!(open[0].side.is_none(), "nobody's side is on chain during the commit window");

    reveal(&mut c, &a, 0, "A");
    reveal(&mut c, &b, 0, "B");
    reveal(&mut c, &ch, 0, "B");
    ctx(&a, t_after(0));
    for p in [&a, &b, &ch] {
        assert_eq!(c.claim(Some(p.clone())), 1);
    }
    assert_eq!(bal(&c, &a), START - N - fee(N) + 2 * N, "winner: 2x the stake, fee not refunded");
    assert_eq!(bal(&c, &b), START - 2 * N - fee(2 * N));
    assert_eq!(bal(&c, &ch), START - N / 2 - fee(N / 2));
    let r = c.get_round(U64(0));
    assert_eq!(r.outcome.as_deref(), Some("A"));
    let fees = fee(N) + fee(2 * N) + fee(N / 2);
    assert_eq!(r.to_treasury.0, fees + (2 * N + N / 2 - N), "treasury gets the fees + |A - B|");
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
#[should_panic(expected = "stake plus the fee")]
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
#[should_panic(expected = "already committed")]
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
    c.commit(U64(0), U128(N), h, None);
    ctx(&b, t_reveal(0));
    c.reveal(U64(0), "A".into(), s, None);
}

#[test]
#[should_panic(expected = "not opened yet")]
fn reveal_too_early_fails() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    commit(&mut c, &a, 0, "A", N);
    ctx(&a, t_commit(0));
    c.reveal(U64(0), "A".into(), salt(&a, 0), None);
}

#[test]
#[should_panic(expected = "reveal window is closed")]
fn reveal_too_late_fails() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    commit(&mut c, &a, 0, "A", N);
    ctx(&a, t_after(0));
    c.reveal(U64(0), "A".into(), salt(&a, 0), None);
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
        c.claim(Some(p.clone()));
    }
    assert_eq!(c.get_round(U64(0)).outcome.as_deref(), Some("void"));
    assert_eq!(bal(&c, &a), START, "void: stake and fee both come back");
    assert_eq!(bal(&c, &b), START);
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
    c.claim(Some(a.clone()));
    c.claim(Some(b.clone()));
    assert_eq!(bal(&c, &a), START);
    assert_eq!(bal(&c, &b), START);
    assert_eq!(c.get_status().treasury.0, 0);
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
    assert_eq!(c.claim(Some(a.clone())), 0, "nothing claimable before the reveal window ends");
    ctx(&keeper, t_after(0));
    assert_eq!(c.claim(Some(a.clone())), 1);
    assert_eq!(bal(&c, &a), START + N - fee(N));
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
    assert_eq!(c.commit(U64(1), U128(N), hash_hex(&a, 1, "B", &s), None).0, 1);
    c.reveal(U64(0), "A".into(), salt(&a, 0), None);
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
    c.claim(Some(a.clone()));
    let p = c.get_player(a.clone());
    assert_eq!((p.wins, p.losses, p.streak, p.best_streak), (2, 1, 0, 2));
    let s = c.get_status();
    assert_eq!(s.best_streak, 2);
    assert_eq!(s.best_streak_holder, Some(a.clone()));
    c.claim(Some(b.clone()));
    c.claim(Some(ch.clone()));
    check_invariants(&c, &[a, b, ch], 0);
}

#[test]
#[should_panic(expected = "too many unclaimed rounds")]
fn open_rounds_are_bounded() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    for r in 0..=(MAX_OPEN_ROUNDS as u64) {
        commit(&mut c, &a, r, "A", N / 100);
    }
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
            c.claim(Some(p.clone()));
        }
        let net = (bal(&c, &h1) + bal(&c, &h2)) as i128 - 2 * START as i128;
        assert_eq!(net, -2 * fee(x) as i128, "hedged round costs both fees, whichever side wins");
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
    c.claim(Some(h1.clone()));
    c.claim(Some(h2.clone()));
    assert_eq!(bal(&c, &h1) + bal(&c, &h2), 2 * START, "void rounds refund everything");
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
            c.claim(Some(w1.clone()));
            c.claim(Some(w2.clone()));
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
        c.claim(Some(p.clone()));
    }
    let s = c.get_status();
    assert_eq!(tokens(&c, &a), 3 * T, "rounds 0 and 1 rolled over into round 2's pot");
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
        c.claim(Some(p.clone()));
    }
    // round 2: alice's 3rd win takes the 3-token pot alone (eve is on her 2nd)
    // round 3: pot of 1 token split 2 shares x 1000 (alice, streak 4) : 1 share x 500 (eve, streak 3)
    assert_eq!(tokens(&c, &a), 3 * T + T * 2000 / 2500);
    assert_eq!(tokens(&c, &e), T * 500 / 2500);
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
        c.claim(Some(p.clone()));
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
        c.claim(Some(p.clone()));
    }
    let p = c.get_player(a.clone());
    assert_eq!((p.wins, p.voids, p.streak), (3, 1, 3));
    assert!(tokens(&c, &a) > 0, "the third win mined");
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
    c.claim(Some(a.clone()));
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
        c.claim(Some(p.clone()));
    }
    let s = c.get_status();
    assert_eq!(s.issued.0, T * 5 / 2);
    assert_eq!(c.get_round(U64(2)).emission.0, T / 2);
    assert_eq!(c.get_round(U64(3)).emission.0, 0);
    assert_eq!(tokens(&c, &a), T * 5 / 2);
    check_invariants(&c, &[a, b1, b2], 0);
}

#[test]
fn mul_div_is_exact_and_does_not_overflow() {
    assert_eq!(mul_div(10, 1, 3), 3);
    assert_eq!(mul_div(1_000_000 * T, 999_999, 1_000_000), 999_999 * T);
    let big = u128::MAX / 2;
    assert_eq!(mul_div(big, 7, 7), big);
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
    let owed = s.balances_total.0 + s.escrow.0 + storage + SAFETY_RESERVE;
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
    c.claim(Some(a.clone()));
    ctx_full(&a, t_after(2), 1, BIG, vec![]);
    c.ft_transfer(me(), U128(T), None);
    let s = c.get_status();
    assert_eq!(tokens(&c, &a), 2 * T);
    assert_eq!((s.total_supply.0, s.total_burned.0), (2 * T, T));
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
    c.on_graduate(STEP_START);
    // 1: register + create the pool
    ctx(&k, now_g());
    let _ = c.graduate();
    callback(now_g(), ok_json(7u64));
    c.on_graduate(STEP_REGISTER);
    // 2: deposit the wNEAR
    let near_amount = c.get_status().dex.near_amount.0;
    ctx(&k, now_g());
    let _ = c.graduate();
    callback(now_g(), ok_json(U128(near_amount)));
    c.on_graduate(STEP_SEND_NEAR);
    // 3: mint + deposit the seed
    ctx(&k, now_g());
    let _ = c.graduate();
    let seed = c.get_status().dex.seed.0;
    assert_eq!(tokens(&c, &dex()), seed, "the seed sits with the DEX");
    callback(now_g(), ok_json(U128(seed)));
    c.on_graduate(STEP_SEND_TOKEN);
    // 4: add liquidity
    ctx(&k, now_g());
    let _ = c.graduate();
    callback(now_g(), ok_json(U128(1_000_000)));
    c.on_graduate(STEP_ADD_LIQUIDITY);
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
    c.on_graduate(STEP_START);
    let s = c.get_status();
    assert_eq!((s.dex.step, s.treasury.0, s.dex.busy), (STEP_START, 6 * N, false));
    // try again, succeed, then fail creating the pool: stays on that step
    ctx(&k, now_g());
    let _ = c.graduate();
    callback(now_g(), PromiseResult::Successful(vec![]));
    c.on_graduate(STEP_START);
    ctx(&k, now_g());
    let _ = c.graduate();
    callback(now_g(), PromiseResult::Failed);
    c.on_graduate(STEP_REGISTER);
    assert_eq!(c.get_status().dex.step, STEP_REGISTER);
    assert_eq!(c.get_status().dex.pool_id, None);
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
        c.on_graduate(step);
    }
    let near_amount = c.get_status().dex.near_amount.0;
    ctx(&k, now_g());
    let _ = c.graduate();
    callback(now_g(), ok_json(U128(near_amount)));
    c.on_graduate(STEP_SEND_NEAR);
    ctx(&k, now_g());
    let _ = c.graduate();
    // the DEX refused: ft_resolve_transfer moved the seed back to us and reported 0 used
    ctx_full(&me(), now_g(), 0, BIG, vec![ok_json(U128(T))]); // ft_on_transfer said: all unused
    c.ft_resolve_transfer(me(), dex(), U128(T));
    callback(now_g(), ok_json(U128(0)));
    c.on_graduate(STEP_SEND_TOKEN);
    assert_eq!(c.get_status().dex.step, STEP_SEND_TOKEN);
    assert_eq!(tokens(&c, &me()), T);
    ctx(&k, now_g());
    let _ = c.graduate();
    let s = c.get_status();
    assert_eq!((s.issued.0, s.total_supply.0), (T, T), "retry re-sends the same seed");
    assert_eq!(tokens(&c, &dex()), T);
}

#[test]
fn buyback_spends_at_most_buyback_max_and_burns_what_comes_back() {
    let mut c = graduated(6 * N);
    donate(&mut c, 3 * N, now_g());
    let k = acc("keeper.testnet");
    ctx(&k, now_g() + MIN);
    let _ = c.buyback();
    assert_eq!(c.get_status().treasury.0, 2 * N, "one buyback spends at most buyback_max");
    callback(now_g() + MIN, ok_json(U128(N)));
    c.on_buyback(U128(0), U128(N));
    // the pool sends the bought BEFEWER to the contract: it is burned on arrival
    ctx_full(&dex(), now_g() + MIN, 1, BIG, vec![]);
    c.ft_transfer(me(), U128(T / 10), None);
    let s = c.get_status();
    assert_eq!((s.dex.bought_near.0, s.dex.bought_burned.0, s.dex.buybacks), (N, T / 10, 1));
    assert_eq!(s.total_burned.0, T / 10);
    assert_eq!(s.total_supply.0, T - T / 10);
    assert_eq!(tokens(&c, &me()), 0);
}

#[test]
#[should_panic(expected = "too soon")]
fn buybacks_are_rate_limited() {
    let mut c = graduated(6 * N);
    donate(&mut c, 3 * N, now_g());
    let k = acc("keeper.testnet");
    ctx(&k, now_g() + MIN);
    let _ = c.buyback();
    callback(now_g() + MIN, ok_json(U128(N)));
    c.on_buyback(U128(0), U128(N));
    ctx(&k, now_g() + MIN + MIN / 2);
    let _ = c.buyback();
}

#[test]
fn a_swap_that_does_not_go_through_keeps_the_wnear_for_next_time() {
    let mut c = graduated(6 * N);
    donate(&mut c, 3 * N, now_g());
    let k = acc("keeper.testnet");
    ctx(&k, now_g() + MIN);
    let _ = c.buyback();
    callback(now_g() + MIN, ok_json(U128(0))); // the DEX refunded everything
    c.on_buyback(U128(0), U128(N));
    let s = c.get_status();
    assert_eq!((s.dex.held_wnear.0, s.dex.bought_near.0, s.treasury.0), (N, 0, 2 * N));
    // next time it swaps the held wNEAR first and takes nothing new from the treasury
    ctx(&k, now_g() + 3 * MIN);
    let _ = c.buyback();
    assert_eq!(c.get_status().treasury.0, 2 * N);
    callback(now_g() + 3 * MIN, PromiseResult::Failed); // and if the whole call fails
    c.on_buyback(U128(N), U128(0));
    let s = c.get_status();
    assert_eq!((s.dex.held_wnear.0, s.treasury.0), (N, 2 * N), "nothing is lost");
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
        c.commit(U64(0), U128(amt), hash_hex(who, 0, side, &s), Some(format!("tlock-ciphertext-of-{}:{}", side, s)));
    }
    let list = c.get_round_commits(U64(0), 0, 10);
    assert_eq!(list.len(), 2);
    assert!(list.iter().all(|x| x.side.is_none() && x.sealed.is_some()));
    assert_eq!(list[0].hash, hash_hex(&a, 0, "A", &salt(&a, 0)), "view exposes the commitment");
    ctx(&keeper, t_reveal(0));
    c.reveal(U64(0), "A".into(), salt(&a, 0), Some(a.clone()));
    c.reveal(U64(0), "B".into(), salt(&b, 0), Some(b.clone()));
    let list = c.get_round_commits(U64(0), 0, 10);
    assert_eq!(list[0].side.as_deref(), Some("A"));
    assert!(list.iter().all(|x| x.sealed.is_none()), "ciphertext dropped on reveal");
    ctx(&keeper, t_after(0));
    c.claim(Some(a.clone()));
    c.claim(Some(b.clone()));
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
    c.reveal(U64(0), "B".into(), salt(&a, 0), Some(a.clone()));
}

#[test]
#[should_panic(expected = "sealed must be 1..1024 bytes")]
fn sealed_ciphertext_is_bounded() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    ctx(&a, t_commit(0));
    let s = salt(&a, 0);
    c.commit(U64(0), U128(N), hash_hex(&a, 0, "A", &s), Some("x".repeat(MAX_SEALED_LEN + 1)));
}

#[test]
#[should_panic(expected = "is not taking commits")]
fn late_commit_is_refused_not_moved_to_the_next_round() {
    let mut c = setup();
    let a = acc("alice.testnet");
    join(&mut c, &a);
    let s = salt(&a, 0);
    ctx(&a, G + C + 1); // round 0's window closed one nanosecond ago
    c.commit(U64(0), U128(N), hash_hex(&a, 0, "A", &s), None);
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
                c.claim(Some(p.clone()));
                check_invariants(&c, &players, 0);
            }
        }
    }
    ctx(&players[0], t_after(50));
    for p in &players {
        c.claim(Some(p.clone()));
    }
    let s = c.get_status();
    assert_eq!(s.escrow.0, 0, "everything claimed -> nothing left in escrow");
    check_invariants(&c, &players, 0);
    assert!(s.treasury.0 > 0);
    assert!(s.mined.0 > 0, "40 random rounds should produce some 3-win streaks");
}
