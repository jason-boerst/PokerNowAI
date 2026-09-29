import { expect } from "chai";

import { countLimpers, heroView, netResult, parseCards, parseHand, positionLabels } from "../../app/engine/hand-parser.ts";

const p = (name: string, id: string) => `"${name} @ ${id}"`;

// 9-handed hand, 0.10/0.20, dealer in seat 9
const nineHanded = [
    `-- starting hand #42 (id: h42)  No Limit Texas Hold'em (dealer: ${p("S9", "i9")}) --`,
    `Player stacks: ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `#${n} ${p(`S${n}`, `i${n}`)} (20.00)`).join(" | ")}`,
    `Your hand is A♠, K♦`,
    `${p("S1", "i1")} posts a small blind of 0.10`,
    `${p("S2", "i2")} posts a big blind of 0.20`,
    `${p("S3", "i3")} calls 0.20`,
    `${p("S4", "i4")} folds`,
    `${p("S5", "i5")} calls 0.20`
];

describe("positionLabels", () => {
    it("gives unique labels ending at the button for 2-9 players", () => {
        for (let n = 2; n <= 9; n++) {
            const labels = positionLabels(n);
            expect(labels).to.have.length(n);
            expect(new Set(labels).size, `n=${n}: ${labels}`).to.equal(n);
        }
        expect(positionLabels(9)).to.deep.equal(["SB", "BB", "UTG", "UTG+1", "MP", "LJ", "HJ", "CO", "BU"]);
        expect(positionLabels(6)).to.deep.equal(["SB", "BB", "UTG", "HJ", "CO", "BU"]);
        expect(positionLabels(2)).to.deep.equal(["SB", "BB"]);
    });
});

describe("parseCards", () => {
    it("normalizes suits and tens", () => {
        expect(parseCards("[10♥, A♠, 2♣]")).to.deep.equal(["Th", "As", "2c"]);
    });
});

