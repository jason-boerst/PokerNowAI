import { expect } from "chai";

import { ActionWeights, continuationEquity, equity, resetActionWeights, setActionWeights, weightsFor } from "../../app/engine/equity.ts";
import { heroView, parseHand } from "../../app/engine/hand-parser.ts";
import { analyzePostflop, heroInPosition, OpponentTendency, PostflopAnalysis } from "../../app/engine/postflop.ts";
import { topRange } from "../../app/engine/ranges.ts";

const p = (name: string, id: string) => `"${name} @ ${id}"`;
const H = p("H", "h"), V = p("V", "v");
const STREETS = ["flop", "turn", "river"] as const;

/**
 * Heads-up hand checked down to `street`, then `last` (the current street's actions so far).
 * The button posts the small blind and acts last after the flop.
 */
function headsUp(hero: string, board: string[], street: typeof STREETS[number], hero_button: boolean, last: string[] = []) {
    const [sb, bb] = hero_button ? [H, V] : [V, H];
    const lines = [
        `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${sb}) --`,
        `Player stacks: #1 ${H} (400) | #2 ${V} (400)`,
        `Your hand is ${hero}`,
        `${sb} posts a small blind of 1`, `${bb} posts a big blind of 2`, `${sb} calls 2`, `${bb} checks`
    ];
    const deal = [`Flop:  [${board.slice(0, 3).join(", ")}]`, `Turn: ${board.slice(0, 3).join(", ")} [${board[3]}]`, `River: ${board.slice(0, 4).join(", ")} [${board[4]}]`];
    for (let i = 0; i <= STREETS.indexOf(street); i++) {
        lines.push(deal[i]);
        if (STREETS[i] !== street) lines.push(`${bb} checks`, `${sb} checks`);
    }
    const s = parseHand([...lines, ...last], { hero_name: "H" });
    return { s, v: heroView(s)! };
}

const BOARD = ["Ks", "7d", "2c", "9h", "3c"];
const villain = (extra: Partial<OpponentTendency> = {}): OpponentTendency =>
    ({ model: { range: topRange(40) }, fold_to_bet: 0.3, fold_to_raise: 0.2, ...extra });
const evOf = (a: PostflopAnalysis, action: string, to = 0) => a.candidates.find((c) => c.action === action && (to === 0 || c.to === to))!.ev;
const bets = (a: PostflopAnalysis) => a.candidates.filter((c) => c.action === "bet");

describe("post-flop position", () => {
    // ten-handed: SB, BB, UTG, UTG+1, UTG+2, MP, LJ, HJ, CO, BU (seat 10 is the button)
    function tenHanded(mp_calls: boolean) {
        const seat = (i: number) => p(`P${i}`, `p${i}`);
        const s = parseHand([
            `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${seat(10)}) --`,
            `Player stacks: ${Array.from({ length: 10 }, (_, i) => `#${i + 1} ${seat(i + 1)} (200)`).join(" | ")}`,
            `Your hand is A♠, Q♠`,
            `${seat(1)} posts a small blind of 1`, `${seat(2)} posts a big blind of 2`,
            `${seat(3)} folds`, `${seat(4)} calls 2`, `${seat(5)} calls 2`, mp_calls ? `${seat(6)} calls 2` : `${seat(6)} folds`,
            `${seat(7)} folds`, `${seat(8)} folds`, `${seat(9)} folds`, `${seat(10)} folds`, `${seat(1)} folds`, `${seat(2)} checks`,
            `Flop:  [K♥, 9♦, 4♣]`, `${seat(2)} checks`, `${seat(4)} checks`
        ], { hero_name: "P5" });
        return s;
    }

    it("orders UTG+2 between UTG+1 and MP", () => {
        const behind_mp = tenHanded(true);
        expect(behind_mp.seats.find((x) => x.id === behind_mp.hero_id)!.position).to.equal("UTG+2");
        expect(heroInPosition(behind_mp)).to.equal(false);
        // only the big blind and UTG+1 left: UTG+2 acts last
        expect(heroInPosition(tenHanded(false))).to.equal(true);
    });
});

