// Simulated cash game: the engine in one seat against opponents who play the engine's OWN model of
// your pool. This is a consistency check (does the engine beat the players it believes it is
// facing?), not proof of real results: if the model of the pool is wrong, so is this number.
//
// Table: 2 or 6 seats, everyone starts every hand with the same stack (100 BB by default), so there
// are never side pots. Blinds 10/20, no antes, no straddles, no rake, no 7-2 bounty. Each hand is
// written as a PokerNow log and re-parsed before every action, so the engine sees exactly what the
// live bot would see.
//
// The pool players (assumptions follow the engine's own model, see opponent-range.ts and ranges.ts):
//   preflop  : each action's chance is the hand's weight in the range the engine assigns to that line
//              for an average pool player (pool VPIP, PFR and 3-bet): raise first in, limp, 3-bet,
//              call a raise, 4-bet, call a 3-bet. Opens are 3 BB plus 1 BB per limper, 3-bets 3x
//              (plus 1x per caller), 4-bets 2.3x, and anything past a 4-bet is all-in.
//   facing a bet after the flop: fold, call or raise with the chances in the measured response table
//              (by street, by who bets, by size); raises of a raise use the engine's fold-to-raise
//              estimate. Which hands raise follows the raise action weights; the hands that fold are
//              the weakest part of their range (narrowed by their actions), as the engine assumes.
//   checked to or first in: bet 2/3 pot at the pool's "bets when checked to" rate (c-bet rate for
//              the preflop raiser on the flop, half the rate for a lead into the aggressor), with
//              hands chosen by the bet action weights. Raises are 3x the bet.
//   Showdown by the actual cards.
import { Worker } from "node:worker_threads";
import { allInAdjustedNet } from "../engine/allin-ev.ts";
import { code, DECK, cardName, evaluate, RANKS, seededRandom } from "../engine/cards.ts";
import { ActionWeights, equity, PostflopStreet, setActionWeights, StrengthClass, strengthClass, weightsFor } from "../engine/equity.ts";
import { classOf } from "../engine/hand-classes.ts";
import { HandState, heroView, HeroView, netResult, parseHand, SeatState } from "../engine/hand-parser.ts";
import { ObservedStats, opponentModels, POPULATION_TENDENCIES, postflopActions, preflopLine, reraiseFactor, TABLE_RULES } from "../engine/opponent-range.ts";
import { PRIORS, RATE_KEYS, RateKey } from "../engine/player-profile.ts";
import { analyzePostflop, setBetPlanInEv, setResponseTable } from "../engine/postflop.ts";
import { preflopAdvice } from "../engine/preflop.ts";
import { expandRange, positionWidth, PreflopLine, preflopRange, PreflopTendencies, Range } from "../engine/ranges.ts";
import { defaultResponseTable, responseFor, ResponseTable, roleOf } from "../engine/response-calibration.ts";
import { summarizeWinrate, WinrateSummary } from "../engine/winrate.ts";
import { opponentTendencies } from "../helpers/decision-maker.ts";

/** Everything the engine believes about your pool, in a form that can be sent to a worker thread. */
export interface PoolModel {
    priors: Record<RateKey, number>,
    population: PreflopTendencies,
    action_weights: { flop?: ActionWeights, turn?: ActionWeights, river?: ActionWeights },
    response_table: ResponseTable
}

/** The pool model as the engine currently holds it (after ProfileService.load), plus the measured tables. */
export function capturePool(action_weights: PoolModel["action_weights"], response_table: ResponseTable): PoolModel {
    const priors = {} as Record<RateKey, number>;
    for (const key of RATE_KEYS) priors[key] = PRIORS[key].mean;
    return { priors, population: { ...POPULATION_TENDENCIES }, action_weights: structuredClone(action_weights), response_table: structuredClone(response_table) };
}

/** Installs a pool model in the engine's global state (population averages, action weights, response table). */
export function applyPool(pool: PoolModel): void {
    for (const key of RATE_KEYS) PRIORS[key].mean = pool.priors[key];
    Object.assign(POPULATION_TENDENCIES, pool.population);
    setActionWeights(pool.action_weights);
    setResponseTable(pool.response_table);
}

