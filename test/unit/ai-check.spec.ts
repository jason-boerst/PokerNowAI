import { expect } from "chai";
import { readFileSync } from "node:fs";

import { aiCheck, AiCheckRow, chosenCandidate, engineEvs, MIN_AI_DECISIONS, runAiCheck } from "../../app/eval/ai-check.ts";
import { readLogRows, splitHands } from "../../app/import/pokernow-csv.ts";
import type { PostflopAnalysis } from "../../app/engine/postflop.ts";
import { DBService } from "../../app/services/db-service.ts";
import { HandRecorder } from "../../app/services/hand-recorder.ts";

const FIXTURE = readFileSync(new URL("../fixtures/poker_now_log_fixtureGame01.csv", import.meta.url), "utf8");
const hand = (n: number) => splitHands(readLogRows(FIXTURE)).hands.find((h) => h.hand_number === n)!.messages;
const before = (messages: string[], text: string, nth = 0) => messages.slice(0, messages.map((m, i) => [m, i] as const).filter(([m]) => m.includes(text))[nth][1]);

// an analysis with the options the engine would list (chips; big blind 2)
const analysis = {
    candidates: [
        { action: "bet", to: 10, ev: 6, risk: 1, label: "bet 50%" },
        { action: "check", to: 0, ev: 4, label: "check" },
        { action: "bet", to: 20, ev: 3, risk: 2, label: "bet 100%" }
    ]
} as unknown as PostflopAnalysis;

const AI_PROMPT = "You are advising in a live No-Limit Hold'em cash game";
/** n decisions of one source, each in its own hand with a result. */
const rows = (n: number, source: "llm" | "engine", lost: (i: number) => number, result: (i: number) => number, offset = 0): AiCheckRow[] =>
    Array.from({ length: n }, (_, i) => ({
        game_id: "g", hand_number: offset + i, street: "flop", source, model: source === "llm" ? "some/model" : "postflop-engine",
        prompt: source === "llm" ? AI_PROMPT : "", action_json: "{}", followed: 1, hand_net_bb: result(i), adjusted_net_bb: result(i),
        engine_top: "bet 50%", engine_top_ev: 2, chosen_ev: 2 - lost(i), close_spot: 1
    }));

describe("AI vs engine check", () => {
    it("matches a suggestion to the engine's option by action and nearest size (within 25%)", () => {
        expect(chosenCandidate(analysis, "check", 0, 2)!.label).to.equal("check");
        expect(chosenCandidate(analysis, "bet", 5.5, 2)!.label).to.equal("bet 50%");
        expect(chosenCandidate(analysis, "raise", 9, 2)!.label).to.equal("bet 100%");
        expect(chosenCandidate(analysis, "bet", 7.5, 2)).to.equal(undefined);
        expect(chosenCandidate(analysis, "fold", 0, 2)).to.equal(undefined);
    });

    it("records the top option's and the chosen option's EV after risk, in big blinds", () => {
        expect(engineEvs(analysis, "check", 0, 2, true)).to.deep.equal({ engine_top: "bet 50%", engine_top_ev: 2.5, chosen_ev: 2, close_spot: 1 });
        expect(engineEvs(analysis, "bet", 7.5, 2, false)!.chosen_ev).to.equal(null);
    });

    it("waits for enough AI decisions before deciding", () => {
        const c = aiCheck([...rows(MIN_AI_DECISIONS - 1, "llm", () => 0.5, () => 0), ...rows(100, "engine", () => 0, () => 0, 1000)]);
        expect(c.verdict).to.equal("not_enough");
    });

    it("turns the AI off when it gives up EV and shows no result edge", () => {
        const noisy = (i: number) => (i % 2 ? 10 : -10);
        const c = aiCheck([...rows(250, "llm", (i) => (i % 3 === 0 ? 1 : 0), noisy), ...rows(250, "engine", () => 0, noisy, 1000)]);
        expect(c.ai.measured).to.equal(250);
        expect(c.ai.departures).to.equal(84);
        expect(c.ai.ev_lost.low).to.be.greaterThan(0);
        expect(c.verdict).to.equal("ai_worse");
    });

    it("keeps the AI when following it clearly did better", () => {
        const c = aiCheck([...rows(250, "llm", () => 0.3, (i) => 5 + (i % 2)), ...rows(250, "engine", () => 0, (i) => -5 - (i % 2), 1000)]);
        expect(c.result_edge.low).to.be.greaterThan(0);
        expect(c.verdict).to.equal("ai_better");
    });

    it("leaves out preflop and engine decisions in clear spots", () => {
        const clear = rows(10, "engine", () => 0, () => 0, 1000).map((r) => ({ ...r, close_spot: 0 }));
        const pre = rows(10, "llm", () => 1, () => 0, 2000).map((r) => ({ ...r, street: "preflop" }));
        const c = aiCheck([...clear, ...pre]);
        expect(c.ai.decisions).to.equal(0);
        expect(c.engine.decisions).to.equal(0);
    });

    describe("stored decisions", () => {
        let db: DBService;
        let recorder: HandRecorder;
        beforeEach(async () => {
            db = new DBService(":memory:");
            await db.init();
            await db.createTables();
            recorder = new HandRecorder(db);
        });
        afterEach(async () => { await db.close(); });

        it("stores the engine's view with each decision, and fills it in once for older ones", async () => {
            const h2 = hand(2);
            const base = { game_id: "live", hand_number: 2, hero_name: "Hero", hero_cards: [], big_blind: 1, prompt: AI_PROMPT, response: "", model: "some/model", source: "llm", latency_ms: 5 };
            await recorder.recordDecision({ ...base, street: "flop", messages: before(h2, '"Hero @ HeroId0001" checks'), action: { action_str: "check", bet_size_in_BBs: 0 },
                engine: { engine_top: "check", engine_top_ev: 1.5, chosen_ev: 1.5, close_spot: 1 } });
            // recorded by an older version: no engine view
            await recorder.recordDecision({ ...base, street: "turn", messages: before(h2, '"Hero @ HeroId0001" checks', 1), action: { action_str: "check", bet_size_in_BBs: 0 } });
            let stored = await recorder.decisions();
            expect(stored[0]).to.include({ engine_top: "check", engine_top_ev: 1.5, chosen_ev: 1.5, close_spot: 1 });
            expect(stored[1].engine_top).to.equal(null);

            const writes: number[] = [];
            const src = { decisions: () => recorder.decisions(), matchPendingDecisions: () => recorder.matchPendingDecisions(),
                setEngineEvs: async (id: number, evs: Parameters<HandRecorder["setEngineEvs"]>[1]) => { writes.push(id); await recorder.setEngineEvs(id, evs); } };
            const check = await runAiCheck(src, () => undefined, () => ({ deviations: [] }), 20);
            expect(writes).to.deep.equal([stored[1].id]);
            stored = await recorder.decisions();
            expect(stored[1].engine_top).to.be.a("string").and.not.equal("");
            expect(stored[1].engine_top_ev).to.be.a("number");
            expect(stored[1].chosen_ev).to.be.a("number");
            expect(check.ai.decisions).to.equal(2);
            // a second run has nothing left to fill in
            writes.length = 0;
            await runAiCheck(src, () => undefined, () => ({ deviations: [] }), 20);
            expect(writes).to.deep.equal([]);
        });
    });
});
