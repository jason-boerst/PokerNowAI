import { expect } from "chai";

import { heroView, parseHand } from "../../app/engine/hand-parser.ts";
import { preflopAdvice } from "../../app/engine/preflop.ts";
import { parseRange } from "../../app/engine/range-notation.ts";
import { ObservedStats } from "../../app/engine/opponent-range.ts";

const p = (name: string, id: string) => `"${name} @ ${id}"`;

/** Builds a preflop spot: n players (seat i = name Si), dealer = last seat, then `lines` of action. */
function spot(n: number, hero: string, cards: string, lines: string[], stack = 100, stats: Record<string, ObservedStats> = {}) {
    const seats = Array.from({ length: n }, (_, i) => i + 1);
    const messages = [
        `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${p(`S${n}`, `i${n}`)}) --`,
        `Player stacks: ${seats.map((i) => `#${i} ${p(`S${i}`, `i${i}`)} (${stack})`).join(" | ")}`,
        `Your hand is ${cards}`,
        `${p("S1", "i1")} posts a small blind of 1`,
        `${p("S2", "i2")} posts a big blind of 2`,
        ...lines.map((l) => l.replace(/^(S\d+) /, (_m, name) => `${p(name, "i" + name.slice(1))} `))
    ];
    const s = parseHand(messages, { hero_name: hero });
    return preflopAdvice(s, heroView(s)!, (name) => stats[name]);
}

// 9-handed seats: S1 SB, S2 BB, S3 UTG, S4 UTG+1, S5 MP, S6 LJ, S7 HJ, S8 CO, S9 BU

describe("range notation", () => {
    it("expands plus, dash and bare items", () => {
        expect([...parseRange("TT+")]).to.deep.equal(["TT", "JJ", "QQ", "KK", "AA"]);
        expect([...parseRange("ATs+")]).to.deep.equal(["ATs", "AJs", "AQs", "AKs"]);
        expect([...parseRange("A5s-A3s")].sort()).to.deep.equal(["A3s", "A4s", "A5s"]);
        expect([...parseRange("KQ")].sort()).to.deep.equal(["KQo", "KQs"]);
    });
});

