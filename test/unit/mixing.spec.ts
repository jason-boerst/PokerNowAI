import { expect } from "chai";

import { heroView, parseHand } from "../../app/engine/hand-parser.ts";
import { rangeProfile } from "../../app/engine/equity.ts";
import { Candidate, PostflopAnalysis } from "../../app/engine/postflop.ts";
import { comboCount } from "../../app/engine/hand-classes.ts";
import { RANKED_CLASSES, topRange } from "../../app/engine/ranges.ts";
import { PreflopAdvice, PreflopTier } from "../../app/engine/preflop.ts";
import {
    balanceNeed, describeMix, MIN_FREQ, mixPostflop, mixPreflop, parseMixStyle, pickByRoll, rollRng, withRanges
} from "../../app/engine/mixing.ts";
import { postflopOverlay, preflopOverlay } from "../../app/helpers/overlay-builder.ts";
import { renderPanel } from "../../app/ui/panel-render.ts";
import { decidePostflop, opponentTendencies } from "../../app/helpers/decision-maker.ts";
import { seatModel } from "../../app/engine/opponent-range.ts";
import { AIMessage, AIResponse, AIService } from "../../app/interfaces/ai-client-interfaces.ts";
import { SCENARIOS, spotOf, useBuiltInDefaults } from "../../scripts/scenarios.ts";

class CountingAI extends AIService {
    calls = 0;
    constructor() { super("k", "test/model", "neutral"); }
    init(): void {}
    processMessages(): any[] { return []; }
    async query(_input: string, prev: AIMessage[]): Promise<AIResponse> {
        this.calls++;
        return { bot_action: { action_str: "", bet_size_in_BBs: 0 }, prev_messages: prev, curr_message: { text_content: '{"action":"check","size_bb":0,"confidence":0.5,"reason":"x"}', metadata: { role: "assistant" } } };
    }
}

const p = (name: string, id: string) => `"${name} @ ${id}"`;
const H = p("H", "h"), V = p("V", "v");

/** Heads-up hand checked to the flop (villain on the button), then `last`. Pot 4 chips, big blind 2. */
function flop(hero: string, board: string[], last: string[] = []) {
    const s = parseHand([
        `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${V}) --`,
        `Player stacks: #1 ${H} (400) | #2 ${V} (400)`,
        `Your hand is ${hero}`,
        `${V} posts a small blind of 1`, `${H} posts a big blind of 2`, `${V} calls 2`, `${H} checks`,
        `Flop:  [${board.join(", ")}]`,
        ...last
    ], { hero_name: "H" });
    return { s, v: heroView(s)! };
}

/** A synthetic analysis: EVs in big blinds (big blind 2 chips). */
function analysis(cands: { action: Candidate["action"], to_bb?: number, ev_bb: number, purpose?: Candidate["purpose"] }[]): PostflopAnalysis {
    const candidates: Candidate[] = cands.map((c) => ({
        action: c.action, to: (c.to_bb ?? 0) * 2, ev: c.ev_bb * 2,
        label: c.to_bb ? `${c.action === "raise" ? "raise to" : c.action} ${c.to_bb} BB` : c.action,
        ...(c.purpose ? { purpose: c.purpose, called_equity: c.purpose === "value" ? 0.7 : 0.1, fold_chance: 0.3, raise_chance: 0.05 } : {})
    }));
    return { equity: 0.5, equity_when_called: 0.5, required_equity: 0, fold_probability: new Map(), candidates, in_position: false, realization: 1, street: "flop" };
}

