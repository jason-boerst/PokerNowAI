import { expect } from "chai";

import { heroView, parseHand } from "../../app/engine/hand-parser.ts";
import { analyzePostflop } from "../../app/engine/postflop.ts";
import { preflopAdvice } from "../../app/engine/preflop.ts";
import { topRange } from "../../app/engine/ranges.ts";
import { basicPanel, postflopOverlay, preflopOverlay, sentences, withWarning } from "../../app/helpers/overlay-builder.ts";
import { ProfileBuilder } from "../../app/engine/player-profile.ts";
import type { PanelModel } from "../../app/ui/panel-model.ts";

const p = (name: string, id: string) => `"${name} @ ${id}"`;
const header = (dealer: string) => `-- starting hand #12 (id: t)  No Limit Texas Hold'em (dealer: ${p(dealer, dealer.toLowerCase())}) --`;
const H = p("H", "h"), V = p("V", "v");
/** Hero (BB) checked the flop and V bet: hero faces a bet. */
const flopSpot = () => {
    const s = parseHand([
        header("V"), `Player stacks: #1 ${H} (200) | #2 ${V} (200)`, `Your hand is A♥, 5♥`,
        `${V} posts a small blind of 1`, `${H} posts a big blind of 2`, `${V} calls 2`, `${H} checks`,
        `Flop:  [K♥, 9♥, 2♣]`, `${H} checks`, `${V} bets 3`
    ], { hero_name: "H" });
    return { s, v: heroView(s)! };
};
/** Hero (BB) first to act on the flop with top set: nothing to call. */
const checkedSpot = (cards = "K♠, K♦") => {
    const s = parseHand([
        header("V"), `Player stacks: #1 ${H} (200) | #2 ${V} (200)`, `Your hand is ${cards}`,
        `${V} posts a small blind of 1`, `${H} posts a big blind of 2`, `${V} calls 2`, `${H} checks`,
        `Flop:  [K♥, 9♥, 2♣]`
    ], { hero_name: "H" });
    return { s, v: heroView(s)! };
};
const tendency = [{ model: { range: topRange(40) }, fold_to_bet: 0.4, fold_to_raise: 0.25 }];
const noProfile = () => ({ deviations: [] });
const noStats = () => undefined;
const llm = (action: string, size_bb = 0, reason = "Good price with a strong draw.") => ({ action, size_bb, reason, source: "llm", confidence: 0.7 });
const DASHES = /[—–]/;
/** Every piece of text in the model, for the dash check. */
const allText = (m: PanelModel) => JSON.stringify(m);

