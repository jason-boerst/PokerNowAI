// Candidate actions and rough EV estimates for post-flop decisions.
//
// Model (this street in full, the next street for calls, later streets roughly):
//   call        : on the river, equity x (pot + call) - call. On the flop and turn, valued over the next
//                 street (equity.ts callTree): the bettor bets again with a chance that follows their hand
//                 on the next card, hero keeps calling only on the cards where that pays, and folds on the rest.
//   check       : if hero closes the action, equity x pot x R. Otherwise the players still to act
//                 bet with their "bet when checked to" rate (about 2/3 pot); hero then calls only when
//                 their equity against a betting range beats the price, and gives up the pot otherwise.
//   bet / raise : everyone folds -> hero wins the pot. Called -> hero's share of the bigger pot against
//                 the hands that call: each opponent raises at their raise rate (mostly strong hands),
//                 otherwise calls with the strongest part of their range (as much as their fold rate
//                 leaves) or folds, and every caller adds chips. Raised -> hero continues only when
//                 their equity against a raising range beats the price, else loses the bet.
//   every option: plus what later betting adds when both hands are worth putting money in (implied and
//                 reverse implied odds, equity.ts STACK_IN), from the chips still behind.
// How opponents answer hero's bets (fold, call or raise) comes from a table measured from your stored
// hands: by street, by who bets (a lead into the last aggressor, a c-bet, a barrel, a stab) and by size
// (response-calibration.ts). It is adjusted for each player's own fold and raise rates, how their folds
// change with bet size, and how many weak hands their likely range holds on this board. Answers to hero's
// raises use the players' fold-to-raise estimates. Options are ranked by EV minus how far it could be off
// through those estimates (robustEv). The other constants below are stated assumptions, not measured values.
import { HandState, HeroView, SeatState } from "./hand-parser.ts";
import { callTree, CallTreeResult, continuationEquity, equity, IMPLIED_POTS, OpponentModel, PostflopStreet, rangeClassShares, strengthClass } from "./equity.ts";
import { PRIORS } from "./player-profile.ts";
import { BetRole, defaultResponseTable, heroBetRole, responseFor, ResponseTable } from "./response-calibration.ts";

/** Why a bet or raise: value (ahead of the hands that call), semi-bluff (behind but with a draw or real equity), bluff (wins by folds). */
export type BetPurpose = "value" | "semi-bluff" | "bluff";

export interface Candidate {
    action: "fold" | "check" | "call" | "bet" | "raise" | "all-in",
    /** Total bet/raise-to in chips (0 for fold/check/call). */
    to: number,
    /** Estimated EV in chips relative to folding now. */
    ev: number,
    label: string,
    /** Bets and raises: chance everyone folds, chance hero gets raised, hero's equity against the hands that call. */
    fold_chance?: number,
    raise_chance?: number,
    called_equity?: number,
    purpose?: BetPurpose,
    /** Folds this bet needs to break even as a pure bluff. */
    needs_folds?: number,
    /** Bets: how players in your games answer this kind and size of bet (before adjusting for this player and board). */
    response?: { fold: number, raise: number, n: number },
    /**
     * Bets and raises: how far the EV could be off because the fold estimate is (chips, one standard error of the
     * fold chance times what a fold is worth against a call). Options are ranked by EV minus this (see robustEv).
     */
    risk?: number
}

export interface PostflopAnalysis {
    equity: number,
    /** Equity when the bet or raise gets called (opponents continue with stronger hands). */
    equity_when_called: number,
    required_equity: number,
    fold_probability: Map<number, number>,
    candidates: Candidate[],
    in_position: boolean,
    realization: number,
    street?: PostflopStreet,
    /** Why the top option isn't simply the highest EV (e.g. a bluff only barely ahead of checking). */
    note?: string,
    /** What a bet by hero would be here (lead, c-bet, barrel...); missing when hero faces a bet. */
    bet_role?: BetRole,
    /** Share of the opponents' likely hands with no pair and no strong draw on this board (average). */
    air_share?: number,
    /** Facing a bet on the flop or turn: how calling plays out over the next street (see callTree). */
    call_plan?: CallPlan,
    /** How the players hero can bet into answer small and big bets, when it differs clearly from your games. */
    size_notes?: string[]
}

