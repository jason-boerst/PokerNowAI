// How players in your games respond to a bet after the flop: by street, by who bets and by bet size.
//
// Who bets matters a lot. In the games this was built from, a flop bet by the preflop raiser (a c-bet)
// got 39% folds and 8% raises, but a flop lead into the raiser got only 23% folds and 23% raises.
// Size matters too: small river bets (a third of the pot) got far fewer folds than pot-sized ones.
// The table is measured from heads-up spots in your stored hands (your own responses left out),
// blended toward the defaults below while samples are small, and recalculated at every start.
// Checked on 2,569 heads-up bets: predicted fold rates matched actual ones on every street
// (flop 37.8% vs 38.5%, turn 40.1% vs 40.1%, river 52.9% vs 52.7%).
import { ActionRecord as Action, HandState, POST_TYPES, SeatState } from "./hand-parser.ts";
import type { PostflopStreet } from "./equity.ts";

/**
 * Who is betting, relative to the last aggressor (the preflop raiser on the flop, else whoever bet or
 * raised last on an earlier street):
 *   cbet    : the preflop raiser bets the flop
 *   barrel  : the last aggressor bets again after their bet on the previous street was called
 *   delayed : the last aggressor bets after the previous street was checked through
 *   lead    : someone else bets into the last aggressor before they act (a "donk bet")
 *   stab    : someone else bets after the last aggressor checked (or nobody raised yet)
 */
export type BetRole = "cbet" | "barrel" | "delayed" | "lead" | "stab";
export type SizeBucket = "small" | "medium" | "big";

export interface Response {
    /** Chance the player facing the bet folds, and raises (0-1). */
    fold: number,
    raise: number
}
export interface ResponseCell extends Response {
    /** Measured cases behind the numbers (0: defaults only). */
    n: number
}
export type ResponseTable = Record<PostflopStreet, Record<BetRole, Record<SizeBucket, ResponseCell>>>;

export const STREETS: PostflopStreet[] = ["flop", "turn", "river"];
export const ROLES: BetRole[] = ["cbet", "barrel", "delayed", "lead", "stab"];
export const BUCKETS: SizeBucket[] = ["small", "medium", "big"];

/** Bet size as a share of the pot: up to 40% small, up to 80% medium, bigger is big. */
export function sizeBucket(share_of_pot: number): SizeBucket {
    return share_of_pot <= 0.4 ? "small" : share_of_pot <= 0.8 ? "medium" : "big";
}
/** Typical size in each bucket (share of the pot), for interpolating between buckets. */
const ANCHORS: [SizeBucket, number][] = [["small", 0.33], ["medium", 0.6], ["big", 1.0]];

/**
 * Defaults (fold, raise) by street and role for a medium bet, measured from 3,490 hands of the home
 * games this tool was tuned on, heads-up spots only. A flop has no barrel, so it uses the c-bet numbers.
 */
const DEFAULT_ROLE: Record<PostflopStreet, Record<BetRole, Response>> = {
    flop: { cbet: { fold: 0.39, raise: 0.08 }, barrel: { fold: 0.39, raise: 0.08 }, delayed: { fold: 0.39, raise: 0.08 }, lead: { fold: 0.24, raise: 0.22 }, stab: { fold: 0.29, raise: 0.14 } },
    turn: { cbet: { fold: 0.38, raise: 0.10 }, barrel: { fold: 0.38, raise: 0.10 }, delayed: { fold: 0.43, raise: 0.06 }, lead: { fold: 0.35, raise: 0.10 }, stab: { fold: 0.42, raise: 0.05 } },
    river: { cbet: { fold: 0.45, raise: 0.09 }, barrel: { fold: 0.45, raise: 0.09 }, delayed: { fold: 0.52, raise: 0.12 }, lead: { fold: 0.58, raise: 0.08 }, stab: { fold: 0.64, raise: 0.03 } }
};
/**
 * How folds and raises change with size, relative to a medium bet, by street (measured on the same hands):
 * small bets are called and raised more, most of all on the river.
 */
