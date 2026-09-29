import { expect } from "chai";

import { code, DECK, evaluate } from "../../app/engine/cards.ts";
import { equity, strengthClass } from "../../app/engine/equity.ts";
import { ALL_CLASSES, classOf, comboCount, combosOf } from "../../app/engine/hand-classes.ts";
import { bluffBreakeven, mdf, requiredEquity } from "../../app/engine/odds.ts";
import { preflopRange, rangeBetween, rangePercent, topRange } from "../../app/engine/ranges.ts";

const exact = (cls: string) => new Map([[cls, 1]]);

/** Exact equity by enumerating every remaining board, for one opponent with known cards. */
function exactEquity(hero: string[], villain: string[], board: string[]): number {
    const dead = new Set([...hero, ...villain, ...board].map(code));
    const rest = DECK.filter((c) => !dead.has(c));
    const need = 5 - board.length;
    let share = 0, n = 0;
    const recurse = (start: number, picked: number[]) => {
        if (picked.length === need) {
            const b = [...board.map(code), ...picked];
            const h = evaluate([...hero.map(code), ...b]);
            const v = evaluate([...villain.map(code), ...b]);
            share += h < v ? 1 : h === v ? 0.5 : 0;
            n++;
            return;
        }
        for (let i = start; i < rest.length; i++) recurse(i + 1, [...picked, rest[i]]);
    };
    recurse(0, []);
    return share / n;
}

describe("hand classes", () => {
    it("has 169 classes covering all 1326 combos", () => {
        expect(ALL_CLASSES).to.have.length(169);
        expect(ALL_CLASSES.reduce((s, c) => s + comboCount(c), 0)).to.equal(1326);
        expect(combosOf("AKs")).to.have.length(4);
        expect(combosOf("QQ")).to.have.length(6);
        expect(classOf(["Kd", "As"])).to.equal("AKo");
        expect(classOf(["9h", "Th"])).to.equal("T9s");
    });
});

describe("ranges", () => {
    it("builds top-N% ranges by combos", () => {
        expect(rangePercent(topRange(10))).to.be.closeTo(10, 0.01);
        expect(rangePercent(rangeBetween(10, 35))).to.be.closeTo(25, 0.01);
        expect(topRange(1).has("AA")).to.equal(true);
        expect(topRange(100).size).to.equal(169);
    });

    it("narrows ranges by preflop line", () => {
        const loose = { vpip: 45, pfr: 15 };
        expect(rangePercent(preflopRange("raise", loose))).to.be.closeTo(15, 0.01);
        expect(rangePercent(preflopRange("3bet", loose))).to.be.closeTo(5, 0.01);
        expect(rangePercent(preflopRange("limp", loose))).to.be.lessThan(45);
        expect(preflopRange("3bet", loose).has("AA")).to.equal(true);
        expect(preflopRange("limp", loose).has("AA")).to.equal(false);
    });
});

