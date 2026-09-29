import { expect } from "chai";

import { heroView, parseHand } from "../../app/engine/hand-parser.ts";
import { actionsAgree, checkLegality, parseSuggestedAction } from "../../app/engine/legality.ts";
import { summarizeWinrate } from "../../app/engine/winrate.ts";

const p = (name: string, id: string) => `"${name} @ ${id}"`;
const facingRaise = parseHand([
    `-- starting hand #1 (id: a)  No Limit Texas Hold'em (dealer: ${p("C", "c")}) --`,
    `Player stacks: #1 ${p("A", "a")} (20) | #2 ${p("B", "b")} (20) | #3 ${p("C", "c")} (20)`,
    `${p("A", "a")} posts a small blind of 0.10`,
    `${p("B", "b")} posts a big blind of 0.20`,
    `${p("C", "c")} raises to 0.60`
], { hero_name: "A" });
const view = heroView(facingRaise)!;

describe("checkLegality", () => {
    const legal = (text: string) => checkLegality(parseSuggestedAction(text)!, view, 0.2);
    it("accepts legal actions facing a raise", () => {
        expect(legal("call").legal).to.equal(true);
        expect(legal("fold").legal).to.equal(true);
        expect(legal("raise 5").legal).to.equal(true);      // min raise to 1.00 = 5 BB
        expect(legal("all in").legal).to.equal(true);
    });
    it("rejects illegal ones with a reason", () => {
        expect(legal("check").reason).to.match(/can't check/);
        expect(legal("raise 4").reason).to.match(/below the minimum/);
        expect(legal("raise 500").reason).to.match(/more than hero's stack/);
    });
    it("flags folding when checking is free as dominated", () => {
        const bbView = heroView(parseHand([
            `-- starting hand #2 (id: b)  No Limit Texas Hold'em (dealer: ${p("A", "a")}) --`,
            `Player stacks: #1 ${p("A", "a")} (20) | #2 ${p("B", "b")} (20)`,
            `${p("A", "a")} posts a small blind of 0.10`,
            `${p("B", "b")} posts a big blind of 0.20`,
            `${p("A", "a")} calls 0.20`
        ], { hero_name: "B" }))!;
        const r = checkLegality({ action: "fold", size_bb: 0 }, bbView, 0.2);
        expect(r.legal && r.dominated).to.equal(true);
        expect(checkLegality({ action: "call", size_bb: 0 }, bbView, 0.2).legal).to.equal(false);
    });
});

describe("actionsAgree", () => {
    it("treats bet and raise as the same and allows 25% size difference", () => {
        expect(actionsAgree(parseSuggestedAction("bet 4")!, parseSuggestedAction("raise 4.8")!)).to.equal(true);
        expect(actionsAgree(parseSuggestedAction("raise 3")!, parseSuggestedAction("raise 6")!)).to.equal(false);
        expect(actionsAgree(parseSuggestedAction("call")!, parseSuggestedAction("fold")!)).to.equal(false);
    });
});

describe("summarizeWinrate", () => {
    it("computes bb/100 and a confidence interval", () => {
        const w = summarizeWinrate([1, -1, 1, -1, 2]);
        expect(w.bb_per_100).to.be.closeTo(40, 1e-9);
        expect(w.inconclusive).to.equal(true);
        expect(w.ci_low).to.be.lessThan(0);
    });
    it("is conclusive only when the interval excludes zero", () => {
        expect(summarizeWinrate(Array(400).fill(0).map((_, i) => (i % 2 ? 1.2 : 0.8))).inconclusive).to.equal(false);
    });
});