/** How a call on the flop or turn plays out over the next street. */
export interface CallPlan {
    /** Chance someone bets the next street, and the share of those bets hero keeps calling. */
    barrel: number,
    continue_vs_barrel: number,
    /** Chips from later betting (implied odds minus reverse implied odds). */
    implied: number,
    /** The call's EV with plain equity and a flat realization share (the old model), for comparison. */
    flat_ev: number,
    /** The call's value against its plain equity in the pot: (EV + call) / (equity x pot after the call). */
    realization: number
}

let response_table: ResponseTable = defaultResponseTable();
/** How opponents answer hero's bets, measured from your stored hands (ProfileService.responseTable()). */
export function setResponseTable(table: ResponseTable): void {
    response_table = table;
}
export function resetResponseTable(): void {
    response_table = defaultResponseTable();
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
    seat_id?: string,
    /**
     * Chance of folding to a small bet (up to 40% of the pot) and a big one (over 80%), heads-up, with the chances
     * they were measured over: how this player's folds change with size compared with your games' average.
     */
    fold_by_size?: { small: number, big: number, n_small?: number, n_big?: number }
}

const BET_SIZES = [0.25, 0.33, 0.5, 0.66, 1.0];
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
/**
 * After hero's bet is called, the next street is bet again this often (measured on the stored hands: after a
 * heads-up flop bet was called, the bettor bet the turn 54% of the time when they had the chance; after a turn
 * bet, the river 58%; median sizes 71% and 75% of the pot). Scaled per player by their bet rate when checked to.
 */
const BET_NEXT: Record<PostflopStreet, number> = { flop: 0.54, turn: 0.58, river: 0 };
const NEXT_BET_SHARE = 0.75;
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

/** This player's fold rate on this street compared with your games' average (1 for an average or unknown player). */
function playerFoldFactor(o: OpponentTendency, street: PostflopStreet): number {
    if (o.fold_by_street) return clamp(o.fold_by_street[street] / Math.max(PRIORS[`fold_to_bet_${street}`].mean, 0.05), 0.6, 1.5);
    return clamp(o.fold_to_bet / Math.max(PRIORS.fold_to_cbet.mean, 0.05), 0.6, 1.5);
}

/**
 * How this player's folds change with bet size compared with your games' average, relative to their own level
 * (which playerFoldFactor already covers): a player who calls small bets and folds to big ones more than most
 * gets a factor below 1 for small bets and above 1 for big ones; one who calls anything, the other way round.
 */
function playerSizeFactor(o: OpponentTendency, share_of_pot: number): number {
    const f = o.fold_by_size;
    if (!f) return 1;
    const small = clamp(f.small / Math.max(PRIORS.fold_to_small_bet.mean, 0.05), 0.5, 2);
    const big = clamp(f.big / Math.max(PRIORS.fold_to_big_bet.mean, 0.05), 0.5, 2);
    const level = Math.sqrt(small * big);
    const t = clamp((share_of_pot - 0.33) / (1 - 0.33), 0, 1);
    return clamp((small + t * (big - small)) / level, 0.75, 1.33);
}

/**
 * Uncertainty of a fold estimate, as one standard error: sampling error of the measured cell (its cases plus the
 * defaults it is blended with) and a model error for everything the table can't see (this player, this board, why
 * players bet that size), assumed to be FOLD_MODEL_ERROR of the estimate.
 */
const FOLD_MODEL_ERROR = 0.1;
const FOLD_PRIOR_CASES = 25;
/** Fold-to-raise estimates come from a rough rule, not a measured table: they count as this many cases. */
const RAISE_FOLD_CASES = 20;
function foldError(fold: number, cases: number): number {
    return Math.sqrt(fold * (1 - fold) / Math.max(1, cases) + (FOLD_MODEL_ERROR * fold) ** 2);
}
/**
 * Options are ranked by their EV minus RISK_Z times their risk: when two sizes are close, the one whose EV rests
 * on better-measured fold and raise estimates wins. Picking the highest of several noisy estimates favors the
 * noisiest ones (the "optimizer's curse"); this discount offsets it. A bluff or semi-bluff also has to beat the
 * passive option by at least BLUFF_MARGIN_BB or BLUFF_MARGIN_POT of the pot: its profit rests on the fold
 * estimate, the least certain number in the model.
 */
