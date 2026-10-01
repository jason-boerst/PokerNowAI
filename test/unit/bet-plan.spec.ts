import { expect } from "chai";

import { heroBetTree, HeroBetTreeInput } from "../../app/engine/equity.ts";
import { heroView, parseHand } from "../../app/engine/hand-parser.ts";
import { analyzePostflop, OpponentTendency, setBetPlanInEv } from "../../app/engine/postflop.ts";
import { topRange } from "../../app/engine/ranges.ts";
import { betPlanLine } from "../../app/helpers/bet-explain.ts";

// the caller of hero's flop bet: a wide range that called a bet on K-8-2
const board = ["Kh", "8c", "2s"];
const caller = { range: topRange(40), postflop_actions: [{ board, action: "call" as const }] };
const tree = (hero: string[], extra: Partial<HeroBetTreeInput> = {}) => heroBetTree({
    hero, board, caller, pots: [{ pot: 20, stack_behind: 200 }], barrel_shares: [0.5, 0.75], barrel_folds: [0.45, 0.5],
    barrel_raise: 0.08, caller_bet: 0.4, caller_bet_share: 0.75, iterations: 6000, time_budget_ms: 2000, seed: 3, ...extra
}).plans[0];

describe("hero's plan for the next street", () => {
    it("bets more turns against a caller who folds a lot than against one who never folds", () => {
        const folder = tree(["Qs", "Js"], { barrel_folds: [0.6, 0.65] });
        const sticky = tree(["Qs", "Js"], { barrel_folds: [0.05, 0.05], barrel_raise: 0.02 });
        expect(folder.gain).to.be.greaterThan(sticky.gain);
        expect(folder.barrel_rate).to.be.greaterThan(sticky.barrel_rate);
        expect(sticky.gain).to.be.at.least(0);
    });

    it("values a strong hand's barrels (called by worse) and grows with the pot", () => {
        const set = tree(["8h", "8d"]);
        expect(set.barrel_rate).to.be.greaterThan(0.8);
        const t = heroBetTree({
            hero: ["8h", "8d"], board, caller, pots: [{ pot: 20, stack_behind: 400 }, { pot: 40, stack_behind: 800 }], barrel_shares: [0.5, 0.75],
            barrel_folds: [0.45, 0.5], barrel_raise: 0.08, caller_bet: 0.4, caller_bet_share: 0.75, iterations: 6000, time_budget_ms: 2000, seed: 3
        });
        // the same plan in a pot twice as big (with stacks to match) is worth twice as much
        expect(t.plans[1].gain).to.be.closeTo(2 * t.plans[0].gain, 1e-9);
    });

    it("adds nothing when there is nothing left to bet", () => {
        expect(tree(["Qs", "Js"], { pots: [{ pot: 20, stack_behind: 0 }] }).gain).to.equal(0);
    });

    it("comes with each heads-up flop bet in the analysis, and leaves the EVs alone unless switched on", () => {
        const p = (name: string, id: string) => `"${name} @ ${id}"`;
        const H = p("H", "h"), V = p("V", "v");
        const s = parseHand([
            `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${H}) --`,
            `Player stacks: #1 ${H} (400) | #2 ${V} (400)`, `Your hand is Q♠, J♠`,
            `${H} posts a small blind of 1`, `${V} posts a big blind of 2`, `${H} raises to 6`, `${V} calls 6`,
            `Flop:  [K♥, 8♣, 2♠]`, `${V} checks`
        ], { hero_name: "H" });
        const villain: OpponentTendency = { model: { range: topRange(40) }, fold_to_bet: 0.4, fold_to_raise: 0.2 };
        const off = analyzePostflop(s, heroView(s)!, [villain]);
        const bets = off.candidates.filter((c) => c.action === "bet");
        expect(bets.length).to.be.greaterThan(0);
        for (const b of bets) expect(b.plan).to.not.equal(undefined);
        expect(off.candidates.find((c) => c.action === "check")!.plan).to.equal(undefined);
        try {
            setBetPlanInEv(true);
            const on = analyzePostflop(s, heroView(s)!, [villain]);
            for (const b of on.candidates.filter((c) => c.action === "bet")) {
                const before = bets.find((x) => x.to === b.to)!;
                expect(b.ev).to.be.closeTo(before.ev + (1 - b.fold_chance! - b.raise_chance!) * b.plan!.gain, 0.02 * Math.abs(before.ev) + 1);
            }
            expect(on.candidates.find((c) => c.action === "check")!.plan).to.not.equal(undefined);
        } finally {
            setBetPlanInEv(false);
        }
    });

    it("says on the panel which cards to keep betting", () => {
        expect(betPlanLine({ barrel_rate: 0.95, ranks: [], suits: [] }, "turn")).to.match(/almost any card/);
        expect(betPlanLine({ barrel_rate: 0.05, ranks: [], suits: [] }, "turn")).to.match(/check the turn on almost every card/);
        expect(betPlanLine({ barrel_rate: 0.3, ranks: ["A", "T"], suits: ["h"] }, "turn")).to.equal(
            "If called: bet the turn again on about 30% of cards (A, 10, any ♥) and check the rest (the engine's estimate from how your games fold to turn bets).");
        expect(betPlanLine({ barrel_rate: 0.7, ranks: ["A", "K", "Q", "J", "T", "9", "8", "7"], suits: [] }, "river")).to.match(/any card but 6, 5, 4, 3, 2/);
    });
});
