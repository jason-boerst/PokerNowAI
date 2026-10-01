// Plain-language labels for a suggested bet or raise: value, semi-bluff or bluff, and whether it is a
// lead into the last aggressor, a c-bet, a barrel..., with the numbers behind it.
import type { Candidate, PostflopAnalysis } from "../engine/postflop.ts";
import type { BetRole } from "../engine/response-calibration.ts";

const pct = (x: number) => `${Math.round(x * 100)}%`;

const PURPOSE_NAME = { value: "Value bet", "semi-bluff": "Semi-bluff", bluff: "Bluff" } as const;
/** Panel colors: green for value, amber for semi-bluffs, red for bluffs. */
const PURPOSE_COLOR = { value: "#4ade80", "semi-bluff": "#fbbf24", bluff: "#f87171" } as const;
const ROLE_NOUN: Record<BetRole, string> = { cbet: "c-bet", barrel: "barrel", delayed: "delayed bet", lead: "lead", stab: "stab" };

/** What kind of bet hero is making, in words, e.g. "lead into the preflop raiser". */
export function roleText(role: BetRole | undefined, street: string | undefined, raise: boolean): string {
    if (raise || !role) return "raise";
    switch (role) {
        case "cbet": return "c-bet (you raised preflop)";
        case "barrel": return `barrel (you bet the ${street === "river" ? "turn" : "flop"} and got called)`;
        case "delayed": return "delayed bet (the last street was checked through)";
        case "lead": return street === "flop" || !street ? "lead into the preflop raiser" : "lead into the last bettor";
        case "stab": return "stab (they checked, or nobody has bet yet)";
    }
}

/** The bet or raise option closest to a suggested action and size (undefined for checks, calls and folds). */
export function matchCandidate(a: PostflopAnalysis, action: string, size_bb: number, big_blind: number): Candidate | undefined {
    const options = a.candidates.filter((c) => c.purpose !== undefined);
    if (!["bet", "raise", "all-in"].includes(action) || options.length === 0) return undefined;
    if (action === "all-in") {
        const all_in = options.find((c) => c.action === "all-in");
        if (all_in) return all_in;
    }
    const distance = (c: Candidate) => Math.abs(c.to / big_blind - size_bb);
    return options.reduce((best, c) => (distance(c) < distance(best) ? c : best));
}

export interface BetExplanation {
    /** e.g. "Bluff · lead into the preflop raiser" */
    tag: string,
    color: string,
    lines: string[]
}

/** Why this bet: its purpose, the folds it needs vs the folds expected, raise risk, and what the numbers come from. */
export function explainBet(a: PostflopAnalysis, c: Candidate): BetExplanation | null {
    if (!c.purpose) return null;
    const raise = c.action === "raise" || !a.bet_role;
    const tag = `${PURPOSE_NAME[c.purpose]} · ${roleText(a.bet_role, a.street, raise)}`;
    const lines: string[] = [];
    const called = c.called_equity ?? 0;
    if (c.purpose === "value") lines.push(`The hands that call are mostly worse: about ${pct(called)} equity when called.`);
    else if (c.purpose === "semi-bluff") lines.push(`Wins now if they fold (about ${pct(c.fold_chance ?? 0)}), with ${pct(called)} equity if called.`);
    else lines.push(`Wins only if they fold: needs ${pct(c.needs_folds ?? 0)} folds, expect about ${pct(c.fold_chance ?? 0)}.`);
    if ((c.raise_chance ?? 0) >= 0.08) lines.push(`Gets raised about ${pct(c.raise_chance!)} of the time.`);
    if (c.response && a.bet_role) {
        const source = c.response.n > 0 ? `${c.response.n} similar spots` : "estimate";
        lines.push(`Your games vs a ${a.street} ${ROLE_NOUN[a.bet_role]} this size: ${pct(c.response.fold)} fold, ${pct(c.response.raise)} raise (${source}).`);
    }
    return { tag, color: PURPOSE_COLOR[c.purpose], lines };
}

/** One short line for option lists: "bluff, lead" / "value, c-bet". */
export function shortTag(a: PostflopAnalysis, c: Candidate): string {
    if (!c.purpose) return "";
    const kind = c.action === "raise" || !a.bet_role ? "raise" : ROLE_NOUN[a.bet_role];
    return `${c.purpose}, ${kind}`;
}

const RANK_ORDER = "AKQJT98765432";
const SUIT_SYMBOL: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

/** "If called: bet the turn on about 60% of cards (A, K, any ♥), check the rest." */
export function betPlanLine(plan: { barrel_rate: number, ranks: string[], suits: string[] }, next: string): string {
    const rate = plan.barrel_rate;
    if (rate >= 0.9) return `If called: keep betting the ${next} on almost any card.`;
    if (rate <= 0.1) return `If called: check the ${next} on almost every card.`;
    const ranks = plan.ranks.map((r) => (r === "T" ? "10" : r));
    const missing = RANK_ORDER.split("").filter((r) => !plan.ranks.includes(r)).map((r) => (r === "T" ? "10" : r));
    const suits = plan.suits.map((u) => `any ${SUIT_SYMBOL[u] ?? u}`);
    const where = ranks.length <= 6 ? [...ranks, ...suits].join(", ")
        : missing.length ? `any card but ${missing.join(", ")}${suits.length ? `, or ${suits.join(", ")}` : ""}` : "";
    return `If called: bet the ${next} again on about ${Math.round(rate * 100)}% of cards${where ? ` (${where})` : ""} and check the rest (the engine's estimate from how your games fold to ${next} bets).`;
}