describe("RNG mixing: ranges and the roll", () => {
    it("gives each option a block of whole numbers on 1-100, passive to aggressive, dropping options under 5%", () => {
        const r = withRanges([
            { action: "bet" as const, size_bb: 6, freq: 0.3 },
            { action: "check" as const, size_bb: 0, freq: 0.52 },
            { action: "bet" as const, size_bb: 3, freq: 0.16 },
            { action: "bet" as const, size_bb: 12, freq: 0.02 }
        ]);
        expect(r.map((o) => [o.action, o.size_bb])).to.deep.equal([["check", 0], ["bet", 3], ["bet", 6]]);
        expect(r[0].from).to.equal(1);
        expect(r[r.length - 1].to).to.equal(100);
        for (let i = 1; i < r.length; i++) expect(r[i].from).to.equal(r[i - 1].to + 1);
        expect(r.reduce((s, o) => s + o.freq, 0)).to.be.closeTo(1, 1e-9);
        expect(r.every((o) => o.freq >= MIN_FREQ)).to.equal(true);
    });

    it("picks by roll: 1 is the most passive option, 100 the most aggressive, boundaries inclusive", () => {
        const r = withRanges([{ action: "fold" as const, size_bb: 0, freq: 0.25 }, { action: "call" as const, size_bb: 0, freq: 0.5 }, { action: "raise" as const, size_bb: 9, freq: 0.25 }]);
        expect(pickByRoll(r, 1).action).to.equal("fold");
        expect(pickByRoll(r, 25).action).to.equal("fold");
        expect(pickByRoll(r, 26).action).to.equal("call");
        expect(pickByRoll(r, 75).action).to.equal("call");
        expect(pickByRoll(r, 76).action).to.equal("raise");
        expect(pickByRoll(r, 100).action).to.equal("raise");
    });

    it("rolls whole numbers from 1 to 100", () => {
        const rolls = Array.from({ length: 3000 }, () => rollRng());
        expect(rolls.every((x) => Number.isInteger(x) && x >= 1 && x <= 100)).to.equal(true);
        expect(Math.min(...rolls)).to.be.at.most(5);
        expect(Math.max(...rolls)).to.be.at.least(96);
    });

    it("reads the style from the config (balanced by default)", () => {
        expect(parseMixStyle(undefined)).to.equal("balanced");
        expect(parseMixStyle("OFF")).to.equal("off");
        expect(parseMixStyle(false)).to.equal("off");
        expect(parseMixStyle("exploit")).to.equal("exploit");
        expect(parseMixStyle("gto")).to.equal("gto");
        expect(parseMixStyle("anything else")).to.equal("balanced");
    });

    it("weighs balance by the opponents still in: full against regulars, less against players who don't adjust", () => {
        expect(balanceNeed(["TAG", "calling station"])).to.equal(1);
        expect(balanceNeed(["calling station", "maniac"])).to.be.below(0.5);
        expect(balanceNeed([])).to.equal(0.75);
        expect(balanceNeed(["unknown"])).to.equal(0.75);
    });
});

