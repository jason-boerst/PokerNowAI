import { expect } from "chai";

import { HandState, parseHand, positionLabels } from "../../app/engine/hand-parser.ts";
import { ObservedStats, opponentModels, preflopLine, reraiseFactor } from "../../app/engine/opponent-range.ts";
import {
    PLAYABILITY_CLASSES, positionWidth, preflopRange, RANKED_CLASSES, rangeBetween, rangePercent, topRange
} from "../../app/engine/ranges.ts";

const p = (name: string, id: string) => `"${name} @ ${id}"`;

/**
 * A synthetic hand, 1/2 blinds, 200 chip stacks, button in the last seat. Seat n is player "Sn"
 * with id "in"; actions are written as "S3 raises to 6" and the player name is expanded.
 * 6-handed positions: S1 SB, S2 BB, S3 UTG, S4 HJ, S5 CO, S6 BU.
 */
function hand(actions: string[], players = 6, stacks: Record<number, number> = {}): HandState {
    const seats = Array.from({ length: players }, (_, i) => i + 1);
    return parseHand([
        `-- starting hand #1 (id: h1)  No Limit Texas Hold'em (dealer: ${p(`S${players}`, `i${players}`)}) --`,
        `Player stacks: ${seats.map((n) => `#${n} ${p(`S${n}`, `i${n}`)} (${stacks[n] ?? 200})`).join(" | ")}`,
        `${p("S1", "i1")} posts a small blind of 1`,
        `${p("S2", "i2")} posts a big blind of 2`,
        ...actions.map((a) => a.replace(/^S(\d+)/, (_, n) => p(`S${n}`, `i${n}`)))
    ]);
}

const regular = { vpip: 31, pfr: 16 };

describe("position widths", () => {
    it("treats UTG+2 at a 10-handed table like the other early seats", () => {
        expect(positionLabels(10)).to.include("UTG+2");
        expect(positionWidth("UTG+2", 10)).to.deep.equal(positionWidth("UTG", 10));
        const utg = rangePercent(preflopRange("raise", regular, positionWidth("UTG", 10)));
        const utg2 = rangePercent(preflopRange("raise", regular, positionWidth("UTG+2", 10)));
        const lj = rangePercent(preflopRange("raise", regular, positionWidth("LJ", 10)));
        expect(utg2).to.be.closeTo(utg, 0.01);
        expect(utg2).to.be.lessThan(lj);
    });
});

