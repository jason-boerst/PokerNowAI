import { expect } from "chai";

import { appendUserInput, parseResponse } from "../../app/helpers/ai-query-helper.ts";
import { AIServiceFactory, resolveAIConfig } from "../../app/helpers/ai-service-factory.ts";
import { AIMessage } from "../../app/interfaces/ai-client-interfaces.ts";
import { AnthropicService } from "../../app/services/ai/anthropic-service.ts";
import { GoogleAIService } from "../../app/services/ai/googleai-service.ts";
import { OpenAIService } from "../../app/services/ai/openai-service.ts";

const base_config = { provider: "Anthropic", model_name: "claude-opus-5-5", playstyle: "neutral" };

describe("parseResponse", () => {
    it("parses action, size and reason", () => {
        const res = parseResponse("{raise, 8 BB} Top pair is ahead. BB (Villain) calls too much.");
        expect(res.action_str).to.equal("raise");
        expect(res.bet_size_in_BBs).to.equal(8);
        expect(res.reason).to.equal("Top pair is ahead. BB (Villain) calls too much.");
    });

    it("normalizes all-in", () => {
        expect(parseResponse("{All In, 0 BB} Shove.").action_str).to.equal("all-in");
    });
});

describe("appendUserInput", () => {
    it("appends new input without mutating the history", () => {
        const history: AIMessage[] = [];
        const next = appendUserInput(history, "q1");
        expect(history).to.have.length(0);
        expect(next).to.deep.equal([{ text_content: "q1", metadata: { role: "user" } }]);
    });

    it("does not duplicate a retried query", () => {
        const history = appendUserInput([], "q1");
        expect(appendUserInput(history, "q1")).to.equal(history);
    });
});

describe("resolveAIConfig", () => {
    it("applies environment overrides", () => {
        const res = resolveAIConfig({ ...base_config, effort: "low" }, { AI_PROVIDER: "OpenAI", AI_MODEL: "some-new-model", AI_EFFORT: "" });
        expect(res.provider).to.equal("OpenAI");
        expect(res.model_name).to.equal("some-new-model");
        expect(res.effort).to.equal(undefined);
    });
});

describe("AIServiceFactory", () => {
    const factory = new AIServiceFactory();

    it("accepts any model ID and matches providers case-insensitively", () => {
        const svc = factory.createAIService({ ...base_config, provider: "anthropic", model_name: "claude-future-9" }, { ANTHROPIC_API_KEY: "k" });
        expect(svc).to.be.instanceOf(AnthropicService);
        expect(svc.getModelName()).to.equal("claude-future-9");
    });

    it("creates each provider", () => {
        expect(factory.createAIService({ ...base_config, provider: "OpenAI" }, { OPENAI_API_KEY: "k" })).to.be.instanceOf(OpenAIService);
        expect(factory.createAIService({ ...base_config, provider: "Google" }, { GOOGLEAI_API_KEY: "k" })).to.be.instanceOf(GoogleAIService);
        const compat = factory.createAIService({ ...base_config, provider: "OpenAICompatible" }, { OPENAI_COMPATIBLE_BASE_URL: "http://localhost:11434/v1" });
        expect(compat).to.be.instanceOf(OpenAIService);
        expect(compat.getOptions().base_url).to.equal("http://localhost:11434/v1");
    });

    it("reports a missing key by its variable name", () => {
        expect(() => factory.createAIService(base_config, {})).to.throw(/ANTHROPIC_API_KEY/);
    });

    it("rejects unknown providers", () => {
        expect(() => factory.createAIService({ ...base_config, provider: "Nope" }, {})).to.throw(/Unknown AI provider/);
    });
});

describe("AnthropicService.processMessages", () => {
    it("replays assistant content blocks unchanged and merges consecutive user turns", () => {
        const svc = new AnthropicService("k", "claude-opus-5-5", "neutral");
        const assistant_content = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "{call, 2 BB} ok" }];
        const out = svc.processMessages([
            { text_content: "q1", metadata: { role: "user" } },
            { text_content: "{call, 2 BB} ok", metadata: { role: "assistant", content: assistant_content } },
            { text_content: "q2", metadata: { role: "user" } },
            { text_content: "q3", metadata: { role: "user" } }
        ]);
        expect(out).to.have.length(3);
        expect(out[1]).to.deep.equal({ role: "assistant", content: assistant_content });
        expect(out[2]).to.deep.equal({ role: "user", content: [{ type: "text", text: "q2" }, { type: "text", text: "q3" }] });
    });
});
