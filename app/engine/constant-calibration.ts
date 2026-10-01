// Some of the engine's numbers were measured once, on the games it was built from, and then written into the code
// (postflop.ts BET_NEXT, MULTIWAY_BET, MULTIWAY_CONTINUE, MULTIWAY_RAISE; equity.ts OTHERS_BET_SHARE). This
// measures them again on your stored hands each time they load, the same way, from opponents' actions only.
//
// A measured value is blended toward the built-in one (a prior worth PRIOR_CASES cases) and used only when it
// predicts held-out games better: leaving one game out at a time, the value fit on the other games and the built-in
// value each predict the left-out game's events, and the measured one has to win by more than two standard errors.
// Not measured: OVERCALL (it is about players holding better hands than yours, which mostly never show) and STACK_IN
// (it rests on showdowns only, with a hand-set discount for that bias).
import { HandState, SeatState, Street } from "./hand-parser.ts";
import { isHoldem } from "./player-profile.ts";

export type ConstantName = "bet_next_flop" | "bet_next_turn" | "multiway_bet" | "multiway_continue" | "multiway_raise" | "others_bet_share";
export const CONSTANT_NAMES: ConstantName[] = ["bet_next_flop", "bet_next_turn", "multiway_bet", "multiway_continue", "multiway_raise", "others_bet_share"];
export type PlayConstants = Record<ConstantName, number>;

/** The built-in values (postflop.ts and equity.ts). */
export const DEFAULT_CONSTANTS: PlayConstants = {
    bet_next_flop: 0.54, bet_next_turn: 0.58, multiway_bet: 0.62, multiway_continue: 0.75, multiway_raise: 0.6, others_bet_share: 0.4
};
export const CONSTANT_TEXT: Record<ConstantName, string> = {
    bet_next_flop: "a called flop bettor bets the turn",
    bet_next_turn: "a called turn bettor bets the river",
    multiway_bet: "bet chance per extra player left to act, after a check",
    multiway_continue: "continue chance per extra player facing a bet",
    multiway_raise: "raise chance per extra player facing a bet",
    others_bet_share: "callers lead the next street, relative to the bettor betting again"
};
const PRIOR_CASES = 100;

/** One observed event and what it counts toward. */
export type ConstantEvent =
    | { kind: "bet_next", street: "flop" | "turn", hit: boolean }
    | { kind: "checked_to", behind: number, hit: boolean }
    | { kind: "facing_bet", extra: number, cont: boolean, raise: boolean }
    | { kind: "next_lead", bettor: boolean, hit: boolean };

const NEXT: Partial<Record<Street, Street>> = { flop: "turn", turn: "river" };

