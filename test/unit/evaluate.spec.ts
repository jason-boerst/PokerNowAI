import { expect } from "chai";

import { callValue, comparePolicies, counterfactualSpots, policyValue } from "../../app/eval/counterfactual.ts";
import { agreementReport, classifyHand, decisionMatches } from "../../app/eval/agreement.ts";
import { Advisor, HeroHand, kindOf, replayHand } from "../../app/eval/replay.ts";
import { simulate } from "../../app/eval/simulate.ts";
import { sumInterval } from "../../app/eval/stats.ts";
import { netResult, parseHand } from "../../app/engine/hand-parser.ts";

const H = `"H @ h"`, V = `"V @ v"`;

/** Heads-up hand: checked to the river, V bets `bet`, H calls, and (optionally) V shows `villain`. */
function riverCall(opts: { hero_stack?: number, bet?: number, villain?: string, hero?: string } = {}): string[] {
    const bet = opts.bet ?? 40;
    const lines = [
        `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${H}) --`,
        `Player stacks: #1 ${H} (${opts.hero_stack ?? 1000}) | #2 ${V} (1000)`,
        `Your hand is ${opts.hero ?? "As, Ad"}`,
        `${H} posts a small blind of 10`, `${V} posts a big blind of 20`, `${H} calls 20`, `${V} checks`,
        `Flop:  [2c, 7d, 9h]`, `${V} checks`, `${H} checks`,
        `Turn: 2c, 7d, 9h [Js]`, `${V} checks`, `${H} checks`,
        `River: 2c, 7d, 9h, Js [3s]`, `${V} bets ${bet}`, `${H} calls ${bet}`
    ];
    if (opts.villain) lines.push(`${V} shows a ${opts.villain}.`);
    lines.push(`-- ending hand #1 --`);
    return lines;
}

const row = (messages: string[]) => ({ game_id: "g", hand_number: 1, big_blind: 20, messages_json: JSON.stringify(messages), hero_id: "h" });
const alwaysFold: Advisor = (_s, v) => ({ kind: v.to_call > 0 ? "fold" : "check", to: 0, label: "fold" });
const alwaysCall: Advisor = (_s, v) => ({ kind: v.to_call > 0 ? "call" : "check", to: 0, label: "call" });

describe("evaluation: counterfactual math", () => {
    it("values a river call exactly against known cards (win, loss, split)", () => {
        const board = ["2c", "7d", "9h", "Js", "3s"];
        const win = callValue(["As", "Ad"], ["Kc", "Kd"], board, board, 100, 50);
        expect(win.share).to.equal(1);
        expect(win.value).to.equal(100);
        expect(win.value_equity).to.equal(100);
        const loss = callValue(["Kc", "Kd"], ["As", "Ad"], board, board, 100, 50);
        expect(loss.value).to.equal(-50);
        // both play the board's straight: half of pot + call
        const broadway = ["Ah", "Kh", "Qd", "Jc", "Ts"];
        const split = callValue(["2c", "3d"], ["2d", "3c"], broadway, broadway, 100, 50);
        expect(split.share).to.equal(0.5);
        expect(split.value).to.equal(25);
    });

    it("uses the actual river when it was dealt, and exact equity for the by-equity value", () => {
        // hero AK has top pair on the turn; villain's QQ has 2 outs among 44 cards, and the river is a queen
        const turn = ["Ah", "7c", "2s", "9d"];
        const cv = callValue(["As", "Kd"], ["Qc", "Qd"], turn, [...turn, "Qs"], 60, 20);
        expect(cv.equity).to.be.closeTo(42 / 44, 1e-12);
        expect(cv.share).to.equal(0);
        expect(cv.value).to.equal(-20);
        expect(cv.value_equity).to.be.closeTo(42 / 44 * 80 - 20, 1e-9);
        // run-out not known (hand ended on the turn): the equity is used for both
        const unknown = callValue(["As", "Kd"], ["Qc", "Qd"], turn, turn, 60, 20);
        expect(unknown.value).to.be.closeTo(unknown.value_equity, 1e-12);
    });

    it("folding is worth 0, calling and raising the call value", () => {
        expect(policyValue("fold", 12)).to.equal(0);
        expect(policyValue("call", 12)).to.equal(12);
        expect(policyValue("raise", -3)).to.equal(-3);
    });

    it("finds a heads-up river call against shown cards and compares the two policies", () => {
        const hand = replayHand(row(riverCall({ villain: "Kc, Kd" })), alwaysFold)!;
        expect(hand.decisions.map((d) => d.actual)).to.deep.equal(["call", "check", "check", "call"]);
        const spots = counterfactualSpots([hand]);
        // the preflop limp only faces the big blind, so the river call is the only spot
        expect(spots).to.have.length(1);
        const s = spots[0];
        expect(s.street).to.equal("river");
        expect(s.pot_bb).to.equal(4);
        expect(s.to_call_bb).to.equal(2);
        expect(s.call_bb).to.equal(4);   // (80 + 40) - 40 chips = 80 = 4 BB
        const c = comparePolicies(spots);
        expect(c.you.total).to.equal(4);
        expect(c.engine.total).to.equal(0);
        expect(c.difference.total).to.equal(-4);
        expect(c.engine_fold_you_continue).to.deep.equal({ n: 1, gain_bb: -4 });
        const same = comparePolicies(counterfactualSpots([replayHand(row(riverCall({ villain: "Kc, Kd" })), alwaysCall)!]));
        expect(same.difference.total).to.equal(0);
        expect(same.agree).to.equal(1);
    });

    it("skips spots where the opponent's cards stay hidden", () => {
        expect(counterfactualSpots([replayHand(row(riverCall()), alwaysFold)!])).to.have.length(0);
    });

    it("leaves out the part of a bet hero can't cover", () => {
        // hero has 60: 20 preflop, 40 left; villain bets 100, 60 of which would come back
        const hand = replayHand(row(riverCall({ hero_stack: 60, bet: 100, villain: "Kc, Kd" })), alwaysFold)!;
        const [s] = counterfactualSpots([hand]);
        expect(s.to_call_bb).to.equal(2);
        expect(s.pot_bb).to.equal(4);   // 40 preflop + 100 bet - 60 uncovered
        expect(s.call_bb).to.equal(4);
    });
});

