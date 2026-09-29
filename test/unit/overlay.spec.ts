import { expect } from "chai";

import { heroView, parseHand } from "../../app/engine/hand-parser.ts";
import { analyzePostflop } from "../../app/engine/postflop.ts";
import { preflopAdvice } from "../../app/engine/preflop.ts";
import { topRange } from "../../app/engine/ranges.ts";
import { postflopOverlay, preflopOverlay } from "../../app/helpers/overlay-builder.ts";
import { ProfileBuilder } from "../../app/engine/player-profile.ts";

const p = (name: string, id: string) => `"${name} @ ${id}"`;
const flopSpot = () => {
    const s = parseHand([
        `-- starting hand #12 (id: t)  No Limit Texas Hold'em (dealer: ${p("V", "v")}) --`,
        `Player stacks: #1 ${p("H", "h")} (200) | #2 ${p("V", "v")} (200)`,
        `Your hand is A♥, 5♥`,
        `${p("V", "v")} posts a small blind of 1`, `${p("H", "h")} posts a big blind of 2`,
        `${p("V", "v")} calls 2`, `${p("H", "h")} checks`,
        `Flop:  [K♥, 9♥, 2♣]`, `${p("H", "h")} checks`, `${p("V", "v")} bets 3`
    ], { hero_name: "H" });
    return { s, v: heroView(s)! };
};
const noProfile = () => undefined;
const noStats = () => undefined;

describe("overlay content", () => {
    it("shows the spot, hand with draws and outs, odds, all options and opponents after the flop", () => {
        const { s, v } = flopSpot();
        const a = analyzePostflop(s, v, [{ model: { range: topRange(40) }, fold_to_bet: 0.4, fold_to_raise: 0.25 }]);
        const o = postflopOverlay({ state: s, view: v, profiles: noProfile, stats: noStats }, a,
            { action: "call", size_bb: 0, reason: "Nut flush draw with good odds.", source: "llm", confidence: 0.6 }, "test/model", 20000);
        const titles = o.sections.map((x) => x.title);
        expect(titles).to.deep.equal(["Spot", "Your hand", "Odds", "Options (rough EV, this street only)", "Opponents in the hand (1)"]);
        expect(o.context).to.equal("Hand #12 · Flop · you: BB");
        expect(o.sections[0].lines[0]).to.include("To call 1.5 BB");
        expect(o.sections[1].lines.join(" ")).to.include("Nut flush draw: 9 outs");
        expect(o.sections[3].lines.length).to.equal(a.candidates.length);
        expect(o.sections[3].lines.filter((l) => l.startsWith("▶"))).to.have.length(1);
        expect(o.header).to.equal("AI (test/model) · 60% confident");
        expect(o.warnings.join(" ")).to.include("population defaults");
    });

    it("shows the engine's pick with a thinking status while the AI works", () => {
        const { s, v } = flopSpot();
        const a = analyzePostflop(s, v, [{ model: { range: topRange(40) }, fold_to_bet: 0.4, fold_to_raise: 0.25 }]);
        const o = postflopOverlay({ state: s, view: v, profiles: noProfile, stats: noStats }, a, null, "test/model", 20000);
        expect(o.status).to.equal("thinking");
        expect(o.header).to.include("asking test/model (up to 20s)");
        expect(o.action).to.equal(a.candidates[0].action);
    });

    it("shows the stats that matter for the decision: aggression when facing a bet", () => {
        const { s, v } = flopSpot();
        const b = new ProfileBuilder();
        for (let i = 0; i < 25; i++) b.addHand(parseHand([
            `-- starting hand #${i} (id: x)  No Limit Texas Hold'em (dealer: ${p("V", "v")}) --`,
            `Player stacks: #1 ${p("H", "h")} (200) | #2 ${p("V", "v")} (200)`,
            `${p("V", "v")} posts a small blind of 1`, `${p("H", "h")} posts a big blind of 2`, `${p("V", "v")} calls 2`, `${p("H", "h")} checks`
        ]));
        const a = analyzePostflop(s, v, [{ model: { range: topRange(40) }, fold_to_bet: 0.4, fold_to_raise: 0.25 }]);
        const o = postflopOverlay({ state: s, view: v, profiles: (n) => b.profile(n), stats: noStats }, a,
            { action: "call", size_bb: 0, reason: "", source: "engine", confidence: 0.8 }, "m", 20000);
        const opp = o.sections[4].lines.join(" ");
        expect(opp).to.include("(25 hands)");
        expect(opp).to.include("aggression");
        expect(o.header).to.equal("Engine · clear spot");
    });

    it("preflop: chart spot, equity and hand name", () => {
        const s = parseHand([
            `-- starting hand #3 (id: t)  No Limit Texas Hold'em (dealer: ${p("H", "h")}) --`,
            `Player stacks: #1 ${p("H", "h")} (40) | #2 ${p("V", "v")} (40)`,
            `Your hand is K♠, 6♦`,
            `${p("H", "h")} posts a small blind of 0.10`, `${p("V", "v")} posts a big blind of 0.20`
        ], { hero_name: "H" });
        const v = heroView(s)!;
        const advice = preflopAdvice(s, v, noStats)!;
        const o = preflopOverlay({ state: s, view: v, profiles: noProfile, stats: noStats }, advice, { equity: 0.52, need: 0 });
        expect(o.header).to.equal("Preflop chart");
        expect(o.action).to.equal("raise");
        const text = o.sections.flatMap((x) => x.lines).join(" | ");
        expect(text).to.include("K6o (offsuit)");
        expect(text).to.include("Equity 52% vs their likely hands");
        expect(text).to.not.include("need");
        expect(text).to.include("heads-up, small blind (button) first in");
    });
});
