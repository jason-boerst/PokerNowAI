import { expect } from "chai";

import { parseGameInfo } from "../../app/utils/game-info-utils.ts";

describe("parseGameInfo", () => {
    const cases: Array<[string, string, number, number]> = [
        ["NLH~ 10 / 20", "NLH", 10, 20],          // format the original parser expected
        ["NLH~10/20", "NLH", 10, 20],             // no spaces (e.g. text split across elements)
        ["NLH ~ 10 / 20", "NLH", 10, 20],
        ["NLH ~ 1 / 2", "NLH", 1, 2],
        ["PLO~ 0.10 / 0.20", "PLO", 0.1, 0.2],
        ["PLO5 ~ 25 / 50", "PLO5", 25, 50],
        ["NLH~ 1,000 / 2,000", "NLH", 1000, 2000],
        ["NLH ~ $0.05 / $0.10", "NLH", 0.05, 0.1],
        ["NLH~ 10 / 20 / 5", "NLH", 10, 20],      // ante after the blinds
        ["10 / 20", "NLH", 10, 20]                 // no game type shown
    ];
    for (const [text, type, sb, bb] of cases) {
        it(`parses ${JSON.stringify(text)}`, () => {
            expect(parseGameInfo(text)).to.deep.equal({ game_type: type, small_blind: sb, big_blind: bb });
        });
    }

    it("returns null when there are no blinds", () => {
        expect(parseGameInfo("NLH")).to.equal(null);
        expect(parseGameInfo("")).to.equal(null);
        expect(parseGameInfo(null)).to.equal(null);
        expect(parseGameInfo("0 / 0")).to.equal(null);
    });
});