export interface SimOptions {
    /** Seats at the table (2 to 9). */
    players: number,
    hands: number,
    seed: number,
    stack_bb?: number,
    /** Post-flop engine time budget per decision in ms (smaller is faster and a little noisier). */
    engine_budget_ms?: number,
    /** Who sits in your seat: the engine (default), or a pool player (a control that should break even). */
    hero?: "engine" | "pool",
    /** Add the betting plan's value to the engine's EVs (postflop.ts setBetPlanInEv; off by default). */
    plan_in_ev?: boolean,
    /** Called with each finished hand's log (in-process runs only; for checks and tests). */
    on_hand?: (lines: string[]) => void
}

export interface SimResult {
    players: number,
    hands: number,
    /** Your seat's result per hand in BB, and the same with all-ins before the river counted at equity. */
    results_bb: number[],
    adjusted_bb: number[],
    /** Hands your seat put money in voluntarily preflop, and raised preflop. */
    vpip_hands: number,
    pfr_hands: number,
    /** Hands abandoned because something threw (not counted in the results). */
    errors: number,
    error_samples: string[]
}

export interface SimSummary {
    players: number,
    hands: number,
    winrate: WinrateSummary,
    adjusted: WinrateSummary,
    vpip: number,
    pfr: number,
    errors: number
}

export function summarizeSim(r: SimResult): SimSummary {
    return {
        players: r.players, hands: r.hands, winrate: summarizeWinrate(r.results_bb), adjusted: summarizeWinrate(r.adjusted_bb),
        vpip: r.hands ? r.vpip_hands / r.hands : 0, pfr: r.hands ? r.pfr_hands / r.hands : 0, errors: r.errors
    };
}

type Move = { action: "fold" | "check" | "call" | "raise", to: number };
type Decider = (s: HandState, v: HeroView, cards: string[], rand: () => number) => Move;

const BB = 20;
const EPS = 1e-6;
const HERO_ID = "hero";
const fmt = (x: number) => String(Math.round(x * 100) / 100);
const tag = (p: { name: string, id: string }) => `"${p.name} @ ${p.id}"`;

// --- the pool players -------------------------------------------------------------------------

/** Share of the stack at which a raise becomes all-in. */
const PREFLOP_ALL_IN_SHARE = 0.4;
const POSTFLOP_ALL_IN_SHARE = 0.6;
const BET_SIZE = 0.66;
const RAISE_MULTIPLIER = 3;
/** Engine's fold-to-raise estimate for an average player, and its size scaling (postflop.ts foldChance). */
const FOLD_TO_RAISE = 0.25;
const REFERENCE_BET = 0.66;
const RERAISE_SHARE = 0.5;
const LEAD_SHARE = 0.5;

/** Stats for an average pool player, as the engine's lookups take them. */
function poolStats(): ObservedStats {
    return { vpip: POPULATION_TENDENCIES.vpip, pfr: POPULATION_TENDENCIES.pfr, three_bet: POPULATION_TENDENCIES.three_bet,
        hands: 200, aggression: PRIORS.aggression.mean, shrunk: true };
}

function rangeOf(s: HandState, seat: SeatState, line: PreflopLine): Range {
    return preflopRange(line, POPULATION_TENDENCIES, positionWidth(seat.position, s.seats.length), {
        reraise: line === "3bet" ? reraiseFactor(s, seat.id) : 1,
        seven_deuce_bounty: TABLE_RULES.seven_deuce_bounty
    });
}