describe("re-raise ranges", () => {
    it("sizes a 3-bet range from the measured 3-bet frequency, and a 4-bet range from it", () => {
        const t = { vpip: 30, pfr: 15, three_bet: 9 };
        expect(rangePercent(preflopRange("3bet", t))).to.be.closeTo(9, 0.01);
        expect(rangePercent(preflopRange("3bet", t, undefined, { reraise: 1.2 }))).to.be.closeTo(10.8, 0.01);
        expect(rangePercent(preflopRange("3bet", { ...t, three_bet: 60 }))).to.be.closeTo(25, 0.01);
        expect(rangePercent(preflopRange("3bet", { ...t, three_bet: 0 }))).to.be.closeTo(2, 0.01);
        expect(rangePercent(preflopRange("4bet", t))).to.be.closeTo(3.6, 0.01);
        // without a 3-bet frequency: a third (3-bet) and an eighth (4-bet) of PFR, as before
        expect(rangePercent(preflopRange("3bet", { vpip: 30, pfr: 15 }))).to.be.closeTo(5, 0.01);
        expect(rangePercent(preflopRange("4bet", { vpip: 30, pfr: 15 }))).to.be.closeTo(1.875, 0.01);
    });

    it("uses a player's 3-bet frequency when their stats have one", () => {
        // 9-handed, UTG opens and UTG+1 3-bets to 3x: an early open, so the 3-bet range is a bit tighter than usual
        const s = hand(["S3 raises to 6", "S4 raises to 18"], 9);
        const stats: ObservedStats = { vpip: 30, pfr: 15, hands: 200, three_bet: 12, shrunk: true };
        const hj = opponentModels(s, () => stats).find((m) => m.seat.id === "i4")!;
        expect(hj.tendencies.three_bet).to.equal(12);
        expect(rangePercent(hj.model.range)).to.be.closeTo(12 * 0.8, 0.01);
        // no 3-bet frequency: falls back to a third of PFR
        const without = opponentModels(s, () => ({ ...stats, three_bet: undefined })).find((m) => m.seat.id === "i4")!;
        expect(without.tendencies.three_bet).to.equal(undefined);
        expect(rangePercent(without.model.range)).to.be.closeTo(15 / 3 * 0.8, 0.01);
    });

    it("widens 3-bets against late opens and narrows them against early opens and big sizes", () => {
        // 9-handed: S3 UTG, S4 UTG+1, S5 MP, S6 LJ, S7 HJ, S8 CO, S9 BU
        const factor = (actions: string[], id: string, stacks: Record<number, number> = {}) => reraiseFactor(hand(actions, 9, stacks), id);
        expect(factor(["S3 raises to 6", "S4 raises to 18"], "i4")).to.equal(0.8);          // UTG open
        expect(factor(["S9 raises to 6", "S1 raises to 18"], "i1")).to.equal(1.2);          // button open
        expect(factor(["S7 raises to 6", "S8 raises to 40"], "i8")).to.equal(0.85);         // HJ open, 6.7x 3-bet
        // a 20 BB shove over a steal: 1.2 x 1.25, capped at 1.4
        expect(factor(["S9 raises to 6", "S1 raises to 40 and go all in"], "i1", { 1: 40 })).to.equal(1.4);
        // counted from the button: 6-handed UTG is a middle seat, and 4-handed "UTG" is the cutoff
        expect(reraiseFactor(hand(["S3 raises to 6", "S4 raises to 18"], 6), "i4")).to.equal(1);
        expect(reraiseFactor(hand(["S3 raises to 6", "S4 raises to 18"], 4), "i4")).to.equal(1.2);
        // only the first re-raiser gets a factor
        expect(reraiseFactor(hand(["S3 raises to 6", "S4 raises to 18", "S5 raises to 50"]), "i5")).to.equal(1);
        expect(reraiseFactor(hand(["S3 raises to 6"]), "i3")).to.equal(1);
    });
});