describe("continuing ranges", () => {
    it("narrows a range to its strongest share of hands", () => {
        const base = { hero: ["9d", "8d"], board: ["Ks", "9h", "4c"], iterations: 30000, time_budget_ms: 5000, seed: 3 };
        const full = equity({ ...base, opponents: [{ range: topRange(40) }] }).equity;
        const top30 = equity({ ...base, opponents: [{ range: topRange(40), continue_fraction: 0.3 }] }).equity;
        expect(top30).to.be.lessThan(full - 0.1);
    });

    it("keeps strong draws ahead of bottom pair", () => {
        // A3s: the nut flush draw (A♥3♥) and three ace-high hands; 65o: bottom pair (nine combos)
        const range = new Map([["A3s", 1], ["65o", 1]]);
        const base = { hero: ["Kd", "Qd"], board: ["Kh", "9h", "5c"], iterations: 30000, time_budget_ms: 5000, seed: 4 };
        // the strongest 1 of 13 combos: the flush draw (top pair is a ~55/45 favourite), not a pair of fives (~80/20)
        const top = equity({ ...base, opponents: [{ range, continue_fraction: 0.075 }] }).equity;
        expect(top).to.be.within(0.45, 0.65);
    });

    it("splits each range into raises, calls and folds for several bet sizes at once", () => {
        const input = { hero: ["Ah", "Jd"], board: ["Js", "8h", "3c"], opponents: [{ range: topRange(30) }, { range: topRange(50) }], iterations: 20000, time_budget_ms: 5000, seed: 9 };
        const r = continuationEquity(input, [
            { continue_fraction: [1, 1] },
            { continue_fraction: [0.5, 0.5] },
            { continue_fraction: [0.5, 0.5], raise_chance: [0.1, 0.1], adds: [10, 0] }
        ]);
        expect(r.equity).to.be.closeTo(equity(input).equity, 0.02);
        // everyone continuing is plain equity; fewer callers when they fold more
        expect(r.results[0].equity).to.be.closeTo(r.equity, 1e-9);
        expect(r.results[0].callers).to.equal(2);
        expect(r.results[1].callers).to.be.lessThan(2);
        expect(r.results[1].call_rate).to.be.closeTo(1 - 0.5 * 0.5, 0.02);
        // raises (mostly strong hands) come out of the calls, so hero does better against the hands that just call
        expect(r.results[2].raise_rate).to.be.closeTo(1 - 0.9 * 0.9, 0.02);
        expect(r.results[2].equity).to.be.greaterThan(r.results[1].equity);
        // only the first player adds chips (the second is all-in)
        expect(r.results[2].added).to.be.within(0, 10);
        expect(r.results[2].matched).to.be.lessThan(1);

        // heads-up the hands that call are stronger than the whole range
        const one = { ...input, opponents: [{ range: topRange(40) }] };
        const hu = continuationEquity(one, [{ continue_fraction: [0.5] }]);
        expect(hu.results[0].equity).to.be.lessThan(hu.equity);
    });
});

