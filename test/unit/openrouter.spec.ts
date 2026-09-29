import { expect } from "chai";

import { AIServiceFactory } from "../../app/helpers/ai-service-factory.ts";
import { chooseModelIfNeeded, describeModel, formatPrice, OpenRouterModel, pickModel, searchModels } from "../../app/helpers/model-picker.ts";
import { OPENROUTER_BASE_URL, OpenRouterService } from "../../app/services/ai/openrouter-service.ts";

const models: OpenRouterModel[] = [
    { id: "anthropic/claude-x", name: "Anthropic: Claude X", pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: ["reasoning"] },
    { id: "openai/gpt-y", name: "OpenAI: GPT Y", pricing: { prompt: "0.00000125", completion: "0.00001" } },
    { id: "meta/llama-z:free", name: "Meta: Llama Z (free)", pricing: { prompt: "0", completion: "0" } }
];

function scripted(answers: string[]) {
    return () => answers.shift() ?? null;
}

describe("OpenRouter provider", () => {
    it("is created from OPENROUTER_API_KEY with the OpenRouter base URL", () => {
        const svc = new AIServiceFactory().createAIService({ provider: "OpenRouter", model_name: "anthropic/claude-x", playstyle: "neutral" }, { OPENROUTER_API_KEY: "k" });
        expect(svc).to.be.instanceOf(OpenRouterService);
        expect(svc.getOptions().base_url).to.equal(OPENROUTER_BASE_URL);
    });

    it("asks for OPENROUTER_API_KEY when it is missing", () => {
        expect(() => new AIServiceFactory().createAIService({ provider: "openrouter", model_name: "m", playstyle: "neutral" }, {})).to.throw(/OPENROUTER_API_KEY/);
    });

    it("leaves configs that already name a model alone", async () => {
        const config = { provider: "OpenRouter", model_name: "openai/gpt-y", playstyle: "neutral" };
        expect(await chooseModelIfNeeded(config, {})).to.equal(config);
    });
});

describe("model menu", () => {
    it("formats per-token prices as dollars per million tokens", () => {
        expect(formatPrice("0.000003")).to.equal("$3.00");
        expect(formatPrice("0")).to.equal("free");
        expect(formatPrice("-1")).to.equal("?");
        expect(formatPrice(undefined)).to.equal("?");
        expect(describeModel(models[0])).to.include("supports effort");
    });

    it("searches ID and name, requiring every word", () => {
        expect(searchModels(models, "claude").map((m) => m.id)).to.deep.equal(["anthropic/claude-x"]);
        expect(searchModels(models, "FREE").map((m) => m.id)).to.deep.equal(["meta/llama-z:free"]);
        expect(searchModels(models, "openai llama")).to.have.length(0);
    });

    it("picks by search then number", async () => {
        expect(await pickModel(models, scripted(["gpt", "1"]))).to.equal("openai/gpt-y");
    });

    it("accepts an exact model ID", async () => {
        expect(await pickModel(models, scripted(["meta/llama-z:free"]))).to.equal("meta/llama-z:free");
    });

    it("uses the last model on Enter", async () => {
        expect(await pickModel(models, scripted([""]), "anthropic/claude-x")).to.equal("anthropic/claude-x");
    });

    it("re-asks after an out-of-range number", async () => {
        expect(await pickModel(models, scripted(["claude", "9", "1"]))).to.equal("anthropic/claude-x");
    });
});
