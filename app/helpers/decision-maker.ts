import { AIService } from "../interfaces/ai-client-interfaces.ts";
import { HandState, HeroView } from "../engine/hand-parser.ts";
import { checkLegality, SuggestedAction } from "../engine/legality.ts";
import { PlayerProfile, PRIORS } from "../engine/player-profile.ts";
import { analyzePostflop, Candidate, isClearSpot, OpponentTendency, PostflopAnalysis } from "../engine/postflop.ts";
import { opponentModels, ObservedStats } from "../engine/opponent-range.ts";
import { buildDecisionPrompt, parseDecision } from "./decision-prompt.ts";

export interface Decision extends SuggestedAction {
    reason: string,
    confidence: number,
    /** "engine" (clear spot), "llm" (close spot), or "engine-fallback" (AI answer missing or unusable). */
    source: "engine" | "llm" | "engine-fallback",
    prompt: string,
    response: string,
    analysis: PostflopAnalysis
}

export interface DecisionOptions {
    /** Give up on the AI after this long and use the engine's pick. */
    llm_timeout_ms: number,
    /** Ask the AI even in clear spots. */
    always_ask_llm?: boolean,
    /** Called with the engine analysis just before waiting on the AI (to show a provisional pick). */
    on_asking_llm?: (analysis: PostflopAnalysis) => Promise<void> | void
}

/** Fold tendencies for each opponent still in the hand, from their profile (population priors if unknown). */
export function opponentTendencies(s: HandState, stats: (name: string) => ObservedStats | undefined, profiles: (name: string) => PlayerProfile | undefined): OpponentTendency[] {
    return opponentModels(s, stats).map(({ seat, model }) => {
        const p = profiles(seat.name);
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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 1000)}s`)), ms);
        p.then((x) => { clearTimeout(t); resolve(x); }, (e) => { clearTimeout(t); reject(e); });
    });
}

export async function decidePostflop(
    s: HandState, v: HeroView, ai: AIService, opponents: OpponentTendency[],
    profiles: (name: string) => PlayerProfile | undefined, options: DecisionOptions
): Promise<Decision> {
    const analysis = analyzePostflop(s, v, opponents);
    const best = fromCandidate(analysis.candidates[0], s.big_blind);
    const engine = (source: Decision["source"], note = "", prompt = "", response = ""): Decision => ({
        ...best,
        reason: note + engineReason(analysis, s.big_blind),
        confidence: source === "engine" ? 0.8 : 0.5,
        source, prompt, response, analysis
    });

    if (!options.always_ask_llm && isClearSpot(analysis, v.pot, s.big_blind)) {
        return engine("engine");
    }

    const prompt = buildDecisionPrompt(s, v, analysis, profiles);
    await options.on_asking_llm?.(analysis);
    let response = "";
    try {
        const res = await withTimeout(ai.query(prompt, []), options.llm_timeout_ms);
        response = res.curr_message?.text_content ?? "";
    } catch (err) {
        return engine("engine-fallback", `AI unavailable (${err instanceof Error ? err.message : err}). `, prompt, response);
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
    return { ...parsed, source: "llm", prompt, response, analysis };
}