const DEFAULT_SIZE: Record<PostflopStreet, Record<SizeBucket, Response>> = {
    flop: { small: { fold: 0.85, raise: 1.1 }, medium: { fold: 1, raise: 1 }, big: { fold: 1.35, raise: 0.8 } },
    turn: { small: { fold: 0.75, raise: 2.0 }, medium: { fold: 1, raise: 1 }, big: { fold: 1.25, raise: 0.8 } },
    river: { small: { fold: 0.55, raise: 2.0 }, medium: { fold: 1, raise: 1 }, big: { fold: 1.2, raise: 0.4 } }
};
/** How many cases each level of defaults counts as (street, role, size effect, cell). */
const WEIGHT = { street: 20, role: 30, size: 25, cell: 25 };

const clampFold = (x: number) => Math.max(0.03, Math.min(0.9, x));
const clampRaise = (x: number) => Math.max(0.01, Math.min(0.5, x));

/** The defaults alone (no measured hands). */
export function defaultResponseTable(): ResponseTable {
    const table = {} as ResponseTable;
    for (const street of STREETS) {
        table[street] = {} as Record<BetRole, Record<SizeBucket, ResponseCell>>;
        for (const role of ROLES) {
            table[street][role] = {} as Record<SizeBucket, ResponseCell>;
            for (const bucket of BUCKETS) {
                const d = DEFAULT_ROLE[street][role], m = DEFAULT_SIZE[street][bucket];
                table[street][role][bucket] = { fold: clampFold(d.fold * m.fold), raise: clampRaise(d.raise * m.raise), n: 0 };
            }
        }
    }
    return table;
}

/**
 * The role of a bet by `bettor` on `street`, given every action before it and who has folded.
 * With nobody to bet into (no raise preflop and no bet since, or the aggressor has folded) it is a stab.
 */
export function roleOf(before: Action[], bettor: string, street: PostflopStreet, folded: Set<string>): BetRole {
    let aggressor: string | undefined;
    let called = false;
    for (const st of ["preflop", "flop", "turn", "river"] as const) {
        if (st === street) break;
        const acts = before.filter((a) => a.street === st && !POST_TYPES.has(a.type));
        const aggressive = acts.filter((a) => a.type === "bet" || a.type === "raise");
        const last = aggressive[aggressive.length - 1];
        called = !!last && acts.some((a) => a.type === "call" && acts.indexOf(a) > acts.indexOf(last));
        if (last) aggressor = last.player_id;
    }
    if (aggressor === undefined || folded.has(aggressor)) return "stab";
    if (bettor === aggressor) return street === "flop" ? "cbet" : called ? "barrel" : "delayed";
    const current = before.filter((a) => a.street === street);
    return current.some((a) => a.player_id === aggressor && a.type === "check") ? "stab" : "lead";
}

/** The role hero's bet would have now (hero to act on the current street of `s`). */
export function heroBetRole(s: HandState): BetRole {
    const street: PostflopStreet = s.street === "turn" || s.street === "river" ? s.street : "flop";
    const folded = new Set(s.seats.filter((p) => p.folded).map((p) => p.id));
    return roleOf(s.actions, s.hero_id ?? "", street, folded);
}

/** Folds and raises for a bet of `share_of_pot`, interpolated between the size buckets (overbets fold a bit more). */
export function responseFor(table: ResponseTable, street: PostflopStreet, role: BetRole, share_of_pot: number): Response & { n: number } {
    const cells = table[street][role];
    const x = Math.max(0, share_of_pot);
    if (x <= ANCHORS[0][1]) {
        // smaller than a third of the pot: fewer folds and more raises (measured: bets under 30% of the pot got
        // 21% folds and 16% raises heads-up, against 36% and 10% for 30-45%)
        const r = Math.max(x, 0.1) / ANCHORS[0][1];
        return { fold: clampFold(cells.small.fold * Math.pow(r, 0.8)), raise: clampRaise(cells.small.raise * Math.pow(r, -0.3)), n: cells.small.n };
    }
    const big = cells.big;
    if (x >= ANCHORS[2][1]) {
        const over = Math.min(x - 1, 1);
        return { fold: clampFold(big.fold * (1 + 0.15 * over)), raise: clampRaise(big.raise * (1 - 0.3 * over)), n: big.n };
    }
    for (let i = 0; i < ANCHORS.length - 1; i++) {
        const [a, xa] = ANCHORS[i], [b, xb] = ANCHORS[i + 1];
        if (x <= xb) {
            const t = (x - xa) / (xb - xa);
            const ca = cells[a], cb = cells[b];
            return { fold: ca.fold + t * (cb.fold - ca.fold), raise: ca.raise + t * (cb.raise - ca.raise), n: t < 0.5 ? ca.n : cb.n };
        }
    }
    return { ...big };
}

