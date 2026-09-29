// Candidate actions and rough EV estimates for post-flop decisions.
//
// Model (a two-street approximation; later streets are only covered by "realization" R):
//   call        : equity x (pot + call) x R - call
//   check       : if hero closes the action, equity x pot x R. Otherwise the players still to act
//                 bet with their "bet when checked to" rate (about 2/3 pot); hero then calls only when
//                 their equity against a betting range beats the price, and gives up the pot otherwise.
//   bet / raise : everyone folds -> hero wins the pot. Called -> hero's share of the bigger pot against
//                 the hands that call: each opponent raises at their raise rate (mostly strong hands),
//                 otherwise calls with the strongest part of their range (as much as their fold rate
//                 leaves) or folds, and every caller adds chips. Raised -> hero continues only when
//                 their equity against a raising range beats the price, else loses the bet.
// Fold rates come from opponent profiles, per street when known, and grow with bet size. All the
// constants below are stated assumptions, not measured values.
import { HandState, HeroView, SeatState } from "./hand-parser.ts";
import { continuationEquity, equity, OpponentModel, PostflopStreet } from "./equity.ts";
import { PRIORS } from "./player-profile.ts";

export interface Candidate {
    action: "fold" | "check" | "call" | "bet" | "raise" | "all-in",
    /** Total bet/raise-to in chips (0 for fold/check/call). */
    to: number,
    /** Estimated EV in chips relative to folding now. */
    ev: number,
    label: string
}

export interface PostflopAnalysis {
    equity: number,
    /** Equity when the bet or raise gets called (opponents continue with stronger hands). */
    equity_when_called: number,
    required_equity: number,
    fold_probability: Map<number, number>,
    candidates: Candidate[],
    in_position: boolean,
    realization: number
}

export interface OpponentTendency {
    model: OpponentModel,
    /** Probability of folding to a ~2/3-pot bet (0-1). */
    fold_to_bet: number,
    /** Probability of folding to a raise (0-1). */
    fold_to_raise: number,
    /** Probability of folding to a ~2/3-pot bet on each street (0-1); replaces fold_to_bet when given. */
    fold_by_street?: { flop: number, turn: number, river: number },
    /** Chance the player raises when facing a bet (0-1). */
    raise_vs_bet?: number,
    /** Chance the player bets when checked to (0-1). */
    bet_when_checked_to?: number,
    /** The player's seat id; when left out, the i-th tendency is the i-th opponent still in the hand, in seat order. */
    seat_id?: string
}

const BET_SIZES = [0.33, 0.66, 1.0];
/** Overbet (share of the pot) offered on the turn and river when a calling range is far behind hero. */
const OVERBET_SIZE = 1.5;
const OVERBET_MIN_EQUITY_WHEN_CALLED = 0.7;
const RAISE_MULTIPLIERS = [2.5, 3.5];
const REFERENCE_BET = 0.66;
const ALL_IN_SHARE = 0.6;
/** Chance a player raises a bet, when their profile doesn't say (scaled by their aggression). */
const DEFAULT_RAISE_VS_BET = 0.1;
/** Re-raises of hero's raise are rarer than raises of a bet. */
const RERAISE_SHARE = 0.5;
/**
 * When hero gets raised, the raise is to this multiple of hero's bet, and the other players are
 * assumed to fold (hero plays against the raiser alone).
 */
const FACING_RAISE_MULTIPLIER = 3;
/** Chance a player bets when checked to, when their profile doesn't say (scaled by their aggression). */
const DEFAULT_BET_WHEN_CHECKED_TO = 0.4;
/** Realization drops for each opponent beyond the first, and out of position with a weak hand. */
const MULTIWAY_REALIZATION_DROP = 0.04;
const LOW_EQUITY = 0.4;
const LOW_EQUITY_OOP_DROP = 0.1;
/** Simulations for the side estimates (equity against a bettor or a raiser): fewer, to stay fast. */
const SIDE_ITERATIONS = 6000;
/** Same simulated hands on every call, so the options compare cleanly and the advice is repeatable. */
const SEED = 20240613;

function realizationFor(street: PostflopStreet, in_position: boolean, opponents: number, equity: number): number {
    if (street === "river") return 1;
    let r = street === "turn" ? (in_position ? 1.0 : 0.9) : (in_position ? 0.95 : 0.85);
    r -= MULTIWAY_REALIZATION_DROP * Math.max(0, opponents - 1);
    if (!in_position && equity < LOW_EQUITY) r -= LOW_EQUITY_OOP_DROP * (LOW_EQUITY - equity) / LOW_EQUITY;
    return Math.max(0.6, r);
}

