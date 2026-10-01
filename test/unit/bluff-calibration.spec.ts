import { expect } from "chai";

import { applyBluffScale, fitBluffScale, fitPlayerBluffScales, heldOutPlayerBluffCheck } from "../../app/engine/bluff-calibration.ts";
import { rangeClassShares, scaleBluffs } from "../../app/engine/equity.ts";
import { seatModel, setPlayerBluffScales } from "../../app/engine/opponent-range.ts";
import { parseHand } from "../../app/engine/hand-parser.ts";
import { DEFAULT_ACTION_WEIGHTS } from "../../app/engine/showdown-calibration.ts";

const p = (name: string, id: string) => `"${name} @ ${id}"`;
const weights = () => ({ flop: structuredClone(DEFAULT_ACTION_WEIGHTS), turn: structuredClone(DEFAULT_ACTION_WEIGHTS), river: structuredClone(DEFAULT_ACTION_WEIGHTS) });

// B (or `bettor`, in B's seat) raises preflop and bets every street; C calls down; the bettor shows `b_cards`
// (board K-8-4-9-3: no help for most hands)
const barrel = (n: number, b_cards: string, bettor = "b") => {
    const B = p(bettor.toUpperCase(), bettor);
    return parseHand([
        `-- starting hand #${n} (id: h${n})  No Limit Texas Hold'em (dealer: ${p("C", "c")}) --`,
        `Player stacks: #1 ${p("A", "a")} (200) | #2 ${B} (200) | #3 ${p("C", "c")} (200)`,
        `${p("A", "a")} posts a small blind of 1`, `${B} posts a big blind of 2`,
        `${p("C", "c")} calls 2`, `${p("A", "a")} folds`, `${B} raises to 8`, `${p("C", "c")} calls 8`,
        `Flop:  [K♠, 8♠, 4♣]`, `${B} bets 8`, `${p("C", "c")} calls 8`,
        `Turn: K♠, 8♠, 4♣ [9♥]`, `${B} bets 16`, `${p("C", "c")} calls 16`,
        `River: K♠, 8♠, 4♣, 9♥ [3♦]`, `${B} bets 30`, `${p("C", "c")} calls 30`,
        `${B} shows a ${b_cards}.`, `-- ending hand #${n} --`]);
};

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

describe("per-player bluffing", () => {
    const stats = () => undefined;
    const keyOf = (seat: { id: string }) => seat.id;
    // B bluffs: air on every called river bet; D (same seat, other hands) always has it; half of the pool's bets are air
    const hands = (offset: number) => [
        ...Array.from({ length: 25 }, (_, i) => barrel(offset + i, "Q♥, J♥", "b")),
        ...Array.from({ length: 25 }, (_, i) => barrel(offset + 100 + i, "K♦, K♣", "d"))
    ];

    it("fits each player's own scale against the pool's, pulled toward the pool", () => {
        const fits = fitPlayerBluffScales(hands(0), applyBluffScale(weights(), 1.5), stats, keyOf);
        const b = fits.get("b")!, d = fits.get("d")!;
        expect(b.samples).to.equal(25);
        expect(b.air).to.equal(25);
        expect(b.scale).to.be.greaterThan(1).and.below(b.best + 1e-9);
        expect(d.air).to.equal(0);
        expect(d.scale).to.be.below(1);
        // with a huge prior everyone stays at the pool's scale
        expect(fitPlayerBluffScales(hands(0), weights(), stats, keyOf, () => true, 1e9).get("b")!.scale).to.equal(1);
    });

    it("predicts a held-out game better than the pool when players bluff consistently differently", () => {
        const states = [...hands(0).map((s) => ({ game: "g1", s })), ...hands(1000).map((s) => ({ game: "g2", s }))];
        const check = heldOutPlayerBluffCheck(states, weights(), stats, keyOf);
        expect(check.samples).to.equal(100);
        expect(check.ll_player).to.be.greaterThan(check.ll_pool + 2 * check.diff_se);
    });

    it("reads a player who bluffs more with a wider betting range on the flop and turn only", () => {
        const w = weights();
        expect(scaleBluffs(w.flop, "flop", 2).bet.air).to.be.closeTo(w.flop.bet.air * 2, 1e-9);
        expect(scaleBluffs(w.river, "river", 2)).to.equal(w.river);
        const range = new Map([["QJs", 1], ["KK", 1]]);
        const board = ["Ks", "8s", "4c"];
        const pool = rangeClassShares({ range, postflop_actions: [{ board, action: "bet" }] }, board);
        const bluffer = rangeClassShares({ range, postflop_actions: [{ board, action: "bet" }], bluff_scale: 2 }, board);
        expect(bluffer.air).to.be.greaterThan(pool.air);
    });

    it("puts the scale into the seat's model only while a reader is set", () => {
        const s = barrel(1, "Q♥, J♥");
        const seat = s.seats.find((x) => x.id === "b")!;
        try {
            setPlayerBluffScales((x) => (x.id === "b" ? { scale: 1.6, note: "Bluffs more than most" } : undefined));
            expect(seatModel(s, seat, stats).model.bluff_scale).to.equal(1.6);
            expect(seatModel(s, s.seats.find((x) => x.id === "c")!, stats).model.bluff_scale).to.equal(undefined);
        } finally {
            setPlayerBluffScales(null);
        }
        expect(seatModel(s, seat, stats).model.bluff_scale).to.equal(undefined);
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