/** The events in one hand, for seats `include` accepts. */
export function constantEvents(s: HandState, include: (seat: SeatState) => boolean = () => true): ConstantEvent[] {
    if (!isHoldem(s) || s.bomb_pot) return [];
    const seat = new Map(s.seats.map((p) => [p.id, p]));
    const ok = (id: string) => { const p = seat.get(id); return !!p && include(p); };
    const out: ConstantEvent[] = [];
    const folded = new Set<string>(), all_in = new Set<string>();
    const by_street = new Map<Street, typeof s.actions>();
    // who was still in (and who could still act) at the start of each street
    const in_at = new Map<Street, string[]>(), live_at = new Map<Street, string[]>();
    for (const a of s.actions) {
        if (!by_street.has(a.street)) {
            by_street.set(a.street, []);
            in_at.set(a.street, s.seats.filter((p) => !folded.has(p.id)).map((p) => p.id));
            live_at.set(a.street, s.seats.filter((p) => !folded.has(p.id) && !all_in.has(p.id)).map((p) => p.id));
        }
        by_street.get(a.street)!.push(a);
        if (a.type === "fold") folded.add(a.player_id);
        if (a.all_in) all_in.add(a.player_id);
    }
    for (const street of ["flop", "turn", "river"] as const) {
        const acts = (by_street.get(street) ?? []).filter((a) => ["bet", "raise", "call", "check", "fold"].includes(a.type));
        if (!acts.length) continue;
        const live = live_at.get(street) ?? [];
        // after the first check, with no bet yet: does anyone of the players left to act bet?
        const first_check = acts.findIndex((a) => a.type === "check");
        const first_bet = acts.findIndex((a) => a.type === "bet" || a.type === "raise");
        if (first_check >= 0 && (first_bet < 0 || first_bet > first_check)) {
            const acted = new Set(acts.slice(0, first_check + 1).map((a) => a.player_id));
            const behind = live.filter((id) => !acted.has(id));
            if (behind.length > 0 && behind.every(ok)) out.push({ kind: "checked_to", behind: behind.length, hit: first_bet > first_check });
        }
        // the first bet: each other player's first answer, before anyone raises it
        if (first_bet >= 0) {
            const bet = acts[first_bet];
            const facing = live.filter((id) => id !== bet.player_id);
            const after = acts.slice(first_bet + 1);
            const raised_at = after.findIndex((a) => a.type === "raise");
            const before_raise = raised_at < 0 ? after : after.slice(0, raised_at + 1);
            const answered = new Set<string>();
            for (const a of before_raise) {
                if (answered.has(a.player_id) || !facing.includes(a.player_id) || !ok(a.player_id)) continue;
                answered.add(a.player_id);
                out.push({ kind: "facing_bet", extra: facing.length - 1, cont: a.type !== "fold", raise: a.type === "raise" });
            }
        }
        // the next street after a bet that was called: does the bettor bet again, does a caller lead?
        const next = NEXT[street];
        const next_acts = next ? (by_street.get(next) ?? []).filter((a) => ["bet", "raise", "call", "check", "fold"].includes(a.type)) : [];
        const aggressive = acts.filter((a) => a.type === "bet" || a.type === "raise");
        const last = aggressive[aggressive.length - 1];
        if (!next || !last || !next_acts.length) continue;
        const callers = acts.filter((a, i) => a.type === "call" && i > acts.indexOf(last)).map((a) => a.player_id);
        const going = in_at.get(next) ?? [];
        const can_act = live_at.get(next) ?? [];
        if (!callers.length || !can_act.includes(last.player_id)) continue;
        const next_bet = next_acts.findIndex((a) => a.type === "bet");
        // a player "had the chance" when they acted with no bet before them on the street
        const chance = (id: string) => {
            const i = next_acts.findIndex((a) => a.player_id === id);
            return i >= 0 && (next_bet < 0 || next_bet >= i) ? next_acts[i] : null;
        };
        if (going.length === 2 && (street === "flop" || street === "turn") && ok(last.player_id)) {
            const a = chance(last.player_id);
            if (a) out.push({ kind: "bet_next", street, hit: a.type === "bet" });
        }
        if (going.length >= 3) {
            for (const id of going) {
                if (!can_act.includes(id) || !ok(id)) continue;
                const a = chance(id);
                if (a) out.push({ kind: "next_lead", bettor: id === last.player_id, hit: a.type === "bet" });
            }
        }
    }
    return out;
}

/** Base rates the ratio constants multiply (heads-up continue and raise, one player behind betting, the bettor betting again). */
interface Bases { bet_one: number, cont_hu: number, raise_hu: number, bettor_bets: number }

function bases(events: ConstantEvent[]): Bases {
    const rate = (xs: boolean[], d: number) => (xs.length ? (xs.filter(Boolean).length + d) / (xs.length + 1) : d);
    const ev = <K extends ConstantEvent["kind"]>(k: K) => events.filter((e): e is Extract<ConstantEvent, { kind: K }> => e.kind === k);
    return {
        bet_one: rate(ev("checked_to").filter((e) => e.behind === 1).map((e) => e.hit), 0.6),
        cont_hu: rate(ev("facing_bet").filter((e) => e.extra === 0).map((e) => e.cont), 0.6),
        raise_hu: rate(ev("facing_bet").filter((e) => e.extra === 0).map((e) => e.raise), 0.08),
        bettor_bets: rate(ev("next_lead").filter((e) => e.bettor).map((e) => e.hit), 0.5)
    };
}

const clampP = (p: number) => Math.min(0.999, Math.max(0.001, p));

/** The probability the model gives an event (and whether it happened), under constants `c` and base rates `b`; null if `name` doesn't use it. */
function predict(name: ConstantName, e: ConstantEvent, c: PlayConstants, b: Bases): { p: number, hit: boolean } | null {
    switch (name) {
        case "bet_next_flop": case "bet_next_turn":
            return e.kind === "bet_next" && `bet_next_${e.street}` === name ? { p: c[name], hit: e.hit } : null;
        case "multiway_bet":
            if (e.kind !== "checked_to" || e.behind < 2) return null;
            return { p: 1 - Math.pow(1 - Math.min(0.97, b.bet_one * Math.pow(c.multiway_bet, e.behind - 1)), e.behind), hit: e.hit };
        case "multiway_continue":
            return e.kind === "facing_bet" && e.extra > 0 ? { p: b.cont_hu * Math.pow(c.multiway_continue, e.extra), hit: e.cont } : null;
        case "multiway_raise":
            return e.kind === "facing_bet" && e.extra > 0 ? { p: b.raise_hu * Math.pow(c.multiway_raise, e.extra), hit: e.raise } : null;
        case "others_bet_share":
            return e.kind === "next_lead" && !e.bettor ? { p: Math.min(0.97, b.bettor_bets * c.others_bet_share), hit: e.hit } : null;
    }
}