describe("preflopAdvice", () => {
    it("opens strong hands and folds weak ones by position", () => {
        expect(spot(9, "S3", "A♠, K♦", [])).to.include({ action: "raise", size_bb: 3 });
        expect(spot(9, "S3", "7♠, 6♠", [])!.action).to.equal("fold");
        expect(spot(9, "S9", "7♠, 6♠", [])!.action).to.equal("raise");
    });

    it("uses the range for the number of players left to act at short tables", () => {
        // 6-handed: UTG has 3 non-blind players behind, like a 9-max LJ; A7s is in LJ but not UTG
        const n6 = (lines: string[]) => spot(6, "S3", "A♦, 7♦", lines);
        expect(n6([])!.action).to.equal("raise");
        expect(spot(9, "S3", "A♦, 7♦", [])!.action).to.equal("fold");
    });

    it("opens bigger when the players behind call too much", () => {
        const loose = { vpip: 55, pfr: 10, hands: 50 };
        const stats = Object.fromEntries(["S4", "S5", "S6", "S7", "S8", "S9", "S1", "S2"].map((n) => [n, loose]));
        expect(spot(9, "S3", "A♠, K♦", [], 100, stats)).to.include({ action: "raise", size_bb: 4 });
    });

    it("isolates limpers with strong hands, limps behind with speculative ones", () => {
        const limped = ["S3 calls 2", "S5 calls 2"];
        expect(spot(9, "S9", "Q♠, Q♦", limped)).to.include({ action: "raise", size_bb: 6 });
        expect(spot(9, "S9", "6♠, 5♠", limped)!.action).to.equal("call");
        expect(spot(9, "S9", "K♠, 7♦", limped)!.action).to.equal("fold");
        expect(spot(9, "S2", "7♣, 2♦", [...limped, "S9 calls 2", "S1 calls 2"])!.action).to.equal("check");
    });

    it("3-bets value, calls playable hands, folds the rest against a raise", () => {
        const raised = ["S3 raises to 6"];
        expect(spot(9, "S9", "A♠, A♦", raised)).to.include({ action: "raise", size_bb: 9 });
        expect(spot(9, "S9", "J♠, J♦", raised)!.action).to.equal("call");
        expect(spot(9, "S9", "K♠, 9♦", raised)!.action).to.equal("fold");
    });

    it("3-bets wider against a loose raiser and tighter against a nit", () => {
        const raised = ["S3 raises to 6"];
        expect(spot(9, "S9", "J♠, J♦", raised, 100, { S3: { vpip: 45, pfr: 30, hands: 60 } })!.action).to.equal("raise");
        expect(spot(9, "S9", "Q♠, Q♦", raised, 100, { S3: { vpip: 12, pfr: 4, hands: 60 } })!.action).to.equal("call");
    });

    it("folds small pairs when stacks are too short to set-mine", () => {
        // 30 chip stacks (15 BB) facing a 3 BB raise: 12 BB behind vs a 2 BB call is under 15x
        expect(spot(9, "S9", "2♠, 2♦", ["S3 raises to 6"], 30)!.action).to.equal("fold");
        expect(spot(9, "S9", "2♠, 2♦", ["S3 raises to 6"], 200)!.action).to.equal("call");
    });

    it("handles 3-bets: 4-bet the top, call strong hands, fold the rest", () => {
        const three_bet = ["S3 folds", "S4 folds", "S5 folds", "S6 folds", "S7 raises to 6", "S8 raises to 18"];
        // 100 BB deep: a 4-bet to ~21 BB is under 40% of the stack, so it stays a raise
        expect(spot(9, "S7", "K♠, K♦", three_bet, 200)!.action).to.equal("raise");
        expect(spot(9, "S7", "Q♠, Q♦", three_bet)!.action).to.equal("call");
        expect(spot(9, "S7", "9♠, 8♠", three_bet)!.action).to.equal("fold");
    });

    it("goes all-in when the raise would commit a big share of the stack", () => {
        const three_bet = ["S7 raises to 6", "S8 raises to 18"];
        expect(spot(9, "S7", "A♠, A♦", three_bet, 60)!.action).to.equal("all-in");
    });

    it("never suggests a raise below the legal minimum", async () => {
        const { ALL_CLASSES } = await import("../../app/engine/hand-classes.ts");
        const suitsFor = (cls: string) => cls.length === 2 || cls[2] === "o" ? [`${cls[0]}♠`, `${cls[1]}♦`] : [`${cls[0]}♠`, `${cls[1]}♠`];
        const lines_options = [[], ["S3 calls 2"], ["S3 raises to 7"], ["S3 raises to 30"], ["S3 raises to 6", "S5 raises to 20"]];
        let raises = 0;
        for (const cls of ALL_CLASSES) {
            for (const lines of lines_options) {
                for (const stack of [40, 200, 1000]) {
                    const messages_spot = spot(9, "S9", suitsFor(cls).join(", "), lines, stack)!;
                    if (messages_spot.action !== "raise") continue;
                    raises++;
                    const s = parseHand([
                        `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${p("S9", "i9")}) --`,
                        `Player stacks: ${Array.from({ length: 9 }, (_, i) => `#${i + 1} ${p(`S${i + 1}`, `i${i + 1}`)} (${stack})`).join(" | ")}`,
                        `${p("S1", "i1")} posts a small blind of 1`, `${p("S2", "i2")} posts a big blind of 2`,
                        ...lines.map((l) => l.replace(/^(S\d+) /, (_m, n) => `${p(n, "i" + n.slice(1))} `))
                    ], { hero_name: "S9" });
                    const v = heroView(s)!;
                    expect(messages_spot.size_bb * 2, `${cls} ${lines} ${stack}`).to.be.at.least(v.min_raise_to! - 1e-9);
                    expect(messages_spot.size_bb * 2).to.be.at.most(v.max_raise_to + 1e-9);
                }
            }
        }
        expect(raises).to.be.greaterThan(100);
    });
});