describe("RNG mixing: post-flop", () => {
    const { s, v } = flop("Kd, Qc", ["Ks", "7d", "2c"]);

    it("plays a clear best option at every roll", () => {
        const a = analysis([{ action: "check", ev_bb: 1 }, { action: "bet", to_bb: 2, ev_bb: 3, purpose: "value" }]);
        for (const roll of [1, 50, 100]) {
            const m = mixPostflop({ analysis: a, state: s, view: v, style: "balanced", roll });
            expect(m.pure).to.equal(true);
            expect(m.pick.label).to.equal("bet 2 BB");
            expect([m.options[0].from, m.options[0].to]).to.deep.equal([1, 100]);
        }
    });

    it("mixes close options: low rolls check, high rolls bet, and the cost stays inside the band", () => {
        const a = analysis([{ action: "check", ev_bb: 1.9 }, { action: "bet", to_bb: 2, ev_bb: 2, purpose: "value" }]);
        const low = mixPostflop({ analysis: a, state: s, view: v, style: "balanced", roll: 1, opponent_types: ["TAG"] });
        const high = mixPostflop({ analysis: a, state: s, view: v, style: "balanced", roll: 100, opponent_types: ["TAG"] });
        expect(low.pure).to.equal(false);
        expect(low.pick.action).to.equal("check");
        expect(high.pick.action).to.equal("bet");
        // value hands bet in a balanced range: the bet gets the bigger share
        const bet = low.options.find((o) => o.action === "bet")!;
        expect(bet.freq).to.be.above(0.5);
        expect(low.cost_bb!).to.be.at.least(0).and.at.most(low.band_bb!);
        expect(describeMix(low)).to.match(/^check 1-\d+ · bet 2 BB \d+-100$/);
    });

    it("counts a bluff the engine's margin lower: a bluff barely ahead of checking mixes in less often, never more", () => {
        const a = analysis([{ action: "check", ev_bb: 1 }, { action: "bet", to_bb: 2, ev_bb: 1.3, purpose: "bluff" }]);
        const m = mixPostflop({ analysis: a, state: s, view: v, style: "balanced", roll: 50, opponent_types: ["TAG"] });
        const check = m.options.find((o) => o.action === "check");
        const bet = m.options.find((o) => o.action === "bet");
        expect(check, describeMix(m)).to.not.equal(undefined);
        expect((bet?.freq ?? 0)).to.be.below(check!.freq);
        expect(m.reasons.join(" ")).to.match(/margin of error/);
    });

    it("never folds when checking is free, even if an analysis offers it", () => {
        const a = analysis([{ action: "fold", ev_bb: 1 }, { action: "check", ev_bb: 1 }, { action: "bet", to_bb: 2, ev_bb: 1, purpose: "value" }]);
        for (const style of ["exploit", "balanced", "gto"] as const) {
            const m = mixPostflop({ analysis: a, state: s, view: v, style, roll: 1 });
            expect(m.options.some((o) => o.action === "fold")).to.equal(false);
        }
    });

    it("mixes less against players who don't adjust: a 0.3 BB gap mixes against a regular, not against a calling station", () => {
        const a = analysis([{ action: "check", ev_bb: 0 }, { action: "bet", to_bb: 2, ev_bb: 1.3, purpose: "value" }, { action: "bet", to_bb: 4, ev_bb: 1, purpose: "value" }]);
        const reg = mixPostflop({ analysis: a, state: s, view: v, style: "balanced", roll: 50, opponent_types: ["TAG"] });
        const fish = mixPostflop({ analysis: a, state: s, view: v, style: "balanced", roll: 50, opponent_types: ["calling station"] });
        expect(reg.pure, describeMix(reg)).to.equal(false);
        expect(fish.pure, describeMix(fish)).to.equal(true);
        expect(fish.pick.label).to.equal("bet 2 BB");
        expect(fish.reasons.join(" ")).to.match(/calling station/);
    });

    it("off: always the engine's own first option", () => {
        const a = analysis([{ action: "check", ev_bb: 1 }, { action: "bet", to_bb: 2, ev_bb: 1.3, purpose: "bluff" }]);
        const m = mixPostflop({ analysis: a, state: s, view: v, style: "off", roll: 100 });
        expect(m.pure).to.equal(true);
        expect(m.pick.action).to.equal("check");
    });

    it("facing a bet: a hand high in its range defends, one far below the defense line mostly folds", () => {
        const facing = flop("Kd, Qc", ["Ks", "7d", "2c"], [`${H} checks`, `${V} bets 2`]);
        const a = { ...analysis([{ action: "fold", ev_bb: 0 }, { action: "call", ev_bb: 0.1 }]), required_equity: 0.25 };
        const strong = mixPostflop({ analysis: a, state: facing.s, view: facing.v, style: "balanced", roll: 50, opponent_types: ["TAG"],
            hero_range: { value: 0.3, strong: 0.1, medium: 0.2, draw: 0.1, air: 0.4, above: 0.1, tied: 0.02 } });
        const weak = mixPostflop({ analysis: a, state: facing.s, view: facing.v, style: "balanced", roll: 50, opponent_types: ["TAG"],
            hero_range: { value: 0.3, strong: 0.1, medium: 0.2, draw: 0.1, air: 0.4, above: 0.95, tied: 0.02 } });
        const callShare = (m: typeof strong) => m.options.find((o) => o.action === "call")?.freq ?? 0;
        expect(callShare(strong)).to.be.above(0.8);
        expect(callShare(weak)).to.be.below(callShare(strong));
        // a half-pot bet: a balanced defense continues two thirds of the time
        expect(strong.baseline!.continue).to.be.closeTo(2 / 3, 0.01);
        expect(strong.reasons.join(" ")).to.match(/minimum defense frequency/);
    });

    it("a medium pair never bluffs in the mix, even when the bet ties checking", () => {
        const { s: s2, v: v2 } = flop("7h, 7s", ["Ks", "Qd", "2c"]);
        const a = analysis([{ action: "check", ev_bb: 1 }, { action: "bet", to_bb: 2, ev_bb: 1.5, purpose: "bluff" }]);
        const m = mixPostflop({ analysis: a, state: s2, view: v2, style: "balanced", roll: 100, opponent_types: ["TAG"],
            hero_range: { value: 0.3, strong: 0.1, medium: 0.3, draw: 0.1, air: 0.3 } });
        expect(m.pure).to.equal(true);
        expect(m.pick.action).to.equal("check");
    });
});

