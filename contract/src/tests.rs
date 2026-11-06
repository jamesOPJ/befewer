use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const ONE: u128 = 1_000_000_000_000_000_000; // 1 FEWER (18 decimals)
const MIN: u64 = 60_000_000_000; // one minute in ns
const G: u64 = 1_000 * MIN; // genesis
const C: u64 = 10 * MIN; // commit window
const R: u64 = 5 * MIN; // reveal window
const SUPPLY: u128 = 1_000_000 * ONE;
const FAUCET: u128 = 1_000 * ONE;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn me() -> AccountId {
    acc("fewer.testnet")
}

fn ctx(who: &AccountId, now: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(me())
        .predecessor_account_id(who.clone())
        .signer_account_id(who.clone())
        .block_timestamp(now)
        .attached_deposit(NearToken::from_yoctonear(0));
    testing_env!(b.build());
}

fn setup() -> Contract {
    ctx(&acc("deployer.testnet"), G - MIN);
    // fresh chain state: testing_env! carries storage over, so wipe it for each new contract
    near_sdk::mock::with_mocked_blockchain(|b| {
        b.take_storage();
    });
    ctx(&acc("deployer.testnet"), G - MIN);
    Contract::new(
        U128(SUPPLY),
        Params {
            genesis_ns: U64(G),
            commit_ns: U64(C),
            reveal_ns: U64(R),
            max_stake_bps: 2500,
            min_stake: U128(ONE),
            faucet_amount: U128(FAUCET),
        },
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "FEWER".into(),
            symbol: "FEWER".into(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 18,
        },
    )
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

fn commit(c: &mut Contract, who: &AccountId, r: u64, side: &str, amount: u128) {
    ctx(who, t_commit(r));
    let s = salt(who, r);
    let got = c.commit(U128(amount), hash_hex(who, r, side, &s));
    assert_eq!(got.0, r);
}

fn reveal(c: &mut Contract, who: &AccountId, r: u64, side: &str) {
    ctx(who, t_reveal(r));
    c.reveal(U64(r), side.into(), salt(who, r));
}

fn faucet(c: &mut Contract, who: &AccountId) {
    ctx(who, G);
    c.faucet();
}

fn bal(c: &Contract, who: &AccountId) -> u128 {
    c.ft_balance_of(who.clone()).0
}

/// Invariants that must hold at every point.
fn check_invariants(c: &Contract, players: &[AccountId]) {
    let s = c.get_status();
    assert_eq!(bal(c, &me()), s.faucet_reserve.0 + s.escrow.0, "contract balance = reserve + escrow");
    assert_eq!(s.total_supply.0 + s.total_burned.0, SUPPLY, "supply + burned = initial supply");
    let sum: u128 = players.iter().map(|p| bal(c, p)).sum::<u128>() + bal(c, &me());
    assert_eq!(sum, s.total_supply.0, "balances add up to total supply");
}

#[test]
fn faucet_once_per_account() {
    let mut c = setup();
    let alice = acc("alice.testnet");
    faucet(&mut c, &alice);
    assert_eq!(bal(&c, &alice), FAUCET);
    assert_eq!(c.get_status().faucet_reserve.0, SUPPLY - FAUCET);
}

#[test]
#[should_panic(expected = "faucet already claimed")]
fn faucet_twice_fails() {
    let mut c = setup();
    let alice = acc("alice.testnet");
    faucet(&mut c, &alice);
    faucet(&mut c, &alice);
}

#[test]
fn minority_wins_double_and_imbalance_burns() {
    let mut c = setup();
    let (a, b, ch) = (acc("alice.testnet"), acc("bob.testnet"), acc("charlie.testnet"));
    for p in [&a, &b, &ch] {
        faucet(&mut c, p);
    }
    commit(&mut c, &a, 0, "A", 100 * ONE);
    commit(&mut c, &b, 0, "B", 200 * ONE);
    commit(&mut c, &ch, 0, "B", 50 * ONE);
    assert_eq!(c.get_status().escrow.0, 350 * ONE);
    // during the commit window nobody's side is on chain
    let open = c.get_player(a.clone()).open;
    assert_eq!(open.len(), 1);
    assert!(open[0].side.is_none());

    reveal(&mut c, &a, 0, "A");
    reveal(&mut c, &b, 0, "B");
    reveal(&mut c, &ch, 0, "B");
    ctx(&a, t_after(0));
    for p in [&a, &b, &ch] {
        assert_eq!(c.claim(Some(p.clone())), 1);
    }
    assert_eq!(bal(&c, &a), (1000 - 100 + 200) * ONE);
    assert_eq!(bal(&c, &b), (1000 - 200) * ONE);
    assert_eq!(bal(&c, &ch), (1000 - 50) * ONE);
    let r = c.get_round(U64(0));
    assert_eq!(r.outcome.as_deref(), Some("A"));
    assert_eq!(r.burned.0, 150 * ONE, "burn = |A - B|");
    let s = c.get_status();
    assert_eq!(s.total_burned.0, 150 * ONE);
    assert_eq!(s.escrow.0, 0);
    check_invariants(&c, &[a, b, ch]);
}

#[test]
#[should_panic(expected = "per-round cap")]
fn stake_cap_enforced() {
    let mut c = setup();
    let a = acc("alice.testnet");
    faucet(&mut c, &a);
    commit(&mut c, &a, 0, "A", 250 * ONE + 1);
}

#[test]
fn stake_cap_exact_is_ok() {
    let mut c = setup();
    let a = acc("alice.testnet");
    faucet(&mut c, &a);
    commit(&mut c, &a, 0, "A", 250 * ONE);
}

#[test]
#[should_panic(expected = "below min_stake")]
fn min_stake_enforced() {
    let mut c = setup();
    let a = acc("alice.testnet");
    faucet(&mut c, &a);
    commit(&mut c, &a, 0, "A", ONE - 1);
}

#[test]
#[should_panic(expected = "already committed")]
fn one_commit_per_round() {
    let mut c = setup();
    let a = acc("alice.testnet");
    faucet(&mut c, &a);
    commit(&mut c, &a, 0, "A", 10 * ONE);
    commit(&mut c, &a, 0, "B", 10 * ONE);
}

#[test]
#[should_panic(expected = "hash does not match")]
fn reveal_wrong_side_fails() {
    let mut c = setup();
    let a = acc("alice.testnet");
    faucet(&mut c, &a);
    commit(&mut c, &a, 0, "A", 10 * ONE);
    reveal(&mut c, &a, 0, "B");
}

#[test]
#[should_panic(expected = "hash does not match")]
fn commit_hash_is_bound_to_account() {
    // bob copies alice's hash: he cannot reveal it as his own
    let mut c = setup();
    let (a, b) = (acc("alice.testnet"), acc("bob.testnet"));
    faucet(&mut c, &a);
    faucet(&mut c, &b);
    let s = salt(&a, 0);
    let h = hash_hex(&a, 0, "A", &s);
    ctx(&b, t_commit(0));
    c.commit(U128(10 * ONE), h);
    ctx(&b, t_reveal(0));
    c.reveal(U64(0), "A".into(), s);
}

#[test]
#[should_panic(expected = "not opened yet")]
fn reveal_too_early_fails() {
    let mut c = setup();
    let a = acc("alice.testnet");
    faucet(&mut c, &a);
    commit(&mut c, &a, 0, "A", 10 * ONE);
    ctx(&a, t_commit(0));
    c.reveal(U64(0), "A".into(), salt(&a, 0));
}

#[test]
#[should_panic(expected = "reveal window is closed")]
fn reveal_too_late_fails() {
    let mut c = setup();
    let a = acc("alice.testnet");
    faucet(&mut c, &a);
    commit(&mut c, &a, 0, "A", 10 * ONE);
    ctx(&a, t_after(0));
    c.reveal(U64(0), "A".into(), salt(&a, 0));
}

#[test]
fn tie_voids_and_unrevealed_burns() {
    let mut c = setup();
    let (a, b, ch) = (acc("alice.testnet"), acc("bob.testnet"), acc("charlie.testnet"));
    for p in [&a, &b, &ch] {
        faucet(&mut c, p);
    }
    commit(&mut c, &a, 0, "A", 100 * ONE);
    commit(&mut c, &b, 0, "B", 100 * ONE);
    commit(&mut c, &ch, 0, "A", 50 * ONE); // never revealed
    reveal(&mut c, &a, 0, "A");
    reveal(&mut c, &b, 0, "B");
    ctx(&a, t_after(0));
    c.settle(U64(0));
    for p in [&a, &b, &ch] {
        c.claim(Some(p.clone()));
    }
    assert_eq!(c.get_round(U64(0)).outcome.as_deref(), Some("void"));
    assert_eq!(bal(&c, &a), 1000 * ONE);
    assert_eq!(bal(&c, &b), 1000 * ONE);
    assert_eq!(bal(&c, &ch), 950 * ONE);
    assert_eq!(c.get_status().total_burned.0, 50 * ONE);
    assert_eq!(c.get_player(ch.clone()).forfeits, 1);
    check_invariants(&c, &[a, b, ch]);
}

#[test]
fn one_sided_round_is_refunded() {
    let mut c = setup();
    let (a, b) = (acc("alice.testnet"), acc("bob.testnet"));
    faucet(&mut c, &a);
    faucet(&mut c, &b);
    commit(&mut c, &a, 0, "A", 100 * ONE);
    commit(&mut c, &b, 0, "A", 40 * ONE);
    reveal(&mut c, &a, 0, "A");
    reveal(&mut c, &b, 0, "A");
    ctx(&a, t_after(0));
    c.claim(Some(a.clone()));
    c.claim(Some(b.clone()));
    assert_eq!(bal(&c, &a), 1000 * ONE);
    assert_eq!(bal(&c, &b), 1000 * ONE);
    assert_eq!(c.get_status().total_burned.0, 0);
}

#[test]
fn claim_waits_for_reveal_end_and_anyone_can_claim_for_you() {
    let mut c = setup();
    let (a, b, keeper) = (acc("alice.testnet"), acc("bob.testnet"), acc("keeper.testnet"));
    faucet(&mut c, &a);
    faucet(&mut c, &b);
    commit(&mut c, &a, 0, "A", 10 * ONE);
    commit(&mut c, &b, 0, "B", 20 * ONE);
    reveal(&mut c, &a, 0, "A");
    reveal(&mut c, &b, 0, "B");
    ctx(&keeper, t_reveal(0));
    assert_eq!(c.claim(Some(a.clone())), 0, "nothing claimable before the reveal window ends");
    ctx(&keeper, t_after(0));
    assert_eq!(c.claim(Some(a.clone())), 1);
    assert_eq!(bal(&c, &a), (1000 + 10) * ONE);
    assert_eq!(bal(&c, &keeper), 0);
}

#[test]
fn rounds_overlap_commit_next_while_revealing_previous() {
    let mut c = setup();
    let (a, b) = (acc("alice.testnet"), acc("bob.testnet"));
    faucet(&mut c, &a);
    faucet(&mut c, &b);
    commit(&mut c, &a, 0, "A", 10 * ONE);
    commit(&mut c, &b, 0, "B", 20 * ONE);
    // t_reveal(0) is inside round 1's commit window
    ctx(&a, t_reveal(0));
    let st = c.get_status();
    assert_eq!(st.commit_round.0, 1);
    assert_eq!(st.reveal_round.map(|x| x.0), Some(0));
    let s = salt(&a, 1);
    assert_eq!(c.commit(U128(10 * ONE), hash_hex(&a, 1, "B", &s)).0, 1);
    c.reveal(U64(0), "A".into(), salt(&a, 0));
}

#[test]
fn streaks_and_records() {
    let mut c = setup();
    let (a, b, ch) = (acc("alice.testnet"), acc("bob.testnet"), acc("charlie.testnet"));
    for p in [&a, &b, &ch] {
        faucet(&mut c, p);
    }
    // alice is in the minority in rounds 0 and 1, then the majority in round 2
    for (r, sa) in [(0u64, "A"), (1, "B"), (2, "A")] {
        let other = if sa == "A" { "B" } else { "A" };
        let (bob_side, ch_side) = if r < 2 { (other, other) } else { (sa, other) };
        commit(&mut c, &a, r, sa, 10 * ONE);
        commit(&mut c, &b, r, bob_side, 20 * ONE);
        commit(&mut c, &ch, r, ch_side, 15 * ONE);
        reveal(&mut c, &a, r, sa);
        reveal(&mut c, &b, r, bob_side);
        reveal(&mut c, &ch, r, ch_side);
    }
    ctx(&a, t_after(2));
    assert_eq!(c.claim(Some(a.clone())), 3);
    let p = c.get_player(a.clone());
    assert_eq!((p.wins, p.losses, p.streak, p.best_streak), (2, 1, 0, 2));
    let s = c.get_status();
    assert_eq!(s.best_streak, 2);
    assert_eq!(s.best_streak_holder, Some(a.clone()));
    c.claim(Some(b.clone()));
    c.claim(Some(ch.clone()));
    check_invariants(&c, &[a, b, ch]);
}

#[test]
#[should_panic(expected = "too many unclaimed rounds")]
fn open_rounds_are_bounded() {
    let mut c = setup();
    let a = acc("alice.testnet");
    faucet(&mut c, &a);
    for r in 0..=(MAX_OPEN_ROUNDS as u64) {
        commit(&mut c, &a, r, "A", ONE);
    }
}

/// A whale with two accounts commits on both sides, waits until everyone else has
/// revealed, then reveals whichever subset pays best (unrevealed = burned). With the
/// exact-2x payout, the best it can do is what a capped blind bet on the difference pays.
#[test]
fn hedging_with_two_accounts_never_beats_betting_the_difference() {
    let (w1, w2) = (acc("whale1.testnet"), acc("whale2.testnet"));
    let others = [acc("o1.testnet"), acc("o2.testnet"), acc("o3.testnet")];
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
                faucet(&mut c, p);
            }
            commit(&mut c, &w1, 0, "A", ca * ONE);
            commit(&mut c, &w2, 0, "B", cb * ONE);
            for (o, (side, amt)) in others.iter().zip(bets.iter()) {
                commit(&mut c, o, 0, side, amt * ONE);
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
            let net = (bal(&c, &w1) + bal(&c, &w2)) as i128 - 2 * FAUCET as i128;
            best = best.max(net);
            let mut all = vec![w1.clone(), w2.clone()];
            all.extend(others.iter().cloned());
            check_invariants(&c, &all);
        }
        let diff = (ca as i128 - cb as i128).abs() * ONE as i128;
        assert!(best <= diff, "hedge net {} beat the difference bet {}", best, diff);
    }
}

