// Sizing tells for 7-2 under the bounty: do players size their raises or bets differently when they hold 7-2?
//
// Each candidate tell compares a player's size with their own usual size for that action (their median, or your
// games' median when they have fewer than MIN_OWN cases), and calls it "big" from BIG_PRE (preflop) or BIG_BET
// (bets) times that. Over your stored hands it counts how often shown 7-2 was big against every other case (shown
// or not), and turns a tell on only when the difference is statistically significant: a one-sided two-proportion
// z of at least Z_ON (about p < 0.0013 each, under 0.01 for all five candidates together) with at least MIN_72
// shown 7-2 cases. In the games this was built from, opens of 7-2 were big 29% of the time against 12% for every
// other open (79 shown 7-2 opens by 46 players, z 4.6; 50% vs 13% among hands shown only at showdown, so it isn't
// that big opens win more and get shown more); flop and turn bets showed no tell.
//
// An active tell is a likelihood ratio: how much more often 7-2 is big than other hands. The engine multiplies the
// odds of 7-2 in that player's range by it (and by the smaller ratio for a normal size), which is a Bayes update
// from whatever share of 7-2 the range already had. Shown 7-2 is a lower bound of how often 7-2 is played (unshown
// 7-2 counts with the other hands), which makes the tell, if anything, look weaker than it is.
import { isSevenDeuce } from "./equity.ts";
import { HandState, SeatState } from "./hand-parser.ts";
import { isHoldem } from "./player-profile.ts";

export type TellKind = "open" | "iso" | "three_bet" | "flop_bet" | "turn_bet";
export const TELL_KINDS: TellKind[] = ["open", "iso", "three_bet", "flop_bet", "turn_bet"];

/** What each candidate measures, for the panel and reports. */
export const TELL_NAMES: Record<TellKind, string> = {
    open: "first raise (no limpers)", iso: "raise over limpers", three_bet: "3-bet",
    flop_bet: "flop bet by the preflop raiser", turn_bet: "turn bet by the preflop raiser"
};

/** Big: at least this many times the player's usual size (preflop raises, and bets as a share of the pot). */
const BIG_PRE = 1.25;
const BIG_BET = 1.3;
/** Own cases needed before a player's own median is their usual size. */
const MIN_OWN = 5;
/** Significance needed to turn a tell on, and shown 7-2 cases needed. */
export const Z_ON = 3;
const MIN_72 = 10;
/** The likelihood ratios are pulled toward 1 (in log scale) as if this many 7-2 cases said "no tell". */
const LR_PRIOR = 20;
/** Most the odds of 7-2 can be moved by all tells together. */
const MAX_LR = 6;

export interface TellStat {
    kind: TellKind,
    /** Shown 7-2 cases and how many were big; every other case and how many were big. */
    n72: number, big72: number,
    n_other: number, big_other: number,
    /** One-sided two-proportion z (7-2 bigger than the rest). */
    z: number,
    active: boolean,
    /** Likelihood ratios used when active: a big size and a normal one. */
    lr_big: number,
    lr_normal: number
}

export interface TellModel {
    stats: Record<TellKind, TellStat>,
    /** Usual size per player and kind (median and cases), and your games' median per kind. */
    own: Map<string, { median: number, n: number }>,
    pool: Record<TellKind, number>
}

/** One measured size: who, which kind, the size (BB per blind level, ratio to the raise, or share of the pot). */
interface Case { key: string, kind: TellKind, size: number, is72: boolean }

/** Every case of every kind in a hand, for every seat `include` accepts. */
function casesOf(s: HandState, keyOf: (seat: { id: string }) => string, include: (seat: SeatState) => boolean): Case[] {
    if (!isHoldem(s) || s.bomb_pot) return [];
    const out: Case[] = [];
    const seat = (id: string) => s.seats.find((p) => p.id === id);
    const known72 = (id: string) => { const c = seat(id)?.shown_cards; return !!c && c.length === 2 && isSevenDeuce(c); };
    const push = (id: string, kind: TellKind, size: number) => {
        const p = seat(id);
        if (!p || !include(p) || !(size > 0) || !Number.isFinite(size)) return;
        out.push({ key: keyOf(p), kind, size, is72: known72(id) });
    };
    for (const m of measures(s)) push(m.player_id, m.kind, m.size);
    return out;
}

/** The sizes of the measured actions in a hand state (only those already taken). */
export function measures(s: HandState): { player_id: string, kind: TellKind, size: number }[] {
    const out: { player_id: string, kind: TellKind, size: number }[] = [];
    const pre = s.actions.filter((a) => a.street === "preflop");
    const level = Math.max(s.big_blind, ...pre.filter((a) => a.type === "post_bb" || a.type === "post_straddle").map((a) => a.street_total));
    const raises = pre.filter((a) => a.type === "raise" || a.type === "bet");
    const first = raises[0];
    if (first && level > 0) {
        const limpers = pre.slice(0, pre.indexOf(first)).filter((a) => a.type === "call").length;
        out.push({ player_id: first.player_id, kind: limpers ? "iso" : "open", size: first.street_total / level - limpers });
        const second = raises[1];
        if (second) out.push({ player_id: second.player_id, kind: "three_bet", size: second.street_total / Math.max(first.street_total, 1e-9) });
    }
    const aggressor = raises[raises.length - 1]?.player_id;
    for (const [street, kind] of [["flop", "flop_bet"], ["turn", "turn_bet"]] as const) {
        const bet = s.actions.find((a) => a.street === street && a.type === "bet");
        if (bet && bet.player_id === aggressor && bet.pot_before > 0) out.push({ player_id: bet.player_id, kind, size: bet.amount / bet.pot_before });
    }
    return out;
}