const RISK_Z = 0.75;
const BLUFF_MARGIN_BB = 0.5;
const BLUFF_MARGIN_POT = 0.05;

/** This player's raise rate against bets compared with your games' average. */
function playerRaiseFactor(o: OpponentTendency): number {
    return o.raise_vs_bet !== undefined && Number.isFinite(o.raise_vs_bet)
        ? clamp(o.raise_vs_bet / Math.max(PRIORS.raise_vs_bet.mean, 0.01), 0.6, 1.6)
        : aggressionFactor(o, 0.8, 1.2);
}

/**
 * Board effect: a player whose likely hands hold more air (no pair, no strong draw) on this board folds a
 * little more. Measured on 2,569 heads-up bets in stored hands after the response table: no effect on the
 * flop, small on the turn, clearer on the river (folds rose from about 50% to 60% as air went from 15% to
 * 50-70% of the range). TYPICAL_AIR is the measured average for a player facing a bet on each street.
 */
const TYPICAL_AIR: Record<PostflopStreet, number> = { flop: 0.51, turn: 0.35, river: 0.28 };
const AIR_SLOPE: Record<PostflopStreet, number> = { flop: 0, turn: 0.2, river: 0.35 };
function boardFoldFactor(air: number | undefined, street: PostflopStreet): number {
    return air === undefined ? 1 : clamp(1 + AIR_SLOPE[street] * (air - TYPICAL_AIR[street]), 0.85, 1.15);
}

/**
 * Facing hero's river raise, a player folds at least the share of their likely hands with no pair (up to
 * this much). Checked on the stored hands: the engine's estimate of a river bettor's hands matches what
 * called river bettors showed (62% strong, 21% pair, 17% air predicted; 62%, 17%, 22% shown; 333 bets).
 */
const MAX_RIVER_AIR_FOLD = 0.97;

/**
 * Multiway, each player continues less and raises less than heads-up (the response table is measured
 * heads-up): per extra player facing hero's bet, a player's chance of continuing is multiplied by
 * MULTIWAY_CONTINUE and of raising by MULTIWAY_RAISE. Measured on the stored hands (first bet of a street,
 * each player's first answer): flop c-bets and barrels got 39% folds and 8% raises heads-up, 52% and 7%
 * per player facing two, 65% and 3% facing three or more; flop leads 24% and 21% heads-up, 58% and 7%, 52%
 * and 9%; the river 45-59% folds heads-up and 74-90% multiway. Without this a small lead into three
 * players was modeled as raised 42-56% of the time (measured: 10-26%) and almost never folded to.
 */
const MULTIWAY_CONTINUE = 0.75;
const MULTIWAY_RAISE = 0.6;
/**
 * Checked to, each player bets less when more players are left to act: per extra player behind hero, a
 * player's bet chance is multiplied by this. Measured after the first player checks: someone bet 64% of
 * flops with one player behind, 65% with two (38% each) and 67% with three or more (27% each); the turn and
 * river look the same.
 */
const MULTIWAY_BET = 0.62;

