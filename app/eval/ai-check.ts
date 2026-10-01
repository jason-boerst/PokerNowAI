// Does the AI beat the engine in close spots? Two measures from your recorded decisions:
//   1. EV the AI gives up by the engine's own numbers when it picks something else. Biased toward the engine by
//      construction (the engine judges itself), so it only shows how far the AI departs, not that it is wrong.
//   2. Your results in close spots where you followed the AI against close spots where you followed the engine
//      (AI off, out of time, mixed). Fair between the two, but noisy: hundreds of hands say little.
// The rule ("auto" AI mode): with 200+ AI decisions measured, the AI is turned off when it gives up EV by the
// engine's numbers (95% interval above 0) and shows no result edge (95% interval of the difference above 0).
import { analyzePostflop, Candidate, PostflopAnalysis, robustEv } from "../engine/postflop.ts";
import { HandState, heroView, parseHand } from "../engine/hand-parser.ts";
import type { ObservedStats } from "../engine/opponent-range.ts";
import type { PlayerRef } from "../engine/player-profile.ts";
import { summarizeWinrate, WinrateSummary } from "../engine/winrate.ts";
import { mapSource } from "../engine/decision-outcomes.ts";
import { clearSpot, opponentTendencies } from "../helpers/decision-maker.ts";
import type { DecisionRow } from "../services/hand-recorder.ts";
import type { PlayerLookup } from "../services/profile-service.ts";

/** What the engine thought of a post-flop decision: its top option and the chosen one, in big blinds (robust EV). */
export interface EngineEvs {
    engine_top: string,
    engine_top_ev: number,
    /** null when the chosen action isn't one of the engine's options (e.g. an AI size far from every option). */
    chosen_ev: number | null,
    /** 1 when the engine's best option wasn't clearly ahead (the AI is asked in those spots), 0 otherwise. */
    close_spot: number
}

/** Relative size gap within which an AI bet counts as the engine's nearest option of the same action. */
const SIZE_MATCH = 0.25;

/** The engine option a suggestion stands for: same action and size, or the nearest size within 25%. */
export function chosenCandidate(a: PostflopAnalysis, action: string, size_bb: number, big_blind: number): Candidate | undefined {
    const act = action === "bet" || action === "raise" ? ["bet", "raise"] : [action];
    const same = a.candidates.filter((c) => act.includes(c.action));
    if (!same.length) return undefined;
    if (!(size_bb > 0)) return same[0];
    let best: Candidate | undefined, gap = Infinity;
    for (const c of same) {
        const to_bb = c.to / big_blind;
        const g = Math.abs(to_bb - size_bb) / Math.max(size_bb, 1e-9);
        if (g < gap) { gap = g; best = c; }
    }
    return gap <= SIZE_MATCH ? best : undefined;
}

export function engineEvs(a: PostflopAnalysis, action: string, size_bb: number, big_blind: number, close: boolean): EngineEvs | null {
    const top = a.candidates[0];
    if (!top) return null;
    const chosen = chosenCandidate(a, action, size_bb, big_blind);
    const r = (x: number) => Math.round(x / big_blind * 1000) / 1000;
    return { engine_top: top.label, engine_top_ev: r(robustEv(top)), chosen_ev: chosen ? r(robustEv(chosen)) : null, close_spot: close ? 1 : 0 };
}

/** A recorded decision with what the check needs. */
export type AiCheckRow = Pick<DecisionRow, "game_id" | "hand_number" | "street" | "source" | "model" | "prompt" | "action_json" | "followed" | "hand_net_bb" | "adjusted_net_bb"> & {
    engine_top?: string | null, engine_top_ev?: number | null, chosen_ev?: number | null, close_spot?: number | null
};

export interface AiCheckGroup {
    decisions: number,
    /** Decisions with both EVs known. */
    measured: number,
    /** Of those, how often the pick wasn't the engine's top option. */
    departures: number,
    /** EV given up per decision by the engine's numbers (top minus chosen, BB), with a 95% interval. */
    ev_lost: { mean: number, low: number, high: number, total: number },
    /** Your results in hands where you followed this source in a close spot. */
    followed: WinrateSummary
}

export type AiVerdict = "not_enough" | "ai_worse" | "ai_better" | "no_clear_difference";

export interface AiCheck {
    ai: AiCheckGroup,
    engine: AiCheckGroup,
    /** AI-followed minus engine-followed results (bb/100) with a 95% interval. */
    result_edge: { diff: number, low: number, high: number },
    verdict: AiVerdict,
    reason: string
}

/** AI decisions with EVs needed before the rule decides. */
export const MIN_AI_DECISIONS = 200;

function group(rows: AiCheckRow[]): AiCheckGroup {
    const measured = rows.filter((r) => r.engine_top_ev !== null && r.engine_top_ev !== undefined && r.chosen_ev !== null && r.chosen_ev !== undefined);
    const lost = measured.map((r) => Math.max(0, r.engine_top_ev! - r.chosen_ev!));
    const n = lost.length;
    const mean = n ? lost.reduce((x, y) => x + y, 0) / n : 0;
    const sd = n > 1 ? Math.sqrt(lost.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1)) : 0;
    const half = n > 1 ? 1.96 * sd / Math.sqrt(n) : Infinity;
    // one result per hand, counted when every close-spot suggestion of this source in it was followed
    const hands = new Map<string, { all: boolean, result: number | null }>();
    for (const r of rows) {
        if (r.followed === null || r.followed === undefined || r.hand_number === null) continue;
        const key = `${r.game_id}#${r.hand_number}`;
        const h = hands.get(key) ?? { all: true, result: r.adjusted_net_bb ?? r.hand_net_bb ?? null };
        h.all &&= !!r.followed;
        hands.set(key, h);
    }
    return {
        decisions: rows.length, measured: n,
        departures: measured.filter((r) => r.engine_top_ev! - r.chosen_ev! > 1e-6).length,
        ev_lost: { mean, low: mean - half, high: mean + half, total: mean * n },
        followed: summarizeWinrate([...hands.values()].filter((h) => h.all && h.result !== null).map((h) => h.result!))
    };
}

