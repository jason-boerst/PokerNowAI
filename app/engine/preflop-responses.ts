// How players in your games answer raises before the flop: fold, call or re-raise, by situation and size.
//
// Measured from stored hands at every start (your own answers left out), blended toward the defaults below while a
// cell has few cases, like the post-flop response table (response-calibration.ts). Each player's own numbers then
// adjust it (preflop-ev.ts): how loose they are (VPIP), how often they 3-bet, and how often they fold to a 3-bet.
import { HandState, SeatState } from "./hand-parser.ts";
import { isHoldem } from "./player-profile.ts";

/**
 * What the player is answering:
 *   open      : a single raise, nobody called it yet, the player hasn't put money in voluntarily
 *   squeeze   : a single raise with one or more callers already in
 *   iso       : a raise over limpers, answered by a player who limped
 *   threebet  : a re-raise, answered by the player who made the first raise
 *   cold3bet  : a re-raise, answered by a player who hasn't raised (called the first raise, or not acted yet)
 *   fourbet   : a raise of a 3-bet (or more), answered by the player who raised before it
 */
export type PreflopSituation = "open" | "squeeze" | "iso" | "threebet" | "cold3bet" | "fourbet";
export const PREFLOP_SITUATIONS: PreflopSituation[] = ["open", "squeeze", "iso", "threebet", "cold3bet", "fourbet"];
/** Blinds answer opens differently (they already have chips in and close the action). */
export type ResponderGroup = "blinds" | "field";
export type PreflopSize = "small" | "medium" | "big";

export interface PreflopResponse { fold: number, call: number, raise: number }
export interface PreflopCell extends PreflopResponse { n: number }
export type PreflopResponseTable = Record<PreflopSituation, Record<ResponderGroup, Record<PreflopSize, PreflopCell>>>;

/**
 * Size buckets. Opens and squeezes are in blind levels (big blinds, or straddles) above the limps they cover:
 * up to 2.75 small, up to 3.75 medium, bigger is big. Re-raises are as a multiple of the raise they answer: up to
 * 3x small, up to 4x medium.
 */
export function preflopSize(situation: PreflopSituation, x: number): PreflopSize {
    if (situation === "open" || situation === "squeeze" || situation === "iso") return x <= 2.75 ? "small" : x <= 3.75 ? "medium" : "big";
    return x <= 3 ? "small" : x <= 4 ? "medium" : "big";
}

/**
 * Defaults for a medium size (assumptions for loose home games, close to what the games this was built from
 * showed), and how size moves them: bigger raises get more folds and fewer calls.
 */
const DEFAULTS: Record<PreflopSituation, Record<ResponderGroup, PreflopResponse>> = {
    open: { field: { fold: 0.8, call: 0.15, raise: 0.05 }, blinds: { fold: 0.62, call: 0.3, raise: 0.08 } },
    squeeze: { field: { fold: 0.75, call: 0.2, raise: 0.05 }, blinds: { fold: 0.55, call: 0.38, raise: 0.07 } },
    iso: { field: { fold: 0.45, call: 0.5, raise: 0.05 }, blinds: { fold: 0.45, call: 0.5, raise: 0.05 } },
    threebet: { field: { fold: 0.45, call: 0.45, raise: 0.1 }, blinds: { fold: 0.45, call: 0.45, raise: 0.1 } },
    cold3bet: { field: { fold: 0.8, call: 0.17, raise: 0.03 }, blinds: { fold: 0.8, call: 0.17, raise: 0.03 } },
    fourbet: { field: { fold: 0.4, call: 0.35, raise: 0.25 }, blinds: { fold: 0.4, call: 0.35, raise: 0.25 } }
};
const SIZE_FOLD: Record<PreflopSize, number> = { small: 0.92, medium: 1, big: 1.1 };
/** Cases each level of defaults counts as. */
const WEIGHT = { situation: 30, cell: 25 };

const normalize = (r: PreflopResponse): PreflopResponse => {
    const fold = Math.min(0.97, Math.max(0.02, r.fold));
    const raise = Math.min(0.6, Math.max(0.005, r.raise));
    return { fold, raise: Math.min(raise, 1 - fold), call: Math.max(0, 1 - fold - Math.min(raise, 1 - fold)) };
};

export function defaultPreflopTable(): PreflopResponseTable {
    const t = {} as PreflopResponseTable;
    for (const sit of PREFLOP_SITUATIONS) {
        t[sit] = {} as PreflopResponseTable[PreflopSituation];
        for (const g of ["blinds", "field"] as ResponderGroup[]) {
            t[sit][g] = {} as Record<PreflopSize, PreflopCell>;
            for (const size of ["small", "medium", "big"] as PreflopSize[]) {
                const d = DEFAULTS[sit][g];
                t[sit][g][size] = { ...normalize({ ...d, fold: d.fold * SIZE_FOLD[size], call: d.call }), n: 0 };
            }
        }
    }
    return t;
}

/** One answer to a raise: the situation, the responder's group, the size and what they did. */
export interface PreflopAnswer { situation: PreflopSituation, group: ResponderGroup, size: PreflopSize, answer: "fold" | "call" | "raise", responder: SeatState }

