import { expect } from "chai";

import { parseHand } from "../../app/engine/hand-parser.ts";
import { newCounters, ProfileBuilder } from "../../app/engine/player-profile.ts";
import { chooseHalfLife, gameOrder, gamesSince, PlayerGameCounts, recencyWeight } from "../../app/engine/recency.ts";

/** Players whose VPIP in each game is `vpip(player, game)`, over `hands` hands per game. */
function counts(players: number, games: number, hands: number, vpip: (p: number, g: number) => number): PlayerGameCounts {
    const out: PlayerGameCounts = new Map();
    for (let p = 0; p < players; p++) {
        const m = new Map();
        for (let g = 0; g < games; g++) {
            const c = newCounters();
            c.vpip = { k: Math.round(vpip(p, g) * hands), n: hands };
            m.set(`g${g}`, c);
        }
        out.set(`p${p}`, m);
    }
    return out;
}
const order = (games: number) => Array.from({ length: games }, (_, g) => `g${g}`);

describe("recency weighting", () => {
    it("weights a player's games by how many of their games came since", () => {
        expect(recencyWeight(0, 5)).to.equal(1);
        expect(recencyWeight(5, 5)).to.be.closeTo(0.5, 1e-12);
        expect(recencyWeight(50, Infinity)).to.equal(1);
        const c = counts(1, 3, 10, () => 0.3);
        c.get("p0")!.delete("g1");
        // the player's own games: g2 is their newest, g0 the one before it (g1 they missed)
        expect([...gamesSince(c, order(3)).get("p0")!]).to.deep.equal([["g2", 0], ["g0", 1]]);
        expect(gameOrder([{ game_id: "b", at: "2026-02" }, { game_id: "a", at: "2026-03" }, { game_id: "b", at: "2026-01" }])).to.deep.equal(["b", "a"]);
    });

    it("picks a short half-life when players change style, and none when they don't", () => {
        // each player drifts from tight to loose over the games
        const drifting = chooseHalfLife(counts(40, 9, 60, (p, g) => 0.15 + 0.06 * g + 0.002 * p), order(9));
        expect(drifting.half_life).to.be.lessThan(Infinity);
        expect(drifting.cases).to.be.greaterThan(0);
        // same style every game
        const stable = chooseHalfLife(counts(40, 9, 60, (p) => 0.2 + 0.01 * (p % 10)), order(9));
        expect(stable.half_life).to.equal(Infinity);
        // too few games to check
        expect(chooseHalfLife(counts(5, 3, 60, () => 0.3), order(3)).reason).to.match(/needs/);
    });

    it("counts a hand at its weight in the player's stats, and fully in the pool's", () => {
        const p = (name: string, id: string) => `"${name} @ ${id}"`;
        const s = parseHand([
            `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${p("A", "a")}) --`,
            `Player stacks: #1 ${p("A", "a")} (100) | #2 ${p("B", "b")} (100)`,
            `${p("A", "a")} posts a small blind of 1`, `${p("B", "b")} posts a big blind of 2`,
            `${p("A", "a")} raises to 6`, `${p("B", "b")} folds`, `-- ending hand #1 --`]);
        const b = new ProfileBuilder();
        b.addHand(s, "", (key) => (key === "a" ? 0.25 : 1));
        expect(b.profile("a")!.vpip).to.include({ k: 0.25, n: 0.25 });
        expect(b.rawCounts().get("a")!.vpip).to.deep.equal({ k: 1, n: 1 });
        expect(b.poolCounts().vpip).to.deep.equal({ k: 1, n: 2 });
    });
});
