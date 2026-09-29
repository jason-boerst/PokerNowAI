import { expect } from "chai";

import { parseHand } from "../../app/engine/hand-parser.ts";
import { describeProfile, PlayerProfile, POOL_PRIOR_WEIGHT, PRIORS, ProfileBuilder, RateKey, resetPriors } from "../../app/engine/player-profile.ts";
import { equity } from "../../app/engine/equity.ts";
import { POPULATION_TENDENCIES } from "../../app/engine/opponent-range.ts";
import { topRange } from "../../app/engine/ranges.ts";
import { DBService } from "../../app/services/db-service.ts";
import { HandRecorder } from "../../app/services/hand-recorder.ts";
import { ProfileService } from "../../app/services/profile-service.ts";

const p = (name: string, id: string) => `"${name} @ ${id}"`;
const header = (n: number, game = "No Limit Texas Hold'em", stacks = [200, 200, 200]) => [
    `-- starting hand #${n} (id: h${n})  ${game} (dealer: ${p("C", "c")}) --`,
    `Player stacks: #1 ${p("A", "a")} (${stacks[0]}) | #2 ${p("B", "b")} (${stacks[1]}) | #3 ${p("C", "c")} (${stacks[2]})`,
    `${p("A", "a")} posts a small blind of 1`,
    `${p("B", "b")} posts a big blind of 2`
];

describe("ProfileBuilder", () => {
    it("counts 3-bets and folds to 3-bets", () => {
        const b = new ProfileBuilder();
        b.addHand(parseHand([...header(1), `${p("C", "c")} raises to 6`, `${p("A", "a")} raises to 20`, `${p("B", "b")} folds`, `${p("C", "c")} folds`]));
        const c = b.profile("c")!, a = b.profile("a")!;
        expect([c.pfr.k, c.pfr.n, c.fold_to_three_bet.k, c.fold_to_three_bet.n]).to.deep.equal([1, 1, 1, 1]);
        expect([a.three_bet.k, a.three_bet.n]).to.deep.equal([1, 1]);
        // B acted after two raises: a 4-bet spot, not a 3-bet chance
        expect([b.profile("b")!.three_bet.k, b.profile("b")!.three_bet.n]).to.deep.equal([0, 0]);
    });

    it("counts c-bets, folds to c-bets, aggression and bet size", () => {
        const b = new ProfileBuilder();
        b.addHand(parseHand([...header(2), `${p("C", "c")} raises to 6`, `${p("A", "a")} folds`, `${p("B", "b")} calls 6`,
            `Flop:  [K♠, 7♦, 2♣]`, `${p("B", "b")} checks`, `${p("C", "c")} bets 9`, `${p("B", "b")} folds`]));
        const c = b.profile("c")!, bb = b.profile("b")!;
        expect([c.cbet.k, c.cbet.n]).to.deep.equal([1, 1]);
        expect([bb.fold_to_cbet.k, bb.fold_to_cbet.n]).to.deep.equal([1, 1]);
        expect(c.avg_bet_to_pot).to.be.closeTo(9 / 13, 1e-9);
        expect([c.aggression.k, c.aggression.n]).to.deep.equal([1, 1]);
    });

    it("records showdown hands with the line they played", () => {
        const b = new ProfileBuilder();
        b.addHand(parseHand([...header(3), `${p("C", "c")} calls 2`, `${p("A", "a")} folds`, `${p("B", "b")} checks`,
            `Flop:  [K♠, 7♦, 2♣]`, `${p("B", "b")} bets 2`, `${p("C", "c")} calls 2`,
            `Turn: K♠, 7♦, 2♣ [9♥]`, `${p("B", "b")} checks`, `${p("C", "c")} checks`,
            `River: K♠, 7♦, 2♣, 9♥ [3♣]`, `${p("B", "b")} checks`, `${p("C", "c")} checks`,
            `${p("C", "c")} shows a 7♠, 6♠.`, `${p("B", "b")} shows a K♦, Q♣.`, `${p("B", "b")} collected 9 from pot`, `-- ending hand #3 --`]));
        const c = b.profile("c")!;
        expect(c.showdowns[0]).to.deep.include({ hand_class: "76s", won: false, line: "preflop: call | flop: call | turn: check | river: check" });
        expect([c.went_to_showdown.k, c.went_to_showdown.n]).to.deep.equal([1, 1]);
        expect([c.limp.k, c.limp.n]).to.deep.equal([1, 1]);
    });

    it("blends small samples toward the population and classifies with enough hands", () => {
        const b = new ProfileBuilder();
        b.addHand(parseHand([...header(4), `${p("C", "c")} calls 2`, `${p("A", "a")} folds`, `${p("B", "b")} checks`]));
        const one = b.profile("c")!;
        expect(one.vpip.value).to.be.lessThan(0.5);           // 1 of 1 is not treated as 100%
        expect(one.type).to.equal("unknown");

        // 40 hands: C limps and calls every c-bet to showdown -> calling station; A always folds -> nit
        const s = new ProfileBuilder();
        for (let i = 0; i < 40; i++) {
            s.addHand(parseHand([...header(10 + i), `${p("C", "c")} calls 2`, `${p("A", "a")} folds`, `${p("B", "b")} raises to 8`, `${p("C", "c")} calls 8`,
                `Flop:  [K♠, 7♦, 2♣]`, `${p("B", "b")} bets 8`, `${p("C", "c")} calls 8`,
                `Turn: K♠, 7♦, 2♣ [9♥]`, `${p("B", "b")} checks`, `${p("C", "c")} checks`,
                `River: K♠, 7♦, 2♣, 9♥ [3♣]`, `${p("B", "b")} checks`, `${p("C", "c")} checks`, `-- ending hand #${10 + i} --`]));
        }
        expect(s.profile("c")!.type).to.equal("calling station");
        expect(s.profile("a")!.type).to.equal("nit");
    });
});

