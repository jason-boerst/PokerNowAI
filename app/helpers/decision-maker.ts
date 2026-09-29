import { AIService } from "../interfaces/ai-client-interfaces.ts";
import { HandState, HeroView } from "../engine/hand-parser.ts";
import { checkLegality, SuggestedAction } from "../engine/legality.ts";
import { PlayerRef, PRIORS } from "../engine/player-profile.ts";
import type { PlayerLookup } from "../services/profile-service.ts";
import { analyzePostflop, Candidate, isClearSpot, OpponentTendency, PostflopAnalysis } from "../engine/postflop.ts";
import { opponentModels, ObservedStats } from "../engine/opponent-range.ts";
import { buildDecisionPrompt, parseDecision } from "./decision-prompt.ts";

export interface Decision extends SuggestedAction {
    reason: string,
    confidence: number,
    /**
     * "engine" (clear spot, or a close spot the AI was skipped for), "llm" (close spot),
     * or "engine-fallback" (AI answer missing or unusable).
     */
    source: "engine" | "llm" | "engine-fallback",
    /** Why the AI wasn't asked in a close spot: "off" (ai_mode) or "time" (not enough left on the clock). */
    ai_skipped?: "off" | "time",
    /** How long the AI was given, in milliseconds (0 when it wasn't asked). */
    ai_budget_ms: number,
    prompt: string,
    response: string,
    analysis: PostflopAnalysis
}

/** When to ask the AI post-flop: only in close spots, never (engine only, instant), or in every spot. */
export type AIMode = "close_spots" | "off" | "always";

/** The action clock assumed when none is configured, in seconds. */
export const DEFAULT_DECISION_SECONDS = 15;
/** The most the AI may take when no limit is configured, in milliseconds. */
export const DEFAULT_LLM_TIMEOUT_MS = 6000;
/** Time kept back from the action clock for reading the suggestion and clicking. */
export const READ_AND_CLICK_MS = 7000;
/** If the clock leaves the AI less than this, it isn't asked: its answer would arrive too late to use. */
export const MIN_AI_BUDGET_MS = 2000;

export interface DecisionOptions {
    /** The most the AI may take, in milliseconds; the action clock can cut this further (see aiBudgetMs). */
    llm_timeout_ms: number,
    /** Old setting: true is the same as ai_mode "always". */
    always_ask_llm?: boolean,
    /** "close_spots" (default), "off" or "always". */
    ai_mode?: string,
    /** The game's action clock in seconds; 0 for a game without one. Default 15. */
    decision_seconds?: number,
    /** When your turn started (Date.now()): time already used comes off the AI's budget. */
    turn_started_at?: number,
    /** Table notes for the AI, e.g. "Antes in play" or "7-2 bounty on: 3 BB from each player". */
    notes?: string[],
    /**
     * Called with the engine analysis and the AI's time budget (ms) once the AI has been asked, to show
     * the engine's provisional pick while it thinks.
     */
    on_asking_llm?: (analysis: PostflopAnalysis, budget_ms: number) => Promise<void> | void
}

