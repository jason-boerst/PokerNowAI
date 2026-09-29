import { AIService } from "../interfaces/ai-client-interfaces.ts";
import { AIConfig } from "../interfaces/config-interfaces.ts";
import { OPENROUTER_BASE_URL } from "../services/ai/openrouter-service.ts";
import { getProviderInfo } from "./ai-service-factory.ts";
import { fetchOpenRouterModels, pickModel, saveLastModel } from "./model-picker.ts";
import { ask, onCommand } from "./terminal.ts";

/** Runs `fn` with bot log output held back, then prints what was held. */
async function withLogsPaused<T>(fn: (print: (...args: unknown[]) => void) => Promise<T>): Promise<T> {
    const original = console.log;
    const held: unknown[][] = [];
    console.log = (...args: unknown[]) => { held.push(args); };
    try {
        return await fn(original);
    } finally {
        console.log = original;
        if (held.length > 0) {
            original(`--- ${held.length} bot message(s) while the menu was open ---`);
            held.forEach((args) => original(...args));
        }
    }
}

/**
 * Lets the user switch models while the bot is running:
 *   m            open the model menu (OpenRouter)
 *   m <model-id> switch directly to that model (any provider)
 */
export function startLiveCommands(ai_service: AIService, config: AIConfig, env: NodeJS.ProcessEnv = process.env): void {
    const is_openrouter = getProviderInfo(config.provider)?.name === "OpenRouter";
    let busy = false;

    console.log(`\nCurrent model: ${ai_service.getModelName()}. To switch at any time, type "m" and press Enter${is_openrouter ? "" : " followed by a model ID"}.\n`);

    onCommand(async (line) => {
        const [command, ...rest] = line.trim().split(/\s+/);
        if (!command || busy) {
            return;
        }
        if (command !== "m" && command !== "model") {
            console.log(`Unknown command "${command}". Type "m" to switch models, or "m <model-id>".`);
            return;
        }

        busy = true;
        try {
            let model = rest.join(" ");
            if (!model) {
                if (!is_openrouter) {
                    console.log(`Type "m <model-id>" to switch (the model menu is available with the OpenRouter provider).`);
                    return;
                }
                model = await withLogsPaused(async (print) => {
                    print(`\nCurrent model: ${ai_service.getModelName()}`);
                    const models = await fetchOpenRouterModels(env.OPENROUTER_API_KEY, config.base_url ?? OPENROUTER_BASE_URL);
                    return pickModel(models, ask, ai_service.getModelName(), { print, allow_cancel: true });
                });
            }
            if (!model || model === ai_service.getModelName()) {
                console.log(`Keeping ${ai_service.getModelName()}.`);
                return;
            }
            ai_service.setModelName(model);
            saveLastModel(model);
            console.log(`Switched to ${model}. It is used from the next AI suggestion.`);
        } catch (err) {
            console.log(`Could not switch models: ${err instanceof Error ? err.message : err}`);
        } finally {
            busy = false;
        }
    });
}