describe("per-street tendencies", () => {
    const counts = (profile: PlayerProfile, ...keys: RateKey[]) => keys.map((key) => [profile[key].k, profile[key].n]);
    // SB A, BB B, button C; after the flop A acts first, then B, then C
    const street_hand = [...header(20), `${p("C", "c")} raises to 6`, `${p("A", "a")} calls 6`, `${p("B", "b")} calls 6`,
        `Flop:  [K♠, 7♦, 2♣]`, `${p("A", "a")} checks`, `${p("B", "b")} bets 9`, `${p("C", "c")} folds`, `${p("A", "a")} calls 9`,
        `Turn: K♠, 7♦, 2♣ [9♥]`, `${p("A", "a")} checks`, `${p("B", "b")} checks`,
        `River: K♠, 7♦, 2♣, 9♥ [3♣]`, `${p("A", "a")} bets 20`, `${p("B", "b")} folds`, `-- ending hand #20 --`];

    it("counts folds to the first bet of each street, raises facing a bet and bets when checked to", () => {
        const b = new ProfileBuilder();
        b.addHand(parseHand(street_hand));
        const keys: RateKey[] = ["fold_to_bet_flop", "fold_to_bet_turn", "fold_to_bet_river", "raise_vs_bet", "bet_when_checked_to"];
        // the flop bet is three-way, so folding or calling it isn't a heads-up fold chance;
        // A acted first after the flop and was never checked to
        expect(counts(b.profile("c")!, ...keys)).to.deep.equal([[0, 0], [0, 0], [0, 0], [0, 1], [0, 0]]);
        expect(counts(b.profile("a")!, ...keys)).to.deep.equal([[0, 0], [0, 0], [0, 0], [0, 1], [0, 0]]);
        // B bets the flop and checks the turn after A checked, then folds to A's heads-up river bet
        expect(counts(b.profile("b")!, ...keys)).to.deep.equal([[0, 0], [0, 0], [1, 1], [0, 1], [1, 2]]);

        const hu = new ProfileBuilder();
        hu.addHand(parseHand([...header(23), `${p("C", "c")} raises to 6`, `${p("A", "a")} folds`, `${p("B", "b")} calls 6`,
            `Flop:  [K♠, 7♦, 2♣]`, `${p("B", "b")} checks`, `${p("C", "c")} bets 9`, `${p("B", "b")} folds`, `-- ending hand #23 --`]));
        expect(counts(hu.profile("b")!, "fold_to_bet_flop", "raise_vs_bet")).to.deep.equal([[1, 1], [0, 1]]);
        expect(counts(hu.profile("c")!, "fold_to_bet_flop", "bet_when_checked_to")).to.deep.equal([[0, 0], [1, 1]]);
    });

    it("counts fold chances heads-up only, and every action facing a bet or raise", () => {
        const b = new ProfileBuilder();
        b.addHand(parseHand([...header(21), `${p("C", "c")} calls 2`, `${p("A", "a")} calls 2`, `${p("B", "b")} checks`,
            `Flop:  [K♠, 7♦, 2♣]`, `${p("A", "a")} checks`, `${p("B", "b")} bets 4`, `${p("C", "c")} raises to 16`, `${p("A", "a")} folds`, `${p("B", "b")} calls 16`,
            `Turn: K♠, 7♦, 2♣ [9♥]`, `${p("B", "b")} checks`, `${p("C", "c")} bets 20`, `${p("B", "b")} raises to 60`, `${p("C", "c")} calls 60`,
            `-- ending hand #21 --`]));
        const keys: RateKey[] = ["fold_to_bet_flop", "fold_to_bet_turn", "raise_vs_bet", "bet_when_checked_to"];
        // three-way flop: no fold chances; A folded to C's raise; on the turn B raises C's heads-up bet
        expect(counts(b.profile("a")!, ...keys)).to.deep.equal([[0, 0], [0, 0], [0, 1], [0, 0]]);
        expect(counts(b.profile("b")!, ...keys)).to.deep.equal([[0, 0], [0, 1], [1, 2], [1, 1]]);
        expect(counts(b.profile("c")!, ...keys)).to.deep.equal([[0, 0], [0, 0], [1, 2], [1, 1]]);
    });

    it("skips raise chances when raising was impossible, and counts all-in players as still in the hand", () => {
        // C's all-in flop bet leaves B nobody to raise against: a fold chance, not a raise chance
        const shove = new ProfileBuilder();
        shove.addHand(parseHand([...header(25, undefined, [200, 200, 30]), `${p("C", "c")} raises to 6`, `${p("A", "a")} folds`, `${p("B", "b")} calls 6`,
            `Flop:  [K♠, 7♦, 2♣]`, `${p("B", "b")} checks`, `${p("C", "c")} bets 24 and go all in`, `${p("B", "b")} folds`, `-- ending hand #25 --`]));
        expect(counts(shove.profile("b")!, "fold_to_bet_flop", "raise_vs_bet")).to.deep.equal([[1, 1], [0, 0]]);

        // A is all-in preflop, so B's flop bet into C isn't heads-up
        const side = new ProfileBuilder();
        side.addHand(parseHand([...header(26, undefined, [10, 200, 200]), `${p("C", "c")} calls 2`, `${p("A", "a")} raises to 10 and go all in`,
            `${p("B", "b")} calls 10`, `${p("C", "c")} calls 10`, `Flop:  [K♠, 7♦, 2♣]`, `${p("B", "b")} bets 20`, `${p("C", "c")} folds`, `-- ending hand #26 --`]));
        expect(counts(side.profile("c")!, "fold_to_bet_flop", "raise_vs_bet")).to.deep.equal([[0, 0], [0, 1]]);

        // C's all-in for less than a full raise doesn't reopen betting for B, who bet; A only checked
        const short = new ProfileBuilder();
        short.addHand(parseHand([...header(27, undefined, [200, 200, 14]), `${p("C", "c")} calls 2`, `${p("A", "a")} calls 2`, `${p("B", "b")} checks`,
            `Flop:  [K♠, 7♦, 2♣]`, `${p("A", "a")} checks`, `${p("B", "b")} bets 10`, `${p("C", "c")} raises to 12 and go all in`,
            `${p("A", "a")} calls 12`, `${p("B", "b")} calls 12`, `-- ending hand #27 --`]));
        expect(counts(short.profile("b")!, "raise_vs_bet")).to.deep.equal([[0, 0]]);
        expect(counts(short.profile("a")!, "raise_vs_bet")).to.deep.equal([[0, 1]]);
        expect(counts(short.profile("c")!, "raise_vs_bet")).to.deep.equal([[1, 1]]);

        // cents stakes: calling exactly your last 0.70 is all-in, not a raise chance
        const cents = new ProfileBuilder();
        cents.addHand(parseHand([`-- starting hand #28 (id: h28)  No Limit Texas Hold'em (dealer: ${p("C", "c")}) --`,
            `Player stacks: #1 ${p("A", "a")} (1.00) | #2 ${p("B", "b")} (20.00) | #3 ${p("C", "c")} (20.00)`,
            `${p("A", "a")} posts a small blind of 0.10`, `${p("B", "b")} posts a big blind of 0.20`,
            `${p("C", "c")} raises to 0.30`, `${p("A", "a")} calls 0.30`, `${p("B", "b")} folds`,
            `Flop:  [K♠, 7♦, 2♣]`, `${p("A", "a")} checks`, `${p("C", "c")} bets 0.70`, `${p("A", "a")} calls 0.70 and go all in`, `-- ending hand #28 --`]));
        expect(counts(cents.profile("a")!, "fold_to_bet_flop", "raise_vs_bet")).to.deep.equal([[0, 1], [0, 0]]);
    });

    it("leaves other games out and shows the street folds in the one-line summary", () => {
        const b = new ProfileBuilder();
        b.addHand(parseHand([...header(22, "Pot Limit Omaha Hi"), ...street_hand.slice(4)]));
        expect(counts(b.profile("b")!, "fold_to_bet_river", "raise_vs_bet", "bet_when_checked_to")).to.deep.equal([[0, 0], [0, 0], [0, 0]]);
        const bb = new ProfileBuilder();
        bb.addHand(parseHand(street_hand));
        expect(describeProfile(bb.profile("b")!)).to.match(/folds to a heads-up bet on flop\/turn\/river \d+\/\d+\/\d+% \[0\/0\/1\]/);
    });
});