/** The AI mode from the config; the old `always_ask_llm: true` still means "always" (unless ai_mode is "off"). */
export function aiMode(opts: { ai_mode?: string, always_ask_llm?: boolean }): AIMode {
    const mode = (opts.ai_mode ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (mode === "off") return "off";
    if (mode === "always" || opts.always_ask_llm) return "always";
    return "close_spots";
}

/**
 * How long to wait for the AI post-flop, in milliseconds: the configured limit, cut to what the action
 * clock leaves after time to read and click (and after `elapsed_ms` already used this turn).
 * `decision_seconds` 0 means a game without an action clock (only the limit applies).
 * 0 means the engine answers alone: the AI is off, or too little time is left for its answer to help.
 */
export function aiBudgetMs(opts: { llm_timeout_ms: number, decision_seconds?: number, ai_mode?: string, always_ask_llm?: boolean, elapsed_ms?: number }): number {
    if (aiMode(opts) === "off") return 0;
    const limit = Number.isFinite(opts.llm_timeout_ms) ? Math.max(0, opts.llm_timeout_ms) : DEFAULT_LLM_TIMEOUT_MS;
    const seconds = opts.decision_seconds !== undefined && Number.isFinite(opts.decision_seconds) ? opts.decision_seconds : DEFAULT_DECISION_SECONDS;
    if (seconds <= 0) return limit;
    const left = seconds * 1000 - READ_AND_CLICK_MS - Math.max(0, opts.elapsed_ms ?? 0);
    if (left < MIN_AI_BUDGET_MS) return 0;
    return Math.min(limit, left);
}

/** Fold tendencies for each opponent still in the hand, from their profile (population priors if unknown). */
export function opponentTendencies(s: HandState, stats: (player: PlayerRef) => ObservedStats | undefined, players: PlayerLookup): OpponentTendency[] {
    return opponentModels(s, stats).map(({ seat, model }) => {
        const p = players(seat).current;
        const aggression = p?.aggression.value ?? PRIORS.aggression.mean;
        return {
            model,
            fold_to_bet: p?.fold_to_cbet.value ?? PRIORS.fold_to_cbet.mean,
            // aggressive players bluff more, so they also give up more often when raised (assumption)
            fold_to_raise: Math.max(0.1, Math.min(0.6, 0.25 + (aggression - PRIORS.aggression.mean)))
        };
    });
}

function fromCandidate(c: Candidate, big_blind: number): SuggestedAction {
    return { action: c.action, size_bb: c.to > 0 ? Math.round(c.to / big_blind * 100) / 100 : 0 };
}

function engineReason(a: PostflopAnalysis, big_blind: number): string {
    const [best, next] = a.candidates;
    const b = (x: number) => (x >= 0 ? "+" : "") + (x / big_blind).toFixed(1);
    const need = a.required_equity > 0 ? `, need ${Math.round(a.required_equity * 100)}%` : "";
    return `Equity ${Math.round(a.equity * 100)}%${need}. ${best.label} is worth about ${b(best.ev)} BB` +
        (next ? ` vs ${b(next.ev)} BB for ${next.label}.` : ".");
}

const aggressive = (action: string) => action === "bet" || action === "raise" || action === "all-in";

/**
 * Clear when the engine's best option beats every other action by a clear margin. Bets, raises and
 * all-ins count as one action: picking between sizes alone isn't worth waiting for the AI.
 */
function clearSpot(a: PostflopAnalysis, pot: number, big_blind: number): boolean {
    const [best, ...rest] = a.candidates;
    const others = rest.filter((c) => c.action !== best.action && !(aggressive(c.action) && aggressive(best.action)));
    return isClearSpot({ ...a, candidates: [best, ...others] }, pot, big_blind);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 100) / 10}s`)), ms);
        p.then((x) => { clearTimeout(t); resolve(x); }, (e) => { clearTimeout(t); reject(e); });
    });
}

export async function decidePostflop(
    s: HandState, v: HeroView, ai: AIService, opponents: OpponentTendency[],
    players: PlayerLookup, options: DecisionOptions
): Promise<Decision> {
    const analysis = analyzePostflop(s, v, opponents);
    const best = fromCandidate(analysis.candidates[0], s.big_blind);
    let budget = 0;
    const engine = (source: Decision["source"], note = "", prompt = "", response = ""): Decision => ({
        ...best,
        reason: note + engineReason(analysis, s.big_blind),
        confidence: source === "engine" ? 0.8 : 0.5,
        source, ai_budget_ms: budget, prompt, response, analysis
    });

    const mode = aiMode(options);
    const clear = clearSpot(analysis, v.pot, s.big_blind);
    if (clear && mode !== "always") {
        return engine("engine");
    }
    const elapsed_ms = options.turn_started_at !== undefined ? Date.now() - options.turn_started_at : 0;
    budget = aiBudgetMs({ ...options, elapsed_ms });
    if (budget <= 0) {
        if (clear) return engine("engine");
        // a limit of 0 means the AI is off too
        const skipped = mode === "off" || !(options.llm_timeout_ms > 0) ? "off" : "time";
        const note = skipped === "off" ? "Close spot, AI off. " : "Close spot, no time left to ask the AI. ";
        return { ...engine("engine", note), confidence: 0.6, ai_skipped: skipped };
    }

    const prompt = buildDecisionPrompt(s, v, analysis, players, options.notes);
    // ask first so showing the provisional pick doesn't eat into the AI's time; a failure becomes a
    // value right away (never an unhandled rejection while the overlay updates)
    const answer = withTimeout(Promise.resolve().then(() => ai.query(prompt, [])), budget)
        .then((res) => ({ text: res.curr_message?.text_content ?? "", error: undefined as unknown }), (error: unknown) => ({ text: "", error: error ?? "unknown error" }));
    await Promise.resolve().then(() => options.on_asking_llm?.(analysis, budget)).catch(() => undefined);
    const { text: response, error } = await answer;
    if (error !== undefined) {
        return engine("engine-fallback", `AI unavailable (${error instanceof Error ? error.message : error}). `, prompt, response);
    }
    const parsed = parseDecision(response);
    if (!parsed) {
        return engine("engine-fallback", "AI reply wasn't valid JSON. ", prompt, response);
    }
    // treat "bet" facing a bet as a raise and vice versa
    if (parsed.action === "bet" && v.to_call > 0) parsed.action = "raise";
    if (parsed.action === "raise" && v.to_call <= 0) parsed.action = "bet";
    const legality = checkLegality(parsed, v, s.big_blind);
    if (!legality.legal) {
        return engine("engine-fallback", `AI suggested an illegal action (${legality.reason}). `, prompt, response);
    }
    if (legality.dominated) {
        return engine("engine-fallback", `AI suggested folding when checking is free. `, prompt, response);
    }
    return { ...parsed, source: "llm", ai_budget_ms: budget, prompt, response, analysis };
}
