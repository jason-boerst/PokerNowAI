import { AIService } from "../interfaces/ai-client-interfaces.ts";
import { AIConfig } from "../interfaces/config-interfaces.ts";
import { AnthropicService } from "../services/ai/anthropic-service.ts";
import { GoogleAIService } from "../services/ai/googleai-service.ts";
import { OpenAIService } from "../services/ai/openai-service.ts";
import { OPENROUTER_BASE_URL, OpenRouterService } from "../services/ai/openrouter-service.ts";

interface ProviderInfo {
    name: string,
    api_key_env: string,
    example_models: string[]
}

// No model allowlist: any model ID the provider accepts will work, so new models can be used
// the day they are released. The examples are only printed as hints.
export const providers: ProviderInfo[] = [
    { name: "OpenRouter", api_key_env: "OPENROUTER_API_KEY", example_models: ["pick from the menu at startup, or run `npm run list-models`"] },
    { name: "Anthropic", api_key_env: "ANTHROPIC_API_KEY", example_models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"] },
    { name: "OpenAI", api_key_env: "OPENAI_API_KEY", example_models: ["run `npm run list-models`"] },
    { name: "Google", api_key_env: "GOOGLEAI_API_KEY", example_models: ["run `npm run list-models`"] },
    { name: "OpenAICompatible", api_key_env: "OPENAI_COMPATIBLE_API_KEY", example_models: ["whatever your endpoint serves"] }
];

export function getProviderInfo(provider: string): ProviderInfo | undefined {
    return providers.find((p) => p.name.toLowerCase() === provider.toLowerCase());
}

/** Applies AI_PROVIDER / AI_MODEL / AI_EFFORT / AI_PLAYSTYLE / AI_BASE_URL environment overrides. */
export function resolveAIConfig(config: AIConfig, env: NodeJS.ProcessEnv = process.env): AIConfig {
    const resolved: AIConfig = { ...config };
    if (env.AI_PROVIDER) resolved.provider = env.AI_PROVIDER;
    if (env.AI_MODEL) resolved.model_name = env.AI_MODEL;
    if (env.AI_PLAYSTYLE) resolved.playstyle = env.AI_PLAYSTYLE;
    if (env.AI_EFFORT !== undefined) resolved.effort = env.AI_EFFORT || undefined;
    if (env.AI_BASE_URL) resolved.base_url = env.AI_BASE_URL;
    return resolved;
}

export class AIServiceFactory {
    createAIService(config: AIConfig, env: NodeJS.ProcessEnv = process.env): AIService {
        const info = getProviderInfo(config.provider);
        if (!info) {
            throw new Error(`Unknown AI provider "${config.provider}". Use one of: ${providers.map((p) => p.name).join(", ")}.`);
        }
        if (!config.model_name) {
            throw new Error("No model chosen. Pick one from the menu, or set model_name in app/configs/ai-config.json or AI_MODEL in .env.");
        }

        const options = {
            effort: config.effort,
            base_url: config.base_url,
            request_timeout_ms: config.request_timeout_ms
        };
        const playstyle = config.playstyle ?? "neutral";
        const api_key = env[info.api_key_env];

        if (info.name === "OpenAICompatible") {
            const base_url = config.base_url ?? env.OPENAI_COMPATIBLE_BASE_URL;
            if (!base_url) {
                throw new Error("Provider OpenAICompatible needs a base URL: set base_url in ai-config.json or OPENAI_COMPATIBLE_BASE_URL in .env.");
            }
            // local servers such as Ollama ignore the key, but the SDK requires a non-empty one
            return new OpenAIService(api_key || "not-needed", config.model_name, playstyle, { ...options, base_url });
        }

        if (!api_key) {
            throw new Error(`Missing ${info.api_key_env}. Add it to your .env file (see .env.example).`);
        }
        switch (info.name) {
            case "OpenRouter":
                return new OpenRouterService(api_key, config.model_name, playstyle, { ...options, base_url: config.base_url ?? OPENROUTER_BASE_URL });
            case "Anthropic":
                return new AnthropicService(api_key, config.model_name, playstyle, options);
            case "OpenAI":
                return new OpenAIService(api_key, config.model_name, playstyle, options);
            case "Google":
                return new GoogleAIService(api_key, config.model_name, playstyle, options);
        }
        throw new Error("Failed to create AI service.");
    }

    printProviders(): void {
        console.log("Available providers (any model ID the provider serves is accepted):")
        for (const p of providers) {
            console.log(`  ${p.name} (${p.api_key_env}): e.g. ${p.example_models.join(", ")}`);
        }
    }
}
