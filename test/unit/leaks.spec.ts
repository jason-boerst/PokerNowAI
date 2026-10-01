import { expect } from "chai";

import { findLeaks, zFor } from "../../app/eval/leaks.ts";
import { HeroHand, replayHand } from "../../app/eval/replay.ts";

// synthetic 3-handed hands: "Hero @ HeroId0001" is on the button
const HEADER = (n: number) => [
    `-- starting hand #${n} (id: synth${n})  No Limit Texas Hold'em (dealer: "Hero @ HeroId0001") --`,
    'Player stacks: #1 "Villain1 @ VillainId01" (100.00) | #2 "Villain2 @ VillainId02" (100.00) | #3 "Hero @ HeroId0001" (100.00)',
    "Your hand is A♠, K♠",
    '"Villain1 @ VillainId01" posts a small blind of 0.50',
    '"Villain2 @ VillainId02" posts a big blind of 1.00'
];
const hero = (messages: string[], n: number): HeroHand => replayHand({
    game_id: "g1", hand_number: n, big_blind: 1, hero_id: "HeroId0001", messages_json: JSON.stringify(messages)
}, null)!;

/** Hero opens, the big blind calls, hero bets the flop, gets raised and folds (loses 3 + `bet`). */
const openAndGiveUp = (n: number, bet: number) => hero([
    ...HEADER(n),
    '"Hero @ HeroId0001" raises to 3.00',
    '"Villain1 @ VillainId01" folds',
    '"Villain2 @ VillainId02" calls 3.00',
    "Flop:  [Q♥, 7♦, 2♣]",
    '"Villain2 @ VillainId02" checks',
    `"Hero @ HeroId0001" bets ${bet.toFixed(2)}`,
    `"Villain2 @ VillainId02" raises to ${(bet * 3).toFixed(2)}`,
    '"Hero @ HeroId0001" folds',
    `"Villain2 @ VillainId02" collected ${(6.5 + bet * 2).toFixed(2)} from pot`,
    `-- ending hand #${n} --`
], n);

/** Hero calls a river bet of 10 into 20 (needs 25%) and wins or loses at showdown. */
const riverCall = (n: number, win: boolean) => hero([
    ...HEADER(n),
    '"Hero @ HeroId0001" calls 1.00',
    '"Villain1 @ VillainId01" folds',
    '"Villain2 @ VillainId02" checks',
    "Flop:  [Q♥, 7♦, 2♣]",
    '"Villain2 @ VillainId02" checks',
    '"Hero @ HeroId0001" checks',
    "Turn: Q♥, 7♦, 2♣ [9♠]",
    '"Villain2 @ VillainId02" bets 8.75',
    '"Hero @ HeroId0001" calls 8.75',
    "River: Q♥, 7♦, 2♣, 9♠ [3♥]",
    '"Villain2 @ VillainId02" bets 10.00',
    '"Hero @ HeroId0001" calls 10.00',
    win ? '"Hero @ HeroId0001" collected 40.00 from pot' : '"Villain2 @ VillainId02" collected 40.00 from pot',
    `-- ending hand #${n} --`
], n);

describe("leak finder", () => {
    it("finds the z for an upper-tail probability", () => {
        expect(zFor(0.025)).to.be.closeTo(1.96, 0.01);
        expect(zFor(0.005)).to.be.closeTo(2.576, 0.01);
    });

    it("flags a line that loses clearly, with the bar set for the number of lines tested", () => {
        const hands = Array.from({ length: 30 }, (_, i) => openAndGiveUp(i + 1, 2 + (i % 5)));
        const r = findLeaks(hands);
        const open = r.lines.find((l) => l.label === "Open from the cutoff or button")!;
        expect(open.n).to.equal(30);
        expect(open.result!.bb_per_100).to.be.lessThan(0);
        expect(open.flagged).to.equal(true);
        expect(r.tested).to.be.greaterThan(0);
        expect(r.z_bar).to.be.closeTo(zFor(0.05 / (2 * r.tested)), 1e-9);
        // folding to the raise is not listed as a result: a fold always shows a loss
        expect(r.lines.some((l) => /fold/i.test(l.label) && l.area === "postflop")).to.equal(false);
        expect(r.lines.find((l) => l.label === "As the preflop raiser on the flop: bet")!.n).to.equal(30);
    });

    it("doesn't flag a line with too few hands", () => {
        const r = findLeaks(Array.from({ length: 10 }, (_, i) => openAndGiveUp(i + 1, 2 + (i % 5))));
        expect(r.lines.find((l) => l.label === "Open from the cutoff or button")!.flagged).to.equal(false);
    });

    it("checks river calls against the price they needed, counting wins from the pot (not shown cards)", () => {
        const hands = [...Array.from({ length: 4 }, (_, i) => riverCall(i + 1, true)), ...Array.from({ length: 16 }, (_, i) => riverCall(i + 5, false))];
        const line = findLeaks(hands).lines.find((l) => l.label === "River calls that won")!;
        expect(line.n).to.equal(20);
        expect(line.rate).to.be.closeTo(0.2, 1e-9);
        expect(line.benchmark).to.be.closeTo(10 / 40, 1e-9);
    });

    it("compares your profile stats with your games' average, flagging only large, clear gaps", () => {
        const r = findLeaks([], [], { mine: { vpip: { k: 60, n: 100 }, pfr: { k: 17, n: 100 } }, pool: { vpip: 0.3, pfr: 0.15 } });
        expect(r.lines.find((l) => l.label === "Hands played (VPIP)")!.flagged).to.equal(true);
        expect(r.lines.find((l) => l.label === "Raises before the flop (PFR)")!.flagged).to.equal(false);
    });
});