/** Equity against the hands that call at or above which a bet is for value; below it, a semi-bluff needs a draw or this much. */
const VALUE_EQUITY = 0.5;
const SEMI_BLUFF_EQUITY = 0.3;
/** A draw counts as a semi-bluff only with at least this much equity against the hands that call (a gutshot often has less). */
const SEMI_BLUFF_DRAW_EQUITY = 0.15;

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
    raise_to: number,
    /** Chips that can still go in on later streets once called (see IMPLIED_POTS). */
    stack_off: number,
    /** One standard error of the chance that everyone folds, and of the chance that someone raises. */
    fold_error: number,
    raise_error: number
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
    const hero = s.hero_cards;
    const board = s.board;
    // hero's bet here would be a lead, c-bet, barrel...; each opponent's share of weak hands on this board
    const role = facing_bet ? undefined : heroBetRole(s);
    const airs = facing_bet ? [] : models.map((m) => rangeClassShares(m, board, hero).air);
    // facing a river bet: the share of each player's likely hands with no pair, which can't call hero's raise
    const river_airs = facing_bet && street === "river" ? models.map((m) => rangeClassShares(m, board, hero).air) : [];
    const hero_class = board.length >= 3 ? strengthClass(hero, board) : "air";

    // what each opponent does against a bet (or raise) to `to`
    const respond = (to: number, raise: boolean, overbet: boolean): Plan => {
        const invest = to - (raise ? hero_in : 0);
        const all_in = to >= hero_total - 1e-9;
        const raise_to = Math.min(FACING_RAISE_MULTIPLIER * to, v.effective_stack);
        const folds: number[] = [], raises: number[] = [], adds: number[] = [], errors: number[] = [], raise_errors: number[] = [];
        const table = raise || !role ? null : responseFor(response_table, street, role, invest / Math.max(pot, 1e-9));
        // players who can answer the bet beyond the first (see MULTIWAY_CONTINUE)
        const extra = Math.max(0, opponents.filter((_, i) => !seats[i]?.all_in).length - 1);
        opponents.forEach((o, i) => {
            const seat = seats[i];
            // a player who is already all-in can't fold, raise or add chips
            if (seat?.all_in) { folds.push(0); raises.push(0); adds.push(0); errors.push(0); raise_errors.push(0); return; }
            // hero's bet: how players in your games answer this kind and size of bet, for this player on this board;
            // hero's raise: this player's fold-to-raise estimate, and on the river at least every hand without a
            // pair (a river bettor's bluffs give up to a raise; otherwise they would count as calling it)
            const share = invest / Math.max(pot, 1e-9);
            const fold = table
                ? clamp(1 - (1 - clamp(table.fold * playerFoldFactor(o, street) * playerSizeFactor(o, share) * boardFoldFactor(airs[i], street), 0.03, 0.9)) * Math.pow(MULTIWAY_CONTINUE, extra), 0.03, 0.95)
                : Math.max(foldChance(o, street, invest, pot + (raise ? v.to_call : 0), raise), Math.min(river_airs[i] ?? 0, MAX_RIVER_AIR_FOLD));
            errors.push(foldError(fold, table ? table.n + FOLD_PRIOR_CASES : RAISE_FOLD_CASES));
            const raise_rate = table ? table.raise * playerRaiseFactor(o) * Math.pow(MULTIWAY_RAISE, extra) : raiseChance(o) * (raise ? RERAISE_SHARE : 1);
            // nobody raises an all-in, or a bet they can't cover more than
            const can_raise = !all_in && raise_to > to + 1e-9 && (!seat || seat.stack + seat.street_contribution > to + 1e-9);
            folds.push(fold);
            raises.push(can_raise ? Math.min(raise_rate, 1 - fold) : 0);
            raise_errors.push(can_raise ? foldError(Math.min(raise_rate, 1 - fold), table ? table.n + FOLD_PRIOR_CASES : RAISE_FOLD_CASES) : 0);
            // a caller adds the difference between hero's new total and their current bet
            adds.push(seat
                ? Math.max(0, Math.min(to - seat.street_contribution, seat.stack))
                : Math.max(0, Math.min(raise ? to - s.current_bet : to, v.effective_stack)));
        });
        // later streets once called: what's left behind, up to a few pots (the pot after the call)
        const pot_called = pot + invest + adds.reduce((sum, x) => sum + x, 0);
        const stack_off = Math.max(0, Math.min(v.effective_stack - to, IMPLIED_POTS[street] * pot_called));
        // all fold: relative errors add up across players
        const pf = product(folds);
        const fold_error = pf * Math.sqrt(folds.reduce((sum, f, i) => sum + (f > 0 ? (errors[i] / f) ** 2 : 0), 0));
        // someone raises: the players' errors add up
        const raise_error = Math.sqrt(raise_errors.reduce((sum, e) => sum + e * e, 0));
        return { to, raise, overbet, invest, folds, raises, adds, raise_to, stack_off, fold_error, raise_error };
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

    // checking it down: everyone stays in, and what later betting adds at this pot
    const plain_stack_off = Math.max(0, Math.min(v.effective_stack - hero_in, IMPLIED_POTS[street] * pot));
    const plain = { continue_fraction: models.map(() => 1), adds: seats.map((p) => (p?.all_in ? 0 : 1)), stack_off: plain_stack_off };
    // one simulation for all of them (it also gives plain equity against everyone)
    const main = continuationEquity({ hero, board, opponents: models, time_budget_ms, seed: SEED },
        [plain, reference, ...plans].map((p) => "folds" in p ? { continue_fraction: p.folds.map((f) => 1 - f), raise_chance: p.raises, adds: p.adds, stack_off: p.stack_off } : p));
    const implied_plain = main.results[0].implied;
    const eq = main.equity;
    const R = realizationFor(street, in_position, opponents.length, eq);
    const side_budget = Math.max(10, time_budget_ms / 2);
    const narrowed = (i: number, action: "bet" | "raise") => models.map((m, j) => j !== i ? m
        : { ...m, postflop_actions: [...(m.postflop_actions ?? []), { board, action }] });

    /** Checking: free when hero closes the action; otherwise a bet may follow, which hero calls or folds to. */
    const checkEV = (): number => {
        const behind = playersBehind(s);
        if (behind.length === 0) return eq * pot * R + implied_plain;
        const behind_ids = new Set(behind.map((p) => p.id));
        // tendencies without a known seat are assumed to act after hero
        const bet_scale = Math.pow(MULTIWAY_BET, Math.max(0, behind.length - 1));
        const bettors = opponents.map((o, i) => (!seats[i] || behind_ids.has(seats[i]!.id)) ? betChance(o) * bet_scale : 0);
        const b = 1 - product(bettors.map((x) => 1 - x));
        if (b <= 0) return eq * pot * R + implied_plain;
        // the most likely bettor stands in for whoever bets
        const bettor = argmax(bettors);
        const bet = Math.min(REFERENCE_BET * pot, v.stack, v.effective_stack);
        const eq_vs_bet = equity({ hero, board, opponents: narrowed(bettor, "bet"), iterations: SIDE_ITERATIONS, time_budget_ms: side_budget, seed: SEED }).equity;
        // equity when it checks through: what's left once that player's betting hands are taken out
        // (split by their own bet rate, so it stays exact heads-up and stable multiway)
        const own = bettors[bettor];
        const eq_checked = own < 0.999 ? clamp((eq - own * eq_vs_bet) / (1 - own), 0, 1) : eq;
        const call_ev = eq_vs_bet * (pot + 2 * bet) * R - bet;
        // later betting (implied odds) while hero is still in
        return (1 - b) * (eq_checked * pot * R + implied_plain) + b * Math.max(0, call_ev + implied_plain);
    };

    const candidates: Candidate[] = [];
    const fold_probability = new Map<number, number>();

    let call_plan: CallPlan | undefined;
    let tree: CallTreeResult | undefined;
    if (!facing_bet) {
        candidates.push({ action: "check", to: 0, ev: checkEV(), label: "check" });
    } else {
        candidates.push({ action: "fold", to: 0, ev: 0, label: "fold" });
        const call_cost = v.to_call;
        const flat_ev = eq * (pot + call_cost) * R - call_cost;
        let call_ev = flat_ev;
        if (street !== "river") {
            // the flop or turn: value the call over the next street (bets again, hero's call or fold, implied odds)
            tree = callTree({
                hero, board, opponents: models, bettor: bettorIndex(s, seats), pot, to_call: call_cost,
                stack_behind: stackBehind(s, v, seats),
                bet_next: opponents.map((o, i) => (seats[i]?.all_in ? 0 : clamp(BET_NEXT[street] * betChance(o) / Math.max(PRIORS.bet_when_checked_to.mean, 0.05), 0.15, 0.9))),
                next_bet_share: NEXT_BET_SHARE, in_position, time_budget_ms: side_budget, seed: SEED
            });
            call_ev = tree.ev;
            call_plan = { barrel: tree.barrel, continue_vs_barrel: tree.continue_vs_barrel, implied: tree.implied, flat_ev, realization: tree.realization };
        }
        candidates.push({ action: "call", to: 0, ev: call_ev, label: `call ${fmt(call_cost)}` });
    }

    // equity against the player most likely to raise, with their range narrowed by a raise (computed when needed)
    const raiser = argmax(opponents.map((o, i) => seats[i]?.all_in ? -1 : raiseChance(o)));
    let eq_vs_raise: number | null = null;
    const equityVsRaise = () => eq_vs_raise ??= equity({ hero, board, opponents: [narrowed(raiser, "raise")[raiser]], iterations: SIDE_ITERATIONS, time_budget_ms: side_budget, seed: SEED }).equity;

    let equity_when_called = main.results[1].equity;
    let best_aggressive = -Infinity;
    for (const [k, p] of plans.entries()) {
        const called = main.results[2 + k];
        if (p.overbet && called.equity < OVERBET_MIN_EQUITY_WHEN_CALLED) continue;
        const all_in = p.to >= hero_total - 1e-9;
        const pf = product(p.folds);
        const pr = Math.min(1 - product(p.raises.map((q) => 1 - q)), 1 - pf);
        // called: hero's share of the pot plus hero's bet (returned if only an all-in player is left) plus the callers' chips,
        // and what later betting adds or costs (implied odds)
        const called_ev = (called.equity * pot + called.equity_x_matched * p.invest + called.equity_x_added) * R - called.matched * p.invest + called.implied;
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
        const purpose: BetPurpose = called.equity >= VALUE_EQUITY ? "value"
            : street !== "river" && ((hero_class === "draw" && called.equity >= SEMI_BLUFF_DRAW_EQUITY) || called.equity >= SEMI_BLUFF_EQUITY) ? "semi-bluff"
            : "bluff";
        // what the EV could be off by through the fold and raise estimates: a fold wins the pot, a raise gets the
        // raised value, instead of the called value
        const response_risk = RISK_Z * Math.hypot(p.fold_error * (pot - called_ev), p.raise_error * (raised_ev - called_ev));
        // the bluff margin is for bets that lose chips when called, whose profit rests on folds. Against several callers
        // a bet wins chips when called from 1 / (1 + callers) equity (each chip bet returns equity x (1 + callers)), so
        // a draw or top pair betting into two callers with 40% doesn't need it
        const wins_when_called = called.equity >= Math.min(VALUE_EQUITY, 1 / (1 + Math.max(1, called.callers)));
        const risk = purpose === "value" || wins_when_called ? response_risk : Math.max(response_risk, BLUFF_MARGIN_BB * bb, BLUFF_MARGIN_POT * pot);
        candidates.push({
            action, to: p.to, ev, label: `${action === "all-in" ? "all-in" : action === "raise" ? "raise to" : "bet"} ${fmt(p.to)}`,
            fold_chance: pf, raise_chance: pr, called_equity: called.equity, purpose, risk,
            needs_folds: p.invest / (pot + p.invest),
            response: p.raise || !role ? undefined : responseFor(response_table, street, role, p.invest / Math.max(pot, 1e-9))
        });
        // report the equity when called for the best bet or raise
        if (ev > best_aggressive) { best_aggressive = ev; equity_when_called = called.equity; }
    }
    candidates.sort((a, b) => b.ev - a.ev);
    // the pick: the best EV after each option's risk (see RISK_Z), so a bluff barely ahead of checking, or a size
    // barely ahead of another but measured on few hands, gives way to the surer option
    let note: string | undefined;
    const top = candidates[0];
    const pick = candidates.reduce((x, c) => (robustEv(c) > robustEv(x) ? c : x));
    if (pick !== top) {
        candidates.splice(candidates.indexOf(pick), 1);
        candidates.unshift(pick);
        const aggressive_pick = pick.action === "bet" || pick.action === "raise" || pick.action === "all-in";
        note = aggressive_pick && top.purpose
            ? `${top.label} is ahead of ${pick.label} by only ${fmt(top.ev - pick.ev)} on the numbers, but its fold estimate is less sure (±${fmt(top.risk ?? 0)} vs ±${fmt(pick.risk ?? 0)}), so ${pick.label}.`
            : `A ${top.purpose ?? "bet"} (${top.label}) would beat ${pick.label} by only ${fmt(top.ev - pick.ev)}, within the margin of error of the fold estimate (±${fmt(top.risk ?? 0)}), so ${pick.label}.`;
    }
    return {
        size_notes: facing_bet ? undefined : sizeNotes(opponents, seats),
        equity: eq,
        equity_when_called,
        required_equity: v.to_call > 0 ? v.to_call / (pot + v.to_call) : 0,
        fold_probability,
        candidates,
        in_position,
        realization: R,
        street,
        note,
        bet_role: role,
        air_share: airs.length ? airs.reduce((sum, x) => sum + x, 0) / airs.length : undefined,
        call_plan
    };
}