/** Post-flop acting order: SB, BB, UTG ... BU; heads-up the small blind is the button, so the big blind acts first. */
const POSTFLOP_ORDER = ["SB", "BB", "UTG", "UTG+1", "UTG+2", "MP", "LJ", "HJ", "CO", "BU"];

function actingOrder(heads_up: boolean, position: string): number {
    if (heads_up) return position === "BB" ? 0 : position === "SB" ? 1 : -1;
    const i = POSTFLOP_ORDER.indexOf(position);
    if (i >= 0) return i;
    // more early seats than the list has (not possible at PokerNow's 10 seats): after UTG+2, before MP
    const extra = position.match(/^UTG\+(\d+)$/);
    return extra ? POSTFLOP_ORDER.indexOf("UTG+2") + Number(extra[1]) / 100 : -1;
}

/** Two players dealt in (players the log never listed with a seat don't count). */
function headsUp(s: HandState): boolean {
    return s.seats.filter((p) => p.position !== "?").length === 2;
}

/** Hero acts last among the players still in the hand. */
export function heroInPosition(s: HandState): boolean {
    const hu = headsUp(s);
    const active = s.seats.filter((p) => !p.folded).sort((a, b) => actingOrder(hu, a.position) - actingOrder(hu, b.position));
    return active.length > 0 && active[active.length - 1].id === s.hero_id;
}

/** Opponents who act after hero on this street and can still bet (not folded, not all-in). */
function playersBehind(s: HandState): SeatState[] {
    const hero = s.seats.find((p) => p.id === s.hero_id);
    if (!hero) return [];
    const hu = headsUp(s);
    const mine = actingOrder(hu, hero.position);
    return s.seats.filter((p) => p.id !== hero.id && !p.folded && !p.all_in && actingOrder(hu, p.position) > mine);
}

function clamp(x: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, x));
}

/** A profile rate if it is a usable number, else the fallback. */
function rate(x: number | undefined, fallback: number): number {
    return typeof x === "number" && Number.isFinite(x) ? clamp(x, 0, 1) : fallback;
}

/** How much more (or less) often than the average player in your games this opponent bets and raises. */
function aggressionFactor(o: OpponentTendency, lo: number, hi: number): number {
    const a = o.model.aggression;
    return a === undefined ? 1 : clamp(a / Math.max(PRIORS.aggression.mean, 0.05), lo, hi);
}

/** Chance one opponent folds to a bet (or raise) of `bet` chips into `pot`. */
function foldChance(o: OpponentTendency, street: PostflopStreet, bet: number, pot: number, raise: boolean): number {
    const scale = Math.pow(Math.max(bet / Math.max(pot, 1e-9), 0.05) / REFERENCE_BET, 0.35);
    const base = raise ? o.fold_to_raise : rate(o.fold_by_street?.[street], o.fold_to_bet);
    return clamp(base * scale, 0.03, 0.9);
}

function raiseChance(o: OpponentTendency): number {
    return rate(o.raise_vs_bet, DEFAULT_RAISE_VS_BET * aggressionFactor(o, 0.8, 1.2));
}

function betChance(o: OpponentTendency): number {
    return rate(o.bet_when_checked_to, DEFAULT_BET_WHEN_CHECKED_TO * aggressionFactor(o, 0.85, 1.15));
}

const product = (xs: number[]) => xs.reduce((p, x) => p * x, 1);

function argmax(xs: number[]): number {
    let best = 0;
    xs.forEach((x, i) => { if (x > xs[best]) best = i; });
    return best;
}

/** A bet or raise size and how each opponent responds to it. */
interface Plan {
    to: number,
    raise: boolean,
    overbet: boolean,
    /** Chips hero adds with this bet or raise. */
    invest: number,
    /** Each opponent's chance of folding, and of raising, and the chips they add when they call. */
    folds: number[],
    raises: number[],
    adds: number[],
    /** What a raise of hero's bet is assumed to be (raise-to, chips). */
    raise_to: number
}

