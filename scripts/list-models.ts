// Lists the model IDs your API keys can use, straight from each provider's models endpoint.
// Put any of these IDs in app/configs/ai-config.json ("model_name") or AI_MODEL in .env.
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

async function listAnthropic(api_key: string) {
    const client = new Anthropic({ apiKey: api_key });
    const ids: string[] = [];
    for await (const model of client.models.list()) {
        ids.push(model.id);
    }
    return ids;
}

async function listOpenAI(api_key: string, base_url?: string) {
    const client = new OpenAI({ apiKey: api_key, baseURL: base_url });
    const ids: string[] = [];
    for await (const model of client.models.list()) {
        ids.push(model.id);
    }
    return ids.sort();
}

async function listGoogle(api_key: string) {
    const client = new GoogleGenAI({ apiKey: api_key });
    const ids: string[] = [];
    for await (const model of await client.models.list()) {
        if (model.name && (model.supportedActions ?? []).includes("generateContent")) {
            ids.push(model.name.replace(/^models\//, ""));
        }
    }
    return ids;
}

const jobs: Array<[string, string | undefined, (key: string) => Promise<string[]>]> = [
    ["Anthropic", process.env.ANTHROPIC_API_KEY, listAnthropic],
    ["OpenAI", process.env.OPENAI_API_KEY, (key) => listOpenAI(key)],
    ["Google", process.env.GOOGLEAI_API_KEY, listGoogle],
    ["OpenAICompatible", process.env.OPENAI_COMPATIBLE_BASE_URL ? (process.env.OPENAI_COMPATIBLE_API_KEY || "not-needed") : undefined,
        (key) => listOpenAI(key, process.env.OPENAI_COMPATIBLE_BASE_URL)]
];

for (const [provider, key, list] of jobs) {
    if (!key) {
        console.log(`${provider}: skipped (no key/base URL in .env)\n`);
        continue;
    }
    try {
        const ids = await list(key);
        console.log(`${provider} (${ids.length}):\n  ${ids.join("\n  ")}\n`);
    } catch (err) {
        console.log(`${provider}: failed to list models: ${err instanceof Error ? err.message : err}\n`);
    }
}