type Count = { n: number, fold: number, raise: number };
const newCount = (): Count => ({ n: 0, fold: 0, raise: 0 });

/**
 * Measures the response table from stored hands: every heads-up first bet of a street and the other
 * player's answer. `include` picks whose answers count (leave out your own). Bomb pots and non-Hold'em
 * hands are skipped.
 */
export function calibrateResponses(states: HandState[], include: (responder: SeatState) => boolean = () => true): { table: ResponseTable, samples: number } {
    const cell: Record<string, Count> = {};
    const count = (key: string) => cell[key] ??= newCount();
    let samples = 0;
    for (const s of states) {
        if (s.bomb_pot || !(s.game_type === "" || /hold'?em/i.test(s.game_type))) continue;
        const folded = new Set<string>();
        const seat_by_id = new Map(s.seats.map((p) => [p.id, p]));
        const first_bet_seen = new Set<string>();
        s.actions.forEach((a, i) => {
            const street = a.street;
            if (street !== "preflop" && a.type === "bet" && !first_bet_seen.has(street)) {
                first_bet_seen.add(street);
                const active = s.seats.filter((p) => !folded.has(p.id));
                const reply = s.actions.slice(i + 1).find((x) => x.street === street && x.player_id !== a.player_id);
                const responder = reply && seat_by_id.get(reply.player_id);
                if (active.length === 2 && reply && responder && include(responder) && ["fold", "call", "raise"].includes(reply.type)) {
                    const role = roleOf(s.actions.slice(0, i), a.player_id, street, folded);
                    const bucket = sizeBucket(a.amount / Math.max(a.pot_before, 1e-9));
                    for (const key of [street, `${street}|${role}`, `${street}|${bucket}`, `${street}|${role}|${bucket}`]) {
                        const c = count(key);
                        c.n++;
                        if (reply.type === "fold") c.fold++;
                        if (reply.type === "raise") c.raise++;
                    }
                    samples++;
                }
            }
            if (a.type === "fold") folded.add(a.player_id);
        });
    }
    const blend = (c: Count | undefined, prior: Response, w: number): Response => ({
        fold: ((c?.fold ?? 0) + prior.fold * w) / ((c?.n ?? 0) + w),
        raise: ((c?.raise ?? 0) + prior.raise * w) / ((c?.n ?? 0) + w)
    });
    const table = defaultResponseTable();
    for (const street of STREETS) {
        // the street as a whole, then each role, then how size changes things on this street
        const street_default: Response = { fold: DEFAULT_ROLE[street].cbet.fold, raise: DEFAULT_ROLE[street].cbet.raise };
        const street_rate = blend(cell[street], street_default, WEIGHT.street);
        const size_mult = {} as Record<SizeBucket, Response>;
        for (const bucket of BUCKETS) {
            const d = DEFAULT_SIZE[street][bucket];
            const rate = blend(cell[`${street}|${bucket}`], { fold: street_rate.fold * d.fold, raise: street_rate.raise * d.raise }, WEIGHT.size);
            size_mult[bucket] = { fold: rate.fold / Math.max(street_rate.fold, 1e-9), raise: rate.raise / Math.max(street_rate.raise, 1e-9) };
        }
        for (const role of ROLES) {
            // the role's own defaults, pulled toward this street's measured level
            const d = DEFAULT_ROLE[street][role];
            const shift = { fold: street_rate.fold / street_default.fold, raise: street_rate.raise / street_default.raise };
            const role_rate = blend(cell[`${street}|${role}`], { fold: d.fold * shift.fold, raise: d.raise * shift.raise }, WEIGHT.role);
            for (const bucket of BUCKETS) {
                const c = cell[`${street}|${role}|${bucket}`];
                const prior = { fold: role_rate.fold * size_mult[bucket].fold, raise: role_rate.raise * size_mult[bucket].raise };
                const r = blend(c, prior, WEIGHT.cell);
                table[street][role][bucket] = { fold: clampFold(r.fold), raise: clampRaise(r.raise), n: c?.n ?? 0 };
            }
        }
    }
    return { table, samples };
}