function poolPreflop(s: HandState, v: HeroView, cards: string[], rand: () => number): Move {
    const me = s.seats.find((p) => p.id === s.hero_id)!;
    const cls = classOf(cards);
    const w = (line: PreflopLine) => rangeOf(s, me, line).get(cls) ?? 0;
    // chance of a line given the line the player is already on (ranges are nested, so a ratio of weights)
    const given = (line: PreflopLine, before: PreflopLine | null) => before ? Math.min(1, w(line) / Math.max(w(before), 1e-9)) : w(line);
    const pre = s.actions.filter((a) => a.street === "preflop");
    const raises = pre.filter((a) => a.type === "raise" || a.type === "bet");
    const last = raises[raises.length - 1];
    const prev = preflopLine(s, me.id);
    let p_raise = 0, p_call = 0, raise_to = 0;
    if (raises.length === 0) {
        const limpers = pre.filter((a) => a.type === "call").length;
        p_raise = w("raise");
        p_call = v.to_call > EPS ? w("limp") : 0;
        raise_to = (v.to_call > EPS ? 3 : 4) * s.big_blind + limpers * s.big_blind;
    } else if (raises.length === 1) {
        const before = prev === "limp" ? "limp" : null;
        const callers = pre.filter((a) => a.type === "call" && s.actions.indexOf(a) > s.actions.indexOf(last)).length;
        p_raise = given(before ? "limp_raise" : "3bet", before);
        p_call = given("call_raise", before);
        raise_to = last.street_total * (RAISE_MULTIPLIER + callers);
    } else if (raises.length === 2) {
        const before = prev === "raise" || prev === "call_raise" || prev === "limp" ? prev : null;
        p_raise = given("4bet", before);
        p_call = given(prev === "raise" ? "call_3bet" : "cold_call_3bet", before);
        raise_to = last.street_total * 2.3;
    } else {
        // facing a 4-bet or more: continue with 4-bet hands; a re-raiser moves all-in, anyone else calls
        const before = prev === "unknown" || prev === "check_bb" ? null : prev;
        const go = given("4bet", before);
        if (prev === "3bet" || prev === "4bet") { p_raise = go; raise_to = Infinity; } else p_call = go;
    }
    p_raise = Math.min(1, p_raise);
    p_call = Math.min(p_call, 1 - p_raise);
    const u = rand();
    if (u < p_raise) {
        const total = v.max_raise_to;
        return { action: "raise", to: raise_to >= PREFLOP_ALL_IN_SHARE * total ? total : raise_to };
    }
    if (u < p_raise + p_call) return { action: v.to_call > EPS ? "call" : "check", to: 0 };
    return { action: v.to_call > EPS ? "fold" : "check", to: 0 };
}

// hand ranking within a range, as the engine's equity model ranks continuing hands (equity.ts)
const TIER = { strong: 3, pair: 2, draw: 1, air: 1 } as const;
const WORST_VALUE = 7463;
const BEST_PAIR_VALUE: number[] = [...RANKS].map((r) => {
    const kickers = [...RANKS].reverse().filter((k) => k !== r).slice(0, 3);
    return evaluate([r + "s", r + "h", kickers[0] + "d", kickers[1] + "c", kickers[2] + "d"].map(code));
});
/** Strength class and continue score of a combo on a board, cached for the current hand (boards repeat within a hand). */
type Scored = { cls: StrengthClass, score: number };
const score_cache = new Map<string, Map<number, Scored>>();
function scored(c0: number, c1: number, board: string[]): Scored {
    const key = board.join("");
    let by_combo = score_cache.get(key);
    if (!by_combo) score_cache.set(key, by_combo = new Map());
    const k = c0 < c1 ? c0 * 1024 + c1 : c1 * 1024 + c0;
    let hit = by_combo.get(k);
    if (!hit) {
        const hole = [cardName(c0), cardName(c1)];
        const cls = strengthClass(hole, board);
        let score = TIER[cls] * 10000 + (WORST_VALUE - evaluate([c0, c1, ...board.map(code)]));
        if (board.length < 5 && cls === "draw") {
            const lowest = Math.min(...board.map((c) => RANKS.indexOf(c[0])));
            score = Math.max(score, TIER.pair * 10000 + (WORST_VALUE - BEST_PAIR_VALUE[lowest]) + 0.5);
        }
        by_combo.set(k, hit = { cls, score });
    }
    return hit;
}

interface Standing {
    /** Share of the range's weight stronger than this hand (0 = the best hand in the range). */
    position: number,
    /** This hand's raise and bet action weights relative to the range's average. */
    raise_ratio: number,
    bet_ratio: number
}