const median = (xs: number[]) => { const b = [...xs].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };
const bigLine = (kind: TellKind) => (kind === "flop_bet" || kind === "turn_bet" ? BIG_BET : BIG_PRE);

/** Measures every candidate tell over stored hands (`include`: whose actions count, e.g. everyone but you). */
export function calibrateTells(states: HandState[], keyOf: (seat: { id: string }) => string, include: (seat: SeatState) => boolean = () => true): TellModel {
    const cases = states.flatMap((s) => casesOf(s, keyOf, include));
    const lists = new Map<string, number[]>();
    for (const c of cases) {
        const k = `${c.key}|${c.kind}`;
        (lists.get(k) ?? lists.set(k, []).get(k)!).push(c.size);
    }
    const own = new Map<string, { median: number, n: number }>();
    for (const [k, xs] of lists) own.set(k, { median: median(xs), n: xs.length });
    const pool = {} as Record<TellKind, number>;
    for (const kind of TELL_KINDS) pool[kind] = median(cases.filter((c) => c.kind === kind).map((c) => c.size));
    const model: TellModel = { stats: {} as Record<TellKind, TellStat>, own, pool };
    for (const kind of TELL_KINDS) {
        let n72 = 0, big72 = 0, n_other = 0, big_other = 0;
        for (const c of cases) {
            if (c.kind !== kind) continue;
            const big = c.size >= bigLine(kind) * usual(model, c.key, kind);
            if (c.is72) { n72++; if (big) big72++; } else { n_other++; if (big) big_other++; }
        }
        model.stats[kind] = statOf(kind, n72, big72, n_other, big_other);
    }
    return model;
}

function statOf(kind: TellKind, n72: number, big72: number, n_other: number, big_other: number): TellStat {
    const p1 = n72 ? big72 / n72 : 0, p2 = n_other ? big_other / n_other : 0;
    const p = (big72 + big_other) / Math.max(1, n72 + n_other);
    const se = Math.sqrt(p * (1 - p) * (1 / Math.max(1, n72) + 1 / Math.max(1, n_other)));
    const z = se > 0 && n72 > 0 && n_other > 0 ? (p1 - p2) / se : 0;
    // smoothed rates, then the ratios pulled toward 1 by the size of the 7-2 sample
    const r72 = (big72 + 1) / (n72 + 2), ro = (big_other + 1) / (n_other + 2);
    const pull = n72 / (n72 + LR_PRIOR);
    const lr_big = Math.exp(Math.log(r72 / ro) * pull), lr_normal = Math.exp(Math.log((1 - r72) / (1 - ro)) * pull);
    return { kind, n72, big72, n_other, big_other, z, active: z >= Z_ON && n72 >= MIN_72, lr_big, lr_normal };
}

/** A player's usual size for a kind: their own median with enough cases, else your games' median. */
function usual(model: TellModel, key: string, kind: TellKind): number {
    const o = model.own.get(`${key}|${kind}`);
    return o && o.n >= MIN_OWN ? o.median : model.pool[kind];
}

export interface TellReading {
    /** Multiplier for the odds of 7-2 in this player's range (1: no change). */
    lr: number,
    /** One line per active tell they showed this hand, for the panel. */
    notes: string[]
}

/** What the active tells say about one player in the current hand (their actions so far). */
export function readTells(model: TellModel, s: HandState, seat: SeatState, key: string): TellReading {
    let lr = 1;
    const notes: string[] = [];
    for (const m of measures(s)) {
        if (m.player_id !== seat.id) continue;
        const stat = model.stats[m.kind];
        if (!stat.active) continue;
        const base = usual(model, key, m.kind);
        if (!(base > 0)) continue;
        const ratio = m.size / base;
        if (ratio >= bigLine(m.kind)) {
            lr *= stat.lr_big;
            const pct = (x: number) => `${Math.round(x * 100)}%`;
            notes.push(`Possible 7-2: their ${TELL_NAMES[m.kind]} is ${ratio.toFixed(1)}x their usual size. In your games 7-2 was this big ${pct(stat.big72 / stat.n72)} of the time (${stat.n72} shown) vs ${pct(stat.big_other / stat.n_other)} for other hands, so 7-2 counts about ${stat.lr_big.toFixed(1)}x as likely in their range.`);
        } else {
            lr *= stat.lr_normal;
        }
    }
    return { lr: Math.max(1 / MAX_LR, Math.min(MAX_LR, lr)), notes };
}