describe("equity", () => {
    it("matches the known AA vs KK preflop equity", () => {
        const r = equity({ hero: ["As", "Ad"], board: [], opponents: [{ range: exact("KK") }], iterations: 100000, time_budget_ms: 5000, seed: 7 });
        expect(r.equity).to.be.closeTo(0.819, 0.01);
    });

    it("matches exact enumeration on the flop and turn", () => {
        const spots: [string[], string[], string[]][] = [
            [["Ah", "5h"], ["Kc", "Qd"], ["Kh", "9h", "2c"]],
            [["Jc", "Tc"], ["Ad", "Ac"], ["9s", "8d", "2h"]],
            [["7s", "7d"], ["As", "Kd"], ["Ah", "7c", "Kc", "2d"]]
        ];
        for (const [hero, villain, board] of spots) {
            const want = exactEquity(hero, villain, board);
            const got = equity({ hero, board, opponents: [{ range: new Map([[classOf(villain), 1]]) }], iterations: 60000, time_budget_ms: 5000, seed: 3 });
            // the class includes other suit combos than the exact villain hand, so allow a small difference
            expect(got.equity, `${hero} vs ${villain} on ${board}`).to.be.closeTo(want, 0.04);
        }
    });

    it("drops when the opponent's raise makes strong hands more likely", () => {
        const base = { hero: ["Ad", "Jc"], board: ["Ah", "8s", "3d"], iterations: 40000, time_budget_ms: 5000, seed: 11 };
        const passive = equity({ ...base, opponents: [{ range: topRange(40) }] });
        const raised = equity({ ...base, opponents: [{ range: topRange(40), postflop_actions: [{ board: ["Ah", "8s", "3d"], action: "raise" }] }] });
        expect(raised.equity).to.be.lessThan(passive.equity - 0.05);
    });

    it("stays within its time budget", () => {
        const started = Date.now();
        equity({ hero: ["Ah", "Kd"], board: [], opponents: Array(8).fill(0).map(() => ({ range: topRange(40) })), iterations: 1e9, time_budget_ms: 100 });
        expect(Date.now() - started).to.be.lessThan(400);
    });
});

describe("strengthClass", () => {
    it("classifies made hands and draws", () => {
        expect(strengthClass(["As", "Ks"], ["Ah", "Kd", "2c"])).to.equal("strong");   // two pair
        expect(strengthClass(["Qs", "Jd"], ["Qh", "7d", "2c"])).to.equal("pair");
        expect(strengthClass(["9h", "8h"], ["Kh", "4h", "2c"])).to.equal("draw");     // flush draw
        expect(strengthClass(["9c", "8d"], ["7h", "6s", "2c"])).to.equal("draw");     // open-ended
        expect(strengthClass(["Ac", "3d"], ["Kh", "Ks", "Kd"])).to.equal("air");      // trips only on board
    });
});

describe("odds", () => {
    it("computes pot odds, MDF and bluff break-even", () => {
        expect(requiredEquity(5, 15)).to.equal(0.25);
        expect(mdf(10, 10)).to.equal(0.5);
        expect(bluffBreakeven(5, 10)).to.be.closeTo(1 / 3, 1e-9);
    });
});

describe("allInAdjustedNet", () => {
    it("credits hero's equity share for a flop all-in with both hands shown", async () => {
        const { parseHand } = await import("../../app/engine/hand-parser.ts");
        const { allInAdjustedNet, exactEquity } = await import("../../app/engine/allin-ev.ts");
        const p = (n: string, i: string) => `"${n} @ ${i}"`;
        const s = parseHand([
            `-- starting hand #3 (id: z)  No Limit Texas Hold'em (dealer: ${p("V", "v")}) --`,
            `Player stacks: #1 ${p("H", "h")} (100) | #2 ${p("V", "v")} (100)`,
            `Your hand is A♠, A♦`,
            `${p("V", "v")} posts a small blind of 1`,
            `${p("H", "h")} posts a big blind of 2`,
            `${p("V", "v")} calls 2`,
            `${p("H", "h")} checks`,
            `Flop:  [K♠, 7♦, 2♣]`,
            `${p("H", "h")} bets 98 and go all in`,
            `${p("V", "v")} calls 98`,
            `Turn: K♠, 7♦, 2♣ [K♥]`,
            `River: K♠, 7♦, 2♣, K♥ [K♦]`,
            `${p("H", "h")} shows a A♠, A♦.`,
            `${p("V", "v")} shows a K♣, Q♦.`,
            `${p("V", "v")} collected 200 from pot`,
            `-- ending hand #3 --`
        ], { hero_name: "H" });
        const eq = exactEquity(["As", "Ad"], ["Kc", "Qd"], ["Ks", "7d", "2c"]);
        expect(eq).to.be.greaterThan(0.75);          // AA vs top pair on the flop
        expect(allInAdjustedNet(s, "h")).to.be.closeTo(eq * 200 - 100, 1e-9);
    });
});
