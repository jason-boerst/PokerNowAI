import { readFileSync, writeFileSync } from "node:fs";

import { AIConfig } from "../interfaces/config-interfaces.ts";
import { OPENROUTER_BASE_URL } from "../services/ai/openrouter-service.ts";
import { getProviderInfo } from "./ai-service-factory.ts";
import { ask } from "./terminal.ts";

export interface OpenRouterModel {
    id: string,
    name?: string,
    context_length?: number,
    /** USD per token, as strings (e.g. "0.000003"). */
    pricing?: { prompt?: string, completion?: string },
    supported_parameters?: string[]
}

const LAST_MODEL_FILE = ".last-model";
const MAX_SHOWN = 40;

export async function fetchOpenRouterModels(api_key?: string, base_url: string = OPENROUTER_BASE_URL): Promise<OpenRouterModel[]> {
    const res = await fetch(`${base_url}/models`, {
        headers: api_key ? { Authorization: `Bearer ${api_key}` } : {}
    });
    if (!res.ok) {
        throw new Error(`model list request returned status ${res.status}`);
    }
    const body = await res.json() as { data?: OpenRouterModel[] };
    return (body.data ?? [])
        .filter((m) => typeof m.id === "string" && m.id)
        .sort((a, b) => a.id.localeCompare(b.id));
}

/** Formats a per-token USD price string as dollars per million tokens. */
export function formatPrice(per_token?: string): string {
    const value = Number(per_token);
    if (per_token === undefined || !Number.isFinite(value) || value < 0) {
        return "?";
    }
    if (value === 0) {
        return "free";
    }
    return `$${(value * 1e6).toFixed(2)}`;
}

export function describeModel(model: OpenRouterModel): string {
    const reasoning = model.supported_parameters?.includes("reasoning") ? ", supports effort" : "";
    return `${model.id}  (in ${formatPrice(model.pricing?.prompt)} / out ${formatPrice(model.pricing?.completion)} per 1M tokens${reasoning})`;
}

/** Case-insensitive search: every word must appear in the model's ID or display name. */
export function searchModels(models: OpenRouterModel[], query: string): OpenRouterModel[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return models.filter((m) => {
        const haystack = `${m.id} ${m.name ?? ""}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
    });
}

export interface PickModelOptions {
    /** Output function (defaults to console.log). */
    print?: (...args: unknown[]) => void,
    /** When true, typing "q" returns "" to cancel (used for switching models mid-game). */
    allow_cancel?: boolean
}

/**
 * Interactive model menu. `ask` returns the user's answer, or null if input was cancelled.
 * Accepts a search, a number from the last list shown, an exact model ID, "all", or Enter for the last model used.
 */
export async function pickModel(models: OpenRouterModel[], ask: (question: string) => Promise<string | null> | string | null, last_model?: string, options: PickModelOptions = {}): Promise<string> {
    const print = options.print ?? console.log;
    let shown: OpenRouterModel[] = [];
    print(`\nOpenRouter currently lists ${models.length} models.`);
    while (true) {
        const default_hint = last_model ? `, or press Enter for ${last_model}` : "";
        const cancel_hint = options.allow_cancel ? `, "q" to cancel` : "";
        const answer = await ask(`Search models (e.g. "claude", "gpt", "gemini", "free"), type "all", or a number from the list${default_hint}${cancel_hint}: `);
        if (answer === null) {
            process.exit(0);
        }
        const input = answer.trim();
        if (options.allow_cancel && input.toLowerCase() === "q") {
            return "";
        }

        if (!input) {
            if (last_model) {
                return last_model;
            }
            continue;
        }
        if (/^\d+$/.test(input) && shown.length > 0) {
            const picked = shown[Number(input) - 1];
            if (picked) {
                return picked.id;
            }
            print("No model with that number in the list above.");
            continue;
        }
        const exact = models.find((m) => m.id === input);
        if (exact) {
            return exact.id;
        }

        const show_all = input.toLowerCase() === "all";
        const matches = show_all ? models : searchModels(models, input);
        if (matches.length === 0) {
            print("No models match that search.");
            continue;
        }
        shown = show_all ? matches : matches.slice(0, MAX_SHOWN);
        shown.forEach((m, i) => print(`  ${String(i + 1).padStart(3)}. ${describeModel(m)}`));
        if (matches.length > shown.length) {
            print(`  ... and ${matches.length - shown.length} more. Add words to narrow the search.`);
        }
    }
}

export function readLastModel(): string | undefined {
    try {
        return readFileSync(LAST_MODEL_FILE, "utf8").trim() || undefined;
    } catch {
        return undefined;
    }
}

export function saveLastModel(model: string): void {
    try {
        writeFileSync(LAST_MODEL_FILE, model + "\n");
    } catch {
        // remembering the choice is only a convenience
    }
}

/**
 * For the OpenRouter provider with no model set (no AI_MODEL and an empty model_name),
 * shows the model menu and returns the config with the chosen model.
 */
export async function chooseModelIfNeeded(config: AIConfig, env: NodeJS.ProcessEnv = process.env): Promise<AIConfig> {
    if (config.model_name || getProviderInfo(config.provider)?.name !== "OpenRouter") {
        return config;
    }
    const last_model = readLastModel();

    let model: string;
    try {
        const models = await fetchOpenRouterModels(env.OPENROUTER_API_KEY, config.base_url ?? OPENROUTER_BASE_URL);
        model = await pickModel(models, ask, last_model);
    } catch (err) {
        console.log(`Could not load the OpenRouter model list (${err instanceof Error ? err.message : err}).`);
        const default_hint = last_model ? ` (Enter = ${last_model})` : "";
        model = (await ask(`Type an OpenRouter model ID, e.g. provider/model-name${default_hint}: `)) || last_model || "";
    }

    if (model) {
        saveLastModel(model);
        console.log(`Using model: ${model}\n`);
    }
    return { ...config, model_name: model };
}