describe("heads-up and position-aware preflop", () => {
    // 2 players: S1 posts SB (and is the button), S2 posts BB
    it("raises most hands from the heads-up small blind, including K6o", () => {
        expect(spot(2, "S1", "K♠, 6♦", [])).to.include({ action: "raise", size_bb: 2.5 });
        expect(spot(2, "S1", "T♠, 6♦", [])!.action).to.equal("raise");
        expect(spot(2, "S1", "7♠, 2♦", [])!.action).to.equal("fold");
    });

    it("defends the heads-up big blind wide against a raise", () => {
        expect(spot(2, "S2", "K♠, 6♦", ["S1 raises to 5"])!.action).to.equal("call");
        expect(spot(2, "S2", "A♠, K♦", ["S1 raises to 5"])!.action).to.equal("raise");
        expect(spot(2, "S2", "7♠, 2♦", ["S1 raises to 5"])!.action).to.equal("fold");
    });

    it("raises strong hands and checks the rest when the heads-up small blind limps", () => {
        expect(spot(2, "S2", "A♠, 9♦", ["S1 calls 2"])!.action).to.equal("raise");
        expect(spot(2, "S2", "K♠, 6♦", ["S1 calls 2"])!.action).to.equal("check");
    });

    it("defends the big blind wider against a button raise than against an early raise", () => {
        const folds = ["S3 folds", "S4 folds", "S5 folds", "S6 folds", "S7 folds", "S8 folds"];
        expect(spot(9, "S2", "K♠, 9♦", [...folds, "S9 raises to 6", "S1 folds"])!.action).to.equal("call");
        expect(spot(9, "S2", "K♠, 9♦", ["S3 raises to 6", "S4 folds", "S5 folds", "S6 folds", "S7 folds", "S8 folds", "S9 folds", "S1 folds"])!.action).to.equal("fold");
    });

    it("completes the small blind with playable hands when folded to it at a full table", () => {
        const folds = ["S3 folds", "S4 folds", "S5 folds", "S6 folds", "S7 folds", "S8 folds", "S9 folds"];
        expect(spot(9, "S1", "K♠, 6♦", folds)!.action).to.equal("call");
        expect(spot(9, "S1", "7♠, 2♦", folds)!.action).to.equal("fold");
    });
});

describe("heads-up position and ranges", () => {
    it("treats the heads-up small blind (button) as in position after the flop", async () => {
        const { heroInPosition } = await import("../../app/engine/postflop.ts");
        const flop = (hero: string) => parseHand([
            `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${p("S1", "i1")}) --`,
            `Player stacks: #1 ${p("S1", "i1")} (100) | #2 ${p("S2", "i2")} (100)`,
            `${p("S1", "i1")} posts a small blind of 1`, `${p("S2", "i2")} posts a big blind of 2`,
            `${p("S1", "i1")} raises to 5`, `${p("S2", "i2")} calls 5`, `Flop:  [K♥, 7♦, 2♣]`
        ], { hero_name: hero });
        expect(heroInPosition(flop("S1"))).to.equal(true);
        expect(heroInPosition(flop("S2"))).to.equal(false);
    });

    it("estimates wider opening ranges from late position and heads-up", async () => {
        const { positionWidth, preflopRange, rangePercent } = await import("../../app/engine/ranges.ts");
        const t = { vpip: 35, pfr: 12 };
        const utg = rangePercent(preflopRange("raise", t, positionWidth("UTG", 9)));
        const bu = rangePercent(preflopRange("raise", t, positionWidth("BU", 9)));
        const hu = rangePercent(preflopRange("raise", t, positionWidth("SB", 2)));
        expect(utg).to.be.lessThan(bu);
        expect(bu).to.be.lessThan(hu);
    });
});
