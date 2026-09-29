import { DebugMode } from "../utils/error-handling-utils.ts"

export interface AIConfig {
    /** One of: "Anthropic", "OpenAI", "Google", "OpenAICompatible" (case-insensitive). */
    provider: string,
    /** Any model ID the provider accepts, e.g. "claude-opus-5-5". Run `npm run list-models` to see yours. */
    model_name: string,
    playstyle: string,
    /**
     * Optional reasoning effort. Anthropic: output_config.effort; OpenAI: reasoning_effort;
     * Google: thinkingConfig.thinkingLevel. Leave unset to use the model's default.
     */
    effort?: string,
    /** Base URL for the "OpenAICompatible" provider (e.g. OpenRouter, xAI, Ollama). */
    base_url?: string,
    /** Per-request timeout in milliseconds. */
    request_timeout_ms?: number
}

export interface BotConfig {
    debug_mode: DebugMode,
    query_retries: number,
    /** When true, AI only shows suggestion in top-right; user clicks actions manually. */
    assistant_mode: boolean,
    /** Preflop decisions from the rule-based engine (app/configs/preflop-ranges.json) instead of the AI. Default true. */
    preflop_engine?: boolean,
    /**
     * Post-flop: when to ask the AI. "close_spots" (default): only when the engine's top options are
     * close. "off": engine only, instant. "always": every post-flop spot.
     */
    ai_mode?: string,
    /**
     * Your game's action clock in seconds (15 in most PokerNow games). The AI only gets the time the
     * clock leaves after about 7 seconds for you to read and click; under 2 seconds it isn't asked.
     * 0 for a game without an action clock. Default 15.
     */
    decision_seconds?: number,
    /** Post-flop: the most the AI may take, in milliseconds, before the engine's pick is used. Default 6000. */
    llm_timeout_ms?: number,
    /** Old setting, kept working: true is the same as "ai_mode": "always". */
    always_ask_llm?: boolean,
    /** Stop when nothing has happened at the table for this long. Default 10. */
    stop_after_idle_minutes?: number,
    /** Stop after you've been unseated this long. Default 60. */
    stop_after_unseated_seconds?: number,
    /** Stop after fewer than 2 players have been seated this long. Default 2. */
    stop_after_short_table_minutes?: number
}

export interface WebDriverConfig {
    default_timeout: number,
    headless_flag: boolean,
    /** Connect to an already-running Chrome instead of launching a new one. */
    use_existing_browser: boolean,
    /** Chrome remote debugging port (--remote-debugging-port). */
    debugging_port: number
}