/** Measured cases before a player's size tendency is mentioned, and how far from your games' average it must be. */
const SIZE_NOTE_CASES = 8;
const SIZE_NOTE_GAP = 0.08;

/** One line per player whose folds to small or big bets clearly differ from your games' average. */
function sizeNotes(opponents: OpponentTendency[], seats: (SeatState | undefined)[]): string[] | undefined {
    const out: string[] = [];
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    opponents.forEach((o, i) => {
        const f = o.fold_by_size;
        if (!f || seats[i]?.all_in || (f.n_small ?? 0) + (f.n_big ?? 0) < SIZE_NOTE_CASES) return;
        const ds = f.small - PRIORS.fold_to_small_bet.mean, db = f.big - PRIORS.fold_to_big_bet.mean;
        if (Math.abs(ds) < SIZE_NOTE_GAP && Math.abs(db) < SIZE_NOTE_GAP) return;
        const who = seats[i]?.position ?? "This player";
        const lean = db - ds >= SIZE_NOTE_GAP ? ": bigger bets win more folds against them"
            : ds - db >= SIZE_NOTE_GAP ? ": they call big bets about as readily as small ones, so bluff small and bet big only for value"
            : ds > 0 ? ": they fold more than most to any size" : ": they call more than most at any size";
        out.push(`${who} folds ${pct(f.small)} to small bets (${f.n_small ?? 0} seen) and ${pct(f.big)} to big ones (${f.n_big ?? 0} seen); your games: ${pct(PRIORS.fold_to_small_bet.mean)} and ${pct(PRIORS.fold_to_big_bet.mean)}${lean}.`);
    });
    return out.length ? out : undefined;
}

