import { expect } from "chai";

import { AIMessage, AIResponse, AIService } from "../../app/interfaces/ai-client-interfaces.ts";
import { heroView, parseHand } from "../../app/engine/hand-parser.ts";
import { analyzePostflop, OpponentTendency } from "../../app/engine/postflop.ts";
import { calibratePriors, RATE_KEYS, RateKey, resetPriors } from "../../app/engine/player-profile.ts";
import { topRange } from "../../app/engine/ranges.ts";
import { aiBudgetMs, aiMode, decidePostflop } from "../../app/helpers/decision-maker.ts";
import { buildDecisionPrompt } from "../../app/helpers/decision-prompt.ts";

class ScriptedAI extends AIService {
    calls = 0;
    constructor(private reply: string, private delay_ms = 0) { super("k", "test/model", "neutral"); }
    init(): void {}
    processMessages(): any[] { return []; }
    async query(_input: string, prev: AIMessage[]): Promise<AIResponse> {
        this.calls++;
        if (this.delay_ms) await new Promise((r) => setTimeout(r, this.delay_ms));
        return { bot_action: { action_str: "", bet_size_in_BBs: 0 }, prev_messages: prev, curr_message: { text_content: this.reply, metadata: { role: "assistant" } } };
    }
}

const p = (name: string, id: string) => `"${name} @ ${id}"`;
function riverSpot(hero_cards: string, bet: number) {
    const s = parseHand([
        `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${p("V", "v")}) --`,
        `Player stacks: #1 ${p("H", "h")} (200) | #2 ${p("V", "v")} (200)`,
        `Your hand is ${hero_cards}`,
        `${p("V", "v")} posts a small blind of 1`,
        `${p("H", "h")} posts a big blind of 2`,
        `${p("V", "v")} calls 2`,
        `${p("H", "h")} checks`,
        `Flop:  [K♠, 7♦, 2♣]`, `${p("H", "h")} checks`, `${p("V", "v")} checks`,
        `Turn: K♠, 7♦, 2♣ [9♥]`, `${p("H", "h")} checks`, `${p("V", "v")} checks`,
        `River: K♠, 7♦, 2♣, 9♥ [3♣]`,
        `${p("H", "h")} checks`,
        `${p("V", "v")} bets ${bet}`
    ], { hero_name: "H" });
    return { s, v: heroView(s)! };
}
const passive: OpponentTendency = { model: { range: topRange(40), aggression: 0.15 }, fold_to_bet: 0.3, fold_to_raise: 0.15 };
const noProfiles = () => ({ deviations: [] });
const CALL = '{"action":"call","size_bb":0,"confidence":0.6,"reason":"x"}';
// second pair facing a small river bet: calling and raising are close, so the AI would be asked
const closeSpot = () => riverSpot("Q♥, 9♣", 3);
// 5-high facing a bet: a clear fold
const clearSpot = () => riverSpot("5♦, 4♣", 10);
// top pair facing a small bet: raising is clearly best, only the raise size is close
const sizingSpot = () => riverSpot("K♦, Q♣", 4);

describe("aiBudgetMs", () => {
    it("fits the AI inside the action clock, leaving time to read and click", () => {
        expect(aiBudgetMs({ llm_timeout_ms: 6000, decision_seconds: 15 })).to.be.within(1, 6000);
        // an old 20 s setting is cut to what a 15 s clock allows
        expect(aiBudgetMs({ llm_timeout_ms: 20000, decision_seconds: 15 })).to.be.at.most(8000);
        expect(aiBudgetMs({ llm_timeout_ms: 6000, decision_seconds: 10 })).to.be.within(2500, 3500);
        expect(aiBudgetMs({ llm_timeout_ms: 6000, decision_seconds: 8 })).to.equal(0);
        // no clock configured: the usual 15 s
        expect(aiBudgetMs({ llm_timeout_ms: 6000 })).to.equal(aiBudgetMs({ llm_timeout_ms: 6000, decision_seconds: 15 }));
        // a game without an action clock: only the limit applies
        expect(aiBudgetMs({ llm_timeout_ms: 20000, decision_seconds: 0 })).to.equal(20000);
    });

    it("takes off time already used this turn", () => {
        expect(aiBudgetMs({ llm_timeout_ms: 6000, decision_seconds: 15, elapsed_ms: 4000 })).to.equal(4000);
        expect(aiBudgetMs({ llm_timeout_ms: 6000, decision_seconds: 15, elapsed_ms: 7000 })).to.equal(0);
    });

    it("is 0 when the AI is off, and keeps honoring the old always_ask_llm", () => {
        expect(aiBudgetMs({ llm_timeout_ms: 6000, decision_seconds: 15, ai_mode: "off" })).to.equal(0);
        expect(aiBudgetMs({ llm_timeout_ms: 6000, decision_seconds: 15, always_ask_llm: true })).to.equal(6000);
        expect(aiMode({ always_ask_llm: true })).to.equal("always");
        expect(aiMode({ ai_mode: "off", always_ask_llm: true })).to.equal("off");
        expect(aiMode({ ai_mode: "Always" })).to.equal("always");
        expect(aiMode({ ai_mode: "close-spots" })).to.equal("close_spots");
        expect(aiMode({})).to.equal("close_spots");
    });
});

