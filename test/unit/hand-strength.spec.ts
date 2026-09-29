import { expect } from "chai";

import { describeHand } from "../../app/engine/hand-strength.ts";

describe("describeHand", () => {
    const made = (hole: string, board: string) => describeHand(hole.split(" "), board.split(" ")).made;

    it("names made hands", () => {
        expect(made("As Kd", "Kh 7c 2d")).to.equal("Top pair, Ace kicker");
        expect(made("Qs Qd", "Jh 7c 2d")).to.equal("Overpair (Queens)");
        expect(made("7s 7d", "Kh 7c 2d")).to.equal("Set of 7s");
        expect(made("Ks 7d", "Kh 7c 2d")).to.equal("Two pair (both your cards)");
        expect(made("9s 9d", "Kh Jc 2d")).to.equal("Pocket 9s below the board's top card");
        expect(made("Qs 7d", "Kh 7c 2d")).to.equal("Second pair (7s)");
        expect(made("As Qd", "Kh 7c 2d")).to.equal("Ace high, 1 overcard");
        expect(made("Ah 3h", "Kh 7h 2h Js")).to.equal("Nut flush");
        expect(made("9s 8d", "7h 6c 5d")).to.equal("Straight");
        expect(made("As Kd", "7h 7c 7d")).to.equal("Trips on the board");
    });

    it("finds draws and counts outs", () => {
        const fd = describeHand(["Ah", "5h"], ["Kh", "9h", "2c"]);
        expect(fd.draws).to.deep.equal(["Nut flush draw"]);
        expect(fd.outs).to.equal(9);
        expect(fd.hit_next).to.be.closeTo(9 / 47, 1e-9);
        expect(fd.hit_by_river).to.be.closeTo(1 - (38 * 37) / (47 * 46), 1e-9);  // ~35%

        const oesd = describeHand(["9c", "8d"], ["7h", "6s", "2c"]);
        expect(oesd.draws).to.deep.equal(["Open-ended straight draw"]);
        expect(oesd.outs).to.equal(8);

        const gut = describeHand(["9c", "8d"], ["Jh", "7s", "2c"]);
        expect(gut.draws).to.deep.equal(["Gutshot straight draw"]);
        expect(gut.outs).to.equal(4);

        const combo = describeHand(["9h", "8h"], ["7h", "6h", "2c"]);  // flush draw + open-ender: 15 outs
        expect(combo.outs).to.equal(15);

        expect(describeHand(["As", "Kd"], ["Kh", "7c", "2d", "9s", "3h"]).draws).to.deep.equal([]);
    });

    it("names starting hands preflop", () => {
        expect(describeHand(["Ks", "6d"], []).made).to.equal("K6o (offsuit)");
        expect(describeHand(["7s", "7d"], []).made).to.equal("Pocket 7s");
    });
});