describe("overlay content (panel model)", () => {
    it("fills the spot, hand with draws and outs, odds, options and opponents after the flop", () => {
        const { s, v } = flopSpot();
        const a = analyzePostflop(s, v, tendency);
        const m = postflopOverlay({ state: s, view: v, players: noProfile, stats: noStats }, a, llm("call"), "test/model", 20000);
        expect(m.status).to.equal("final");
        expect(m.context).to.equal(`Hand #12 · Flop · you: BB (${a.in_position ? "in" : "out of"} position)`);
        expect(m.spot.to_call_bb).to.equal(1.5);
        expect(m.spot.pot_bb).to.equal(3.5);
        expect(m.spot.spr_label).to.equal("SPR");
        expect(m.spot.min_raise_bb).to.be.a("number");
        expect(m.spot.in_position).to.equal(a.in_position);
        expect(m.hand.cards).to.deep.equal(s.hero_cards);
        expect(m.hand.board).to.deep.equal(s.board);
        expect(m.hand.draws).to.include("Nut flush draw: 9 outs");
        expect(m.odds.equity).to.equal(a.equity);
        expect(m.odds.need).to.equal(a.required_equity);
        expect(m.odds.equity_when_called).to.equal(a.equity_when_called);
        expect(m.options).to.have.length(a.candidates.length);
        expect(m.options.filter((o) => o.chosen).map((o) => o.label)).to.deep.equal(["call 1.5 BB"]);
        expect(m.source).to.deep.equal({ label: "AI (test/model)", detail: "70% confident" });
        expect(m.opponents).to.have.length(1);
        expect(m.opponents[0].name).to.equal("V");
        expect(m.more_opponents).to.equal(0);
        expect(m.warnings.join(" ")).to.include("population defaults");
        // a call shows the amount to call
        expect(m.action).to.deep.equal({ verb: "CALL", size_bb: 1.5, chips: 3 });
    });

    it("colors the panel by the action: red fold, yellow check, green call, bet, raise and all-in", () => {
        const facing = flopSpot();
        const fa = analyzePostflop(facing.s, facing.v, tendency);
        const fi = { state: facing.s, view: facing.v, players: noProfile, stats: noStats };
        const checked = checkedSpot();
        const ca = analyzePostflop(checked.s, checked.v, tendency);
        const ci = { state: checked.s, view: checked.v, players: noProfile, stats: noStats };
        const cases: [PanelModel, string, string][] = [
            [postflopOverlay(fi, fa, llm("fold"), "m", 0), "fold", "FOLD"],
            [postflopOverlay(ci, ca, llm("check"), "m", 0), "check", "CHECK"],
            [postflopOverlay(fi, fa, llm("call"), "m", 0), "go", "CALL"],
            [postflopOverlay(ci, ca, llm("bet", 4), "m", 0), "go", "BET"],
            [postflopOverlay(fi, fa, llm("raise", 9), "m", 0), "go", "RAISE TO"],
            [postflopOverlay(fi, fa, llm("all-in", 0), "m", 0), "go", "ALL-IN"]
        ];
        for (const [m, tone, verb] of cases) {
            expect(m.tone, verb).to.equal(tone);
            expect(m.action.verb).to.equal(verb);
            expect(m.reasoning.length, verb).to.be.within(1, 5);
            expect(allText(m)).to.not.match(DASHES);
        }
        // sizes: chips follow the big blind, and bets and raises show their share of the pot
        const bet = cases[3][0].action;
        expect(bet).to.include({ size_bb: 4, chips: 8 });
        expect(bet.pot_share).to.be.closeTo(8 / checked.v.pot, 0.01);
        const raise = cases[4][0].action;
        expect(raise).to.include({ size_bb: 9, chips: 18 });
        expect(raise.pot_share).to.be.closeTo(18 / facing.v.pot, 0.01);
        // all-in without a size: hero's whole stack
        expect(cases[5][0].action.size_bb).to.equal(facing.v.max_raise_to / 2);
        // ...and it marks only an all-in option, never a smaller bet
        const all_in_option = fa.candidates.find((c) => c.action === "all-in");
        expect(cases[5][0].options.filter((o) => o.chosen).map((o) => o.label)).to.deep.equal(all_in_option ? [all_in_option.label] : []);
        const deep = analyzePostflop(facing.s, facing.v, tendency);
        const no_all_in = { ...deep, candidates: deep.candidates.filter((c) => c.action !== "all-in") };
        const shove = postflopOverlay(fi, no_all_in, llm("all-in", 0), "m", 0);
        expect(shove.options.some((o) => o.chosen)).to.equal(false);
        expect(shove.tag).to.equal(undefined);
        expect(cases[0][0].action.size_bb).to.equal(undefined);
        expect(cases[1][0].action.chips).to.equal(undefined);
    });

    it("always has reasoning: the AI's reason split into sentences, else the engine's numbers", () => {
        const { s, v } = flopSpot();
        const a = analyzePostflop(s, v, tendency);
        const inputs = { state: s, view: v, players: noProfile, stats: noStats };
        const ai = postflopOverlay(inputs, a, llm("call", 0, "Nut flush draw with 9 outs — good odds. Calling keeps their bluffs in. Calling keeps their bluffs in."), "m", 0);
        expect(ai.reasoning).to.deep.equal(["Nut flush draw with 9 outs, good odds.", "Calling keeps their bluffs in."]);
        // an AI answer without a reason falls back to the engine's numbers
        const empty = postflopOverlay(inputs, a, llm("call", 0, ""), "m", 0);
        expect(empty.reasoning.length).to.be.greaterThan(0);
        expect(empty.reasoning.join(" ")).to.match(/equity/);
        // engine: equity against the price and the EV comparison
        const top = a.candidates[0];
        const engine = postflopOverlay(inputs, a, { action: top.action, size_bb: top.to / 2, reason: "x", source: "engine", confidence: 0.8 }, "m", 0);
        expect(engine.reasoning.length).to.be.within(1, 5);
        expect(engine.reasoning.join(" ")).to.include("is worth about");
        if (!top.purpose) expect(engine.reasoning.join(" ")).to.include(`need ${Math.round(a.required_equity * 100)}% to call`);
        expect(new Set(engine.reasoning).size).to.equal(engine.reasoning.length);
    });

    it("thinking: the engine's pick with the AI's time budget for a countdown", () => {
        const { s, v } = flopSpot();
        const a = analyzePostflop(s, v, tendency);
        const before = Date.now();
        const m = postflopOverlay({ state: s, view: v, players: noProfile, stats: noStats }, a, null, "test/model", 6000);
        expect(m.status).to.equal("thinking");
        expect(m.source).to.deep.equal({ label: "Engine pick", detail: "asking test/model (up to 6s)" });
        expect(m.thinking?.model).to.equal("test/model");
        expect(m.thinking?.budget_ms).to.equal(6000);
        expect(m.thinking?.started_at).to.be.within(before, Date.now());
        expect(m.tone).to.equal(a.candidates[0].action === "fold" ? "fold" : "go");
        expect(m.reasoning.length).to.be.greaterThan(0);
        expect(m.options.filter((o) => o.chosen)).to.have.length(1);
        const final = postflopOverlay({ state: s, view: v, players: noProfile, stats: noStats }, a, llm("call"), "m", 6000);
        expect(final.thinking).to.equal(undefined);
    });

    it("says who decided: clear spot, close spot without the AI, and a fallback with its reason", () => {
        const { s, v } = flopSpot();
        const a = analyzePostflop(s, v, tendency);
        const inputs = { state: s, view: v, players: noProfile, stats: noStats };
        const engine = { action: "call", size_bb: 0, reason: "Close spot, no time left to ask the AI. Equity 40%.", source: "engine", confidence: 0.6 };
        expect(postflopOverlay(inputs, a, { ...engine, ai_skipped: "time" }, "m", 0).source).to.deep.equal({ label: "Engine", detail: "close spot, no time for AI" });
        expect(postflopOverlay(inputs, a, { ...engine, ai_skipped: "off" }, "m", 0).source).to.deep.equal({ label: "Engine", detail: "close spot, AI off" });
        expect(postflopOverlay(inputs, a, engine, "m", 0).source).to.deep.equal({ label: "Engine", detail: "clear spot" });
        const fallback = postflopOverlay(inputs, a,
            { ...engine, reason: "AI unavailable (no answer within 6s). Equity 40%.", source: "engine-fallback", confidence: 0.5 }, "m", 0);
        expect(fallback.source).to.deep.equal({ label: "Engine", detail: "AI fallback" });
        expect(fallback.warnings[0]).to.equal("AI unavailable (no answer within 6s).");
    });

    it("warns when the AI disagrees with the engine's top option", () => {
        const { s, v } = checkedSpot();
        const a = analyzePostflop(s, v, tendency);
        const inputs = { state: s, view: v, players: noProfile, stats: noStats };
        const top = a.candidates[0];
        const other = top.action === "check" ? llm("bet", 4) : llm("check");
        const m = postflopOverlay(inputs, a, other, "m", 0);
        expect(m.warnings).to.include(`The AI disagrees with the engine's top option (${top.label}).`);
        const same = postflopOverlay(inputs, a, llm(top.action, top.to / 2), "m", 0);
        expect(same.warnings.join(" ")).to.not.include("disagrees");
    });

    it("tags bets and raises with their purpose, colored by kind", () => {
        const { s, v } = checkedSpot();
        const a = analyzePostflop(s, v, tendency);
        const inputs = { state: s, view: v, players: noProfile, stats: noStats };
        const bets = a.candidates.filter((c) => c.purpose);
        expect(bets.length).to.be.greaterThan(0);
        const names = { value: "Value bet", "semi-bluff": "Semi-bluff", bluff: "Bluff" };
        for (const c of bets) {
            const m = postflopOverlay(inputs, a, llm(c.action, c.to / 2), "m", 0);
            expect(m.tag?.kind).to.equal(c.purpose);
            expect(m.tag?.text.startsWith(names[c.purpose!])).to.equal(true);
            expect(m.options.filter((o) => o.chosen).map((o) => o.label)).to.deep.equal([c.label]);
            expect(m.options.find((o) => o.label === c.label)?.kind).to.match(/^(value|semi-bluff|bluff), /);
        }
        // top set bets for value; the engine's reasoning explains the bet
        const value = bets.find((c) => c.purpose === "value")!;
        const engine = postflopOverlay(inputs, a, { action: value.action, size_bb: value.to / 2, reason: "", source: "engine", confidence: 0.8 }, "m", 0);
        expect(engine.tag?.kind).to.equal("value");
        expect(engine.reasoning[0]).to.include("equity when called");
        // no tag on a plain check or call
        expect(postflopOverlay(inputs, a, llm("check"), "m", 0).tag).to.equal(undefined);
    });

    it("a check or call picked over a marginal bluff gets a neutral tag and the note as its main reason", () => {
        const { s, v } = checkedSpot("7♣, 3♦");
        const a = analyzePostflop(s, v, tendency);
        const inputs = { state: s, view: v, players: noProfile, stats: noStats };
        const note = "A bluff (bet 2.3 BB) would beat check by only 0.1 BB, within the margin of error of the fold estimate, so check.";
        const marginal = { ...a, note, candidates: [a.candidates.find((c) => c.action === "check")!, ...a.candidates.filter((c) => c.action !== "check")] };
        const m = postflopOverlay(inputs, marginal, { action: "check", size_bb: 0, reason: "", source: "engine", confidence: 0.8 }, "m", 0);
        expect(m.tag).to.deep.equal({ text: "Check: a bluff here is too close to call", kind: "neutral" });
        expect(m.reasoning[0]).to.equal(note);
        expect(m.tone).to.equal("check");
    });

    it("shows the table notes without the effective stack note", () => {
        const { s, v } = flopSpot();
        const a = analyzePostflop(s, v, tendency);
        const notes = ["7-2 bounty on: 3 BB from each player", "Antes in play", "Effective stack 250 BB"];
        const m = postflopOverlay({ state: s, view: v, players: noProfile, stats: noStats, notes }, a, null, "test/model", 6000);
        expect(m.spot.notes).to.deep.equal(["7-2 bounty on: 3 BB from each player", "Antes in play"]);
        const none = postflopOverlay({ state: s, view: v, players: noProfile, stats: noStats }, a, null, "test/model", 6000);
        expect(none.spot.notes).to.deep.equal([]);
    });

    it("opponent cards come from the player's profile", () => {
        const { s, v } = flopSpot();
        const b = new ProfileBuilder();
        for (let i = 0; i < 25; i++) b.addHand(parseHand([
            `-- starting hand #${i} (id: x)  No Limit Texas Hold'em (dealer: ${V}) --`,
            `Player stacks: #1 ${H} (200) | #2 ${V} (200)`,
            `${V} posts a small blind of 1`, `${H} posts a big blind of 2`, `${V} calls 2`, `${H} checks`
        ]));
        const a = analyzePostflop(s, v, tendency);
        const m = postflopOverlay({ state: s, view: v, players: (ref) => ({ current: b.profile(ref.id), deviations: [] }), stats: noStats }, a,
            { action: "call", size_bb: 0, reason: "", source: "engine", confidence: 0.8 }, "m", 20000);
        expect(m.opponents[0].low_sample).to.equal(false);
        expect(m.opponents[0].stats.length).to.be.greaterThan(0);
        expect(m.warnings.join(" ")).to.not.include("population defaults");
    });

    it("preflop: chart spot, equity, hand name and the flop SPR label", () => {
        const s = parseHand([
            `-- starting hand #3 (id: t)  No Limit Texas Hold'em (dealer: ${H}) --`,
            `Player stacks: #1 ${H} (40) | #2 ${V} (40)`,
            `Your hand is K♠, 6♦`,
            `${H} posts a small blind of 0.10`, `${V} posts a big blind of 0.20`
        ], { hero_name: "H" });
        const v = heroView(s)!;
        const advice = preflopAdvice(s, v, noStats)!;
        const m = preflopOverlay({ state: s, view: v, players: noProfile, stats: noStats }, advice, { equity: 0.52, need: 0 });
        expect(m.source).to.deep.equal({ label: "Preflop chart" });
        expect(m.status).to.equal("final");
        expect(m.tone).to.equal("go");
        expect(m.action.verb).to.equal("RAISE TO");
        expect(m.action.size_bb).to.equal(advice.size_bb);
        expect(m.action.chips).to.equal(Math.round(advice.size_bb * 0.2 * 100) / 100);
        expect(m.hand.made).to.equal("K6o (offsuit)");
        expect(m.odds).to.deep.equal({ chart_spot: "heads-up, small blind (button) first in", equity: 0.52 });
        expect(m.spot.spr_label).to.equal("flop SPR if you call");
        expect(m.reasoning.length).to.be.greaterThan(0);
        expect(m.reasoning[0]).to.equal(sentences(advice.reason)[0]);
        expect(m.context).to.equal("Hand #3 · Preflop · you: SB");
        const with_notes = preflopOverlay({ state: s, view: v, players: noProfile, stats: noStats, notes: ["Straddle 2 BB"] }, advice, null);
        expect(with_notes.spot.notes).to.deep.equal(["Straddle 2 BB"]);
        expect(with_notes.odds.equity).to.equal(undefined);
        // facing a raise the equity needed to call is shown
        const needed = preflopOverlay({ state: s, view: v, players: noProfile, stats: noStats }, advice, { equity: 0.4, need: 0.33 });
        expect(needed.odds.need).to.equal(0.33);
        expect(allText(m)).to.not.match(DASHES);
    });

    it("basic prompt panel: says why there's no engine, for another game or a missing hand state", () => {
        const omaha = basicPanel({ action: "raise", size_bb: 6, big_blind: 0.5, model_name: "m", reason: "Strong wrap. Raise for value.", other_game: "Pot Limit Omaha Hi" });
        expect(omaha.source).to.deep.equal({ label: "AI (m)", detail: "basic prompt (Pot Limit Omaha Hi: no engine)" });
        expect(omaha.warnings[0]).to.include("This hand is Pot Limit Omaha Hi. The equity engine, preflop charts and opponent stats are Hold'em only");
        expect(omaha.tone).to.equal("go");
        expect(omaha.action).to.deep.equal({ verb: "RAISE TO", size_bb: 6, chips: 3 });
        expect(omaha.reasoning).to.deep.equal(["Strong wrap.", "Raise for value."]);
        const missing = basicPanel({ action: "fold", size_bb: 0, big_blind: 2, model_name: "m", reason: "", other_game: null, state_warning: "The game log may be behind the table." });
        expect(missing.source.detail).to.equal("basic prompt (full hand state unavailable)");
        expect(missing.warnings).to.deep.equal(["The game log may be behind the table.", "The full hand history couldn't be read, so this used the basic prompt without the engine."]);
        expect(missing.tone).to.equal("fold");
        expect(missing.action).to.deep.equal({ verb: "FOLD" });
        expect(missing.reasoning.length).to.equal(1);
        expect(basicPanel({ action: "check", size_bb: 0, big_blind: 2, model_name: "m", reason: "Free card.", other_game: null }).tone).to.equal("check");
    });

    it("withWarning puts a warning first once", () => {
        const m = basicPanel({ action: "call", size_bb: 2, big_blind: 1, model_name: "m", reason: "Price.", other_game: null });
        const w = withWarning(withWarning(m, "Check the pot yourself."), "Check the pot yourself.");
        expect(w.warnings[0]).to.equal("Check the pot yourself.");
        expect(w.warnings.filter((x) => x === "Check the pot yourself.")).to.have.length(1);
        expect(m.warnings).to.have.length(1);
    });
});
