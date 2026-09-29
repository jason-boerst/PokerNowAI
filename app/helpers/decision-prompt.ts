import { HandState, HeroView } from "../engine/hand-parser.ts";
import { ActionKind, SuggestedAction } from "../engine/legality.ts";
import { describeProfile, PRIORS } from "../engine/player-profile.ts";
import type { PlayerLookup } from "../services/profile-service.ts";
import { PostflopAnalysis } from "../engine/postflop.ts";
import { bb, formatActions, formatSpot } from "../engine/spot-format.ts";

export interface LLMDecision extends SuggestedAction {
    confidence: number,
    reason: string
}

/**
 * Builds the structured post-flop prompt: the table (size, depth, your pool's averages, table notes),
 * full hand, engine numbers, opponent profiles, legal actions. Kept short so the AI answers fast.
 */
export function buildDecisionPrompt(s: HandState, v: HeroView, a: PostflopAnalysis, players: PlayerLookup, notes: string[] = []): string {
    const b = (chips: number) => bb(chips, s.big_blind);
    const lines: string[] = [];
    lines.push(`No-Limit Hold'em cash game${s.bomb_pot ? " (bomb pot)" : ""}, ${s.seats.length} players dealt. ` +
        `Effective stack ${b(v.effective_stack)} BB, SPR ${Math.round(v.spr * 10) / 10}. Amounts are in big blinds (BB).`);
    lines.push(`Players in your games on average: VPIP ${pct(PRIORS.vpip.mean)}, PFR ${pct(PRIORS.pfr.mean)}, 3-bet ${pct(PRIORS.three_bet.mean)}, ` +
        `fold to c-bet ${pct(PRIORS.fold_to_cbet.mean)}, aggression ${pct(PRIORS.aggression.mean)}, showdown ${pct(PRIORS.went_to_showdown.mean)}.`);
    // the live effective stack is on the first line, so a table-level "Effective stack" note is left out
    const table = notes.map((n) => n.trim().replace(/\.+$/, "")).filter((n) => n && !/^effective stack/i.test(n));
    if (table.length) lines.push(`Table: ${table.join("; ")}.`);
    lines.push("Maximize expected value by exploiting each opponent's tendencies.");
    lines.push("");
    lines.push(`Your cards: ${s.hero_cards.join(" ")}. Board: ${s.board.length ? s.board.join(" ") : "none"} (${s.street}).`);
    if (table.some((n) => /7-2 bounty/i.test(n)) && sevenDeuce(s.hero_cards)) {
        lines.push("You hold 7-2: winning this pot may also collect the 7-2 bounty.");
    }
    lines.push(`Spot: ${formatSpot(s, v)}.`);
    lines.push("Hand so far:");
    for (const l of formatActions(s)) lines.push(`  ${l}`);
    lines.push("");
    lines.push("Opponents still in the hand:");
    for (const seat of v.active_opponents) {
        const info = players(seat);
        const p = info.current;
        const stack = `${b(seat.stack)} BB behind`;
        if (!p) {
            lines.push(`  ${seat.position}, ${stack}: no history (assume the averages above).`);
            continue;
        }
        lines.push(`  ${seat.position}, ${stack}: ${describeProfile(p)}. ${p.exploit}`);
        if (info.long && info.session) {
            lines.push(`    long-term: ${info.long.hands} hands, VPIP ${pct(info.long.vpip.value)}, PFR ${pct(info.long.pfr.value)}, aggression ${pct(info.long.aggression.value)}; this session: ${info.session.hands} hands`);
        }
        for (const d of info.deviations) lines.push(`    today: ${d.text}`);
        for (const sd of p.showdowns.slice(0, 2)) {
            lines.push(`    showed ${sd.cards.join(" ")} on ${sd.board.join(" ")} after ${sd.line}`);
        }
    }
    lines.push("");
    lines.push("Engine estimates (Monte Carlo against ranges estimated from each opponent's stats and actions; approximate):");
    lines.push(`  Your equity: ${pct(a.equity)}. Equity when a bet/raise gets called: ${pct(a.equity_when_called)}.${v.to_call > 0 ? ` Equity needed to call: ${pct(a.required_equity)}.` : ""}`);
    lines.push(`  You are ${a.in_position ? "in position" : "out of position"}.`);
    lines.push("  Rough EV of each option (models the next bet or raise on this street, not later streets):");
    for (const c of a.candidates) {
        const fold = a.fold_probability.get(c.to);
        lines.push(`    ${c.label}: ${sign(b(c.ev))} BB${fold !== undefined ? ` (everyone folds ~${pct(fold)})` : ""}`);
    }
    lines.push("");
    lines.push(`Legal actions: ${legalActions(v, s.big_blind).join("; ")}.`);
    lines.push("Use the engine numbers as inputs, not orders: adjust for the opponents' tendencies, the board texture, future streets and the table rules.");
    lines.push("");
    lines.push("Reply with ONLY a JSON object, no other text:");
    lines.push('{"action": "fold|check|call|bet|raise|all-in", "size_bb": <total bet or raise-to in BB, 0 otherwise>, "confidence": <0-1>, "reason": "<one short sentence: why, and which opponent tendency matters>"}');
    return lines.join("\n");
}

/** True for a 7 and a 2 as hole cards (the 7-2 bounty hand). */
function sevenDeuce(cards: string[]): boolean {
    return cards.length === 2 && cards.map((c) => c[0]).sort().join("") === "27";
}

function legalActions(v: HeroView, big_blind: number): string[] {
    const out: string[] = [];
    if (v.to_call > 0) out.push("fold", `call ${bb(v.to_call, big_blind)}`);
    else out.push("check");
    if (v.min_raise_to !== null) {
        const verb = v.to_call > 0 ? "raise to" : "bet";
        out.push(`${verb} between ${bb(v.min_raise_to, big_blind)} and ${bb(v.max_raise_to, big_blind)}`);
    }
    out.push(`all-in (${bb(v.max_raise_to, big_blind)})`);
    return out;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const sign = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1);

const ACTIONS: ActionKind[] = ["fold", "check", "call", "bet", "raise", "all-in"];

/** Parses the model's JSON reply; tolerates code fences and surrounding text. Returns null if unusable. */
export function parseDecision(text: string): LLMDecision | null {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    let obj: any;
    try {
        obj = JSON.parse(match[0]);
    } catch {
        return null;
    }
    const raw_action = String(obj.action ?? "").toLowerCase().replace(/[\s_]+/g, "-").replace("allin", "all-in");
    const action = ACTIONS.find((a) => a === raw_action);
    if (!action) return null;
    const size = Number(obj.size_bb ?? 0);
    const confidence = Number(obj.confidence);
    return {
        action,
        size_bb: Number.isFinite(size) ? size : 0,
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
        reason: String(obj.reason ?? "").slice(0, 400)
    };
}
