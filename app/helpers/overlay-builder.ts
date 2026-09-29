// Builds the content of the in-game suggestion panel (a PanelModel): everything needed to decide at a
// glance. How it is drawn lives in ui/panel-render.ts; the opponent cards come from ui/opponent-cards.ts.
import { HandState, HeroView } from "../engine/hand-parser.ts";
import { describeHand } from "../engine/hand-strength.ts";
import { ObservedStats } from "../engine/opponent-range.ts";
import { PlayerRef } from "../engine/player-profile.ts";
import type { PlayerLookup } from "../services/profile-service.ts";
import { Candidate, PostflopAnalysis } from "../engine/postflop.ts";
import { explainBet, matchCandidate, shortTag } from "./bet-explain.ts";
import { PreflopAdvice } from "../engine/preflop.ts";
import { bb } from "../engine/spot-format.ts";
import { opponentCards } from "../ui/opponent-cards.ts";
import { PanelModel, PanelOption, toneFor } from "../ui/panel-model.ts";

/** @deprecated The panel content is a PanelModel now; kept so older imports still compile. */
export type OverlayContent = PanelModel;

export interface OverlayInputs {
    state: HandState,
    view: HeroView,
    players: PlayerLookup,
    stats: (player: PlayerRef) => ObservedStats | undefined,
    /** Table notes from the game rules, e.g. "Antes in play" or "7-2 bounty on: 3 BB from each player". */
    notes?: string[]
}

/** A post-flop decision as decidePostflop returns it (only the fields the panel needs). */
export interface PanelDecision {
    action: string,
    size_bb: number,
    reason: string,
    source: string,
    confidence: number,
    ai_skipped?: string
}

/** The most reasoning lines shown. */
const MAX_REASON_LINES = 5;
/** How many opponents get a card; the rest are counted. */
const MAX_OPPONENT_CARDS = 4;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const round2 = (x: number) => Math.round(x * 100) / 100;
const aggressive = (action: string) => action === "bet" || action === "raise" || action === "all-in";

const VERB: Record<string, string> = { fold: "FOLD", check: "CHECK", call: "CALL", bet: "BET", raise: "RAISE TO", "all-in": "ALL-IN" };

export function contextLine(s: HandState, v: HeroView, in_position?: boolean): string {
    const street = s.street[0].toUpperCase() + s.street.slice(1);
    const where = in_position === undefined ? "" : in_position ? " (in position)" : " (out of position)";
    return `Hand #${s.hand_number ?? "?"} · ${street} · you: ${v.position}${where}`;
}

/** Plain text for the panel: no em or en dashes, single spaces. */
function plain(text: string): string {
    return text.replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim();
}