/** Where `cards` stand in the player's range narrowed by their actions, on the current board. */
function standing(s: HandState, me: SeatState, cards: string[], rand: () => number): Standing {
    const board = s.board;
    const street = (board.length >= 5 ? "river" : board.length === 4 ? "turn" : "flop") as PostflopStreet;
    const aggression = PRIORS.aggression.mean;
    const range = rangeOf(s, me, preflopLine(s, me.id));
    const acts = postflopActions(s, me.id);
    const rows = { flop: weightsFor(aggression, "flop"), turn: weightsFor(aggression, "turn"), river: weightsFor(aggression, "river") };
    const now = rows[street];
    const dead = new Set(board.map(code));
    const own = cards.map(code);
    const combos = expandRange(range, dead);
    if (!combos.some((c) => (c.cards[0] === own[0] && c.cards[1] === own[1]) || (c.cards[0] === own[1] && c.cards[1] === own[0]))) {
        combos.push({ cards: [own[0], own[1]], weight: 1e-3 });
    }
    let total = 0, above = 0, equal = 0, raise_mass = 0, bet_mass = 0;
    const mine = scored(own[0], own[1], board);
    for (const c of combos) {
        let w = c.weight;
        for (const a of acts) {
            const st = (a.board.length >= 5 ? "river" : a.board.length === 4 ? "turn" : "flop") as PostflopStreet;
            w *= rows[st][a.action][scored(c.cards[0], c.cards[1], a.board).cls];
        }
        if (!(w > 0)) continue;
        const { cls, score } = scored(c.cards[0], c.cards[1], board);
        total += w;
        raise_mass += w * now.raise[cls];
        bet_mass += w * now.bet[cls];
        if (score > mine.score) above += w;
        else if (score === mine.score) equal += w;
    }
    if (!(total > 0)) return { position: 0.5, raise_ratio: 1, bet_ratio: 1 };
    return {
        position: (above + rand() * equal) / total,
        raise_ratio: now.raise[mine.cls] / Math.max(raise_mass / total, 1e-9),
        bet_ratio: now.bet[mine.cls] / Math.max(bet_mass / total, 1e-9)
    };
}

function poolPostflop(table: ResponseTable) {
    return (s: HandState, v: HeroView, cards: string[], rand: () => number): Move => {
        const me = s.seats.find((p) => p.id === s.hero_id)!;
        const street = s.street as PostflopStreet;
        const st = standing(s, me, cards, rand);
        const u = rand();
        const aggressive = s.actions.filter((a) => a.street === s.street && (a.type === "bet" || a.type === "raise"));
        const allIn = (to: number) => to >= POSTFLOP_ALL_IN_SHARE * v.max_raise_to ? v.max_raise_to : to;
        if (v.to_call > EPS) {
            const last = aggressive[aggressive.length - 1];
            const share = last ? last.amount / Math.max(last.pot_before, EPS) : REFERENCE_BET;
            let fold: number, raise: number;
            if (last && aggressive.length === 1) {
                const folded = new Set(s.seats.filter((p) => p.folded).map((p) => p.id));
                const role = roleOf(s.actions.slice(0, s.actions.indexOf(last)), last.player_id, street, folded);
                ({ fold, raise } = responseFor(table, street, role, share));
            } else {
                fold = Math.max(0.03, Math.min(0.9, FOLD_TO_RAISE * Math.pow(Math.max(share, 0.05) / REFERENCE_BET, 0.35)));
                raise = PRIORS.raise_vs_bet.mean * RERAISE_SHARE;
            }
            if (aggressive.length >= 4) raise = 0;
            const q = Math.min(1, raise * st.raise_ratio);
            if (v.min_raise_to !== null && u < q) return { action: "raise", to: allIn(s.current_bet * RAISE_MULTIPLIER) };
            return { action: st.position < 1 - fold ? "call" : "fold", to: 0 };
        }
        // not facing a bet: c-bet, bet when checked to, or lead into the last aggressor
        const earlier = s.actions.filter((a) => a.street !== s.street && (a.type === "bet" || a.type === "raise"));
        const aggressor = earlier[earlier.length - 1]?.player_id;
        const aggressor_seat = s.seats.find((p) => p.id === aggressor);
        const aggressor_acted = s.actions.some((a) => a.street === s.street && a.player_id === aggressor);
        const rate = street === "flop" && aggressor === me.id ? PRIORS.cbet.mean
            : aggressor_seat && aggressor !== me.id && !aggressor_seat.folded && !aggressor_seat.all_in && !aggressor_acted ? PRIORS.bet_when_checked_to.mean * LEAD_SHARE
            : PRIORS.bet_when_checked_to.mean;
        if (v.min_raise_to !== null && u < Math.min(1, rate * st.bet_ratio)) return { action: "raise", to: allIn(BET_SIZE * v.pot) };
        return { action: "check", to: 0 };
    };
}

