import { HAND_RANKING } from "./hand-ranking.ts";
import { comboCount, combosOf, HandClass } from "./hand-classes.ts";

/** A range: hand classes with a weight between 0 and 1 (share of that class's combos in the range). */
export type Range = Map<HandClass, number>;

const TOTAL_COMBOS = 1326;
export const RANKED_CLASSES: HandClass[] = HAND_RANKING.map(([cls]) => cls);

/** Classes making up the strongest `pct` (0-100) of all combos, by the preflop ranking. */
export function topRange(pct: number): Range {
    return rangeBetween(0, pct);
}

/**
 * Classes between two percentiles of the ranking, e.g. rangeBetween(10, 35) is the hands a player
 * plays (top 35%) minus the ones they'd raise with (top 10%). The class straddling a boundary is
 * included partially.
 */
export function rangeBetween(from_pct: number, to_pct: number): Range {
    const from = Math.max(0, Math.min(100, from_pct)) / 100 * TOTAL_COMBOS;
    const to = Math.max(0, Math.min(100, to_pct)) / 100 * TOTAL_COMBOS;
    const range: Range = new Map();
    let cumulative = 0;
    for (const cls of RANKED_CLASSES) {
        const n = comboCount(cls);
        const start = cumulative;
        const end = cumulative + n;
        cumulative = end;
        const overlap = Math.min(end, to) - Math.max(start, from);
        if (overlap > 0) range.set(cls, overlap / n);
    }
    return range;
}

/** Share of all 1326 combos in the range, 0-100. */
export function rangePercent(range: Range): number {
    let combos = 0;
    for (const [cls, w] of range) combos += comboCount(cls) * w;
    return combos / TOTAL_COMBOS * 100;
}

export interface WeightedCombo {
    cards: [number, number],
    weight: number
}

/** Expands a range into concrete card combos, dropping any that use a dead card. */
export function expandRange(range: Range, dead: Set<number> = new Set()): WeightedCombo[] {
    const out: WeightedCombo[] = [];
    for (const [cls, w] of range) {
        if (w <= 0) continue;
        for (const cards of combosOf(cls)) {
            if (!dead.has(cards[0]) && !dead.has(cards[1])) out.push({ cards, weight: w });
        }
    }
    return out;
}

export type PreflopLine = "raise" | "3bet" | "4bet" | "call_raise" | "limp" | "check_bb" | "unknown";

export interface PreflopTendencies {
    /** Voluntarily put money in pot, 0-100. */
    vpip: number,
    /** Preflop raise, 0-100. */
    pfr: number
}

/**
 * Estimated preflop range from a player's tendencies and what they did this hand.
 * Raisers get the top of their PFR range, callers get the part of their VPIP range they didn't raise,
 * and re-raises narrow sharply. These are standard modeling approximations, not solver ranges.
 */
export function preflopRange(line: PreflopLine, t: PreflopTendencies): Range {
    const vpip = clamp(t.vpip, 5, 95);
    const pfr = clamp(Math.min(t.pfr, vpip), 2, vpip);
    switch (line) {
        case "raise": return topRange(pfr);
        case "3bet": return topRange(clamp(pfr / 3, 2, 15));
        case "4bet": return topRange(clamp(pfr / 8, 1.5, 6));
        case "call_raise": return rangeBetween(Math.min(pfr * 0.35, 6), vpip * 0.8);
        case "limp": return rangeBetween(Math.min(pfr * 0.5, 8), vpip);
        case "check_bb": return rangeBetween(pfr, 100);
        case "unknown": return topRange(vpip);
    }
}

function clamp(x: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, x));
}
