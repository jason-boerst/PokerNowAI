import { RANKS } from "./cards.ts";
import { HAND_RANKING } from "./hand-ranking.ts";
import { comboCount, combosOf, HandClass } from "./hand-classes.ts";

/** A range: hand classes with a weight between 0 and 1 (share of that class's combos in the range). */
export type Range = Map<HandClass, number>;

const TOTAL_COMBOS = 1326;
/** The 169 classes by preflop strength (all-in equity against a random hand), strongest first. */
export const RANKED_CLASSES: HandClass[] = HAND_RANKING.map(([cls]) => cls);

// Playability adjustments, in the equity units of HAND_RANKING. Assumptions, chosen so the order
// matches how loose players pick the hands they call and limp with (see PLAYABILITY_CLASSES).
const PAIR_BONUS = 0.10;
const SUITED_BONUS = 0.04;
/** For two cards that make 4 different straights together (like 76), suited; half that offsuit. */
const STRAIGHT_BONUS = 0.12;
/** Offsuit hands that can't make a straight with both cards and aren't ace-high (K7o, Q5o). */
const OFFSUIT_JUNK_PENALTY = 0.04;

/** Number of straights (A-5 up to T-A) that use both ranks: 4 for connectors like 76, 1 for AK or A5, 0 for K7. */
function straightsWith(r1: string, r2: string): number {
    const values = (r: string) => {
        const v = RANKS.indexOf(r) + 2;
        return v === 14 ? [1, 14] : [v];
    };
    let n = 0;
    for (let low = 1; low <= 10; low++) {
        const fits = (r: string) => values(r).some((v) => v >= low && v <= low + 4);
        if (fits(r1) && fits(r2)) n++;
    }
    return n;
}

function playabilityBonus(cls: HandClass): number {
    if (cls.length === 2) return PAIR_BONUS;
    const straights = straightsWith(cls[0], cls[1]);
    if (cls[2] === "s") return SUITED_BONUS + STRAIGHT_BONUS * straights / 4;
    if (straights > 0) return STRAIGHT_BONUS / 2 * straights / 4;
    return cls[0] === "A" ? 0 : -OFFSUIT_JUNK_PENALTY;
}

/**
 * The 169 classes by how well they play as a call or a limp, best first. Loose home players call
 * with pairs (to hit a set), suited hands and connected hands far more often than with offsuit
 * hands like K7o or Q8o, which rank higher on all-in equity alone. Starts from HAND_RANKING and
 * adds bonuses for pairs, suitedness and straight chances, and a penalty for unconnected offsuit
 * hands that aren't ace-high; ties keep the strength order, so the result is deterministic.
 * With these bonuses 22, 76s and 65s are in the top 30% while Q8o, K7o and K2o are not.
 */