function poolDecider(table: ResponseTable): Decider {
    const post = poolPostflop(table);
    return (s, v, cards, rand) => s.street === "preflop" ? poolPreflop(s, v, cards, rand) : post(s, v, cards, rand);
}

// --- the engine ---------------------------------------------------------------------------------

/** The engine as the live bot runs it with the AI off, facing players it knows as average pool players. */
function engineDecider(budget_ms: number): Decider {
    const stats = () => poolStats();
    const players = () => ({ deviations: [] });
    return (s, v) => {
        if (s.street === "preflop") {
            let eq: number | undefined;
            if (v.to_call > 0) {
                const models = opponentModels(s, stats).map((m) => m.model);
                eq = equity({ hero: s.hero_cards, board: s.board, opponents: models, iterations: 5000, time_budget_ms: Math.max(budget_ms, 5), seed: 97 }).equity;
            }
            const advice = preflopAdvice(s, v, stats, undefined, { seven_deuce_bounty: 0, equity: eq, ev: { time_budget_ms: Math.max(budget_ms, 10) } });
            if (!advice) return { action: v.to_call > 0 ? "fold" : "check", to: 0 };
            // size_bb is rounded to cents of a BB, so an all-in goes by the stack, not the rounded size
            if (advice.action === "all-in") return { action: "raise", to: v.max_raise_to };
            if (advice.action === "raise") return { action: "raise", to: advice.size_bb * s.big_blind };
            return { action: advice.action, to: 0 };
        }
        const a = analyzePostflop(s, v, opponentTendencies(s, stats, players), budget_ms);
        const best = a.candidates[0];
        if (best.action === "bet" || best.action === "raise" || best.action === "all-in") return { action: "raise", to: best.to };
        return { action: best.action, to: 0 };
    };
}

// --- the table ----------------------------------------------------------------------------------

interface SimPlayer { id: string, name: string, cards: string[] }

class SimHand {
    lines: string[] = [];
    constructor(private players: SimPlayer[], private button: number, private stack: number, private deciders: Map<string, Decider>,
        private rand: () => number, private board: string[], number: number) {
        const dealer = players[button];
        this.lines.push(`-- starting hand #${number} (id: sim${number})  No Limit Texas Hold'em (dealer: ${tag(dealer)}) --`);
        this.lines.push("Player stacks: " + players.map((p, i) => `#${i + 1} ${tag(p)} (${fmt(stack)})`).join(" | "));
        const hero = players.find((p) => p.id === HERO_ID);
        if (hero) this.lines.push(`Your hand is ${hero.cards.join(", ")}`);
    }

    private at(offset: number): SimPlayer {
        return this.players[(this.button + offset) % this.players.length];
    }

    /** The hand from one player's seat (their id and cards as hero). */
    stateFor(id: string): HandState {
        const s = parseHand(this.lines, { big_blind: BB });
        s.hero_id = id;
        s.hero_cards = this.players.find((p) => p.id === id)!.cards;
        return s;
    }

    private order(street: string): SimPlayer[] {
        const n = this.players.length;
        const start = n === 2 ? (street === "preflop" ? 0 : 1) : (street === "preflop" ? 3 : 1);
        return Array.from({ length: n }, (_, i) => this.at(start + i));
    }

    private canAct(s: HandState, id: string): boolean {
        const p = s.seats.find((x) => x.id === id)!;
        return !p.folded && !p.all_in;
    }

