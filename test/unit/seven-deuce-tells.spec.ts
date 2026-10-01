import { expect } from "chai";

import { HandState, parseHand } from "../../app/engine/hand-parser.ts";
import { seatModel, setSevenDeuceTells, TABLE_RULES } from "../../app/engine/opponent-range.ts";
import { calibrateTells, readTells } from "../../app/engine/seven-deuce-tells.ts";

const p = (name: string, id: string) => `"${name} @ ${id}"`;
const keyOf = (seat: { id: string }) => seat.id;

/** Player `who` opens to `to` chips (big blind 2) and everyone folds; `cards` are shown when given. */
const open = (n: number, who: string, to: number, cards?: string) => parseHand([
    `-- starting hand #${n} (id: h${n})  No Limit Texas Hold'em (dealer: ${p(who, who)}) --`,
    `Player stacks: #1 ${p(who, who)} (400) | #2 ${p("S", "s")} (400) | #3 ${p("B", "b")} (400)`,
    `${p("S", "s")} posts a small blind of 1`, `${p("B", "b")} posts a big blind of 2`,
    `${p(who, who)} raises to ${to}`, `${p("S", "s")} folds`, `${p("B", "b")} folds`,
    ...(cards ? [`${p(who, who)} shows a ${cards}.`] : []), `-- ending hand #${n} --`]);

describe("7-2 sizing tells", () => {
    // ten players who open to 3 BB with most hands, and to 6 BB with shown 7-2 two times in three
    const hands: HandState[] = [];
    let n = 0;
    for (let i = 0; i < 10; i++) {
        for (let k = 0; k < 20; k++) hands.push(open(n++, `P${i}`, k % 10 === 0 ? 12 : 6));
        for (let k = 0; k < 3; k++) hands.push(open(n++, `P${i}`, k < 2 ? 12 : 6, "7♣, 2♦"));
    }

    it("turns on a tell only when 7-2 is clearly sized differently, against the player's own usual size", () => {
        const model = calibrateTells(hands, keyOf);
        const t = model.stats.open;
        expect(t.n72).to.equal(30);
        expect(t.big72).to.equal(20);
        expect(t.active).to.equal(true);
        expect(t.z).to.be.at.least(3);
        expect(t.lr_big).to.be.greaterThan(1);
        expect(t.lr_normal).to.be.lessThan(1);
        expect(model.stats.flop_bet.active).to.equal(false);
        // the same sizes with 7-2 opened like everything else: no tell
        const plain = calibrateTells(hands.map((h, i) => (i % 23 >= 20 ? open(5000 + i, `P${Math.floor(i / 23)}`, 6, "7♣, 2♦") : h)), keyOf);
        expect(plain.stats.open.active).to.equal(false);
    });

    it("reads a big open as more likely 7-2 and a normal one as a little less likely, and says so on the panel", () => {
        const model = calibrateTells(hands, keyOf);
        const big = open(9000, "P3", 12), normal = open(9001, "P3", 6);
        const rb = readTells(model, big, big.seats.find((s) => s.id === "P3")!, "P3");
        const rn = readTells(model, normal, normal.seats.find((s) => s.id === "P3")!, "P3");
        expect(rb.lr).to.be.greaterThan(1);
        expect(rb.notes[0]).to.match(/Possible 7-2: their first raise \(no limpers\) is 2\.0x their usual size/);
        expect(rn.lr).to.be.lessThan(1);
        expect(rn.notes).to.deep.equal([]);
    });

    it("moves 7-2's weight in the opener's range under the bounty, and leaves it alone without one", () => {
        const model = calibrateTells(hands, keyOf);
        const s = open(9002, "P3", 12);
        const seat = s.seats.find((x) => x.id === "P3")!;
        const rule = TABLE_RULES.seven_deuce_bounty;
        try {
            TABLE_RULES.seven_deuce_bounty = true;
            const before = seatModel(s, seat, () => undefined).model.range.get("72o") ?? 0;
            setSevenDeuceTells((st, se) => readTells(model, st, se, se.id));
            const after = seatModel(s, seat, () => undefined).model.range.get("72o") ?? 0;
            expect(before).to.be.greaterThan(0);
            expect(after).to.be.closeTo(before * readTells(model, s, seat, "P3").lr, 1e-9);
            TABLE_RULES.seven_deuce_bounty = false;
            expect(seatModel(s, seat, () => undefined).model.range.get("72o") ?? 0).to.equal(0);
        } finally {
            TABLE_RULES.seven_deuce_bounty = rule;
            setSevenDeuceTells(null);
        }
    });
});
