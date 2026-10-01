import { expect } from "chai";

import { heroView, parseHand } from "../../app/engine/hand-parser.ts";
import { preflopAdvice } from "../../app/engine/preflop.ts";
import { preflopEv } from "../../app/engine/preflop-ev.ts";
import { calibratePreflopResponses, defaultPreflopTable, preflopAnswers, resetPreflopResponseTable } from "../../app/engine/preflop-responses.ts";
import default_config from "../../app/configs/preflop-ranges.json" with { type: "json" };
import { classOf } from "../../app/engine/hand-classes.ts";

const p = (name: string) => `"${name} @ ${name.toLowerCase()}"`;
const SEATS = ["UTG", "MP", "CO", "BU", "SB", "BB"];
/** Six-handed hand (big blind 2, stacks 200) with hero `hero` holding `cards`, then `lines` of preflop actions. */
const hand = (hero: string, cards: string, lines: string[], shown: string[] = []) => {
    const s = parseHand([
        `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${p("BU")}) --`,
        `Player stacks: ${SEATS.map((x, i) => `#${i + 1} ${p(x)} (200)`).join(" | ")}`,
        `Your hand is ${cards}`,
        `${p("SB")} posts a small blind of 1`, `${p("BB")} posts a big blind of 2`,
        ...lines, ...shown
    ], { hero_name: hero });
    return { s, v: heroView(s)! };
};

describe("preflop response table", () => {
    it("reads who answered which raise, and how", () => {
        const { s } = hand("UTG", "A♠, K♦", [`${p("UTG")} raises to 6`, `${p("MP")} folds`, `${p("CO")} calls 6`, `${p("BU")} raises to 24`,
            `${p("SB")} folds`, `${p("BB")} folds`, `${p("UTG")} calls 24`, `${p("CO")} folds`]);
        const answers = preflopAnswers(s).map((a) => `${a.responder.name}:${a.situation}:${a.answer}`);
        expect(answers).to.include.members(["MP:open:fold", "CO:open:call", "SB:cold3bet:fold", "BB:cold3bet:fold",
            "UTG:threebet:call", "CO:cold3bet:fold", "BU:squeeze:raise"]);
    });

    it("blends measured answers with the defaults by sample size", () => {
        const folds = Array.from({ length: 200 }, () => hand("UTG", "A♠, K♦", [`${p("UTG")} raises to 6`, `${p("MP")} folds`, `${p("CO")} folds`, `${p("BU")} folds`, `${p("SB")} folds`, `${p("BB")} folds`]).s);
        const { table, samples } = calibratePreflopResponses(folds);
        expect(samples).to.equal(1000);
        expect(table.open.field.medium.fold).to.be.greaterThan(defaultPreflopTable().open.field.medium.fold);
        expect(table.open.field.medium.n).to.equal(600);
        const r = table.open.blinds.medium;
        expect(r.fold + r.call + r.raise).to.be.closeTo(1, 1e-9);
    });
});

describe("preflop EV pricing", () => {
    before(() => resetPreflopResponseTable());

    it("charges the call: 7-2 offsuit in the big blind loses against a big open, aces win", () => {
        const spot = (cards: string) => hand("BB", cards, [`${p("UTG")} raises to 10`, `${p("MP")} folds`, `${p("CO")} folds`, `${p("BU")} folds`, `${p("SB")} folds`]);
        const weak = spot("7♣, 2♦"), strong = spot("A♠, A♦");
        const ev = (x: ReturnType<typeof spot>) => preflopEv(x.s, x.v, classOf(x.s.hero_cards), () => undefined, default_config, 30, () => undefined, 200)!;
        const call = (r: ReturnType<typeof ev>) => r.options.find((o) => o.action === "call")!;
        expect(call(ev(weak)).ev_bb).to.be.lessThan(0);
        expect(call(ev(strong)).ev_bb).to.be.greaterThan(0);
        const raise = ev(strong).options.find((o) => o.action === "raise")!;
        expect(raise.ev_bb).to.be.greaterThan(call(ev(weak)).ev_bb);
        expect(ev(strong).options.map((o) => o.action)).to.deep.equal(["fold", "call", "raise"]);
    });

    it("prices the chart's play and keeps it unless another play is clearly better", () => {
        const { s, v } = hand("BU", "A♠, K♦", [`${p("UTG")} folds`, `${p("MP")} folds`, `${p("CO")} folds`]);
        const advice = preflopAdvice(s, v, () => undefined, undefined, { ev: { time_budget_ms: 200 } })!;
        expect(advice.action).to.equal("raise");
        expect(advice.ev).to.not.equal(undefined);
        expect(advice.ev!.overruled).to.equal(false);
        expect(advice.ev!.options.some((o) => o.action === "raise" && o.ev_bb > 0)).to.equal(true);
        // without the EV context, the chart alone
        expect(preflopAdvice(s, v, () => undefined)!.ev).to.equal(undefined);
    });
});