describe("parseHand", () => {
    it("assigns 9-handed positions from the blinds", () => {
        const s = parseHand(nineHanded, { hero_name: "S7" });
        const pos = Object.fromEntries(s.seats.map((x) => [x.name, x.position]));
        expect(pos).to.deep.equal({ S1: "SB", S2: "BB", S3: "UTG", S4: "UTG+1", S5: "MP", S6: "LJ", S7: "HJ", S8: "CO", S9: "BU" });
        expect(s.hand_number).to.equal(42);
        expect(s.hero_cards).to.deep.equal(["As", "Kd"]);
    });

    it("computes hero's spot facing limpers at decimal stakes", () => {
        const s = parseHand(nineHanded, { hero_name: "S7" });
        const v = heroView(s)!;
        expect(v.position).to.equal("HJ");
        expect(v.to_call).to.be.closeTo(0.2, 1e-9);
        expect(v.pot).to.be.closeTo(0.7, 1e-9);            // 0.10 + 0.20 + 0.20 + 0.20
        expect(v.min_raise_to).to.be.closeTo(0.4, 1e-9);
        expect(v.limpers).to.equal(2);
        expect(v.pot_odds).to.be.closeTo(0.2 / 0.9, 1e-9);
        expect(v.active_opponents).to.have.length(7);       // S4 folded, hero excluded
    });

    it("handles heads-up (button posts the small blind)", () => {
        const s = parseHand([
            `-- starting hand #1 (id: a)  No Limit Texas Hold'em (dealer: ${p("A", "a")}) --`,
            `Player stacks: #2 ${p("A", "a")} (100) | #5 ${p("B", "b")} (100)`,
            `${p("A", "a")} posts a small blind of 1`,
            `${p("B", "b")} posts a big blind of 2`
        ]);
        expect(s.seats.map((x) => x.position)).to.deep.equal(["SB", "BB"]);
    });

    it("tracks a multiway hand through showdown with an all-in, uncalled bet and results", () => {
        const s = parseHand([
            `-- starting hand #7 (id: h7)  No Limit Texas Hold'em (dealer: ${p("C", "c")}) --`,
            `Player stacks: #1 ${p("A", "a")} (100) | #2 ${p("B", "b")} (30) | #3 ${p("C", "c")} (200)`,
            `${p("A", "a")} posts a small blind of 1`,
            `${p("B", "b")} posts a big blind of 2`,
            `${p("C", "c")} raises to 6`,
            `${p("A", "a")} calls 6`,
            `${p("B", "b")} calls 6`,
            `Flop:  [K♠, 7♦, 2♣]`,
            `${p("A", "a")} checks`,
            `${p("B", "b")} bets 24 and go all in`,
            `${p("C", "c")} raises to 80`,
            `${p("A", "a")} folds`,
            `Uncalled bet of 56 returned to ${p("C", "c")}`,
            `Turn: K♠, 7♦, 2♣ [9♥]`,
            `River: K♠, 7♦, 2♣, 9♥ [3♣]`,
            `${p("B", "b")} shows a K♦, K♣.`,
            `${p("C", "c")} shows a A♠, A♦.`,
            `${p("B", "b")} collected 66 from pot with Three of a Kind, K's`,
            `-- ending hand #7 --`
        ], { hero_name: "C" });

        const by = Object.fromEntries(s.seats.map((x) => [x.name, x]));
        expect(by.B.all_in).to.equal(true);
        expect(by.B.total_contribution).to.equal(30);
        expect(by.C.total_contribution).to.equal(30);         // 6 + 80 - 56 returned
        expect(by.A.total_contribution).to.equal(6);
        expect(s.pot).to.equal(66);
        expect(s.board).to.deep.equal(["Ks", "7d", "2c", "9h", "3c"]);
        expect(by.B.shown_cards).to.deep.equal(["Kd", "Kc"]);
        expect(s.ended).to.equal(true);
        expect(netResult(s, "b")).to.equal(36);
        expect(netResult(s, "c")).to.equal(-30);
        expect(netResult(s, "a")).to.equal(-6);
        expect(s.unparsed).to.deep.equal([]);
    });

    it("caps a call at the caller's stack", () => {
        const s = parseHand([
            `-- starting hand #8 (id: h8)  No Limit Texas Hold'em (dealer: ${p("A", "a")}) --`,
            `Player stacks: #1 ${p("A", "a")} (100) | #2 ${p("B", "b")} (10) | #3 ${p("C", "c")} (100)`,
            `${p("B", "b")} posts a small blind of 1`,
            `${p("C", "c")} posts a big blind of 2`,
            `${p("A", "a")} raises to 50`,
            `${p("B", "b")} calls 10 and go all in`
        ]);
        const b = s.seats.find((x) => x.id === "b")!;
        expect(b.total_contribution).to.equal(10);
        expect(b.all_in).to.equal(true);
        expect(b.stack).to.equal(0);
    });

    it("uses the straddle as the minimum raise size and ignores dead blinds for calling", () => {
        const s = parseHand([
            `-- starting hand #9 (id: h9)  No Limit Texas Hold'em (dealer: ${p("D", "d")}) --`,
            `Player stacks: #1 ${p("A", "a")} (100) | #2 ${p("B", "b")} (100) | #3 ${p("C", "c")} (100) | #4 ${p("D", "d")} (100)`,
            `${p("A", "a")} posts a small blind of 1`,
            `${p("B", "b")} posts a big blind of 2`,
            `${p("C", "c")} posts a straddle of 4`,
            `${p("D", "d")} posts a missing small blind of 1`
        ], { hero_name: "D" });
        const v = heroView(s)!;
        expect(v.to_call).to.equal(4);
        expect(v.min_raise_to).to.equal(8);
        expect(s.pot).to.equal(8);
    });

    it("collects unknown lines instead of throwing", () => {
        const s = parseHand([...nineHanded, "Something new PokerNow added", `${p("S6", "i6")} does a new thing`]);
        expect(s.unparsed).to.deep.equal(["Something new PokerNow added", `${p("S6", "i6")} does a new thing`]);
    });

    it("counts limpers only before the first raise", () => {
        const s = parseHand([...nineHanded, `${p("S6", "i6")} raises to 1.00`, `${p("S7", "i7")} calls 1.00`]);
        expect(countLimpers(s)).to.equal(2);
    });
});

describe("Table.convertOrderToPosition (legacy path)", () => {
    it("labels 9 players without duplicates", async () => {
        const { Table } = await import("../../app/models/table.ts");
        const t = new Table({} as any);
        const labels = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => t.convertOrderToPosition(String(n), 9));
        expect(labels).to.deep.equal(["SB", "BB", "UTG", "UTG+1", "MP", "LJ", "HJ", "CO", "BU"]);
    });
});