const GRID: Record<ConstantName, number[]> = {
    bet_next_flop: [], bet_next_turn: [],
    multiway_bet: Array.from({ length: 41 }, (_, i) => 0.2 + i * 0.025),
    multiway_continue: Array.from({ length: 41 }, (_, i) => 0.3 + i * 0.0175),
    multiway_raise: Array.from({ length: 41 }, (_, i) => 0.1 + i * 0.025),
    others_bet_share: Array.from({ length: 41 }, (_, i) => 0.05 + i * 0.025)
};

/** Each constant fit on `events` (maximum likelihood), blended toward the built-in value by the events behind it. */
export function fitConstants(events: ConstantEvent[]): { values: PlayConstants, cases: Record<ConstantName, number> } {
    const b = bases(events);
    const values = { ...DEFAULT_CONSTANTS }, cases = {} as Record<ConstantName, number>;
    for (const name of CONSTANT_NAMES) {
        const used = events.filter((e) => predict(name, e, DEFAULT_CONSTANTS, b));
        cases[name] = used.length;
        if (!used.length) continue;
        let best: number;
        if (name === "bet_next_flop" || name === "bet_next_turn") {
            best = used.filter((e) => predict(name, e, DEFAULT_CONSTANTS, b)!.hit).length / used.length;
        } else {
            let best_ll = -Infinity;
            best = DEFAULT_CONSTANTS[name];
            for (const x of GRID[name]) {
                const c = { ...DEFAULT_CONSTANTS, [name]: x };
                let ll = 0;
                for (const e of used) {
                    const r = predict(name, e, c, b)!;
                    const p = clampP(r.p);
                    ll += r.hit ? Math.log(p) : Math.log(1 - p);
                }
                if (ll > best_ll) { best_ll = ll; best = x; }
            }
        }
        values[name] = (used.length * best + PRIOR_CASES * DEFAULT_CONSTANTS[name]) / (used.length + PRIOR_CASES);
    }
    return { values, cases };
}

export interface ConstantCheck {
    name: ConstantName,
    built_in: number,
    /** Fit on all games (blended toward the built-in value), the events behind it, and whether it is used. */
    measured: number,
    cases: number,
    /** Leave-one-game-out log-likelihood gain of the measured value over the built-in one, and one standard error. */
    gain: number,
    se: number,
    active: boolean
}

/** Fits every constant and checks each, one game left out at a time. */
export function checkConstants(states: { game: string, s: HandState }[], include: (seat: SeatState) => boolean = () => true): { values: PlayConstants, checks: ConstantCheck[] } {
    return checkConstantEvents(states.map(({ game, s }) => ({ game, events: constantEvents(s, include) })));
}

/** checkConstants on events already collected per game. */
export function checkConstantEvents(all: { game: string, events: ConstantEvent[] }[]): { values: PlayConstants, checks: ConstantCheck[] } {
    const fit = fitConstants(all.flatMap((x) => x.events));
    const diffs = new Map<ConstantName, number[]>(CONSTANT_NAMES.map((n) => [n, []]));
    for (const game of new Set(all.map((x) => x.game))) {
        const train = all.filter((x) => x.game !== game).flatMap((x) => x.events);
        const test = all.filter((x) => x.game === game).flatMap((x) => x.events);
        if (!train.length || !test.length) continue;
        const trained = fitConstants(train).values;
        const b = bases(train);
        for (const name of CONSTANT_NAMES) {
            for (const e of test) {
                const r0 = predict(name, e, DEFAULT_CONSTANTS, b);
                const r1 = predict(name, e, { ...DEFAULT_CONSTANTS, [name]: trained[name] }, b);
                if (!r0 || !r1) continue;
                const ll = (p: number, hit: boolean) => (hit ? Math.log(clampP(p)) : Math.log(1 - clampP(p)));
                diffs.get(name)!.push(ll(r1.p, r1.hit) - ll(r0.p, r0.hit));
            }
        }
    }
    const values = { ...DEFAULT_CONSTANTS };
    const r = (x: number, d = 1000) => Math.round(x * d) / d;
    const checks = CONSTANT_NAMES.map((name): ConstantCheck => {
        const d = diffs.get(name)!;
        const n = d.length;
        const mean = n ? d.reduce((a, x) => a + x, 0) / n : 0;
        const sd = n > 1 ? Math.sqrt(d.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
        const gain = mean * n, se = sd * Math.sqrt(n);
        const active = se > 0 && gain > 2 * se;
        if (active) values[name] = fit.values[name];
        return { name, built_in: DEFAULT_CONSTANTS[name], measured: r(fit.values[name]), cases: fit.cases[name], gain: r(gain, 10), se: r(se, 10), active };
    });
    return { values, checks };
}
