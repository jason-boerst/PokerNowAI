import { expect } from "chai";

import { parseHand } from "../../app/engine/hand-parser.ts";
import { ProfileBuilder } from "../../app/engine/player-profile.ts";
import { equity } from "../../app/engine/equity.ts";
import { topRange } from "../../app/engine/ranges.ts";

const p = (name: string, id: string) => `"${name} @ ${id}"`;
const header = (n: number) => [
    `-- starting hand #${n} (id: h${n})  No Limit Texas Hold'em (dealer: ${p("C", "c")}) --`,
    `Player stacks: #1 ${p("A", "a")} (200) | #2 ${p("B", "b")} (200) | #3 ${p("C", "c")} (200)`,
    `${p("A", "a")} posts a small blind of 1`,
    `${p("B", "b")} posts a big blind of 2`
];

describe("ProfileBuilder", () => {
    it("counts 3-bets and folds to 3-bets", () => {
        const b = new ProfileBuilder();
        b.addHand(parseHand([...header(1), `${p("C", "c")} raises to 6`, `${p("A", "a")} raises to 20`, `${p("B", "b")} folds`, `${p("C", "c")} folds`]));
        const c = b.profile("C")!, a = b.profile("A")!;
        expect([c.pfr.k, c.pfr.n, c.fold_to_three_bet.k, c.fold_to_three_bet.n]).to.deep.equal([1, 1, 1, 1]);
        expect([a.three_bet.k, a.three_bet.n]).to.deep.equal([1, 1]);
        // B acted after two raises: a 4-bet spot, not a 3-bet chance
        expect([b.profile("B")!.three_bet.k, b.profile("B")!.three_bet.n]).to.deep.equal([0, 0]);
    });

    it("counts c-bets, folds to c-bets, aggression and bet size", () => {
        const b = new ProfileBuilder();
        b.addHand(parseHand([...header(2), `${p("C", "c")} raises to 6`, `${p("A", "a")} folds`, `${p("B", "b")} calls 6`,
            `Flop:  [K♠, 7♦, 2♣]`, `${p("B", "b")} checks`, `${p("C", "c")} bets 9`, `${p("B", "b")} folds`]));
        const c = b.profile("C")!, bb = b.profile("B")!;
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
        const c = b.profile("C")!;
        expect(c.showdowns[0]).to.deep.include({ hand_class: "76s", won: false, line: "preflop: call | flop: call | turn: check | river: check" });
        expect([c.went_to_showdown.k, c.went_to_showdown.n]).to.deep.equal([1, 1]);
        expect([c.limp.k, c.limp.n]).to.deep.equal([1, 1]);
    });

    it("blends small samples toward the population and classifies with enough hands", () => {
        const b = new ProfileBuilder();
        b.addHand(parseHand([...header(4), `${p("C", "c")} calls 2`, `${p("A", "a")} folds`, `${p("B", "b")} checks`]));
        const one = b.profile("C")!;
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
        expect(s.profile("C")!.type).to.equal("calling station");
        expect(s.profile("A")!.type).to.equal("nit");
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
