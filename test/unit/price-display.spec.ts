import { expect } from "chai";

import { heroView, parseHand } from "../../app/engine/hand-parser.ts";
import { preflopAdvice } from "../../app/engine/preflop.ts";
import { mixPostflop } from "../../app/engine/mixing.ts";
import { PostflopAnalysis } from "../../app/engine/postflop.ts";
import { preflopOverlay } from "../../app/helpers/overlay-builder.ts";
import { renderPanel } from "../../app/ui/panel-render.ts";
import { buildLog, useBuiltInDefaults } from "../../scripts/scenarios.ts";

/** Small blind opens 98s to 10 BB, the big blind 3-bets to 30 BB; stacks of `stack_bb`. */
function threeBetSpot(stack_bb: number) {
    const s = parseHand(buildLog({ n: 6, hero: "SB", cards: "9h 8h", stack_bb }, ["SB raises 20", "BB raises 60"]), { hero_name: "SB" });
    return { s, v: heroView(s)! };
}
const inputs = (s: ReturnType<typeof threeBetSpot>["s"], v: ReturnType<typeof threeBetSpot>["v"]) =>
    ({ state: s, view: v, players: () => ({ deviations: [] }), stats: () => undefined });

describe("preflop price against a 3-bet", () => {
    before(() => useBuiltInDefaults());

    it("calls a 3-bet the chart folds when the call leaves a stack-to-pot ratio under 2 and the price is right", () => {
        const { s, v } = threeBetSpot(100);
        const a = preflopAdvice(s, v, () => undefined, undefined, { equity: 0.36 })!;
        expect(a.action).to.equal("call");
        expect(a.price!.decided).to.equal(true);
        expect(a.reason).to.match(/plays nearly to showdown/);
        // not enough equity: still a fold
        expect(preflopAdvice(s, v, () => undefined, undefined, { equity: 0.25 })!.action).to.equal("fold");
    });

    it("leaves deeper 3-bets to the chart, and explains a fold whose raw equity beats the price", () => {
        const { s, v } = threeBetSpot(300);
        const a = preflopAdvice(s, v, () => undefined, undefined, { equity: 0.36 })!;
        expect(a.action).to.equal("fold");
        expect(a.price!.decided).to.equal(false);
        expect(a.price!.realized).to.be.below(a.price!.need);
        const model = preflopOverlay(inputs(s, v), a, { equity: 0.36, need: a.price!.need });
        expect(model.odds.realized).to.be.closeTo(a.price!.realized, 1e-9);
        expect(model.reasoning.join(" ")).to.match(/Raw equity 36% is above the 33% the call needs, but out of position 98s keeps about 90%/);
        // the key numbers judge the equity the hand keeps: red, not green
        const { html } = renderPanel(model);
        expect(html).to.match(/pgpt-key pgpt-key-bad"><span class="pgpt-key-label">Equity<\/span> <b>36% \(32% kept\)/);
    });
});

describe("balanced defense before the river", () => {
    const s = parseHand([
        `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: "V @ v") --`,
        `Player stacks: #1 "H @ h" (400) | #2 "V @ v" (400)`,
        `Your hand is 9h, 9d`,
        `"V @ v" posts a small blind of 1`, `"H @ h" posts a big blind of 2`, `"V @ v" calls 2`, `"H @ h" checks`,
        `Flop:  [As, Qd, 2h]`, `"H @ h" checks`, `"V @ v" bets 4`
    ], { hero_name: "H" });
    const v = heroView(s)!;
    const analysis = (realization: number): PostflopAnalysis => ({
        equity: 0.3, equity_when_called: 0.3, required_equity: 0.33, fold_probability: new Map(), in_position: false, realization, street: "flop",
        candidates: [{ action: "fold", to: 0, ev: 0, label: "fold" }, { action: "call", to: 0, ev: -0.2, label: "call 2 BB" }]
    });
    const range = { value: 0.2, strong: 0.05, medium: 0.6, draw: 0, air: 0.2, above: 0.5, tied: 0.04 };

    it("moves the defense line down by the share of equity hands keep, so a mid-range hand folds more out of position", () => {
        const river_like = mixPostflop({ analysis: analysis(1), state: s, view: v, style: "balanced", roll: 50, hero_range: range, opponent_types: ["TAG"] });
        const flop_oop = mixPostflop({ analysis: analysis(0.8), state: s, view: v, style: "balanced", roll: 50, hero_range: range, opponent_types: ["TAG"] });
        // a pot-size bet: MDF 50%, and 80% of that out of position
        expect(river_like.baseline!.continue).to.be.closeTo(0.5, 0.01);
        expect(flop_oop.baseline!.continue).to.be.closeTo(0.4, 0.01);
        const call = (m: typeof flop_oop) => m.options.find((o) => o.action === "call")?.freq ?? 0;
        expect(call(flop_oop)).to.be.below(call(river_like));
        expect(call(flop_oop)).to.be.below(0.5);
        expect(flop_oop.reasons.join(" ")).to.match(/less than the 50% minimum defense frequency because hands keep only about 80% of their equity out of position/);
    });
});