    /** Applies a move; returns true when it raised the bet. */
    private apply(p: SimPlayer, m: Move, s: HandState, v: HeroView): boolean {
        const me = s.seats.find((x) => x.id === p.id)!;
        let action = m.action;
        if (action === "fold" && v.to_call <= EPS) action = "check";
        if (action === "check" && v.to_call > EPS) action = "fold";
        if (action === "call" && v.to_call <= EPS) action = "check";
        if (action === "raise") {
            if (v.min_raise_to === null) action = v.to_call > EPS ? "call" : "check";
            else {
                // never more than the most another player still in can match
                const cap = Math.max(...s.seats.filter((x) => x.id !== p.id && !x.folded).map((x) => x.stack + x.street_contribution));
                let to = Math.min(Math.max(m.to, v.min_raise_to), v.max_raise_to, cap);
                to = Math.round(to * 100) / 100;
                if (to >= v.max_raise_to - 0.005) to = v.max_raise_to;
                if (to <= s.current_bet + EPS) action = v.to_call > EPS ? "call" : "check";
                else {
                    const all_in = to >= v.max_raise_to - EPS;
                    this.lines.push(`${tag(p)} ${s.current_bet > EPS ? "raises to" : "bets"} ${fmt(to)}${all_in ? " and go all in" : ""}`);
                    return true;
                }
            }
        }
        if (action === "fold") this.lines.push(`${tag(p)} folds`);
        else if (action === "check") this.lines.push(`${tag(p)} checks`);
        else {
            const amount = Math.min(s.current_bet, me.street_contribution + me.stack);
            this.lines.push(`${tag(p)} calls ${fmt(amount)}${me.stack <= v.to_call + EPS ? " and go all in" : ""}`);
        }
        return false;
    }

    private round(street: string, acted: (id: string, s: HandState, m: Move) => void): void {
        const order = this.order(street);
        const s0 = parseHand(this.lines, { big_blind: BB });
        let pending = new Set(order.filter((p) => this.canAct(s0, p.id)).map((p) => p.id));
        for (let i = 0, guard = 0; pending.size > 0 && guard < 500; i++, guard++) {
            const p = order[i % order.length];
            if (!pending.has(p.id)) continue;
            pending.delete(p.id);
            const s = this.stateFor(p.id);
            const live = s.seats.filter((x) => !x.folded);
            if (live.length <= 1) return;
            if (!this.canAct(s, p.id)) continue;
            const v = heroView(s)!;
            const others_can_act = live.some((x) => x.id !== p.id && !x.all_in);
            if (v.to_call <= EPS && !others_can_act) continue;
            const move = this.deciders.get(p.id)!(s, v, p.cards, this.rand);
            acted(p.id, s, move);
            if (this.apply(p, move, s, v)) {
                const after = parseHand(this.lines, { big_blind: BB });
                pending = new Set(order.filter((x) => x.id !== p.id && this.canAct(after, x.id)).map((x) => x.id));
            }
        }
    }

    play(acted: (id: string, s: HandState, m: Move) => void): HandState {
        const n = this.players.length;
        const [sb, bb] = n === 2 ? [this.at(0), this.at(1)] : [this.at(1), this.at(2)];
        this.lines.push(`${tag(sb)} posts a small blind of ${fmt(BB / 2)}`, `${tag(bb)} posts a big blind of ${fmt(BB)}`);
        this.round("preflop", acted);
        const streets: [string, number][] = [["Flop", 3], ["Turn", 4], ["River", 5]];
        for (const [name, k] of streets) {
            if (parseHand(this.lines, { big_blind: BB }).seats.filter((p) => !p.folded).length <= 1) break;
            const b = this.board;
            this.lines.push(k === 3 ? `Flop:  [${b.slice(0, 3).join(", ")}]` : `${name}: ${b.slice(0, k - 1).join(", ")} [${b[k - 1]}]`);
            this.round(name.toLowerCase(), acted);
        }
        this.finish();
        const s = parseHand(this.lines, { big_blind: BB });
        s.hero_id = this.players.some((p) => p.id === HERO_ID) ? HERO_ID : null;
        return s;
    }