describe("ProfileService.stats", () => {
    let db: DBService;

    beforeEach(async () => {
        db = new DBService(":memory:");
        await db.init();
        await db.createTables();
    });

    afterEach(async () => {
        await db.close();
        resetPriors();
        POPULATION_TENDENCIES.vpip = PRIORS.vpip.mean * 100;
        POPULATION_TENDENCIES.pfr = PRIORS.pfr.mean * 100;
    });

    it("includes the 3-bet rate, and summarizes the pool averages", async () => {
        const recorder = new HandRecorder(db);
        await recorder.recordHand("g1", [...header(1), `${p("C", "c")} raises to 6`, `${p("A", "a")} raises to 20`, `${p("B", "b")} folds`,
            `${p("C", "c")} folds`, `-- ending hand #1 --`], "C", 2);
        // B folds to A's heads-up river bet
        await recorder.recordHand("g1", [...header(2), `${p("C", "c")} folds`, `${p("A", "a")} calls 2`, `${p("B", "b")} checks`,
            `Flop:  [K♠, 7♦, 2♣]`, `${p("A", "a")} checks`, `${p("B", "b")} checks`, `Turn: K♠, 7♦, 2♣ [9♥]`, `${p("A", "a")} checks`, `${p("B", "b")} checks`,
            `River: K♠, 7♦, 2♣, 9♥ [3♣]`, `${p("A", "a")} bets 4`, `${p("B", "b")} folds`, `-- ending hand #2 --`], "C", 2);
        const service = new ProfileService(recorder);
        await service.load();
        const stats = service.stats({ id: "a", name: "A" })!;
        const a = service.info({ id: "a", name: "A" }).current!;
        expect(a.three_bet.k).to.equal(1);
        expect(stats.three_bet).to.be.closeTo(a.three_bet.value * 100, 1e-9);
        const pool = service.poolSummary();
        expect(pool.pool_hands).to.equal(4);                    // A and B, two hands each; C is you
        expect(pool.fold_to_bet_river).to.be.closeTo((1 + 0.5 * POOL_PRIOR_WEIGHT) / (1 + POOL_PRIOR_WEIGHT), 1e-9);
        expect(pool.fold_to_bet_flop).to.equal(0.4);            // no chances yet: the built-in guess
    });
});

describe("aggression-aware equity", () => {
    it("gives hero more equity against a bet from an aggressive player than from a passive one", () => {
        const base = { hero: ["Qd", "Jc"], board: ["Qh", "8s", "3d"], iterations: 40000, time_budget_ms: 5000, seed: 5 };
        const bet = [{ board: ["Qh", "8s", "3d"], action: "bet" as const }];
        const passive = equity({ ...base, opponents: [{ range: topRange(40), postflop_actions: bet, aggression: 0.15 }] });
        const maniac = equity({ ...base, opponents: [{ range: topRange(40), postflop_actions: bet, aggression: 0.8 }] });
        expect(maniac.equity).to.be.greaterThan(passive.equity + 0.03);
    });
});