describe("preflop lines", () => {
    it("recognizes a limp-raise, and ranges it as strong", () => {
        const s = hand(["S3 calls 2", "S4 raises to 8", "S5 folds", "S6 folds", "S1 folds", "S2 folds", "S3 raises to 30"]);
        expect(preflopLine(s, "i3")).to.equal("limp_raise");
        expect(preflopLine(s, "i4")).to.equal("raise");
        const range = preflopRange("limp_raise", regular);
        expect(rangePercent(range)).to.be.within(3, 6);
        expect(range.has("AA")).to.equal(true);
        expect(range.has("76s")).to.equal(false);
        // limping and then raising the big blind's raise is a limp-raise too
        const bb = hand(["S3 calls 2", "S4 folds", "S5 folds", "S6 folds", "S1 folds", "S2 raises to 10", "S3 raises to 30"]);
        expect(preflopLine(bb, "i3")).to.equal("limp_raise");
        expect(preflopLine(bb, "i2")).to.equal("raise");
    });

    it("treats a straddler who checks like a big blind who checks", () => {
        const s = hand(["S3 posts a straddle of 4", "S4 calls 4", "S5 folds", "S6 folds", "S1 folds", "S2 folds", "S3 checks"]);
        expect(preflopLine(s, "i3")).to.equal("check_bb");
        expect(preflopLine(s, "i4")).to.equal("limp");
    });

    it("keeps a caller who then calls a 3-bet as a caller, and a 3-bettor who calls a 4-bet as a 3-bettor", () => {
        const s = hand(["S3 raises to 6", "S4 calls 6", "S5 raises to 20", "S6 folds", "S1 folds", "S2 folds", "S3 raises to 50", "S4 calls 50", "S5 calls 50"]);
        expect(preflopLine(s, "i4")).to.equal("call_raise");
        expect(preflopLine(s, "i5")).to.equal("3bet");
        expect(preflopLine(s, "i3")).to.equal("4bet");
    });

    it("separates an opener calling a 3-bet and a cold call of a 3-bet from calling one raise", () => {
        const s = hand(["S3 raises to 6", "S4 raises to 18", "S5 calls 18", "S6 folds", "S1 folds", "S2 folds", "S3 calls 18"]);
        expect(preflopLine(s, "i3")).to.equal("call_3bet");
        expect(preflopLine(s, "i5")).to.equal("cold_call_3bet");
        // a limper who calls a raise and a 3-bet at once is cold-calling the 3-bet too
        const limper = hand(["S3 calls 2", "S4 raises to 8", "S5 raises to 24", "S6 folds", "S1 folds", "S2 folds", "S3 calls 24"]);
        expect(preflopLine(limper, "i3")).to.equal("cold_call_3bet");
        // both are narrower than calling a single raise
        const call = rangePercent(preflopRange("call_raise", regular));
        expect(rangePercent(preflopRange("cold_call_3bet", regular))).to.be.lessThan(call);
        expect(rangePercent(preflopRange("call_3bet", regular, positionWidth("UTG", 6)))).to.be.lessThan(call);
    });

    it("ignores forced posts: antes, dead blinds and missed big blinds", () => {
        const s = parseHand([
            `-- starting hand #2 (id: h2)  No Limit Texas Hold'em (dealer: ${p("S4", "i4")}) --`,
            `Player stacks: #1 ${p("S1", "i1")} (200) | #2 ${p("S2", "i2")} (200) | #3 ${p("S3", "i3")} (200) | #4 ${p("S4", "i4")} (200)`,
            ...[1, 2, 3, 4].map((n) => `${p(`S${n}`, `i${n}`)} posts an ante of 0.5`),
            `${p("S1", "i1")} posts a small blind of 1`,
            `${p("S2", "i2")} posts a big blind of 2`,
            `${p("S3", "i3")} posts a missing small blind of 1`,
            `${p("S3", "i3")} posts a missed big blind of 2`,
            `${p("S3", "i3")} checks`,
            `${p("S4", "i4")} raises to 8`,
            `${p("S1", "i1")} folds`
        ]);
        expect(preflopLine(s, "i2")).to.equal("unknown");     // only posted so far
        expect(preflopLine(s, "i3")).to.equal("check_bb");    // checked the posted big blind
        expect(preflopLine(s, "i4")).to.equal("raise");       // first raise, the posts don't count
        // the missed-blind poster calls the raise: like a limper calling
        const called = parseHand([
            `-- starting hand #2 (id: h2)  No Limit Texas Hold'em (dealer: ${p("S4", "i4")}) --`,
            `Player stacks: #1 ${p("S1", "i1")} (200) | #2 ${p("S2", "i2")} (200) | #3 ${p("S3", "i3")} (200) | #4 ${p("S4", "i4")} (200)`,
            `${p("S1", "i1")} posts a small blind of 1`,
            `${p("S2", "i2")} posts a big blind of 2`,
            `${p("S3", "i3")} posts a missed big blind of 2`,
            `${p("S3", "i3")} checks`,
            `${p("S4", "i4")} raises to 8`,
            `${p("S1", "i1")} folds`,
            `${p("S2", "i2")} folds`,
            `${p("S3", "i3")} calls 8`
        ]);
        expect(preflopLine(called, "i3")).to.equal("call_raise");
    });

    it("gives everyone any two cards in a bomb pot", () => {
        const s = parseHand([
            `-- starting hand #3 (id: h3)  No Limit Texas Hold'em (dealer: ${p("S3", "i3")}) --`,
            `Player stacks: #1 ${p("S1", "i1")} (200) | #2 ${p("S2", "i2")} (200) | #3 ${p("S3", "i3")} (200)`,
            ...[1, 2, 3].map((n) => `${p(`S${n}`, `i${n}`)} posts a bet of 5 (bomb pot bet)`),
            `Flop:  [K♥, 7♦, 2♣]`
        ]);
        expect(s.bomb_pot).to.equal(true);
        for (const m of opponentModels(s, () => undefined)) expect(rangePercent(m.model.range)).to.be.closeTo(100, 0.01);
    });
});