    private finish(): void {
        let s = parseHand(this.lines, { big_blind: BB });
        const live = s.seats.filter((p) => !p.folded);
        if (live.length === 1) {
            const w = live[0];
            const others = Math.max(0, ...s.seats.filter((p) => p.id !== w.id).map((p) => p.street_contribution));
            const excess = Math.round((w.street_contribution - others) * 100) / 100;
            if (excess > 0) this.lines.push(`Uncalled bet of ${fmt(excess)} returned to ${tag(w)}`);
            s = parseHand(this.lines, { big_blind: BB });
            this.lines.push(`${tag(w)} collected ${fmt(s.pot)} from pot`);
        } else {
            const values = live.map((p) => {
                const cards = this.players.find((x) => x.id === p.id)!.cards;
                this.lines.push(`${tag(p)} shows a ${cards.join(", ")}.`);
                return evaluate([...cards, ...this.board].map(code));
            });
            const best = Math.min(...values);
            const winners = live.filter((_, i) => values[i] === best);
            let left = Math.round(s.pot * 100) / 100;
            winners.forEach((p, i) => {
                const share = i === winners.length - 1 ? left : Math.floor(s.pot / winners.length * 100) / 100;
                left = Math.round((left - share) * 100) / 100;
                this.lines.push(`${tag(p)} collected ${fmt(share)} from pot`);
            });
        }
        this.lines.push(`-- ending hand #${s.hand_number} --`);
    }
}

const DECK_NAMES = DECK.map(cardName);

/**
 * allInAdjustedNet for the simulation: the same rule, but a preflop all-in uses 4,000 random boards
 * instead of enumerating all 1.7 million (too slow to do thousands of times).
 */
function adjustedNet(s: HandState, rand: () => number): number | null {
    const hero = s.seats.find((p) => p.id === HERO_ID);
    const others = s.seats.filter((p) => p.id !== HERO_ID && !p.folded);
    const last_money = [...s.actions].reverse().find((a) => ["bet", "raise", "call"].includes(a.type));
    if (last_money?.street !== "preflop") return allInAdjustedNet(s, HERO_ID);
    if (!hero || hero.folded || others.length !== 1 || !(hero.all_in || others[0].all_in)) return null;
    const villain = others[0].shown_cards;
    if (s.hero_cards.length !== 2 || villain?.length !== 2) return null;
    const h = s.hero_cards.map(code), v = villain.map(code);
    const rest = DECK.filter((c) => !h.includes(c) && !v.includes(c));
    let share = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
        // partial shuffle: the first five cards are the board
        for (let k = 0; k < 5; k++) {
            const j = k + Math.floor(rand() * (rest.length - k));
            [rest[k], rest[j]] = [rest[j], rest[k]];
        }
        const board = rest.slice(0, 5);
        const hs = evaluate([...h, ...board]), vs = evaluate([...v, ...board]);
        share += hs < vs ? 1 : hs === vs ? 0.5 : 0;
    }
    return share / N * s.pot - hero.total_contribution;
}

/** Plays `hands` hands with the engine (or a pool player) in seat 1 and pool players elsewhere. */
export function simulate(o: SimOptions): SimResult {
    setBetPlanInEv(!!o.plan_in_ev);
    try {
        return simulateHands(o);
    } finally {
        setBetPlanInEv(false);
    }
}