/** Every answer to a preflop raise in a hand. */
export function preflopAnswers(s: HandState): PreflopAnswer[] {
    if (!isHoldem(s) || s.bomb_pot) return [];
    const pre = s.actions.filter((a) => a.street === "preflop");
    const level = Math.max(s.big_blind, ...pre.filter((a) => a.type === "post_bb" || a.type === "post_straddle").map((a) => a.street_total));
    if (!(level > 0)) return [];
    const seat = (id: string) => s.seats.find((p) => p.id === id)!;
    const out: PreflopAnswer[] = [];
    const raises: typeof pre = [];
    const callers_after_raise: string[] = [];
    const limpers: string[] = [];
    const voluntary = new Set<string>();
    let limps_before_first = 0;
    for (const a of pre) {
        if (a.type === "raise" || a.type === "bet") {
            if (raises.length === 0) limps_before_first = limpers.length;
            raises.push(a);
            callers_after_raise.length = 0;
            voluntary.add(a.player_id);
            continue;
        }
        if (a.type !== "fold" && a.type !== "call" && a.type !== "check") continue;
        const answer = a.type === "fold" ? "fold" : a.type === "call" ? "call" : null;
        if (raises.length === 0) {
            if (a.type === "call") { limpers.push(a.player_id); voluntary.add(a.player_id); }
            continue;
        }
        if (!answer) continue;
        const last = raises[raises.length - 1];
        if (last.player_id === a.player_id) continue;
        const p = seat(a.player_id);
        const group: ResponderGroup = p.position === "SB" || p.position === "BB" ? "blinds" : "field";
        let situation: PreflopSituation;
        let x: number;
        if (raises.length === 1) {
            x = last.street_total / level - limps_before_first;
            situation = limps_before_first > 0 && limpers.includes(a.player_id) ? "iso"
                : callers_after_raise.length > 0 ? "squeeze" : "open";
        } else {
            const before = raises[raises.length - 2];
            x = last.street_total / Math.max(before.street_total, 1e-9);
            situation = raises.length >= 3 && before.player_id === a.player_id ? "fourbet"
                : raises.length === 2 && before.player_id === a.player_id ? "threebet" : raises.length === 2 ? "cold3bet" : "fourbet";
            if (situation === "fourbet" && before.player_id !== a.player_id) continue;   // cold answers to 4-bets: too rare to model
        }
        out.push({ situation, group, size: preflopSize(situation, x), answer, responder: p });
        if (answer === "call") { callers_after_raise.push(a.player_id); voluntary.add(a.player_id); }
    }
    // re-raises are answers too: the raiser answered the raise before theirs
    for (let i = 1; i < raises.length; i++) {
        const r = raises[i], prev = raises[i - 1];
        const p = seat(r.player_id);
        const group: ResponderGroup = p.position === "SB" || p.position === "BB" ? "blinds" : "field";
        const prior_raise = raises.slice(0, i - 1).some((x) => x.player_id === r.player_id);
        const called_before = pre.slice(0, pre.indexOf(r)).some((x) => x.player_id === r.player_id && x.type === "call" && pre.indexOf(x) > pre.indexOf(prev));
        let situation: PreflopSituation, x: number;
        if (i === 1) {
            x = prev.street_total / level - limps_before_first;
            situation = limps_before_first > 0 && limpers.includes(r.player_id) ? "iso" : called_before ? "squeeze" : "open";
            // a raise after callers of the first raise is a squeeze
            const callers_between = pre.slice(pre.indexOf(prev) + 1, pre.indexOf(r)).some((a) => a.type === "call");
            if (situation === "open" && callers_between) situation = "squeeze";
        } else {
            x = prev.street_total / Math.max(raises[i - 2].street_total, 1e-9);
            situation = prior_raise ? (i === 2 ? "threebet" : "fourbet") : "cold3bet";
            if (situation === "fourbet" && !prior_raise) continue;
        }
        out.push({ situation, group, size: preflopSize(situation, x), answer: "raise", responder: p });
    }
    return out;
}

/** The table from stored hands; `include` picks whose answers count (leave out your own). */
export function calibratePreflopResponses(states: HandState[], include: (seat: SeatState) => boolean = () => true): { table: PreflopResponseTable, samples: number } {
    type Count = { n: number, fold: number, call: number, raise: number };
    const counts: Record<string, Count> = {};
    const count = (k: string) => counts[k] ??= { n: 0, fold: 0, call: 0, raise: 0 };
    let samples = 0;
    for (const s of states) {
        for (const a of preflopAnswers(s)) {
            if (!include(a.responder)) continue;
            for (const k of [`${a.situation}|${a.group}`, `${a.situation}|${a.group}|${a.size}`]) {
                const c = count(k);
                c.n++;
                c[a.answer]++;
            }
            samples++;
        }
    }
    const blend = (c: Count | undefined, prior: PreflopResponse, w: number): PreflopResponse => ({
        fold: ((c?.fold ?? 0) + prior.fold * w) / ((c?.n ?? 0) + w),
        call: ((c?.call ?? 0) + prior.call * w) / ((c?.n ?? 0) + w),
        raise: ((c?.raise ?? 0) + prior.raise * w) / ((c?.n ?? 0) + w)
    });
    const table = defaultPreflopTable();
    for (const sit of PREFLOP_SITUATIONS) {
        for (const g of ["blinds", "field"] as ResponderGroup[]) {
            const level = blend(counts[`${sit}|${g}`], DEFAULTS[sit][g], WEIGHT.situation);
            for (const size of ["small", "medium", "big"] as PreflopSize[]) {
                const prior = normalize({ ...level, fold: level.fold * SIZE_FOLD[size] });
                const c = counts[`${sit}|${g}|${size}`];
                table[sit][g][size] = { ...normalize(blend(c, prior, WEIGHT.cell)), n: c?.n ?? 0 };
            }
        }
    }
    return { table, samples };
}

let preflop_table: PreflopResponseTable = defaultPreflopTable();
/** How players in your games answer preflop raises, measured from your stored hands (ProfileService.preflopResponses()). */
export function setPreflopResponseTable(table: PreflopResponseTable): void {
    preflop_table = table;
}
export function resetPreflopResponseTable(): void {
    preflop_table = defaultPreflopTable();
}
export function preflopResponseTable(): PreflopResponseTable {
    return preflop_table;
}
