import { expect } from "chai";

import { applyBluffScale, fitBluffScale } from "../../app/engine/bluff-calibration.ts";
import { rangeClassShares } from "../../app/engine/equity.ts";
import { parseHand } from "../../app/engine/hand-parser.ts";
import { DEFAULT_ACTION_WEIGHTS } from "../../app/engine/showdown-calibration.ts";

const p = (name: string, id: string) => `"${name} @ ${id}"`;
const weights = () => ({ flop: structuredClone(DEFAULT_ACTION_WEIGHTS), turn: structuredClone(DEFAULT_ACTION_WEIGHTS), river: structuredClone(DEFAULT_ACTION_WEIGHTS) });

// B raises preflop and bets every street; C calls down; B shows `b_cards` (board K-7-2-9-3: no help for most hands)
const barrel = (n: number, b_cards: string) => parseHand([
    `-- starting hand #${n} (id: h${n})  No Limit Texas Hold'em (dealer: ${p("C", "c")}) --`,
    `Player stacks: #1 ${p("A", "a")} (200) | #2 ${p("B", "b")} (200) | #3 ${p("C", "c")} (200)`,
    `${p("A", "a")} posts a small blind of 1`, `${p("B", "b")} posts a big blind of 2`,
    `${p("C", "c")} calls 2`, `${p("A", "a")} folds`, `${p("B", "b")} raises to 8`, `${p("C", "c")} calls 8`,
    `Flop:  [K♠, 8♠, 4♣]`, `${p("B", "b")} bets 8`, `${p("C", "c")} calls 8`,
    `Turn: K♠, 8♠, 4♣ [9♥]`, `${p("B", "b")} bets 16`, `${p("C", "c")} calls 16`,
    `River: K♠, 8♠, 4♣, 9♥ [3♦]`, `${p("B", "b")} bets 30`, `${p("C", "c")} calls 30`,
    `${p("B", "b")} shows a ${b_cards}.`, `-- ending hand #${n} --`]);

describe("bluff calibration (flop and turn bettors)", () => {
    it("scales only flop and turn bets and raises of air and draws, never above a strong hand", () => {
        const w = applyBluffScale(weights(), 2);
        expect(w.flop.bet.air).to.be.closeTo(DEFAULT_ACTION_WEIGHTS.bet.air * 2, 1e-9);
        expect(w.turn.raise.draw).to.be.closeTo(DEFAULT_ACTION_WEIGHTS.raise.draw * 2, 1e-9);
        expect(w.flop.bet.draw).to.be.at.most(w.flop.bet.strong);
        expect(w.river.bet.air).to.equal(DEFAULT_ACTION_WEIGHTS.bet.air);
        expect(w.flop.bet.pair).to.equal(DEFAULT_ACTION_WEIGHTS.bet.pair);
        expect(w.flop.call).to.deep.equal(DEFAULT_ACTION_WEIGHTS.call);
        expect(applyBluffScale(weights(), 1)).to.deep.equal(weights());
    });

    it("fits a scale above 1 when called river bettors keep showing air, and about 1 when they show strong hands", () => {
        const stats = () => undefined;
        const bluffy = [...Array.from({ length: 30 }, (_, i) => barrel(i, "Q♥, J♥")), ...Array.from({ length: 30 }, (_, i) => barrel(100 + i, "K♦, K♣"))];
        const fit = fitBluffScale(bluffy, weights(), stats);
        expect(fit.samples).to.equal(60);
        expect(fit.observed_air).to.be.closeTo(0.5, 1e-9);
        expect(fit.best).to.be.greaterThan(1);
        // pulled toward 1 for the small sample, still above it
        expect(fit.scale).to.be.greaterThan(1).and.below(fit.best + 1e-9);
        expect(fit.log_likelihood_fitted).to.be.greaterThan(fit.log_likelihood);
        const honest = fitBluffScale(Array.from({ length: 40 }, (_, i) => barrel(200 + i, "K♦, K♣")), weights(), stats);
        expect(honest.scale).to.equal(1);
        // nothing to learn from: no correction
        expect(fitBluffScale([], weights(), stats).scale).to.equal(1);
    });
});

describe("7-2 under the bounty", () => {
    it("keeps 7-2 in a bettor's range like a strong hand instead of narrowing it away as air", () => {
        // 7-2 (air on K-8-4) and queens (a pair): after a bet, 7-2 keeps its full weight only under the bounty
        const range = new Map([["72o", 1], ["QQ", 1]]);
        const board = ["Ks", "8s", "4c"];
        const plain = rangeClassShares({ range, postflop_actions: [{ board, action: "bet" }] }, board);
        const bounty = rangeClassShares({ range, postflop_actions: [{ board, action: "bet" }], bounty_72: true }, board);
        const before = rangeClassShares({ range }, board);
        expect(plain.air).to.be.lessThan(before.air);
        expect(bounty.air).to.be.greaterThan(plain.air);
        expect(bounty.air).to.be.greaterThan(before.air - 1e-9);
    });
});