describe("analyzePostflop (two-street model)", () => {
    it("uses the fold rate of the current street", () => {
        const flat = villain();
        const by_street = villain({ fold_by_street: { flop: 0.3, turn: 0.3, river: 0.6 } });
        // river bluff with nine-high after a check
        const river = headsUp("4h, 5d", BOARD, "river", true, [`${V} checks`]);
        const a_flat = analyzePostflop(river.s, river.v, [flat]);
        const a_street = analyzePostflop(river.s, river.v, [by_street]);
        for (const c of bets(a_flat)) {
            expect(a_street.fold_probability.get(c.to)!).to.be.closeTo(2 * a_flat.fold_probability.get(c.to)!, 1e-9);
            expect(evOf(a_street, "bet", c.to)).to.be.greaterThan(c.ev);
        }
        // on the flop the flop rate applies, which is the same as the flat rate here
        const flop = headsUp("4h, 5d", BOARD, "flop", true, [`${V} checks`]);
        const f_flat = analyzePostflop(flop.s, flop.v, [flat]);
        const f_street = analyzePostflop(flop.s, flop.v, [by_street]);
        for (const c of bets(f_flat)) expect(f_street.fold_probability.get(c.to)).to.equal(f_flat.fold_probability.get(c.to));
    });

    it("values checking a medium hand less out of position against an aggressive player than when it checks through", () => {
        const aggressive = villain({ model: { range: topRange(40), aggression: 0.6 }, bet_when_checked_to: 0.7 });
        // middle pair on the river: first to act, vs last to act after a check
        const oop = headsUp("9d, 8d", BOARD, "river", false);
        const ip = headsUp("9d, 8d", BOARD, "river", true, [`${V} checks`]);
        const a_oop = analyzePostflop(oop.s, oop.v, [aggressive]);
        const a_ip = analyzePostflop(ip.s, ip.v, [aggressive]);
        expect(a_oop.in_position).to.equal(false);
        expect(a_ip.in_position).to.equal(true);
        expect(evOf(a_ip, "check")).to.be.closeTo(a_ip.equity * ip.v.pot, 1e-9);
        expect(evOf(a_oop, "check")).to.be.lessThan(evOf(a_ip, "check"));
    });

    it("lowers the value of a thin value bet when the opponent raises often", () => {
        // second pair on the river after betting the flop and turn and getting called
        const s = parseHand([
            `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${V}) --`,
            `Player stacks: #1 ${H} (400) | #2 ${V} (400)`,
            `Your hand is 9d, 8d`,
            `${V} posts a small blind of 1`, `${H} posts a big blind of 2`, `${V} calls 2`, `${H} checks`,
            `Flop:  [Ks, 7d, 2c]`, `${H} bets 2`, `${V} calls 2`,
            `Turn: Ks, 7d, 2c [9h]`, `${H} bets 5`, `${V} calls 5`,
            `River: Ks, 7d, 2c, 9h [3c]`
        ], { hero_name: "H" });
        const spot = { s, v: heroView(s)! };
        const calm = analyzePostflop(spot.s, spot.v, [villain({ raise_vs_bet: 0 })]);
        const raiser = analyzePostflop(spot.s, spot.v, [villain({ raise_vs_bet: 0.3 })]);
        expect(bets(calm).length).to.be.greaterThan(0);
        for (const c of bets(calm)) expect(evOf(raiser, "bet", c.to)).to.be.lessThan(c.ev);
    });

    it("offers an overbet only on the turn or river, with a hand far ahead of a calling range", () => {
        const overbet = (a: PostflopAnalysis, pot: number) => a.candidates.some((c) => c.action === "bet" && c.to > 1.2 * pot);
        const nuts = headsUp("Kd, Kc", BOARD, "river", true, [`${V} checks`]);            // top set
        expect(overbet(analyzePostflop(nuts.s, nuts.v, [villain()]), nuts.v.pot)).to.equal(true);
        const flop = headsUp("Kd, Kc", BOARD, "flop", true, [`${V} checks`]);
        expect(overbet(analyzePostflop(flop.s, flop.v, [villain()]), flop.v.pot)).to.equal(false);
        const weak = headsUp("4h, 5d", BOARD, "river", true, [`${V} checks`]);
        expect(overbet(analyzePostflop(weak.s, weak.v, [villain()]), weak.v.pot)).to.equal(false);
    });

    it("keeps fold chances for every bet and raise candidate", () => {
        const spot = headsUp("Kd, Qc", BOARD, "turn", false, [`${H} checks`, `${V} bets 3`]);
        const a = analyzePostflop(spot.s, spot.v, [villain()]);
        const aggressive = a.candidates.filter((c) => c.action === "raise" || c.action === "all-in");
        expect(aggressive.length).to.be.greaterThan(0);
        for (const c of aggressive) expect(a.fold_probability.has(c.to)).to.equal(true);
        expect(a.required_equity).to.be.closeTo(3 / (spot.v.pot + 3), 1e-9);
    });

    it("stays fast with three opponents", () => {
        const seat = (i: number) => p(`P${i}`, `p${i}`);
        const start = [
            `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${seat(4)}) --`,
            `Player stacks: #1 ${seat(1)} (500) | #2 ${seat(2)} (500) | #3 ${seat(3)} (500) | #4 ${seat(4)} (500)`,
            `Your hand is J♣, T♣`,
            `${seat(1)} posts a small blind of 1`, `${seat(2)} posts a big blind of 2`,
            `${seat(3)} calls 2`, `${seat(4)} calls 2`, `${seat(1)} calls 2`, `${seat(2)} checks`,
            `Flop:  [Q♣, 9♦, 4♣]`
        ];
        const opponents = [30, 45, 60].map((pct) => villain({ model: { range: topRange(pct), aggression: 0.4 } }));
        for (const [lines, hero] of [[start, "P1"], [[...start, `${seat(1)} checks`, `${seat(2)} bets 6`, `${seat(3)} calls 6`], "P4"]] as [string[], string][]) {
            const s = parseHand(lines, { hero_name: hero });
            const began = Date.now();
            const a = analyzePostflop(s, heroView(s)!, opponents.map((o) => ({ ...o, model: { ...o.model, postflop_actions: [] } })));
            expect(Date.now() - began).to.be.lessThan(800);
            expect(a.candidates.length).to.be.greaterThan(2);
        }
    });
});

describe("action weights by street", () => {
    afterEach(() => resetActionWeights());

    const bluffy: ActionWeights = {
        bet: { strong: 0.2, pair: 0.2, draw: 1, air: 1 },
        raise: { strong: 1, pair: 0.4, draw: 0.45, air: 0.1 },
        call: { strong: 0.8, pair: 1, draw: 0.9, air: 0.3 },
        check: { strong: 0.5, pair: 0.9, draw: 0.9, air: 1 }
    };
    const river_bet = () => equity({ hero: ["Qd", "Qc"], board: BOARD, opponents: [{ range: topRange(40), postflop_actions: [{ board: BOARD, action: "bet" }] }], iterations: 20000, time_budget_ms: 5000, seed: 5 }).equity;

    it("narrows each action with the weights for its street", () => {
        const before = river_bet();
        setActionWeights({ flop: bluffy, turn: bluffy });
        expect(river_bet()).to.equal(before);                 // river action, river weights unchanged
        setActionWeights({ river: bluffy });
        expect(river_bet()).to.be.greaterThan(before + 0.05); // river bets are now mostly weak hands
        expect(weightsFor(undefined, "river").bet.air).to.equal(1);
        expect(weightsFor(undefined, "flop").bet.air).to.equal(0.25);
        resetActionWeights();
        expect(river_bet()).to.equal(before);
    });

    it("ignores invalid weights", () => {
        setActionWeights({ river: { ...bluffy, bet: { strong: Number.NaN, pair: -1, draw: 0, air: 1 } } });
        const w = weightsFor(undefined, "river").bet;
        expect(w.strong).to.equal(1);      // built-in value
        expect(w.pair).to.equal(0.9);
        expect(w.draw).to.be.greaterThan(0);
        expect(Number.isFinite(river_bet())).to.equal(true);
    });
});