describe("RNG mixing: the decision", () => {
    before(() => useBuiltInDefaults());

    it("in a mixed spot the roll decides without asking the AI, and the suggestion is the roll's pick", async function () {
        this.timeout(60000);
        let mixed = 0;
        for (const sc of SCENARIOS.filter((x) => x.id.startsWith("post-")).slice(0, 24)) {
            const { s, v } = spotOf(sc);
            const hero = s.seats.find((p) => p.id === s.hero_id)!;
            const hero_range = rangeProfile(seatModel(s, hero, () => undefined).model, s.board, s.hero_cards);
            for (const roll of [1, 100]) {
                const ai = new CountingAI();
                const d = await decidePostflop(s, v, ai, opponentTendencies(s, () => undefined, () => ({ deviations: [] })), () => ({ deviations: [] }),
                    { llm_timeout_ms: 5000, decision_seconds: 0, mixing: { style: "gto", roll, hero_range, opponent_types: ["TAG"] } });
                expect(d.mix, sc.id).to.not.equal(undefined);
                if (d.source !== "llm") {
                    expect(d.action, sc.id).to.equal(d.mix!.pick.action);
                    expect(d.size_bb, sc.id).to.be.closeTo(d.mix!.pick.size_bb, 0.01);
                }
                const families = new Set(d.mix!.options.map((o) => (o.action === "raise" || o.action === "all-in" ? "bet" : o.action)));
                if (families.size > 1) {
                    mixed++;
                    expect(ai.calls, sc.id).to.equal(0);
                    expect(d.ai_skipped, sc.id).to.equal("mixed");
                }
            }
        }
        expect(mixed).to.be.greaterThan(0);
    });
});

describe("RNG mixing: preflop chart edges", () => {
    // an opening range of the top 20% of hands by strength, everything else folds
    const range = RANKED_CLASSES.slice(0, 40).join(",");
    const tiers: PreflopTier[] = [
        { action: "raise", size_bb: 3, ranges: [range], order: "strength", reason: "open" },
        { action: "fold", size_bb: 0, ranges: [], order: "strength", reason: "fold" }
    ];
    const adviceFor = (cls: string): PreflopAdvice => {
        const inside = RANKED_CLASSES.indexOf(cls) < 40;
        return { action: inside ? "raise" : "fold", size_bb: inside ? 3 : 0, scenario: "test", reason: "test", tiers };
    };
    const raiseShare = (cls: string) => {
        const m = mixPreflop({ advice: adviceFor(cls), cls, style: "balanced", roll: 50, pot_bb: 1.5, opponent_types: ["TAG"] });
        return m.options.filter((o) => o.action === "raise").reduce((s, o) => s + o.freq, 0);
    };

    it("keeps hands deep inside or far outside the range pure", () => {
        expect(raiseShare(RANKED_CLASSES[0])).to.equal(1);
        expect(raiseShare(RANKED_CLASSES[168])).to.equal(0);
    });

    it("mixes the weakest hands in the range and the strongest ones just outside, each at most half the time on the wrong side", () => {
        const last_in = RANKED_CLASSES[39], first_out = RANKED_CLASSES[40];
        expect(raiseShare(last_in)).to.be.within(0.5, 0.99);
        expect(raiseShare(first_out)).to.be.within(0.01, 0.5);
    });

    it("keeps the range's overall frequency about the same (within 1% of all hands)", () => {
        let chart = 0, mixed = 0;
        for (const [i, cls] of RANKED_CLASSES.entries()) {
            const n = comboCount(cls);
            if (i < 40) chart += n;
            mixed += n * raiseShare(cls);
        }
        expect(Math.abs(mixed - chart) / 1326).to.be.below(0.01);
    });

    it("mixes a close priced call with folding, leaning to the better EV", () => {
        const advice: PreflopAdvice = {
            action: "call", size_bb: 0, scenario: "priced", reason: "priced", price: { ev_bb: 0.2, equity: 0.4, realization: 0.8, realized: 0.32, need: 0.3, decided: true },
            tiers: [{ action: "raise", size_bb: 9, ranges: ["AA"], order: "strength", reason: "3-bet for value" }, { action: "call", size_bb: 0, ranges: [], order: "playability", reason: "call" }]
        };
        const m = mixPreflop({ advice, cls: "K5s", style: "balanced", roll: 50, pot_bb: 3.5, opponent_types: ["TAG"] });
        const call = m.options.find((o) => o.action === "call")!.freq;
        const fold = m.options.find((o) => o.action === "fold")!.freq;
        expect(call).to.be.above(fold);
        expect(m.reasons.join(" ")).to.match(/Close price/);
    });

    it("plays advice without chart tiers (facing a 4-bet, the 7-2 bounty) at any roll", () => {
        const m = mixPreflop({ advice: { action: "raise", size_bb: 3, scenario: "7-2 bounty", reason: "bounty" }, cls: "72o", style: "gto", roll: 1, pot_bb: 1.5 });
        expect(m.pure).to.equal(true);
        expect(m.pick.action).to.equal("raise");
    });
});

