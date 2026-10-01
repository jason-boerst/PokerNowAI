import { expect } from "chai";

import { callTree, CallTreeInput, equity, resetActionWeights } from "../../app/engine/equity.ts";
import { heroView, parseHand } from "../../app/engine/hand-parser.ts";
import { analyzePostflop, OpponentTendency, robustEv } from "../../app/engine/postflop.ts";
import { realizationOf } from "../../app/engine/preflop.ts";
import { topRange } from "../../app/engine/ranges.ts";
import default_config from "../../app/configs/preflop-ranges.json" with { type: "json" };

// a flop bettor: a top-40% range that bet this flop
const bettor = (board: string[]) => ({ range: topRange(40), postflop_actions: [{ board: board.slice(0, 3), action: "bet" as const }] });
const tree = (hero: string[], board: string[], extra: Partial<CallTreeInput> = {}) => callTree({
    hero, board, opponents: [bettor(board)], bettor: 0, pot: 16, to_call: 5, stack_behind: 400, bet_next: [0.54],
    next_bet_share: 0.75, in_position: true, iterations: 20000, time_budget_ms: 5000, seed: 7, ...extra
});
const flat = (hero: string[], board: string[], r = 0.95) =>
    equity({ hero, board, opponents: [bettor(board)], iterations: 20000, seed: 7 }).equity * 21 * r - 5;

describe("calling over the next street", () => {
    before(() => resetActionWeights());

    it("values ace high below its raw equity: it folds to most bets on the next street", () => {
        const hero = ["As", "4d"], board = ["Kh", "8c", "2s"];
        const t = tree(hero, board);
        expect(t.ev).to.be.lessThan(flat(hero, board));
        expect(t.continue_vs_barrel).to.be.lessThan(0.3);
        expect(t.barrel).to.be.closeTo(0.54, 0.08);
    });

    it("gives a nut flush draw implied odds that grow with the stacks", () => {
        const hero = ["Ah", "Th"], board = ["Kh", "8h", "2s"];
        const deep = tree(hero, board), shallow = tree(hero, board, { stack_behind: 20 });
        expect(deep.implied).to.be.greaterThan(0);
        expect(deep.realization).to.be.greaterThan(shallow.realization);
        expect(deep.realization).to.be.greaterThan(1);
        expect(deep.continue_vs_barrel).to.be.greaterThan(0.6);
    });

    it("counts an all-in call at its full equity, with nothing after it", () => {
        const hero = ["Ah", "Th"], board = ["Kh", "8h", "2s"];
        const t = tree(hero, board, { stack_behind: 0 });
        expect(t.implied).to.equal(0);
        expect(t.ev).to.be.closeTo(t.equity * 21 - 5, 0.01);
        expect(t.realization).to.be.closeTo(1, 0.01);
    });

    it("prices one-pair hands that run into better ones (reverse implied odds), but not a pocket pair on a paired board as a big hand", () => {
        const t = tree(["9c", "9d"], ["Kh", "8c", "2s"]);
        expect(t.implied).to.be.lessThan(0);
        // 55 on 6-8-6 is one pair, not a full house draw worth stacks: it can't lose more than a weak pair's share
        const paired = tree(["5c", "5h"], ["6h", "8s", "6d"]);
        expect(paired.implied).to.be.greaterThan(-0.05 * 400);
    });
});