/** Index (in `seats`) of the player who made the bet hero faces: the last bet or raise on this street. */
function bettorIndex(s: HandState, seats: (SeatState | undefined)[]): number {
    const last = [...s.actions].reverse().find((a) => a.street === s.street && (a.type === "bet" || a.type === "raise"));
    const i = last ? seats.findIndex((p) => p?.id === last.player_id) : -1;
    return i >= 0 ? i : 0;
}

/** Chips hero can still put in after calling, against the deepest opponent who isn't all-in (0 when the call ends the betting). */
function stackBehind(s: HandState, v: HeroView, seats: (SeatState | undefined)[]): number {
    const hero = s.seats.find((p) => p.id === s.hero_id);
    if (!hero) return 0;
    const live = seats.filter((p): p is SeatState => !!p && !p.all_in);
    const theirs = live.length ? Math.max(...live.map((p) => p.stack - Math.max(0, s.current_bet - p.street_contribution))) : 0;
    // seats unknown (tests without seat ids): the effective stack decides
    const opp = seats.some((p) => !p) ? Math.max(theirs, v.effective_stack - s.current_bet) : theirs;
    return Math.max(0, Math.min(hero.stack - v.to_call, opp));
}

/** The seat of each opponent tendency: by seat_id, or the i-th opponent still in the hand in seat order. */
function opponentSeats(s: HandState, opponents: OpponentTendency[]): (SeatState | undefined)[] {
    const active = s.seats.filter((p) => p.id !== s.hero_id && !p.folded);
    return opponents.map((o, i) => o.seat_id !== undefined
        ? s.seats.find((p) => p.id === o.seat_id)
        : active.length === opponents.length ? active[i] : undefined);
}

/** EV minus the option's risk (see RISK_Z): what the engine ranks options by. */
export function robustEv(c: Candidate): number {
    return c.ev - (c.risk ?? 0);
}

/** True when the best candidate is clearly ahead (after each option's risk), so the engine can answer without the AI. */
export function isClearSpot(a: PostflopAnalysis, pot: number, big_blind: number): boolean {
    if (a.candidates.length < 2) return true;
    const gap = robustEv(a.candidates[0]) - Math.max(...a.candidates.slice(1).map(robustEv));
    return gap >= Math.max(big_blind, 0.15 * pot);
}