describe("decidePostflop timing", () => {
    it("answers a close spot with the engine when the clock is too short for the AI", async () => {
        const { s, v } = closeSpot();
        const ai = new ScriptedAI(CALL);
        let asked = false;
        const d = await decidePostflop(s, v, ai, [passive], noProfiles,
            { llm_timeout_ms: 6000, decision_seconds: 8, on_asking_llm: () => { asked = true; } });
        expect(ai.calls).to.equal(0);
        expect(asked).to.equal(false);
        expect(d.source).to.equal("engine");
        expect(d.ai_skipped).to.equal("time");
        expect(d.ai_budget_ms).to.equal(0);
        expect(d.reason).to.match(/no time left to ask the AI/);
    });

    it("never asks the AI when it's off", async () => {
        const { s, v } = closeSpot();
        const ai = new ScriptedAI(CALL);
        for (const options of [{ llm_timeout_ms: 6000, ai_mode: "off" }, { llm_timeout_ms: 0 }]) {
            const d = await decidePostflop(s, v, ai, [passive], noProfiles, options);
            expect(ai.calls).to.equal(0);
            expect(d.source).to.equal("engine");
            expect(d.ai_skipped).to.equal("off");
            expect(d.reason).to.match(/AI off/);
        }
    });

    it("keeps clear spots plain when the AI would be skipped anyway", async () => {
        const { s, v } = clearSpot();
        const ai = new ScriptedAI(CALL);
        const d = await decidePostflop(s, v, ai, [passive], noProfiles, { llm_timeout_ms: 6000, decision_seconds: 8, ai_mode: "always" });
        expect(ai.calls).to.equal(0);
        expect(d.source).to.equal("engine");
        expect(d.ai_skipped).to.equal(undefined);
    });

    it("doesn't wait for the AI just to pick between bet sizes", async () => {
        const { s, v } = sizingSpot();
        const ai = new ScriptedAI(CALL);
        const d = await decidePostflop(s, v, ai, [passive], noProfiles, { llm_timeout_ms: 6000, decision_seconds: 15 });
        expect(d.analysis.candidates.slice(0, 2).map((c) => c.action)).to.deep.equal(["raise", "raise"]);
        expect(ai.calls).to.equal(0);
        expect(d.source).to.equal("engine");
        expect(d.action).to.equal("raise");
    });

    it("asks the AI before showing the provisional pick, with the budget left on the clock", async () => {
        const { s, v } = closeSpot();
        const ai = new ScriptedAI(CALL);
        const seen: { calls: number, budget: number }[] = [];
        const d = await decidePostflop(s, v, ai, [passive], noProfiles, {
            llm_timeout_ms: 6000, decision_seconds: 15, turn_started_at: Date.now() - 4000,
            on_asking_llm: (_a, budget) => { seen.push({ calls: ai.calls, budget }); throw new Error("overlay failed"); }
        });
        expect(seen).to.have.length(1);
        expect(seen[0].calls).to.equal(1);
        expect(seen[0].budget).to.be.within(3500, 4000);
        // a failing overlay callback doesn't lose the AI's answer
        expect(d.source).to.equal("llm");
        expect(d.ai_budget_ms).to.equal(seen[0].budget);
    });

    it("falls back to the engine when the AI takes longer than its budget", async () => {
        const { s, v } = closeSpot();
        const ai = new ScriptedAI(CALL, 1000);
        const d = await decidePostflop(s, v, ai, [passive], noProfiles, { llm_timeout_ms: 300, decision_seconds: 15 });
        expect(ai.calls).to.equal(1);
        expect(d.source).to.equal("engine-fallback");
        expect(d.reason).to.match(/no answer within 0.3s/);
    });
});

describe("decision prompt", () => {
    afterEach(() => resetPriors());

    it("describes the real table: size, depth, your pool's averages and the table notes", () => {
        // pool averages as measured in your games
        const measured: Partial<Record<RateKey, number>> = { vpip: 0.31, pfr: 0.16, three_bet: 0.09, fold_to_cbet: 0.48, aggression: 0.44, went_to_showdown: 0.28 };
        const pool = Object.fromEntries(RATE_KEYS.map((k) => [k, { k: (measured[k] ?? 0.5) * 1e6, n: 1e6 }])) as Record<RateKey, { k: number, n: number }>;
        calibratePriors(pool);
        const { s, v } = closeSpot();
        const a = analyzePostflop(s, v, [passive]);
        const prompt = buildDecisionPrompt(s, v, a, noProfiles, ["7-2 bounty on: 3 BB from each player", "Antes in play.", "Effective stack 250 BB"]);
        expect(prompt).to.include("No-Limit Hold'em cash game, 2 players dealt");
        expect(prompt).to.match(/Effective stack \d+(\.\d+)? BB, SPR \d/);
        expect(prompt).to.include("Players in your games on average: VPIP 31%, PFR 16%, 3-bet 9%, fold to c-bet 48%, aggression 44%, showdown 28%");
        expect(prompt).to.include("Table: 7-2 bounty on: 3 BB from each player; Antes in play.");
        expect(prompt).to.include("no history (assume the averages above)");
        expect(prompt).to.include("Legal actions:");
        expect(prompt).to.not.match(/full ring|passive/i);
        expect(prompt).to.not.match(/[–—]/);
        expect(prompt).to.not.include("You hold 7-2");
    });

    it("leaves out the table line without notes, and points out a 7-2 when the bounty is on", () => {
        const { s, v } = riverSpot("7♥, 2♦", 4);
        const a = analyzePostflop(s, v, [passive]);
        expect(buildDecisionPrompt(s, v, a, noProfiles)).to.not.include("Table:");
        expect(buildDecisionPrompt(s, v, a, noProfiles, ["7-2 bounty on: 3 BB from each player"])).to.include("You hold 7-2");
    });
});