/// Pseudo-random play over many rounds: invariants hold after every step.
#[test]
fn random_play_keeps_invariants() {
    let mut c = setup();
    let players: Vec<AccountId> = (0..6).map(|i| acc(&format!("p{}.testnet", i))).collect();
    for p in &players {
        faucet(&mut c, p);
    }
    let mut seed: u64 = 42;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for r in 0..30u64 {
        let mut committed = vec![];
        for p in &players {
            if rnd() % 3 == 0 {
                continue;
            }
            let b = bal(&c, p);
            let cap = b / 4;
            if cap < ONE {
                continue;
            }
            let amt = ONE + (rnd() as u128 % (cap - ONE + 1));
            let side = if rnd() % 2 == 0 { "A" } else { "B" };
            if c.get_player(p.clone()).open.len() >= MAX_OPEN_ROUNDS {
                continue;
            }
            commit(&mut c, p, r, side, amt);
            committed.push((p.clone(), side));
            check_invariants(&c, &players);
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
                check_invariants(&c, &players);
            }
        }
    }
    ctx(&players[0], t_after(40));
    for p in &players {
        c.claim(Some(p.clone()));
    }
    let s = c.get_status();
    assert_eq!(s.escrow.0, 0, "everything claimed -> nothing left in escrow");
    check_invariants(&c, &players);
    assert!(s.total_burned.0 > 0);
}