/** A reason split into short sentences (one per line). */
export function sentences(text: string): string[] {
    return plain(text).split(/(?<=[.!?])\s+(?=[A-Z0-9("'])/).map((x) => x.trim()).filter(Boolean);
}

/** Reasoning lines: plain, no repeats, at most MAX_REASON_LINES, never empty. */
function reasonLines(lines: string[], fallback: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const line of lines.map(plain)) {
        const key = line.toLowerCase().replace(/[.!?]+$/, "");
        if (!line || seen.has(key)) continue;
        seen.add(key);
        out.push(line);
    }
    return out.length ? out.slice(0, MAX_REASON_LINES) : [fallback];
}

/** Returns the model with a warning shown first (not repeated when it is already there). */
export function withWarning(model: PanelModel, text: string): PanelModel {
    const warning = plain(text);
    if (!warning || model.warnings.includes(warning)) return model;
    return { ...model, warnings: [warning, ...model.warnings] };
}

/** The action line: verb, size in BB and chips, and a bet or raise as a share of the pot. */
function actionOf(s: HandState, v: HeroView, action: string, size_bb: number): PanelModel["action"] {
    const a = action.toLowerCase();
    const verb = VERB[a] ?? a.toUpperCase();
    const b = s.big_blind;
    let size = 0;
    if (a === "call") size = size_bb > 0 ? size_bb : bb(v.to_call, b);
    else if (aggressive(a)) size = size_bb > 0 ? size_bb : a === "all-in" ? bb(v.max_raise_to, b) : 0;
    if (!(size > 0) || !(b > 0)) return { verb };
    const out: PanelModel["action"] = { verb, size_bb: round2(size), chips: round2(size * b) };
    // chips hero adds over the current pot (a raise-to size includes what hero already put in)
    const hero_in = s.seats.find((p) => p.id === s.hero_id)?.street_contribution ?? 0;
    const added = size * b - hero_in;
    if (aggressive(a) && v.pot > 0 && added > 0 && size * b > s.current_bet) out.pot_share = round2(added / v.pot);
    return out;
}

/** The table notes that change decisions. An "Effective stack" note is left out: the spot shows it live. */
function tableNotes(inputs: OverlayInputs): string[] {
    return (inputs.notes ?? []).map((n) => plain(n)).filter((n) => n && !/^effective stack/i.test(n));
}

function spotOf(inputs: OverlayInputs, in_position?: boolean): PanelModel["spot"] {
    const { state: s, view: v } = inputs;
    const b = (chips: number) => bb(chips, s.big_blind);
    return {
        pot_bb: b(v.pot),
        to_call_bb: b(v.to_call),
        pot_odds: v.pot_odds,
        stack_bb: b(v.stack),
        effective_bb: b(v.effective_stack),
        spr: Math.round(v.spr * 10) / 10,
        spr_label: s.street === "preflop" ? "flop SPR if you call" : "SPR",
        ...(v.min_raise_to !== null ? { min_raise_bb: b(v.min_raise_to), max_raise_bb: b(v.max_raise_to) } : {}),
        ...(in_position !== undefined ? { in_position } : {}),
        notes: tableNotes(inputs)
    };
}

function handOf(s: HandState): PanelModel["hand"] {
    const h = describeHand(s.hero_cards, s.board);
    const hand: PanelModel["hand"] = { cards: [...s.hero_cards], board: [...s.board], made: h.made };
    if (h.draws.length) {
        const odds = s.board.length === 3
            ? `${pct(h.hit_next)} next card, ${pct(h.hit_by_river)} by the river`
            : `${pct(h.hit_next)} on the river`;
        hand.draws = `${h.draws.join(" + ")}: ${h.outs} outs, ${odds}`;
    }
    return hand;
}

function opponentsOf(inputs: OverlayInputs): { opponents: PanelModel["opponents"], more_opponents: number, warnings: string[] } {
    const { cards, more, warnings } = opponentCards({ state: inputs.state, view: inputs.view, players: inputs.players, stats: inputs.stats }, MAX_OPPONENT_CARDS);
    return { opponents: cards, more_opponents: more, warnings };
}

/** Panel for a preflop chart decision. */
export function preflopOverlay(inputs: OverlayInputs, advice: PreflopAdvice, equity: { equity: number, need: number } | null): PanelModel {
    const { state: s, view: v } = inputs;
    const opp = opponentsOf(inputs);
    const odds: PanelModel["odds"] = { chart_spot: advice.scenario };
    if (equity) {
        odds.equity = equity.equity;
        if (equity.need > 0) odds.need = equity.need;
    }
    const fallback = equity
        ? `Chart play for ${advice.scenario}, with ${pct(equity.equity)} equity vs their likely hands.`
        : `Chart play for ${advice.scenario}.`;
    return {
        status: "final",
        tone: toneFor(advice.action),
        source: { label: "Preflop chart" },
        context: contextLine(s, v),
        action: actionOf(s, v, advice.action, advice.size_bb),
        reasoning: reasonLines(sentences(advice.reason), fallback),
        warnings: opp.warnings.map(plain),
        spot: spotOf(inputs),
        hand: handOf(s),
        odds,
        options: [],
        opponents: opp.opponents,
        more_opponents: opp.more_opponents
    };
}

/** A decision's size in BB; an all-in without a size is hero's whole stack. */
function targetBB(v: HeroView, action: string, size_bb: number, big_blind: number): number {
    return action.toLowerCase() === "all-in" && !(size_bb > 0) ? bb(v.max_raise_to, big_blind) : size_bb;
}

/** The candidate a decision picked: same action (bets and raises as one), closest size. */
function chosenCandidate(a: PostflopAnalysis, action: string, size_bb: number, big_blind: number): Candidate | undefined {
    const act = action.toLowerCase();
    if (!aggressive(act)) return a.candidates.find((c) => c.action === act);
    const matched = matchCandidate(a, act, size_bb, big_blind);
    if (!matched || matched.action === "all-in" && act === "all-in" || !(size_bb > 0)) return matched;
    // a size far from every option (an AI size, or an all-in when no option is one) matches none of them
    const off = Math.abs(matched.to / big_blind - size_bb);
    return off <= Math.max(0.26, 0.1 * size_bb) ? matched : undefined;
}

/** The best option of a different kind (bets, raises and all-ins count as one kind). */
function bestAlternative(a: PostflopAnalysis, chosen: Candidate): Candidate | undefined {
    return a.candidates.filter((c) => c !== chosen && c.action !== chosen.action && !(aggressive(c.action) && aggressive(chosen.action)))
        .reduce<Candidate | undefined>((best, c) => (!best || c.ev > best.ev ? c : best), undefined);
}

/** The engine's reasons for a candidate: why this bet, or the equity against the price, and the EV comparison. */
function engineLines(a: PostflopAnalysis, v: HeroView, chosen: Candidate | undefined, big_blind: number, margin_note: boolean): string[] {
    const lines: string[] = [];
    if (margin_note && a.note) lines.push(a.note);
    const bet = chosen ? explainBet(a, chosen) : null;
    if (bet) lines.push(...bet.lines);
    else if (v.to_call > 0 && a.required_equity > 0) {
        const enough = a.equity >= a.required_equity;
        lines.push(`You have ${pct(a.equity)} equity and need ${pct(a.required_equity)} to call${enough ? ": the price is right." : ": not enough for the price."}`);
    } else {
        lines.push(`You have ${pct(a.equity)} equity vs their likely hands${chosen?.action === "check" ? ", and checking is free." : "."}`);
    }
    if (chosen) {
        const alt = bestAlternative(a, chosen);
        const b = (x: number) => signed(x / big_blind);
        lines.push(`${chosen.label[0].toUpperCase()}${chosen.label.slice(1)} is worth about ${b(chosen.ev)} BB${alt ? ` vs ${b(alt.ev)} BB for ${alt.label}` : ""}.`);
    }
    if (!margin_note && a.note && !lines.includes(a.note)) lines.push(a.note);
    return lines;
}

/**
 * Panel for a post-flop decision, or the engine's provisional pick (decision null) while the AI thinks.
 * `budget_ms` is the time the AI was actually given, for the countdown.
 */
export function postflopOverlay(
    inputs: OverlayInputs, a: PostflopAnalysis, decision: PanelDecision | null,
    model_name: string, budget_ms: number
): PanelModel {
    const { state: s, view: v } = inputs;
    const b = s.big_blind;
    const top = a.candidates[0];
    const chosen = decision ?? { action: top.action, size_bb: top.to > 0 ? round2(top.to / b) : 0, reason: "", source: "thinking", confidence: 0 };
    const size_bb = targetBB(v, chosen.action, chosen.size_bb, b);
    const chosen_candidate = chosenCandidate(a, chosen.action, size_bb, b);
    const warnings: string[] = [];

    const options: PanelOption[] = a.candidates.map((c) => {
        const kind = shortTag(a, c);
        return {
            label: c.label,
            ev_bb: round2(c.ev / b),
            chosen: c === chosen_candidate,
            ...(c.fold_chance !== undefined ? { fold_chance: c.fold_chance } : {}),
            ...(c.raise_chance !== undefined ? { raise_chance: c.raise_chance } : {}),
            ...(kind ? { kind } : {})
        };
    });

    // a bet or raise says what kind it is; a check, call or fold picked over a marginal bluff says so
    // (an AI size between options is tagged like the closest one; an all-in only like an all-in option)
    const closest = chosen.action === "all-in" ? chosen_candidate : matchCandidate(a, chosen.action, size_bb, b);
    const bet = closest ? explainBet(a, closest) : null;
    const passive_by_margin = !aggressive(chosen.action) && !!a.note && top?.action === chosen.action;
    let tag: PanelModel["tag"];
    if (bet && closest?.purpose) tag = { text: bet.tag, kind: closest.purpose };
    else if (passive_by_margin) {
        const word = chosen.action === "check" ? "Check" : chosen.action === "call" ? "Call" : "Fold";
        tag = { text: `${word}: a bluff here is too close to call`, kind: "neutral" };
    }

    const engine = engineLines(a, v, chosen_candidate, b, passive_by_margin);
    let source: PanelModel["source"];
    let reasoning: string[];
    if (decision === null) {
        source = { label: "Engine pick", detail: `asking ${model_name} (up to ${Math.round(budget_ms / 1000)}s)` };
        reasoning = engine;
    } else if (decision.source === "llm") {
        source = { label: `AI (${model_name})`, detail: `${pct(decision.confidence)} confident` };
        const family = (x: string) => (x === "raise" ? "bet" : x);
        if (family(top.action) !== family(decision.action)) warnings.push(`The AI disagrees with the engine's top option (${top.label}).`);
        reasoning = sentences(decision.reason);
        if (!reasoning.length) reasoning = engine;
    } else if (decision.source === "engine") {
        source = {
            label: "Engine",
            detail: decision.ai_skipped === "off" ? "close spot, AI off" : decision.ai_skipped === "time" ? "close spot, no time for AI" : "clear spot"
        };
        reasoning = engine;
    } else {
        source = { label: "Engine", detail: "AI fallback" };
        const first = sentences(decision.reason)[0];
        if (first) warnings.push(first);
        reasoning = engine;
    }

    const opp = opponentsOf(inputs);
    warnings.push(...opp.warnings);
    const odds: PanelModel["odds"] = { equity: a.equity, equity_when_called: a.equity_when_called };
    if (v.to_call > 0 && a.required_equity > 0) odds.need = a.required_equity;

    return {
        status: decision === null ? "thinking" : "final",
        tone: toneFor(chosen.action),
        source,
        context: contextLine(s, v, a.in_position),
        action: actionOf(s, v, chosen.action, chosen.size_bb),
        ...(tag ? { tag } : {}),
        reasoning: reasonLines(reasoning, `${chosen.action[0].toUpperCase()}${chosen.action.slice(1)} is the engine's best option here.`),
        warnings: [...new Set(warnings.map(plain))],
        ...(decision === null ? { thinking: { model: model_name, budget_ms, started_at: Date.now() } } : {}),
        spot: spotOf(inputs, a.in_position),
        hand: handOf(s),
        odds,
        options,
        opponents: opp.opponents,
        more_opponents: opp.more_opponents
    };
}

export interface BasicPanelInputs {
    action: string,
    size_bb: number,
    big_blind: number,
    model_name: string,
    reason: string,
    /** The game when it isn't Hold'em (e.g. "Pot Limit Omaha Hi"); null when the hand state is missing. */
    other_game: string | null,
    state_warning?: string
}

/** Panel for the basic prompt (no engine): a hand that isn't Hold'em, or no readable hand state. */
export function basicPanel(p: BasicPanelInputs): PanelModel {
    const a = p.action.toLowerCase();
    const verb = VERB[a] ?? a.toUpperCase();
    const action: PanelModel["action"] = p.size_bb > 0 && (a === "call" || aggressive(a))
        ? { verb, size_bb: round2(p.size_bb), ...(p.big_blind > 0 ? { chips: round2(p.size_bb * p.big_blind) } : {}) }
        : { verb };
    const warnings = [p.other_game
        ? `This hand is ${p.other_game}. The equity engine, preflop charts and opponent stats are Hold'em only, so this is the AI's opinion without any math. Treat it with caution.`
        : "The full hand history couldn't be read, so this used the basic prompt without the engine."];
    const model: PanelModel = {
        status: "final",
        tone: toneFor(a),
        source: { label: `AI (${p.model_name})`, detail: `basic prompt (${p.other_game ? `${p.other_game}: no engine` : "full hand state unavailable"})` },
        context: p.other_game ? `${p.other_game} · no engine` : "Hand state unavailable",
        action,
        reasoning: reasonLines(sentences(p.reason), "The AI gave no reason for this action."),
        warnings,
        spot: { pot_bb: 0, to_call_bb: 0, pot_odds: 0, stack_bb: 0, effective_bb: 0, spr: 0, spr_label: "SPR", notes: [] },
        hand: { cards: [], board: [], made: "" },
        odds: {},
        options: [],
        opponents: [],
        more_opponents: 0
    };
    return p.state_warning ? withWarning(model, p.state_warning) : model;
}
