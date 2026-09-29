import { expect } from "chai";

import { AIMessage, AIResponse, AIService } from "../../app/interfaces/ai-client-interfaces.ts";
import { heroView, parseHand } from "../../app/engine/hand-parser.ts";
import { analyzePostflop, OpponentTendency } from "../../app/engine/postflop.ts";
import { topRange } from "../../app/engine/ranges.ts";
import { decidePostflop } from "../../app/helpers/decision-maker.ts";
import { parseDecision } from "../../app/helpers/decision-prompt.ts";

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
function riverSpot(hero_cards: string, villain_line: string[]) {
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
        ...villain_line
    ], { hero_name: "H" });
    return { s, v: heroView(s)! };
}
const passive: OpponentTendency = { model: { range: topRange(40), aggression: 0.15 }, fold_to_bet: 0.3, fold_to_raise: 0.15 };
const noProfiles = () => undefined;

describe("parseDecision", () => {
    it("reads JSON, including inside code fences", () => {
        expect(parseDecision('```json\n{"action":"raise","size_bb":12,"confidence":0.7,"reason":"x"}\n```')).to.deep.include({ action: "raise", size_bb: 12, confidence: 0.7 });
        expect(parseDecision('{"action":"All In","size_bb":0}')!.action).to.equal("all-in");
        expect(parseDecision("I would call here")).to.equal(null);
        expect(parseDecision('{"action":"dance"}')).to.equal(null);
    });
});

describe("analyzePostflop", () => {
    it("prefers calling a river bet with a strong hand and folding air", () => {
        const bet = [`${p("V", "v")} bets 10`];
        const strong = riverSpot("K♦, K♣", bet);       // set of kings
        expect(analyzePostflop(strong.s, strong.v, [passive]).candidates[0].action).to.not.equal("fold");
        const air = riverSpot("5♦, 4♣", bet);          // 5-high
        expect(analyzePostflop(air.s, air.v, [passive]).candidates[0].action).to.equal("fold");
    });
});

describe("decidePostflop", () => {
    const options = { llm_timeout_ms: 300 };

    it("answers clear spots with the engine and doesn't call the AI", async () => {
        const { s, v } = riverSpot("5♦, 4♣", [`${p("V", "v")} bets 10`]);
        const ai = new ScriptedAI('{"action":"call","size_bb":0,"confidence":0.9,"reason":"x"}');
        const d = await decidePostflop(s, v, ai, [passive], noProfiles, options);
        expect(d.source).to.equal("engine");
        expect(d.action).to.equal("fold");
        expect(ai.calls).to.equal(0);
    });

    it("uses a legal AI answer in close spots", async () => {
        const { s, v } = riverSpot("K♦, Q♣", [`${p("V", "v")} bets 4`]);
        const ai = new ScriptedAI('{"action":"call","size_bb":0,"confidence":0.6,"reason":"Top pair is ahead of a passive bettor."}');
        const d = await decidePostflop(s, v, ai, [passive], noProfiles, { ...options, always_ask_llm: true });
        expect(d.source).to.equal("llm");
        expect(d.action).to.equal("call");
        expect(d.prompt).to.include("Legal actions:");
        expect(ai.calls).to.equal(1);
    });

    it("falls back to the engine when the AI answer is illegal, garbled or late", async () => {
        const { s, v } = riverSpot("K♦, Q♣", [`${p("V", "v")} bets 4`]);
        const cases: [ScriptedAI, RegExp][] = [
            [new ScriptedAI('{"action":"check","size_bb":0}'), /illegal/],
            [new ScriptedAI("just call"), /valid JSON/],
            [new ScriptedAI('{"action":"call"}', 1000), /no answer within/]
        ];
        for (const [ai, why] of cases) {
            const d = await decidePostflop(s, v, ai, [passive], noProfiles, { ...options, always_ask_llm: true });
            expect(d.source).to.equal("engine-fallback");
            expect(d.reason).to.match(why);
        }
    });
});