function simulateHands(o: SimOptions): SimResult {
    const n = Math.max(2, Math.min(9, Math.floor(o.players)));
    const rand = seededRandom(o.seed);
    const stack = (o.stack_bb ?? 100) * BB;
    const table = poolDecider(pool_table);
    const players: SimPlayer[] = Array.from({ length: n }, (_, i) => i === 0 ? { id: HERO_ID, name: "Hero", cards: [] } : { id: `v${i}`, name: `Villain${i}`, cards: [] });
    const deciders = new Map<string, Decider>(players.map((p) => [p.id, p.id === HERO_ID && o.hero !== "pool" ? engineDecider(o.engine_budget_ms ?? 15) : table]));
    const result: SimResult = { players: n, hands: 0, results_bb: [], adjusted_bb: [], vpip_hands: 0, pfr_hands: 0, errors: 0, error_samples: [] };
    // the simulated game has no 7-2 bounty, so no one's ranges include 7-2 bluffs
    const bounty_rule = TABLE_RULES.seven_deuce_bounty;
    TABLE_RULES.seven_deuce_bounty = false;
    try {
        for (let h = 0; h < o.hands; h++) {
            const deck = [...DECK_NAMES];
            for (let i = deck.length - 1; i > 0; i--) {
                const j = Math.floor(rand() * (i + 1));
                [deck[i], deck[j]] = [deck[j], deck[i]];
            }
            players.forEach((p, i) => p.cards = [deck[2 * i], deck[2 * i + 1]]);
            const board = deck.slice(2 * n, 2 * n + 5);
            score_cache.clear();
            const hand = new SimHand(players, h % n, stack, deciders, rand, board, h + 1);
            let vpip = false, pfr = false;
            try {
                const final = hand.play((id, s, m) => {
                    if (id !== HERO_ID || s.street !== "preflop") return;
                    if (m.action === "raise") { vpip = true; pfr = true; }
                    if (m.action === "call") vpip = true;
                });
                o.on_hand?.(hand.lines);
                const net = netResult(final, HERO_ID);
                const adjusted = adjustedNet(final, rand);
                result.results_bb.push(net / BB);
                result.adjusted_bb.push((adjusted ?? net) / BB);
                result.hands++;
                if (vpip) result.vpip_hands++;
                if (pfr) result.pfr_hands++;
            } catch (err) {
                result.errors++;
                if (result.error_samples.length < 5) result.error_samples.push(String(err instanceof Error ? err.stack?.split("\n").slice(0, 3).join(" | ") : err));
            }
        }
    } finally {
        TABLE_RULES.seven_deuce_bounty = bounty_rule;
    }
    return result;
}

/** The response table the pool players use (the engine's defaults until usePool sets one). */
let pool_table: ResponseTable = defaultResponseTable();

/** Sets the pool model everywhere: the engine's globals and the pool players' response table. */
export function usePool(pool: PoolModel): void {
    applyPool(pool);
    pool_table = pool.response_table;
}

/**
 * Runs the simulation split over worker threads (each with its own seed derived from `o.seed`) and
 * joins the results. Falls back to one thread when workers can't start.
 */
export async function simulateParallel(pool: PoolModel, o: SimOptions, workers: number): Promise<SimResult> {
    const k = Math.max(1, Math.min(workers, o.hands));
    const chunks = Array.from({ length: k }, (_, i) => ({ ...o, on_hand: undefined, seed: (o.seed * 7919 + i * 104729) >>> 0, hands: Math.floor(o.hands / k) + (i < o.hands % k ? 1 : 0) }));
    // a worker doesn't inherit tsx's loader: register it first, then load the TypeScript entry
    const api = import.meta.resolve("tsx/esm/api");
    const entry = new URL("./sim-worker.ts", import.meta.url).href;
    const bootstrap = `import(${JSON.stringify(api)}).then((m) => { m.register(); return import(${JSON.stringify(entry)}); });`;
    const run = (chunk: SimOptions) => new Promise<SimResult>((resolve, reject) => {
        const w = new Worker(bootstrap, { eval: true, workerData: { pool, options: chunk } });
        w.once("message", (r: SimResult) => { resolve(r); void w.terminate(); });
        w.once("error", reject);
        w.once("exit", (codeValue) => { if (codeValue !== 0) reject(new Error(`simulation worker stopped with code ${codeValue}`)); });
    });
    let parts: SimResult[];
    try {
        parts = await Promise.all(chunks.map(run));
    } catch (err) {
        process.stderr.write(`simulation workers failed (${err instanceof Error ? err.message : err}); running on one thread\n`);
        usePool(pool);
        parts = chunks.map((c) => simulate(c));
    }
    return parts.reduce((a, b) => ({
        players: a.players, hands: a.hands + b.hands, results_bb: [...a.results_bb, ...b.results_bb], adjusted_bb: [...a.adjusted_bb, ...b.adjusted_bb],
        vpip_hands: a.vpip_hands + b.vpip_hands, pfr_hands: a.pfr_hands + b.pfr_hands, errors: a.errors + b.errors,
        error_samples: [...a.error_samples, ...b.error_samples].slice(0, 5)
    }));
}