describe("evaluation: agreement", () => {
    const s = parseHand(riverCall().slice(0, 15), { hero_name: "H" });   // V has bet 40 on the river

    it("classifies engine actions: bets and raises are raises, a short all-in is a call", () => {
        expect(kindOf("bet", 40, s)).to.equal("raise");
        expect(kindOf("all-in", 30, s)).to.equal("call");
        expect(kindOf("all-in", 200, s)).to.equal("raise");
        expect(kindOf("fold", 0, s)).to.equal("fold");
    });

    it("marks a hand matched only when every compared decision matched", () => {
        const engine = (kind: "fold" | "check" | "call" | "raise") => ({ kind, to: 0, label: kind });
        const c = classifyHand([
            { street: "preflop", actual: "call", engine: engine("call") },
            { street: "flop", actual: "raise", engine: engine("check") },
            { street: "turn", actual: "check", engine: null }
        ], 5);
        expect(c.compared).to.equal(2);
        expect(c.all_matched).to.equal(false);
        expect(c.by_street.preflop).to.deep.equal({ compared: 1, matched: 1 });
        expect(c.by_street.flop).to.deep.equal({ compared: 1, matched: 0 });
        expect(c.by_street.turn.compared).to.equal(0);
        expect(decisionMatches({ actual: "fold", engine: null })).to.equal(null);
        expect(classifyHand([], 1).all_matched).to.equal(false);
    });

    it("splits win rates by agreement", () => {
        const fake = (actual: "call" | "fold", engine: "call" | "fold", result: number) => ({
            adjusted_bb: result,
            decisions: [{ street: "preflop", actual, engine: { kind: engine, to: 0, label: engine } }]
        }) as unknown as HeroHand;
        const r = agreementReport([fake("call", "call", 10), fake("call", "call", 20), fake("fold", "call", -1)]);
        const whole = r.splits[0];
        expect(whole.matched.hands).to.equal(2);
        expect(whole.matched.bb_per_100).to.equal(1500);
        expect(whole.unmatched.hands).to.equal(1);
        expect(r.confusion.fold.call).to.equal(1);
        expect(r.decision_agreement).to.be.closeTo(2 / 3, 1e-12);
    });
});

describe("evaluation: simulation", function () {
    this.timeout(120000);

    it("plays legal, chip-conserving hands between pool players", () => {
        let hands = 0;
        const r = simulate({ players: 6, hands: 40, seed: 11, hero: "pool", on_hand: (lines) => {
            const s = parseHand(lines, { big_blind: 20 });
            expect(s.ended).to.equal(true);
            expect(s.unparsed).to.deep.equal([]);
            const total = s.seats.reduce((sum, p) => sum + netResult(s, p.id), 0);
            expect(Math.abs(total)).to.be.lessThan(0.02);
            hands++;
        } });
        expect(r.errors).to.equal(0);
        expect(hands).to.equal(40);
        expect(r.results_bb.every(Number.isFinite)).to.equal(true);
    });

    it("runs the engine deterministically for a seed and returns finite numbers", () => {
        // a budget far above the iteration caps, so the engine's simulations stop on count, not on time
        let postflop = 0;
        const opts = { players: 2, hands: 16, seed: 5, engine_budget_ms: 60000 };
        const a = simulate({ ...opts, on_hand: (lines) => {
            const flop = lines.findIndex((l) => l.startsWith("Flop:"));
            if (flop >= 0 && lines.slice(flop).some((l) => l.startsWith(`"Hero @ hero" `) && !/shows|collected/.test(l))) postflop++;
        } });
        const b = simulate(opts);
        expect(a.errors).to.equal(0);
        expect(a.hands).to.equal(16);
        expect(postflop).to.be.greaterThan(0);
        expect(a.results_bb.every(Number.isFinite)).to.equal(true);
        expect(a.adjusted_bb.every(Number.isFinite)).to.equal(true);
        expect(a.results_bb).to.deep.equal(b.results_bb);
    });
});

describe("evaluation: intervals", () => {
    it("brackets the total", () => {
        const xs = [1, -2, 3, 0, 5, -1, 2, 2];
        const i = sumInterval(xs, 2000, 3);
        expect(i.total).to.equal(10);
        expect(i.boot_low).to.be.lessThan(10);
        expect(i.boot_high).to.be.greaterThan(10);
        expect(i.normal_low).to.be.lessThan(i.normal_high);
        expect(sumInterval([], 10).total).to.equal(0);
    });
});
