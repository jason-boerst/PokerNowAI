import { expect } from "chai";

import { parseHand } from "../../app/engine/hand-parser.ts";
import { normalizeName, sameProfileCandidates } from "../../app/engine/identity.ts";
import { ProfileBuilder } from "../../app/engine/player-profile.ts";

const p = (name: string, id: string) => `"${name} @ ${id}"`;
/** A hand with the given seats ([name, id]); the first raises, the rest fold. */
const hand = (n: number, seats: [string, string][]) => parseHand([
    `-- starting hand #${n} (id: h${n})  No Limit Texas Hold'em (dealer: ${p(...seats[0])}) --`,
    `Player stacks: ${seats.map((s, i) => `#${i + 1} ${p(...s)} (100)`).join(" | ")}`,
    `${p(...seats[1])} posts a small blind of 1`, `${p(...seats[2])} posts a big blind of 2`,
    `${p(...seats[0])} raises to 6`, `${p(...seats[1])} folds`, `${p(...seats[2])} folds`, `-- ending hand #${n} --`]);

describe("same-player suggestions", () => {
    const hands = [
        // game 1: "Mike" as m1, and two "Sam"s at the same table
        ...Array.from({ length: 5 }, (_, i) => ({ game_id: "g1", state: hand(i, [["Mike", "m1"], ["Sam", "s1"], ["Sam", "s2"]]) })),
        // game 2: "mike!" as m2, "Mikey" as m3, and "Zed"
        ...Array.from({ length: 5 }, (_, i) => ({ game_id: "g2", state: hand(10 + i, [["mike!", "m2"], ["Zed", "z1"], ["Mikey", "m3"]]) }))
    ];
    const b = new ProfileBuilder();
    for (const h of hands) b.addHand(h.state);
    const list = sameProfileCandidates(hands, (seat) => seat.id, (key) => b.profile(key));
    const pairs = list.map((c) => [c.a, c.b].sort().join("+"));

    it("pairs ids with the same name (ignoring case and symbols) or a name that starts the same", () => {
        expect(normalizeName(" Mike! ")).to.equal("mike");
        expect(pairs).to.include("m1+m2");
        expect(pairs).to.include("m1+m3");
        expect(list.find((c) => [c.a, c.b].sort().join("+") === "m1+m2")!.match).to.equal("same name");
        expect(list.find((c) => [c.a, c.b].sort().join("+") === "m1+m3")!.match).to.equal("name starts the same");
        // exact names first
        expect(list[0].match).to.equal("same name");
    });

    it("never pairs two ids that sat in the same hand", () => {
        expect(pairs).to.not.include("s1+s2");
        // m2 and m3 sat together in game 2
        expect(pairs).to.not.include("m2+m3");
        expect(pairs.some((x) => x.includes("z1"))).to.equal(false);
    });

    it("counts already linked ids as one person", () => {
        const linked = sameProfileCandidates(hands, (seat) => (seat.id === "m2" ? "m1" : seat.id), (key) => b.profile(key));
        expect(linked.map((c) => [c.a, c.b].sort().join("+"))).to.not.include("m1+m2");
    });
});