describe("RNG mixing: hero's range profile", () => {
    it("splits a range into value, medium pairs, draws and air that add up to 1, and places a hand in it", () => {
        const board = ["Ks", "7d", "2c"];
        const model = { range: topRange(30) };
        const top = rangeProfile(model, board, ["Kh", "Qd"]);
        const weak = rangeProfile(model, board, ["5h", "4d"]);
        expect(top.value + top.medium + top.draw + top.air).to.be.closeTo(1, 1e-9);
        expect(top.strong).to.be.at.most(top.value);
        // a king with a queen kicker has less of the range above it than five high
        expect(top.above!).to.be.below(weak.above!);
    });
});

describe("RNG mixing: the panel", () => {
    const { s, v } = flop("Kd, Qc", ["Ks", "7d", "2c"]);
    const inputs = { state: s, view: v, players: () => ({ deviations: [] }), stats: () => undefined };
    const a = analysis([{ action: "check", ev_bb: 1.9 }, { action: "bet", to_bb: 2, ev_bb: 2, purpose: "value" }]);

    it("shows the roll, the mix on 1-100, and the roll's pick as the action", () => {
        const mix = mixPostflop({ analysis: a, state: s, view: v, style: "balanced", roll: 3, opponent_types: ["TAG"] });
        const model = postflopOverlay(inputs, a, { action: mix.pick.action, size_bb: mix.pick.size_bb, reason: "", source: "engine", confidence: 0.6, ai_skipped: "mixed", mix }, "m", 0);
        expect(model.rng!.roll).to.equal(3);
        expect(model.rng!.segments.map((x) => [x.from, x.to])[0][0]).to.equal(1);
        expect(model.rng!.segments[model.rng!.segments.length - 1].to).to.equal(100);
        expect(model.action.verb).to.equal("CHECK");
        expect(model.tone).to.equal("check");
        expect(model.source.detail).to.equal("mixed by the roll");
        expect(model.options.find((o) => o.label === "bet 2 BB")!.mix).to.be.above(0);
        expect(model.reasoning[0]).to.match(/Close spot/);
        const { html } = renderPanel(model);
        expect(html).to.include('class="pgpt-rng-roll-value">3<');
        const widths = [...html.matchAll(/pgpt-rng-seg[^"]*" style="width:(\d+)%/g)].map((m) => Number(m[1]));
        expect(widths.reduce((x, y) => x + y, 0)).to.equal(100);
        expect(html).to.match(/pgpt-rng-marker" style="left:2\.5%/);
    });

    it("escapes option labels on the strip", () => {
        const mix = mixPostflop({ analysis: a, state: s, view: v, style: "balanced", roll: 50, opponent_types: ["TAG"] });
        mix.options[0].label = "<img src=x onerror=alert(1)>";
        const model = preflopOverlay(inputs, { action: "fold", size_bb: 0, scenario: "x", reason: "x" }, null, mix);
        const { html } = renderPanel(model);
        expect(html).to.not.include("<img src=x");
        expect(html).to.include("&lt;img");
    });

    it("says so when the roll picks the chart's neighboring action preflop", () => {
        const range = RANKED_CLASSES.slice(0, 40).join(",");
        const advice: PreflopAdvice = {
            action: "fold", size_bb: 0, scenario: "unopened", reason: "Fold it: outside the range.",
            tiers: [{ action: "raise", size_bb: 3, ranges: [range], order: "strength", reason: "open" }, { action: "fold", size_bb: 0, ranges: [], order: "strength", reason: "fold" }]
        };
        const mix = mixPreflop({ advice, cls: RANKED_CLASSES[40], style: "balanced", roll: 100, pot_bb: 1.5, opponent_types: ["TAG"] });
        expect(mix.pick.action).to.equal("raise");
        const model = preflopOverlay(inputs, advice, null, mix);
        expect(model.action.verb).to.equal("RAISE TO");
        expect(model.tone).to.equal("go");
        expect(model.reasoning[0]).to.match(/^RNG 100/);
        expect(model.reasoning.join(" ")).to.match(/Chart default: Fold it/);
    });
});