describe("the call in the post-flop analysis", () => {
    const p = (name: string, id: string) => `"${name} @ ${id}"`;
    const H = p("H", "h"), V = p("V", "v");
    const spot = (hero: string, board: string[], street_lines: string[], stacks = 400) => {
        const s = parseHand([
            `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${H}) --`,
            `Player stacks: #1 ${H} (${stacks}) | #2 ${V} (${stacks})`,
            `Your hand is ${hero}`,
            `${H} posts a small blind of 1`, `${V} posts a big blind of 2`, `${H} raises to 6`, `${V} calls 6`,
            ...street_lines
        ], { hero_name: "H" });
        return { s, v: heroView(s)! };
    };
    const villain: OpponentTendency = { model: { range: topRange(40) }, fold_to_bet: 0.4, fold_to_raise: 0.2 };

    it("plans the next street when facing a flop bet, not on the river", () => {
        const flop = spot("Qh, Jh", ["Th", "4h", "2c"], [`Flop:  [Th, 4h, 2c]`, `${V} bets 8`]);
        const a = analyzePostflop(flop.s, flop.v, [{ ...villain, model: { ...villain.model, postflop_actions: [{ board: ["Th", "4h", "2c"], action: "bet" }] } }]);
        expect(a.call_plan).to.not.equal(undefined);
        expect(a.call_plan!.barrel).to.be.greaterThan(0.2);
        const river = spot("Qh, Jh", ["Th", "4h", "2c", "3s", "8d"], [`Flop:  [Th, 4h, 2c]`, `${V} checks`, `${H} checks`,
            `Turn: Th, 4h, 2c [3s]`, `${V} checks`, `${H} checks`, `River: Th, 4h, 2c, 3s [8d]`, `${V} bets 6`]);
        expect(analyzePostflop(river.s, river.v, [villain]).call_plan).to.equal(undefined);
    });

    it("folds more to big bets for a player who does, and less for one who calls big bets", () => {
        const s = spot("7c, 6c", ["Ks", "Qd", "2h"], [`Flop:  [Ks, Qd, 2h]`, `${V} checks`]);
        const average = analyzePostflop(s.s, s.v, [villain]);
        const big_folder = analyzePostflop(s.s, s.v, [{ ...villain, fold_by_size: { small: 0.25, big: 0.8, n_small: 30, n_big: 30 } }]);
        const big_caller = analyzePostflop(s.s, s.v, [{ ...villain, fold_by_size: { small: 0.4, big: 0.4, n_small: 30, n_big: 30 } }]);
        const fold = (a: typeof average, which: "small" | "big") => {
            const bets = a.candidates.filter((c) => c.action === "bet").sort((x, y) => x.to - y.to);
            return (which === "small" ? bets[0] : bets[bets.length - 1]).fold_chance!;
        };
        expect(fold(big_folder, "big")).to.be.greaterThan(fold(average, "big"));
        expect(fold(big_folder, "small")).to.be.lessThan(fold(average, "small"));
        expect(fold(big_caller, "big")).to.be.lessThan(fold(average, "big"));
        // the panel says so for a clear difference
        expect(big_folder.size_notes?.[0]).to.match(/bigger bets win more folds/);
    });

    it("ranks options by EV minus how unsure the fold estimate is", () => {
        const s = spot("7c, 6c", ["Ks", "Qd", "2h"], [`Flop:  [Ks, Qd, 2h]`, `${V} checks`]);
        const a = analyzePostflop(s.s, s.v, [villain]);
        const bets = a.candidates.filter((c) => c.action === "bet").sort((x, y) => x.to - y.to);
        for (const c of bets) expect(c.risk).to.be.greaterThan(0);
        // a pure bluff's EV leans on folds more the bigger it is
        expect(bets[bets.length - 1].risk!).to.be.greaterThan(bets[0].risk!);
        const best = a.candidates.reduce((x, c) => (robustEv(c) > robustEv(x) ? c : x));
        expect(a.candidates[0]).to.equal(best);
    });
});

describe("preflop realization, multiway and deep", () => {
    const r = (cls: string, multiway: boolean, spr: number) => realizationOf(default_config, cls, multiway, spr);

    it("keeps pairs and suited connectors multiway, and cuts offsuit hands", () => {
        expect(r("87s", true, 8)).to.be.closeTo(r("87s", false, 8), 1e-9);
        expect(r("66", true, 8)).to.be.closeTo(r("66", false, 8), 1e-9);
        expect(r("KTo", true, 8)).to.be.lessThan(r("KTo", false, 8));
    });

    it("adds implied odds for pairs and suited hands as stacks get deeper, more with several opponents", () => {
        expect(r("66", false, 30)).to.be.greaterThan(r("66", false, 8));
        expect(r("K5s", true, 30) - r("K5s", true, 8)).to.be.greaterThan(r("K5s", false, 30) - r("K5s", false, 8));
        // offsuit hands get no implied odds and lose a little deep
        expect(r("KTo", false, 30)).to.be.lessThan(r("KTo", false, 8) + 1e-9);
    });
});