/** Post-flop decisions only, split into AI (and its fallbacks, which the AI caused) and engine close spots. */
export function aiCheck(rows: AiCheckRow[]): AiCheck {
    const post = rows.filter((r) => r.street && r.street !== "preflop");
    const ai_rows = post.filter((r) => mapSource(r.model, r.source, r.prompt) === "AI");
    const engine_rows = post.filter((r) => mapSource(r.model, r.source, r.prompt) === "Post-flop engine" && r.close_spot === 1);
    const ai = group(ai_rows), engine = group(engine_rows);
    const se = (w: WinrateSummary) => Number.isFinite(w.ci_high) ? (w.ci_high - w.ci_low) / (2 * 1.96) : Infinity;
    const diff = ai.followed.bb_per_100 - engine.followed.bb_per_100;
    const half = 1.96 * Math.sqrt(se(ai.followed) ** 2 + se(engine.followed) ** 2);
    const result_edge = { diff, low: diff - half, high: diff + half };
    const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(2);
    let verdict: AiVerdict, reason: string;
    if (ai.measured < MIN_AI_DECISIONS) {
        verdict = "not_enough";
        reason = `${ai.measured} AI decisions measured; the rule needs ${MIN_AI_DECISIONS}.`;
    } else if (result_edge.low > 0) {
        verdict = "ai_better";
        reason = `Your results following the AI beat following the engine in close spots by ${diff.toFixed(0)} bb/100 (95% interval ${result_edge.low.toFixed(0)} to ${result_edge.high.toFixed(0)}).`;
    } else if (ai.ev_lost.low > 0) {
        verdict = "ai_worse";
        reason = `The AI gives up ${f(ai.ev_lost.mean)} BB per decision by the engine's numbers (95% interval ${f(ai.ev_lost.low)} to ${f(ai.ev_lost.high)}) and shows no result edge ` +
            `(${diff.toFixed(0)} bb/100, interval ${result_edge.low.toFixed(0)} to ${result_edge.high.toFixed(0)}).`;
    } else {
        verdict = "no_clear_difference";
        reason = `The AI's EV cost by the engine's numbers is within noise (${f(ai.ev_lost.mean)} BB per decision) and it shows no clear result edge.`;
    }
    return { ai, engine, result_edge, verdict, reason };
}

/**
 * The engine's EVs for an older post-flop decision recorded before they were stored: the hand as it stood then,
 * analyzed now with today's profiles (in-sample: they include the hand's own game). null when it can't be rebuilt.
 */
export function rebuildEngineEvs(r: Pick<DecisionRow, "street" | "messages_json" | "hero_name" | "big_blind" | "action_json">,
    stats: (p: PlayerRef) => ObservedStats | undefined, players: PlayerLookup, time_budget_ms = 40): EngineEvs | null {
    if (!r.street || r.street === "preflop") return null;
    try {
        const s: HandState = parseHand(JSON.parse(r.messages_json), { hero_name: r.hero_name, big_blind: r.big_blind });
        const v = s.hero_id && s.hero_cards.length === 2 ? heroView(s) : null;
        if (!v || s.street === "preflop") return null;
        const a = analyzePostflop(s, v, opponentTendencies(s, stats, players), time_budget_ms);
        const act = JSON.parse(r.action_json ?? "{}") as { action_str?: string, bet_size_in_BBs?: number };
        return engineEvs(a, (act.action_str ?? "").toLowerCase(), Number(act.bet_size_in_BBs) || 0, s.big_blind, !clearSpot(a, v.pot, s.big_blind));
    } catch {
        return null;
    }
}

/** What the check needs from the recorder and profiles (kept narrow for tests). */
export interface AiCheckSources {
    decisions(): Promise<DecisionRow[]>,
    matchPendingDecisions(): Promise<number>,
    setEngineEvs(id: number, evs: EngineEvs | null): Promise<void>
}

/**
 * Runs the check on your recorded decisions: matches pending ones, fills in the engine's EVs for older post-flop
 * rows (stored, so it happens once; a row that can't be rebuilt is marked with an empty top option), yielding
 * between rows so a running bot stays responsive.
 */
export async function runAiCheck(src: AiCheckSources, stats: (p: PlayerRef) => ObservedStats | undefined, players: PlayerLookup, time_budget_ms = 40): Promise<AiCheck> {
    await src.matchPendingDecisions();
    const rows = await src.decisions();
    for (const r of rows) {
        if (r.engine_top !== null && r.engine_top !== undefined) continue;
        if (!r.street || r.street === "preflop") continue;
        const evs = rebuildEngineEvs(r, stats, players, time_budget_ms);
        await src.setEngineEvs(r.id, evs);
        if (evs) Object.assign(r, evs);
        else r.engine_top = "";
        await new Promise((resolve) => setImmediate(resolve));
    }
    return aiCheck(rows);
}