export const PLAYABILITY_CLASSES: HandClass[] = HAND_RANKING
    .map(([cls, strength], i) => ({ cls, score: strength + playabilityBonus(cls), i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.cls);

/** Classes making up the best `pct` (0-100) of all combos, by strength unless another ranking is given. */
export function topRange(pct: number, ranking: HandClass[] = RANKED_CLASSES): Range {
    return rangeBetween(0, pct, ranking);
}

/**
 * Classes between two percentiles of a ranking (strength by default), e.g. rangeBetween(10, 35) is
 * the hands a player plays (top 35%) minus the ones they'd raise with (top 10%). The class
 * straddling a boundary is included partially.
 */
export function rangeBetween(from_pct: number, to_pct: number, ranking: HandClass[] = RANKED_CLASSES): Range {
    const from = Math.max(0, Math.min(100, from_pct)) / 100 * TOTAL_COMBOS;
    const to = Math.max(0, Math.min(100, to_pct)) / 100 * TOTAL_COMBOS;
    const range: Range = new Map();
    let cumulative = 0;
    for (const cls of ranking) {
        const n = comboCount(cls);
        const start = cumulative;
        const end = cumulative + n;
        cumulative = end;
        const overlap = Math.min(end, to) - Math.max(start, from);
        if (overlap > 0) range.set(cls, overlap / n);
    }
    return range;
}

/**
 * A player's range of `total_pct` of all combos: the strongest `strong_pct` (their raising hands,
 * by strength) topped up with the most playable of the other hands (their calling and limping
 * hands). The raising hands get `strong_weight`: 1 keeps them, 0 leaves only the other hands.
 */
function playingRange(strong_pct: number, total_pct: number, strong_weight: number): Range {
    const strong = topRange(strong_pct);
    const range: Range = new Map();
    if (strong_weight > 0) for (const [cls, w] of strong) range.set(cls, w * strong_weight);
    let left = Math.max(0, Math.min(100, total_pct) - rangePercent(strong)) / 100 * TOTAL_COMBOS;
    for (const cls of PLAYABILITY_CLASSES) {
        if (left <= 1e-9) break;
        const free = 1 - (strong.get(cls) ?? 0);
        if (free <= 0) continue;
        const n = comboCount(cls);
        const take = Math.min(free, left / n);
        range.set(cls, (range.get(cls) ?? 0) + take);
        left -= take * n;
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

/**
 * What a player did preflop. "call_raise": called a raise (and maybe a 3-bet after it);
 * "call_3bet": opened and then called a re-raise; "cold_call_3bet": first put money in by calling
 * two or more raises; "limp_raise": limped, then raised after someone raised (or the big blind
 * raised); "check_bb": checked their blind or straddle.
 */
export type PreflopLine = "raise" | "3bet" | "4bet" | "limp_raise" | "call_raise" | "call_3bet" | "cold_call_3bet" | "limp" | "check_bb" | "unknown";

export interface PreflopTendencies {
    /** Voluntarily put money in pot, 0-100. */
    vpip: number,
    /** Preflop raise, 0-100. */
    pfr: number,
    /** Preflop 3-bet frequency when facing a single raise, 0-100 (optional; estimated from PFR when missing). */
    three_bet?: number
}

/**
 * Share of their raising hands a player who calls a raise still has: home players often just call
 * with big pairs and AK instead of re-raising (assumption; your games' showdowns fit this better
 * than never). Limpers are assumed to raise those, since they could have raised first.
 */
const SLOWPLAY_SHARE = 0.25;

/**
 * Share of 7-2 combos in a raising range when the game pays a bounty for winning with 7-2. In your
 * stored games (all with the bounty) at least 4% of preflop raises and 6% of 3-bets showed 7-2,
 * which is about what raising it every time, and 3-betting it most of the time, gives.
 */
const SEVEN_DEUCE_SHARE: Partial<Record<PreflopLine, number>> = { "raise": 1, "3bet": 0.8, "4bet": 0.3, "limp_raise": 0.5 };
/** 7-2 is at most this share of a raising range, so a tight player's rare 3-bets stay mostly big hands. */
const SEVEN_DEUCE_MAX = 0.15;
/** All 7-2 combos as a percent of all hands (about 1.2). */
const SEVEN_DEUCE_PCT = (comboCount("72o") + comboCount("72s")) / TOTAL_COMBOS * 100;

/**
 * Share of all hands (0-100) a player 3-bets with. A 3-bet frequency is measured per chance (facing
 * one raise), so it is also about the share of starting hands they 3-bet with. Without it, about a
 * third of their PFR. `reraise` widens or narrows it for the spot (see reraiseFactor).
 */
function threeBetPercent(t: PreflopTendencies, pfr: number, reraise: number): number {
    if (isPercent(t.three_bet)) return clamp(t.three_bet * reraise, 2, 25);
    return clamp(pfr / 3 * reraise, 2, 15);
}

/**
 * Share of all hands a player 4-bets with: about 40% of their 3-bet range, or an eighth of PFR when their
 * 3-bet frequency is unknown. `reraise` widens it for the spot (see fourBetFactor).
 */
function fourBetPercent(t: PreflopTendencies, pfr: number, reraise = 1): number {
    const base = isPercent(t.three_bet) ? clamp(t.three_bet * 0.4, 1.5, 8) : clamp(pfr / 8, 1.5, 6);
    return clamp(base * reraise, 1.5, 16);
}

/** Details of the spot that change a range beyond the player's tendencies and seat. */
export interface RangeContext {
    /**
     * Scales a 3-bet or 4-bet range for the spot (see reraiseFactor and fourBetFactor in opponent-range.ts);
     * 1 = their usual range.
     */
    reraise?: number,
    /** The game pays a bounty for winning a hand with 7-2, so raises and re-raises include 7-2. */
    seven_deuce_bounty?: boolean
}

/**
 * Estimated preflop range from a player's tendencies and what they did this hand.
 * Raisers get the top of their PFR range by strength; callers and limpers get the most playable
 * hands of their VPIP range that they didn't raise with (plus a few big hands they slowplay);
 * re-raises narrow sharply, using the player's measured 3-bet frequency when known. These are
 * standard modeling approximations, not solver ranges; the shapes of the calling lines were
 * checked against the hands players showed down in your stored games.
 */
export function preflopRange(line: PreflopLine, t: PreflopTendencies, position_width: PositionWidth = { raise: 1, call: 1 }, context: RangeContext = {}): Range {
    const vpip = clamp(t.vpip, 5, 95);
    const pfr = clamp(Math.min(t.pfr, vpip), 2, vpip);
    // a raising range of `pct`; in a 7-2 bounty game part of it is 7-2 (their stats already count those raises)
    const raising = (pct: number): Range => {
        const share = context.seven_deuce_bounty ? SEVEN_DEUCE_SHARE[line] ?? 0 : 0;
        const weight = Math.min(share, SEVEN_DEUCE_MAX * pct / SEVEN_DEUCE_PCT);
        if (weight <= 0) return topRange(pct);
        const range = topRange(pct - weight * SEVEN_DEUCE_PCT);
        for (const cls of ["72o", "72s"]) range.set(cls, Math.min(1, (range.get(cls) ?? 0) + weight));
        return range;
    };
    switch (line) {
        case "raise": return raising(clamp(pfr * position_width.raise, 2, 90));
        case "3bet": return raising(threeBetPercent(t, pfr, context.reraise ?? 1));
        case "4bet": return raising(fourBetPercent(t, pfr, context.reraise ?? 1));
        // about as strong as their 3-bets (your games' limp-raisers showed big pairs, AK, AQ and middle pairs)
        case "limp_raise": return raising(clamp(threeBetPercent(t, pfr, 1), 3, 6));
        case "call_raise": return playingRange(Math.min(pfr * 0.35, 6), clamp(vpip * 0.8 * position_width.call, 5, 90), SLOWPLAY_SHARE);
        // what they raise with from their seat (an opener) or from anywhere (a cold caller): in your
        // games players who called a 3-bet showed down about as wide a range as they open, leaning
        // toward playable hands; the best hands count half, since those are often re-raised again
        case "call_3bet":
        case "cold_call_3bet": {
            const width = line === "call_3bet" ? position_width.raise : 1;
            const total = clamp(pfr * width, 5, 40);
            const range = playingRange(total / 2, total, 1);
            for (const [cls, w] of topRange(fourBetPercent(t, pfr))) {
                const kept = (range.get(cls) ?? 0) - w / 2;
                if (kept > 0) range.set(cls, kept); else range.delete(cls);
            }
            return range;
        }
        case "limp": return playingRange(Math.min(pfr * 0.5, 8), vpip, 0);
        case "check_bb": return rangeBetween(pfr, 100);
        // hasn't acted yet: the hands they'd continue with, widened for seats that defend a lot (big blind, heads-up)
        case "unknown": {
            const total = clamp(vpip * position_width.call, 5, 95);
            return playingRange(Math.min(pfr, total), total, 1);
        }
    }
}

/** How much wider (or narrower) than average a player's opening and calling ranges are from a seat. */
export interface PositionWidth {
    raise: number,
    call: number
}

/**
 * A player's PFR/VPIP averages over all seats, but opening ranges depend strongly on position:
 * tight from early seats, wide from the button, very wide heads-up. These multipliers (averaging
 * about 1 over a full table) are assumptions, not measured values.
 */
export function positionWidth(position: string, players_dealt: number): PositionWidth {
    if (players_dealt === 2) {
        return position === "SB" ? { raise: 4, call: 1.5 } : { raise: 1.2, call: 2.5 };
    }
    const raise: Record<string, number> = {
        "UTG": 0.6, "UTG+1": 0.6, "UTG+2": 0.6, "MP": 0.6, "LJ": 0.9, "HJ": 0.9, "CO": 1.4, "BU": 2.0, "SB": 1.5, "BB": 1.0
    };
    const call: Record<string, number> = { "BB": 1.6, "SB": 0.9 };
    return { raise: raise[position] ?? 1, call: call[position] ?? 1 };
}

function isPercent(x: number | undefined): x is number {
    return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

function clamp(x: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, x));
}