export function analyzePostflop(s: HandState, v: HeroView, opponents: OpponentTendency[], time_budget_ms = 120): PostflopAnalysis {
    const street: PostflopStreet = s.street === "turn" || s.street === "river" ? s.street : "flop";
    const models = opponents.map((o) => o.model);
    const in_position = heroInPosition(s);
    const pot = v.pot;
    const hero_total = v.max_raise_to;
    const hero_in = s.seats.find((p) => p.id === s.hero_id)?.street_contribution ?? 0;
    const facing_bet = v.to_call > 1e-9;
    const seats = opponentSeats(s, opponents);
    const bb = s.big_blind;
    const fmt = (chips: number) => `${Math.round(chips / bb * 10) / 10} BB`;

    // what each opponent does against a bet (or raise) to `to`
    const respond = (to: number, raise: boolean, overbet: boolean): Plan => {
        const invest = to - (raise ? hero_in : 0);
        const all_in = to >= hero_total - 1e-9;
        const raise_to = Math.min(FACING_RAISE_MULTIPLIER * to, v.effective_stack);
        const folds: number[] = [], raises: number[] = [], adds: number[] = [];
        opponents.forEach((o, i) => {
            const seat = seats[i];
            // a player who is already all-in can't fold, raise or add chips
            if (seat?.all_in) { folds.push(0); raises.push(0); adds.push(0); return; }
            const fold = foldChance(o, street, invest, pot + (raise ? v.to_call : 0), raise);
            // nobody raises an all-in, or a bet they can't cover more than
            const can_raise = !all_in && raise_to > to + 1e-9 && (!seat || seat.stack + seat.street_contribution > to + 1e-9);
            folds.push(fold);
            raises.push(can_raise ? Math.min(raiseChance(o) * (raise ? RERAISE_SHARE : 1), 1 - fold) : 0);
            // a caller adds the difference between hero's new total and their current bet
            adds.push(seat
                ? Math.max(0, Math.min(to - seat.street_contribution, seat.stack))
                : Math.max(0, Math.min(raise ? to - s.current_bet : to, v.effective_stack)));
        });
        return { to, raise, overbet, invest, folds, raises, adds, raise_to };
    };

    // bet or raise sizes, never more than the biggest opponent stack can call (the rest would come back)
    const plans: Plan[] = [];
    const most = Math.max(v.min_raise_to ?? 0, Math.min(hero_total, v.effective_stack));
    const plan = (target: number, raise: boolean, overbet: boolean) => {
        let to = Math.max(v.min_raise_to!, target);
        if (to >= most * ALL_IN_SHARE) to = most;
        to = Math.round(Math.min(to, most) * 100) / 100;
        if (!plans.some((p) => p.to === to)) plans.push(respond(to, raise, overbet));
    };
    if (v.min_raise_to !== null) {
        if (!facing_bet) {
            for (const f of BET_SIZES) plan(pot * f, false, false);
            if (street !== "flop") plan(pot * OVERBET_SIZE, false, true);
        } else {
            // pot-sized raise: call, then raise the size of the pot after the call
            const pot_raise = s.current_bet + (pot + v.to_call);
            for (const target of [...RAISE_MULTIPLIERS.map((m) => s.current_bet * m), pot_raise]) plan(target, true, false);
        }
    }
    // a ~2/3-pot bet (or raise) for "equity when called" when hero can't bet
    const reference = respond(s.current_bet + REFERENCE_BET * (pot + v.to_call), facing_bet, false);

    // one simulation for all of them (it also gives plain equity against everyone)
    const hero = s.hero_cards;
    const board = s.board;
    const main = continuationEquity({ hero, board, opponents: models, time_budget_ms, seed: SEED },
        [reference, ...plans].map((p) => ({ continue_fraction: p.folds.map((f) => 1 - f), raise_chance: p.raises, adds: p.adds })));
    const eq = main.equity;
    const R = realizationFor(street, in_position, opponents.length, eq);
    const side_budget = Math.max(10, time_budget_ms / 2);
    const narrowed = (i: number, action: "bet" | "raise") => models.map((m, j) => j !== i ? m
        : { ...m, postflop_actions: [...(m.postflop_actions ?? []), { board, action }] });

    /** Checking: free when hero closes the action; otherwise a bet may follow, which hero calls or folds to. */
    const checkEV = (): number => {
        const behind = playersBehind(s);
        if (behind.length === 0) return eq * pot * R;
        const behind_ids = new Set(behind.map((p) => p.id));
        // tendencies without a known seat are assumed to act after hero
        const bettors = opponents.map((o, i) => (!seats[i] || behind_ids.has(seats[i]!.id)) ? betChance(o) : 0);
        const b = 1 - product(bettors.map((x) => 1 - x));
        if (b <= 0) return eq * pot * R;
        // the most likely bettor stands in for whoever bets
        const bettor = argmax(bettors);
        const bet = Math.min(REFERENCE_BET * pot, v.stack, v.effective_stack);
        const eq_vs_bet = equity({ hero, board, opponents: narrowed(bettor, "bet"), iterations: SIDE_ITERATIONS, time_budget_ms: side_budget, seed: SEED }).equity;
        // equity when it checks through: what's left once that player's betting hands are taken out
        // (split by their own bet rate, so it stays exact heads-up and stable multiway)
        const own = bettors[bettor];
        const eq_checked = own < 0.999 ? clamp((eq - own * eq_vs_bet) / (1 - own), 0, 1) : eq;
        const call_ev = eq_vs_bet * (pot + 2 * bet) * R - bet;
        return (1 - b) * eq_checked * pot * R + b * Math.max(0, call_ev);
    };

    const candidates: Candidate[] = [];
    const fold_probability = new Map<number, number>();

    if (!facing_bet) {
        candidates.push({ action: "check", to: 0, ev: checkEV(), label: "check" });
    } else {
        candidates.push({ action: "fold", to: 0, ev: 0, label: "fold" });
        const call_cost = v.to_call;
        candidates.push({ action: "call", to: 0, ev: eq * (pot + call_cost) * R - call_cost, label: `call ${fmt(call_cost)}` });
    }

    // equity against the player most likely to raise, with their range narrowed by a raise (computed when needed)
    const raiser = argmax(opponents.map((o, i) => seats[i]?.all_in ? -1 : raiseChance(o)));
    let eq_vs_raise: number | null = null;
    const equityVsRaise = () => eq_vs_raise ??= equity({ hero, board, opponents: [narrowed(raiser, "raise")[raiser]], iterations: SIDE_ITERATIONS, time_budget_ms: side_budget, seed: SEED }).equity;

    let equity_when_called = main.results[0].equity;
    let best_aggressive = -Infinity;
    for (const [k, p] of plans.entries()) {
        const called = main.results[1 + k];
        if (p.overbet && called.equity < OVERBET_MIN_EQUITY_WHEN_CALLED) continue;
        const all_in = p.to >= hero_total - 1e-9;
        const pf = product(p.folds);
        const pr = Math.min(1 - product(p.raises.map((q) => 1 - q)), 1 - pf);
        // called: hero's share of the pot plus hero's bet (returned if only an all-in player is left) plus the callers' chips
        const called_ev = (called.equity * pot + called.equity_x_matched * p.invest + called.equity_x_added) * R - called.matched * p.invest;
        // raised: hero calls only when their equity against a raising range pays for it, else folds
        let raised_ev = -p.invest;
        if (pr > 0) {
            const call_cost = p.raise_to - p.to;
            const raiser_in = seats[raiser]?.street_contribution ?? (p.raise ? s.current_bet : 0);
            const final_pot = pot + p.invest + (p.raise_to - raiser_in) + call_cost;
            raised_ev = Math.max(-p.invest, equityVsRaise() * final_pot * R - p.invest - call_cost);
        }
        const ev = pf * pot + (1 - pf - pr) * called_ev + pr * raised_ev;
        fold_probability.set(p.to, pf);
        const action = all_in ? "all-in" : p.raise ? "raise" : "bet";
        candidates.push({ action, to: p.to, ev, label: `${action === "all-in" ? "all-in" : action === "raise" ? "raise to" : "bet"} ${fmt(p.to)}` });
        // report the equity when called for the best bet or raise
        if (ev > best_aggressive) { best_aggressive = ev; equity_when_called = called.equity; }
    }
    candidates.sort((a, b) => b.ev - a.ev);
    return {
        equity: eq,
        equity_when_called,
        required_equity: v.to_call > 0 ? v.to_call / (pot + v.to_call) : 0,
        fold_probability,
        candidates,
        in_position,
        realization: R
    };
}

/** The seat of each opponent tendency: by seat_id, or the i-th opponent still in the hand in seat order. */
function opponentSeats(s: HandState, opponents: OpponentTendency[]): (SeatState | undefined)[] {
    const active = s.seats.filter((p) => p.id !== s.hero_id && !p.folded);
    return opponents.map((o, i) => o.seat_id !== undefined
        ? s.seats.find((p) => p.id === o.seat_id)
        : active.length === opponents.length ? active[i] : undefined);
}

/** True when the best candidate is clearly ahead, so the engine can answer without the AI. */
export function isClearSpot(a: PostflopAnalysis, pot: number, big_blind: number): boolean {
    if (a.candidates.length < 2) return true;
    const gap = a.candidates[0].ev - a.candidates[1].ev;
    return gap >= Math.max(big_blind, 0.15 * pot);
}