describe("playability ranking", () => {
    it("orders all 169 classes deterministically", () => {
        expect(PLAYABILITY_CLASSES).to.have.length(169);
        expect(new Set(PLAYABILITY_CLASSES)).to.deep.equal(new Set(RANKED_CLASSES));
        expect(PLAYABILITY_CLASSES[0]).to.equal("AA");
    });

    it("puts pairs, suited connectors and suited aces ahead of offsuit junk", () => {
        const at = (cls: string) => PLAYABILITY_CLASSES.indexOf(cls);
        for (const good of ["76s", "65s", "22", "A5s"]) {
            for (const junk of ["K7o", "Q8o", "K2o", "J5o"]) expect(at(good), `${good} vs ${junk}`).to.be.lessThan(at(junk));
        }
        // the strength ranking still has the offsuit hands first
        expect(RANKED_CLASSES.indexOf("K7o")).to.be.lessThan(RANKED_CLASSES.indexOf("76s"));
    });

    it("puts 76s inside a 30% calling range and K2o outside it", () => {
        const call = preflopRange("call_raise", { vpip: 38, pfr: 12 });  // up to 30.4% of hands
        expect(call.has("76s")).to.equal(true);
        expect(call.has("22")).to.equal(true);
        expect(call.has("K2o")).to.equal(false);
        expect(call.has("Q8o")).to.equal(false);
        const top30 = topRange(30, PLAYABILITY_CLASSES);
        expect(top30.has("76s")).to.equal(true);
        expect(top30.has("K2o")).to.equal(false);
        // limpers and players yet to act are playability-ordered too; raisers keep the strength order
        expect(preflopRange("limp", { vpip: 38, pfr: 12 }).has("65s")).to.equal(true);
        expect(preflopRange("unknown", { vpip: 30, pfr: 12 }).has("76s")).to.equal(true);
        expect([...preflopRange("raise", { vpip: 30, pfr: 20 })]).to.deep.equal([...topRange(20)]);
    });
});

describe("range sizes", () => {
    it("match the requested percent for either ranking", () => {
        for (const pct of [1, 5, 12.5, 30, 55, 90, 100]) {
            expect(rangePercent(topRange(pct, PLAYABILITY_CLASSES)), `${pct}%`).to.be.closeTo(pct, 0.01);
            expect(rangePercent(topRange(pct)), `${pct}%`).to.be.closeTo(pct, 0.01);
        }
        expect(rangePercent(rangeBetween(10, 35, PLAYABILITY_CLASSES))).to.be.closeTo(25, 0.01);
    });

    it("stay consistent with a player's stats on every line", () => {
        const t = regular;   // pool-like: VPIP 31, PFR 16
        const size = (r: Map<string, number>) => rangePercent(r);
        // calls: VPIP x 0.8 minus the hands raised with (top PFR x 0.35), of which a quarter are kept
        expect(size(preflopRange("call_raise", t))).to.be.closeTo(24.8 - 5.6 + 5.6 * 0.25, 1);
        expect(size(preflopRange("limp", t))).to.be.closeTo(31 - 8, 1);
        expect(size(preflopRange("unknown", t))).to.be.closeTo(31, 1);
        expect(size(preflopRange("unknown", t, positionWidth("BB", 6)))).to.be.closeTo(31 * 1.6, 1);
        expect(size(preflopRange("raise", t, positionWidth("BU", 6)))).to.be.closeTo(32, 1);
        expect(size(preflopRange("check_bb", t))).to.be.closeTo(84, 1);
    });

    it("add 7-2 to raising ranges in a bounty game without changing their size", () => {
        const pw = positionWidth("CO", 6);
        const plain = preflopRange("raise", regular, pw);
        const bounty = preflopRange("raise", regular, pw, { seven_deuce_bounty: true });
        expect(plain.has("72o")).to.equal(false);
        expect(bounty.get("72o")).to.equal(1);
        expect(bounty.get("72s")).to.equal(1);
        expect(rangePercent(bounty)).to.be.closeTo(rangePercent(plain), 0.01);
        const three_bet = preflopRange("3bet", { ...regular, three_bet: 9 }, pw, { seven_deuce_bounty: true });
        expect(three_bet.get("72o")).to.be.within(0.5, 1);
        expect(rangePercent(three_bet)).to.be.closeTo(9, 0.01);
        // a tight player's rare 3-bets stay mostly big hands
        const tight = preflopRange("3bet", { ...regular, three_bet: 2 }, pw, { seven_deuce_bounty: true });
        expect(rangePercent(tight)).to.be.closeTo(2, 0.01);
        expect(rangePercent(new Map([["72o", tight.get("72o")!], ["72s", tight.get("72s")!]]))).to.be.at.most(2 * 0.15 + 1e-9);
        // callers don't get it
        expect(preflopRange("call_raise", regular, pw, { seven_deuce_bounty: true }).has("72o")).to.equal(false);
    });
});
