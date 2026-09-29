// Builds the content of the in-game suggestion overlay: everything needed to decide at a glance.
import { HandState, HeroView } from "../engine/hand-parser.ts";
import { describeHand } from "../engine/hand-strength.ts";
import { ObservedStats, opponentModels } from "../engine/opponent-range.ts";
import { MIN_HANDS_FOR_TYPE, PlayerRef } from "../engine/player-profile.ts";
import type { PlayerLookup } from "../services/profile-service.ts";
import { PostflopAnalysis } from "../engine/postflop.ts";
import { PreflopAdvice } from "../engine/preflop.ts";
import { rangePercent } from "../engine/ranges.ts";
import { bb } from "../engine/spot-format.ts";

export interface OverlaySection {
    title: string,
    lines: string[]
}

export interface OverlayContent {
    /** "thinking" while waiting for the AI (shown with the engine's provisional pick), else "final". */
    status: "thinking" | "final",
    /** Who decided, e.g. "Engine · clear spot". */
    header: string,
    /** Which hand and street this is for, so a stale suggestion is obvious. */
    context: string,
    action: string,
    size_bb: number,
    big_blind: number,
    sections: OverlaySection[],
    warnings: string[],
    reason: string
}

export interface OverlayInputs {
    state: HandState,
    view: HeroView,
    players: PlayerLookup,
    stats: (player: PlayerRef) => ObservedStats | undefined,
    /** Table notes from the game rules, e.g. "Antes in play" or "7-2 bounty on: 3 BB from each player". */
    notes?: string[]
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;

export function contextLine(s: HandState, v: HeroView): string {
    const street = s.street[0].toUpperCase() + s.street.slice(1);
    return `Hand #${s.hand_number ?? "?"} · ${street} · you: ${v.position}`;
}

/**
 * The table notes on one line (none when there are no notes). An "Effective stack" note is left out:
 * the Spot section already shows the live effective stack.
 */
function tableSection(inputs: OverlayInputs): OverlaySection[] {
    const notes = (inputs.notes ?? []).map((n) => n.trim()).filter((n) => n && !/^effective stack/i.test(n));
    return notes.length ? [{ title: "Table", lines: [notes.join(" · ")] }] : [];
}

function spotSection(s: HandState, v: HeroView): OverlaySection {
    const b = (chips: number) => bb(chips, s.big_blind);
    const to_call = v.to_call > 0 ? `To call ${b(v.to_call)} BB (${pct(v.pot_odds)} of pot after calling)` : "No bet to call";
    return {
        title: "Spot",
        lines: [
            `Pot ${b(v.pot)} BB · ${to_call}`,
            `Your stack ${b(v.stack)} BB · effective ${b(v.effective_stack)} BB · SPR ${Math.round(v.spr * 10) / 10}`,
            ...(v.min_raise_to !== null ? [`Min raise to ${b(v.min_raise_to)} BB · max ${b(v.max_raise_to)} BB`] : [])
        ]
    };
}

function handSection(s: HandState): OverlaySection {
    const h = describeHand(s.hero_cards, s.board);
    const lines = [`${s.hero_cards.join(" ")}${s.board.length ? ` on ${s.board.join(" ")}` : ""}: ${h.made}`];
    if (h.draws.length) {
        const odds = s.board.length === 3
            ? `${pct(h.hit_next)} next card, ${pct(h.hit_by_river)} by the river`
            : `${pct(h.hit_next)} on the river`;
        lines.push(`${h.draws.join(" + ")}: ${h.outs} outs to a straight/flush, ${odds}`);
    }
    return { title: "Your hand", lines };
}

function opponentsSection(inputs: OverlayInputs, warnings: string[]): OverlaySection {
    const { state: s, view: v } = inputs;
    const b = (chips: number) => bb(chips, s.big_blind);
    const models = new Map(opponentModels(s, inputs.stats).map((m) => [m.seat.id, m]));
    const lines: string[] = [];
    const facing_bet = v.to_call > 0;
    let unknown = 0;
    const shown = v.active_opponents.slice(0, 4);
    for (const seat of shown) {
        const info = inputs.players(seat);
        const p = info.current;
        const range = models.get(seat.id);
        const range_text = range ? ` · range ~${Math.round(rangePercent(range.model.range))}%` : "";
        if (!p || p.hands < MIN_HANDS_FOR_TYPE) unknown++;
        if (!p) {
            lines.push(`${seat.position} ${seat.name} · ${b(seat.stack)} BB · no history${range_text}`);
            continue;
        }
        const history = info.long && info.session ? `${info.long.hands} before + ${info.session.hands} today`
            : info.session ? `${info.session.hands} today` : `${p.hands}`;
        lines.push(`${seat.position} ${seat.name} · ${b(seat.stack)} BB · ${p.type} (${history} hands)${range_text}`);
        // the stats that matter for this decision: facing a bet -> how often they bluff/barrel;
        // able to bet -> how often they fold
        const key = facing_bet
            ? `aggression ${pct(p.aggression.value)} [${p.aggression.n}], goes to showdown ${pct(p.went_to_showdown.value)} [${p.went_to_showdown.n}]`
            : `folds to c-bet ${pct(p.fold_to_cbet.value)} [${p.fold_to_cbet.n}], goes to showdown ${pct(p.went_to_showdown.value)} [${p.went_to_showdown.n}]`;
        lines.push(`   VPIP ${pct(p.vpip.value)} PFR ${pct(p.pfr.value)} · ${key}`);
        if (info.long && info.session && info.session.hands > 0) {
            const today = info.session;
            const raw = (r: { k: number, n: number }) => r.n ? `${Math.round(r.k / r.n * 100)}%` : "-";
            lines.push(`   usually VPIP ${pct(info.long.vpip.value)} PFR ${pct(info.long.pfr.value)} · today ${raw(today.vpip)} / ${raw(today.pfr)} over ${today.hands} hands`);
        }
        for (const d of info.deviations) lines.push(`   ⚑ ${d.text}`);
        const sd = p.showdowns[0];
        if (sd) lines.push(`   last showdown: ${sd.cards.join(" ")} after ${sd.line.replace(/\w+: /g, "").replace(/ \| /g, ", ")}`);
    }
    if (v.active_opponents.length > shown.length) lines.push(`+${v.active_opponents.length - shown.length} more opponent(s)`);
    if (unknown > 0) warnings.push(`${unknown} opponent(s) have under ${MIN_HANDS_FOR_TYPE} hands: their stats are mostly population defaults.`);
    return { title: `Opponents in the hand (${v.active_opponents.length})`, lines };
}

/** Overlay for a preflop chart decision. */
export function preflopOverlay(inputs: OverlayInputs, advice: PreflopAdvice, equity: { equity: number, need: number } | null): OverlayContent {
    const { state: s, view: v } = inputs;
    const warnings: string[] = [];
    const math: string[] = [];
    if (equity) math.push(`Equity ${pct(equity.equity)} vs their likely hands${equity.need > 0 ? ` · need ${pct(equity.need)} to call` : ""}`);
    math.push(`Chart spot: ${advice.scenario}`);
    return {
        status: "final",
        header: "Preflop chart",
        context: contextLine(s, v),
        action: advice.action,
        size_bb: advice.size_bb,
        big_blind: s.big_blind,
        sections: [...tableSection(inputs), spotSection(s, v), handSection(s), { title: "Odds", lines: math }, opponentsSection(inputs, warnings)],
        warnings,
        reason: advice.reason
    };
}

/**
 * Overlay for a post-flop decision (or the engine's provisional pick while the AI thinks).
 * `llm_timeout_ms` is the time the AI was actually given (its budget), shown while it thinks.
 */
export function postflopOverlay(
    inputs: OverlayInputs, a: PostflopAnalysis,
    decision: { action: string, size_bb: number, reason: string, source: string, confidence: number, ai_skipped?: string } | null,
    model_name: string, llm_timeout_ms: number
): OverlayContent {
    const { state: s, view: v } = inputs;
    const warnings: string[] = [];
    const b = s.big_blind;
    const top = a.candidates[0];
    const chosen = decision ?? { action: top.action, size_bb: top.to > 0 ? Math.round(top.to / b * 100) / 100 : 0, reason: "", source: "thinking", confidence: 0 };

    const odds = [
        `Equity ${pct(a.equity)} vs their likely hands · ${pct(a.equity_when_called)} if a bet gets called`,
        v.to_call > 0 ? `Need ${pct(a.required_equity)} to call · you are ${a.in_position ? "in position" : "out of position"}` : `You are ${a.in_position ? "in position" : "out of position"}`
    ];
    const options = a.candidates.map((c) => {
        const fold = a.fold_probability.get(c.to);
        const is_chosen = c.action === chosen.action || (c.action === "bet" && chosen.action === "raise") || (c.action === "raise" && chosen.action === "bet");
        const same_size = !chosen.size_bb || Math.abs(c.to / b - chosen.size_bb) < 0.26;
        const mark = is_chosen && same_size ? "▶ " : "   ";
        return `${mark}${c.label}: ${signed(c.ev / b)} BB${fold !== undefined ? ` (all fold ~${pct(fold)})` : ""}`;
    });

    let header: string;
    if (decision === null) {
        header = `Engine pick · asking ${model_name} (up to ${Math.round(llm_timeout_ms / 1000)}s)`;
    } else if (decision.source === "llm") {
        header = `AI (${model_name}) · ${pct(decision.confidence)} confident`;
        const agrees = top.action === decision.action || (top.action === "bet" && decision.action === "raise") || (top.action === "raise" && decision.action === "bet");
        if (!agrees) warnings.push(`The AI disagrees with the engine's top option (${top.label}).`);
    } else if (decision.source === "engine") {
        header = decision.ai_skipped === "off" ? "Engine · close spot (AI off)"
            : decision.ai_skipped === "time" ? "Engine · close spot (no time for AI)"
            : "Engine · clear spot";
    } else {
        header = "Engine (AI fallback)";
        warnings.push(decision.reason.split(". ")[0] + ".");
    }

    return {
        status: decision === null ? "thinking" : "final",
        header,
        context: contextLine(s, v),
        action: chosen.action,
        size_bb: chosen.size_bb,
        big_blind: b,
        sections: [
            ...tableSection(inputs),
            spotSection(s, v),
            handSection(s),
            { title: "Odds", lines: odds },
            { title: "Options (rough EV)", lines: options },
            opponentsSection(inputs, warnings)
        ],
        warnings,
        reason: decision?.reason ?? "Waiting for the AI; this is the engine's best option so far."
    };
}
