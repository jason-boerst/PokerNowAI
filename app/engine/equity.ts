import { category, code, DECK, evaluate, RANKS, seededRandom } from "./cards.ts";
import { classOf } from "./hand-classes.ts";
import { PRIORS } from "./player-profile.ts";
import { expandRange, RANKED_CLASSES, Range, WeightedCombo } from "./ranges.ts";

export type PostflopAction = "bet" | "raise" | "call" | "check";
export type StrengthClass = "strong" | "pair" | "draw" | "air";
/** How likely a player is to take each action with each kind of hand, relative to other hands. */
export type ActionWeights = Record<PostflopAction, Record<StrengthClass, number>>;
export type PostflopStreet = "flop" | "turn" | "river";

export interface OpponentModel {
    range: Range,
    /** The opponent's post-flop actions so far, with the board at the time (used to narrow the range). */
    postflop_actions?: { board: string[], action: PostflopAction }[],
    /** Share of the opponent's post-flop actions that are bets or raises (0-1); aggressive players bluff more. */
    aggression?: number,
    /**
     * Keep only this share (0-1) of the range: the strongest hands on the current board, by weight.
     * Used for "the hands that continue against a bet" (1 minus their chance of folding).
     */
    continue_fraction?: number
}

export interface EquityInput {
    hero: string[],
    board: string[],
    opponents: OpponentModel[],
    /** Stop after this many simulations (default 20000). */
    iterations?: number,
    /** Stop after this many milliseconds (default 150). */
    time_budget_ms?: number,
    seed?: number
}

export interface EquityResult {
    /** Hero's share of the pot on average, 0-1 (ties split). */
    equity: number,
    iterations: number
}

// Heuristics aimed at loose-passive home players (bets and raises mostly mean real hands).
// These are assumptions, not measured frequencies; setActionWeights replaces them per street.
const DEFAULT_ACTION_WEIGHTS: ActionWeights = {
    bet:   { strong: 1.0, pair: 0.9, draw: 0.6, air: 0.25 },
    raise: { strong: 1.0, pair: 0.4, draw: 0.45, air: 0.1 },
    call:  { strong: 0.8, pair: 1.0, draw: 0.9, air: 0.3 },
    check: { strong: 0.5, pair: 0.9, draw: 0.9, air: 1.0 }
};
const ACTIONS: PostflopAction[] = ["bet", "raise", "call", "check"];
const CLASSES: StrengthClass[] = ["strong", "pair", "draw", "air"];
const STREETS: PostflopStreet[] = ["flop", "turn", "river"];

let street_weights: Record<PostflopStreet, ActionWeights> = { flop: DEFAULT_ACTION_WEIGHTS, turn: DEFAULT_ACTION_WEIGHTS, river: DEFAULT_ACTION_WEIGHTS };

/**
 * Replaces the built-in action weights with measured ones (e.g. from showdowns), per street.
 * Streets left out, and any missing or invalid entry, use the built-in weights.
 */
export function setActionWeights(per_street: { flop?: ActionWeights, turn?: ActionWeights, river?: ActionWeights }): void {
    const next = {} as Record<PostflopStreet, ActionWeights>;
    for (const street of STREETS) {
        const given = per_street[street];
        if (!given) { next[street] = DEFAULT_ACTION_WEIGHTS; continue; }
        const w = {} as ActionWeights;
        for (const a of ACTIONS) {
            w[a] = {} as Record<StrengthClass, number>;
            for (const c of CLASSES) {
                const x = given[a]?.[c];
                // a weight of 0 would rule a hand type out completely; keep a small floor instead
                w[a][c] = typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.min(10, Math.max(0.01, x)) : DEFAULT_ACTION_WEIGHTS[a][c];
            }
        }
        next[street] = w;
    }
    street_weights = next;
}

/** Back to the built-in action weights. */
export function resetActionWeights(): void {
    street_weights = { flop: DEFAULT_ACTION_WEIGHTS, turn: DEFAULT_ACTION_WEIGHTS, river: DEFAULT_ACTION_WEIGHTS };
}

function streetOf(board_length: number): PostflopStreet {
    return board_length >= 5 ? "river" : board_length === 4 ? "turn" : "flop";
}

/** Rough strength class of two hole cards on a board (3-5 cards). */
export function strengthClass(hole: string[], board: string[]): StrengthClass {
    return classify(hole, board, evaluate([...hole, ...board].map(code)));
}

/** strengthClass, given the evaluator's value of hole + board. */
function classify(hole: string[], board: string[], value: number): StrengthClass {
    const cat = category(value);
    const board_ranks = board.map((c) => c[0]);
    const pocket_pair = hole[0][0] === hole[1][0];
    const pairs_board = hole.some((c) => board_ranks.includes(c[0]));
    // straight or better, or two pair / trips / set that uses a hole card
    // (a pair or trips that is only on the board doesn't count)
    if (cat <= 4) return "strong";
    if (cat <= 6 && (pocket_pair || pairs_board)) return "strong";
    if (pocket_pair || pairs_board) return "pair";
    if (board.length < 5 && hasDraw(hole, board)) return "draw";
    return "air";
}

function hasDraw(hole: string[], board: string[]): boolean {
    return hasFlushDraw(hole, board) || hasOpenEnder(hole, board);
}

function hasFlushDraw(hole: string[], board: string[]): boolean {
    for (const suit of new Set(hole.map((c) => c[1]))) {
        if ([...hole, ...board].filter((c) => c[1] === suit).length === 4) return true;
    }
    return false;
}

function hasOpenEnder(hole: string[], board: string[]): boolean {
    const toValues = (c: string) => {
        const v = RANKS.indexOf(c[0]) + 2;
        return v === 14 ? [14, 1] : [v];
    };
    const present = new Set([...hole, ...board].flatMap(toValues));
    const hole_values = new Set(hole.flatMap(toValues));
    for (let start = 2; start <= 10; start++) {
        const window = [start, start + 1, start + 2, start + 3];
        if (window.every((v) => present.has(v)) && window.some((v) => hole_values.has(v))) return true;
    }
    return false;
}

const cardString = (c: number) => DECK_NAMES[c];
const DECK_NAMES: string[] = (() => {
    const names: string[] = [];
    for (const r of RANKS) for (const s of "shdc") names[code(r + s)] = r + s;
    return names;
})();

// Continuing ranges: hands are ranked by class (strong > pair > air), then by the evaluator's value
// within a class. Flush draws and open-enders rank just above the best bottom pair, so a calling
// range keeps its draws before its weakest pairs.
const TIER: Record<StrengthClass, number> = { strong: 3, pair: 2, draw: 1, air: 1 };
const WORST_VALUE = 7463;
/** Evaluator value of the best one-pair hand for each rank (index by position in RANKS). */
const BEST_PAIR_VALUE: number[] = [...RANKS].map((r) => {
    const kickers = [...RANKS].reverse().filter((k) => k !== r).slice(0, 3);
    return evaluate([r + "s", r + "h", kickers[0] + "d", kickers[1] + "c", kickers[2] + "d"].map(code));
});
const PREFLOP_ORDER = new Map(RANKED_CLASSES.map((cls, i) => [cls, i]));

/** Score of a strong draw on this board: just above the best hand that pairs the lowest board card. */
function drawScore(board: string[]): number {
    const lowest = Math.min(...board.map((c) => RANKS.indexOf(c[0])));
    return TIER.pair * 10000 + (WORST_VALUE - BEST_PAIR_VALUE[lowest]) + 0.5;
}

/** How strong a hand is for continuing against a bet (higher is stronger); `value` is the evaluator's value of hole + board. */
function continueScore(hole: string[], board: string[], value: number, cls: StrengthClass, draw_score: number): number {
    if (board.length < 3) return RANKED_CLASSES.length - (PREFLOP_ORDER.get(classOf(hole)) ?? RANKED_CLASSES.length);
    const score = TIER[cls] * 10000 + (WORST_VALUE - value);
    if (board.length < 5 && (cls === "draw" || (cls === "pair" && hasDraw(hole, board)))) return Math.max(score, draw_score);
    return score;
}

/**
 * Action weights adjusted for how aggressive this opponent is: someone who bets twice as often as
 * the average player in your games is assumed to bet and raise with weak hands and draws about
 * twice as often. `street` picks that street's weights (see setActionWeights).
 */
export function weightsFor(aggression: number | undefined, street: PostflopStreet = "flop"): ActionWeights {
    const base = street_weights[street];
    if (aggression === undefined) return base;
    const f = Math.max(0.5, Math.min(2.5, aggression / Math.max(PRIORS.aggression.mean, 0.05)));
    // never more likely than with a strong hand
    const scale = (row: Record<StrengthClass, number>, cls: StrengthClass) => Math.min(Math.max(1, row.strong), row[cls] * f);
    return {
        ...base,
        bet: { ...base.bet, draw: scale(base.bet, "draw"), air: scale(base.bet, "air") },
        raise: { ...base.raise, pair: scale(base.raise, "pair"), draw: scale(base.raise, "draw"), air: scale(base.raise, "air") }
    };
}

interface Sampler {
    combos: WeightedCombo[],
    cumulative: Float64Array,
    total: number,
    /** Share of the range's weight ranked above each combo, and above or tied with it (continueScore). */
    rank_lo: Float64Array | null,
    rank_hi: Float64Array | null,
    /** How likely each combo is to raise a bet on this board (raise action weight), and the range's average. */
    raise_w: Float64Array | null,
    raise_mean: number
}

function buildSampler(model: OpponentModel, dead: Set<number>, board: string[], with_ranks: boolean): Sampler {
    let combos = expandRange(model.range, dead);
    if (combos.length === 0) combos = anyTwo(dead);   // no information: any two cards

    // each distinct board the player acted on (plus the current one), so hand classes are computed once per board
    const boards: string[][] = [];
    const board_keys: string[] = [];
    const boardIndex = (b: string[]) => {
        const key = b.join("");
        let i = board_keys.indexOf(key);
        if (i < 0) { i = boards.length; boards.push(b); board_keys.push(key); }
        return i;
    };
    const by_street = { flop: weightsFor(model.aggression, "flop"), turn: weightsFor(model.aggression, "turn"), river: weightsFor(model.aggression, "river") };
    const actions = (model.postflop_actions ?? []).filter((a) => a.board.length >= 3)
        .map((a) => ({ board: boardIndex(a.board), row: by_street[streetOf(a.board.length)][a.action] }));
    const fraction = model.continue_fraction === undefined ? 1 : Math.max(0.01, Math.min(1, model.continue_fraction));
    const ranked = with_ranks || fraction < 1;
    const rank_board = ranked && board.length >= 3 ? boardIndex(board) : -1;
    const raise_row = rank_board >= 0 ? by_street[streetOf(board.length)].raise : null;
    const board_codes = board.map(code);
    const draw_score = board.length >= 3 ? drawScore(board) : 0;

    // weight after the player's actions; when ranking, also the continue score and raise weight on this board
    const classes: (StrengthClass | undefined)[] = new Array(boards.length);
    let weighted: WeightedCombo[] = [];
    let scores: number[] = [];
    let raises: number[] = [];
    const include = (c: WeightedCombo, use_actions: boolean) => {
        classes.fill(undefined);
        const hole = [cardString(c.cards[0]), cardString(c.cards[1])];
        let w = c.weight;
        if (use_actions) for (const a of actions) w *= a.row[classes[a.board] ??= strengthClass(hole, boards[a.board])];
        if (!(w > 0)) return;
        weighted.push({ cards: c.cards, weight: w });
        if (!ranked) return;
        if (rank_board < 0) {
            scores.push(continueScore(hole, board, 0, "air", 0));
            raises.push(1);
            return;
        }
        const value = evaluate([c.cards[0], c.cards[1], ...board_codes]);
        const cls = classes[rank_board] ??= classify(hole, board, value);
        scores.push(continueScore(hole, board, value, cls, draw_score));
        raises.push(raise_row![cls]);
    };
    for (const c of combos) include(c, true);
    if (weighted.length === 0) {
        // the action weights ruled everything out (bad weights): ignore them rather than fail
        for (const c of combos) include(c, false);
    }

    let rank_lo: Float64Array | null = null;
    let rank_hi: Float64Array | null = null;
    if (ranked) {
        ({ rank_lo, rank_hi } = rankByScore(weighted, scores));
        if (fraction < 1) {
            // keep the strongest `fraction` of the weight; a group of equal hands on the boundary is kept in part
            const kept: WeightedCombo[] = [];
            const lo: number[] = [];
            const hi: number[] = [];
            const kept_raises: number[] = [];
            weighted.forEach((c, i) => {
                const a = rank_lo![i], b = rank_hi![i];
                if (a >= fraction) return;
                const share = b <= fraction ? 1 : (fraction - a) / (b - a);
                kept.push({ cards: c.cards, weight: c.weight * share });
                lo.push(a / fraction);
                hi.push(Math.min(b, fraction) / fraction);
                kept_raises.push(raises[i]);
            });
            weighted = kept;
            raises = kept_raises;
            rank_lo = Float64Array.from(lo);
            rank_hi = Float64Array.from(hi);
        }
    }
    const cumulative = new Float64Array(weighted.length);
    let total = 0;
    let raise_mass = 0;
    weighted.forEach((c, i) => {
        total += c.weight;
        cumulative[i] = total;
        if (ranked) raise_mass += c.weight * raises[i];
    });
    return with_ranks
        ? { combos: weighted, cumulative, total, rank_lo, rank_hi, raise_w: Float64Array.from(raises), raise_mean: total > 0 ? raise_mass / total : 0 }
        : { combos: weighted, cumulative, total, rank_lo: null, rank_hi: null, raise_w: null, raise_mean: 0 };
}

function anyTwo(dead: Set<number>): WeightedCombo[] {
    const out: WeightedCombo[] = [];
    for (let i = 0; i < DECK.length; i++) for (let j = i + 1; j < DECK.length; j++) {
        if (!dead.has(DECK[i]) && !dead.has(DECK[j])) out.push({ cards: [DECK[i], DECK[j]], weight: 1 });
    }
    return out;
}

/** For each combo, the share of total weight ranked strictly above it and above-or-tied with it (higher score = stronger). */
function rankByScore(combos: WeightedCombo[], scores: number[]): { rank_lo: Float64Array, rank_hi: Float64Array } {
    const order = combos.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
    const total = combos.reduce((t, c) => t + c.weight, 0) || 1;
    const rank_lo = new Float64Array(combos.length);
    const rank_hi = new Float64Array(combos.length);
    let above = 0;
    for (let g = 0; g < order.length;) {
        let end = g, mass = 0;
        while (end < order.length && scores[order[end]] === scores[order[g]]) mass += combos[order[end++]].weight;
        for (let j = g; j < end; j++) {
            rank_lo[order[j]] = above / total;
            rank_hi[order[j]] = Math.min(1, (above + mass) / total);
        }
        above += mass;
        g = end;
    }
    return { rank_lo, rank_hi };
}

function sample(s: Sampler, rand: () => number): number {
    const x = rand() * s.total;
    let lo = 0, hi = s.cumulative.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (s.cumulative[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/**
 * How a player's likely hands (their range, narrowed by their actions so far) split into strength
 * classes on `board`: shares of strong hands, pairs, strong draws and air (no pair, no strong draw),
 * with the cards in `dead` (hero's cards) removed. The shares add up to 1.
 */
export function rangeClassShares(model: OpponentModel, board: string[], dead: string[] = []): Record<StrengthClass, number> {
    const shares: Record<StrengthClass, number> = { strong: 0, pair: 0, draw: 0, air: 0 };
    if (board.length < 3) return { ...shares, air: 1 };
    const sampler = buildSampler({ ...model, continue_fraction: undefined }, new Set([...dead, ...board].map(code)), board, false);
    if (!(sampler.total > 0)) return { ...shares, air: 1 };
    for (const c of sampler.combos) shares[strengthClass([cardString(c.cards[0]), cardString(c.cards[1])], board)] += c.weight;
    for (const cls of CLASSES) shares[cls] /= sampler.total;
    return shares;
}

/** How a range splits on a board, for balancing hero's own play (see mixing.ts). Shares add up to 1. */
export interface RangeProfile {
    /** Top pair, an overpair or better: the hands a balanced range bets for value. */
    value: number,
    /** Two pair or better (included in value). */
    strong: number,
    /** Weaker pairs: showdown value, mostly checked. */
    medium: number,
    /** A flush draw or open-ended straight draw without a pair. */
    draw: number,
    /** No pair and no strong draw. */
    air: number,
    /** With `hole`: share of the range stronger than that hand, and tied with it (by strength for continuing against a bet). */
    above?: number,
    tied?: number
}

/**
 * The shares of a player's likely hands (their range narrowed by their actions) that are value, medium
 * pairs, draws and air on `board`, and where `hole` ranks inside that range. Used with hero's own range as
 * other players see it: only the board's cards are removed, since nobody else knows hero's cards.
 */
export function rangeProfile(model: OpponentModel, board: string[], hole?: string[]): RangeProfile {
    const out: RangeProfile = { value: 0, strong: 0, medium: 0, draw: 0, air: 0 };
    if (board.length < 3) return { ...out, air: 1 };
    const board_codes = board.map(code);
    const sampler = buildSampler({ ...model, continue_fraction: undefined }, new Set(board_codes), board, false);
    if (!(sampler.total > 0)) return { ...out, air: 1 };
    const top = Math.max(...board.map((c) => RANKS.indexOf(c[0])));
    const draw_score = drawScore(board);
    const score = (h: string[], value: number) => continueScore(h, board, value, classify(h, board, value), draw_score);
    const hero_score = hole && hole.length === 2 ? score(hole, evaluate([...hole, ...board].map(code))) : undefined;
    let above = 0, tied = 0;
    for (const c of sampler.combos) {
        const h = [cardString(c.cards[0]), cardString(c.cards[1])];
        const value = evaluate([c.cards[0], c.cards[1], ...board_codes]);
        const cls = classify(h, board, value);
        if (cls === "strong") {
            out.strong += c.weight;
            out.value += c.weight;
        } else if (cls === "pair") {
            const r0 = RANKS.indexOf(h[0][0]), r1 = RANKS.indexOf(h[1][0]);
            // an overpair, or a hole card pairing the highest board card
            const top_pair = r0 === r1 ? r0 > top : r0 === top || r1 === top;
            if (top_pair) out.value += c.weight; else out.medium += c.weight;
        } else {
            out[cls] += c.weight;
        }
        if (hero_score !== undefined) {
            const sc = continueScore(h, board, value, cls, draw_score);
            if (sc > hero_score) above += c.weight;
            else if (sc === hero_score) tied += c.weight;
        }
    }
    const t = sampler.total;
    const shares: RangeProfile = { value: out.value / t, strong: out.strong / t, medium: out.medium / t, draw: out.draw / t, air: out.air / t };
    if (hero_score !== undefined) {
        shares.above = above / t;
        shares.tied = tied / t;
    }
    return shares;
}

/** Monte Carlo equity of hero's hand against one or more opponent range models. */
export function equity(input: EquityInput): EquityResult {
    const r = simulate(input, null);
    return { equity: r.equity, iterations: r.iterations };
}

/** What each opponent does against one bet size (arrays in the same order as the opponents). */
export interface ContinueScenario {
    /** Share of each range that continues (0-1): the strongest hands on this board, as with continue_fraction. */
    continue_fraction: number[],
    /**
     * Each opponent's chance of raising (0-1, default 0). Raising hands come from the whole range in
     * proportion to the raise action weights (mostly strong hands, some bluffs); they don't call.
     */
    raise_chance?: number[],
    /** Chips each opponent adds to the pot when calling (default 1, which counts callers); 0 for players already all-in. */
    adds?: number[],
    /**
     * Chips that can still go in on later streets once called (see STACK_IN); 0 or missing for none. Each
     * caller who isn't all-in puts in the STACK_IN share of it, by both hands' classes on the final board.
     */
    stack_off?: number
}

/** Averages over the simulations in which at least one opponent calls and nobody raises. */
export interface ContinueResult {
    /** Hero's share of the pot (0-1). */
    equity: number,
    /** Number of opponents who call. */
    callers: number,
    /** Chips the callers add. */
    added: number,
    /** Hero's pot share times the chips the callers add. */
    equity_x_added: number,
    /** Share of these simulations in which someone puts chips in (an all-in player alone can't). */
    matched: number,
    /** Hero's pot share in simulations where someone puts chips in, times that share. */
    equity_x_matched: number,
    /** Share of all simulations in which someone calls (and nobody raises). */
    call_rate: number,
    /** Share of all simulations in which someone raises. */
    raise_rate: number,
    /** Chips hero wins (or loses, negative) on later streets when called, on average (with stack_off). */
    implied: number
}

/**
 * Hero's equity in several "who continues" scenarios at once, e.g. one per bet size. In each
 * scenario every opponent raises (at their raise chance, weighted toward strong hands), else calls
 * with the strongest part of their range, else folds. All scenarios share the same simulated
 * hands, so their results compare cleanly. `equity` is plain equity against everyone.
 */
export function continuationEquity(input: EquityInput, scenarios: ContinueScenario[]): { equity: number, iterations: number, results: ContinueResult[] } {
    return simulate(input, scenarios);
}

function simulate(input: EquityInput, scenarios: ContinueScenario[] | null): { equity: number, iterations: number, results: ContinueResult[] } {
    const rand = seededRandom(input.seed ?? (Date.now() & 0x7fffffff));
    const hero = input.hero.map(code);
    const board = input.board.map(code);
    const dead = new Set([...hero, ...board]);
    const with_ranks = scenarios !== null && scenarios.some((sc) => sc.continue_fraction.some((f) => f < 1) || (sc.raise_chance ?? []).some((q) => q > 0));
    const samplers = input.opponents.map((o) => buildSampler(o, dead, input.board, with_ranks));
    // a hand raises with chance raise_scale x its raise weight, which averages to the raise chance over the range
    const raise_scale = (scenarios ?? []).map((sc) => samplers.map((s, i) => {
        const q = sc.raise_chance?.[i] ?? 0;
        return q > 0 && s.raise_mean > 0 ? q / s.raise_mean : 0;
    }));
    const max_iterations = input.iterations ?? 20000;
    const deadline = Date.now() + (input.time_budget_ms ?? 150);
    const deck = DECK.filter((c) => !dead.has(c));
    const used = new Uint8Array(64);
    const cards_needed = 5 - board.length;
    const final_board = new Array<number>(5);
    for (let i = 0; i < board.length; i++) final_board[i] = board[i];

    const n_opp = samplers.length;
    const n_sc = scenarios?.length ?? 0;
    const sums = Array.from({ length: n_sc }, () => ({ called: 0, raised: 0, share: 0, callers: 0, added: 0, share_added: 0, matched: 0, share_matched: 0, implied: 0 }));
    const with_stack_off = (scenarios ?? []).some((sc) => (sc.stack_off ?? 0) > 0) && board.length < 5;
    const opp_stake: Stake[] = new Array(n_opp);
    const opp_cards: [number, number][] = new Array(n_opp);
    const opp_values = new Array<number>(n_opp);
    const opp_raise_w = new Float64Array(n_opp);
    const position = new Float64Array(n_opp);
    const raise_draw = new Float64Array(n_opp);

    let share = 0;
    let done = 0;
    outer:
    for (let it = 0; it < max_iterations; it++) {
        if ((it & 511) === 0 && it > 0 && Date.now() > deadline) break;
        used.fill(0);
        for (let i = 0; i < n_opp; i++) {
            const s = samplers[i];
            let picked = -1;
            for (let tries = 0; tries < 30; tries++) {
                const k = sample(s, rand);
                const c = s.combos[k].cards;
                if (!used[c[0]] && !used[c[1]]) { picked = k; break; }
            }
            if (picked < 0) continue outer;
            const c = s.combos[picked].cards;
            used[c[0]] = 1;
            used[c[1]] = 1;
            opp_cards[i] = c;
            if (with_ranks) {
                // where this hand sits in the range, strongest first (0-1), spread evenly across equal hands
                position[i] = s.rank_lo![picked] + rand() * (s.rank_hi![picked] - s.rank_lo![picked]);
                opp_raise_w[i] = s.raise_w![picked];
                raise_draw[i] = rand();
            }
        }
        for (let k = 0; k < cards_needed; k++) {
            let c: number;
            do { c = deck[Math.floor(rand() * deck.length)]; } while (used[c]);
            used[c] = 1;
            final_board[board.length + k] = c;
        }
        const hero_strength = evaluate([hero[0], hero[1], ...final_board]);
        let best = hero_strength;
        let tied = 1;
        let hero_best = true;
        for (let i = 0; i < n_opp; i++) {
            const s = evaluate([opp_cards[i][0], opp_cards[i][1], ...final_board]);
            opp_values[i] = s;
            if (s < best) { best = s; tied = 1; hero_best = false; }
            else if (s === best) { tied++; }
        }
        if (hero_best && best === hero_strength) share += 1 / tied;
        let hero_stake: Stake = "none";
        if (with_stack_off) {
            const final_names = final_board.map(cardString);
            hero_stake = stakeOf(input.hero, final_names, hero_strength);
            for (let i = 0; i < n_opp; i++) opp_stake[i] = stakeOf([cardString(opp_cards[i][0]), cardString(opp_cards[i][1])], final_names, opp_values[i]);
        }
        scenario:
        for (let k = 0; k < n_sc; k++) {
            const sc = scenarios![k];
            let n = 0, beaten = false, ties = 0, added = 0, later = 0, later_top = 0;
            const stack_off = with_stack_off ? sc.stack_off ?? 0 : 0;
            for (let i = 0; i < n_opp; i++) {
                if (raise_draw[i] < raise_scale[k][i] * opp_raise_w[i]) { sums[k].raised++; continue scenario; }
                const f = sc.continue_fraction[i];
                if (f < 1 && position[i] >= f) continue;   // folds
                n++;
                const adds = sc.adds ? sc.adds[i] : 1;
                added += adds;
                // later streets: only against a player who still has chips (an all-in caller adds 0 here)
                if (stack_off > 0 && (!sc.adds || adds > 0)) {
                    const x = STACK_IN[hero_stake][opp_stake[i]] * stack_off * (opp_values[i] > hero_strength ? 1 : opp_values[i] === hero_strength ? 0 : -1);
                    later += x;
                    if (Math.abs(x) > Math.abs(later_top)) later_top = x;
                }
                if (opp_values[i] < hero_strength) beaten = true;
                else if (opp_values[i] === hero_strength) ties++;
            }
            if (n === 0) continue;
            const s = beaten ? 0 : 1 / (ties + 1);
            const t = sums[k];
            t.called++;
            t.share += s;
            t.callers += n;
            t.added += added;
            t.share_added += s * added;
            if (added > 0) { t.matched++; t.share_matched += s; }
            t.implied += Math.max(-stack_off, Math.min(stack_off * n_opp, multiwayLater(later, later_top)));
        }
        done++;
    }
    const results: ContinueResult[] = sums.map((t) => t.called > 0
        ? { equity: t.share / t.called, callers: t.callers / t.called, added: t.added / t.called, equity_x_added: t.share_added / t.called,
            matched: t.matched / t.called, equity_x_matched: t.share_matched / t.called, call_rate: t.called / done, raise_rate: t.raised / done,
            implied: t.implied / t.called }
        : { equity: 0, callers: 0, added: 0, equity_x_added: 0, matched: 0, equity_x_matched: 0, call_rate: 0, raise_rate: done ? t.raised / done : 0, implied: 0 });
    return { equity: done ? share / done : 0, iterations: done, results };
}

/** A call facing a bet on the flop or turn, valued over the next street (see callTree). */
export interface CallTreeInput {
    hero: string[],
    /** The flop or the turn. */
    board: string[],
    /** Every opponent still in, narrowed by their actions (including the bet hero faces). */
    opponents: OpponentModel[],
    /** Index of the player whose bet hero faces: the likeliest to bet again on the next street. */
    bettor: number,
    /** Pot including the bet hero faces, before hero calls; hero's call. */
    pot: number,
    to_call: number,
    /** Chips hero can still put in after this call (against the biggest opponent stack); 0 when the call is all-in. */
    stack_behind: number,
    /** Each opponent's chance of betting the next street when they get the chance (0-1); 0 for a player already all-in. */
    bet_next: number[],
    /** Next street's bet as a share of the pot. */
    next_bet_share: number,
    in_position: boolean,
    iterations?: number,
    time_budget_ms?: number,
    seed?: number
}

export interface CallTreeResult {
    /** Calling now, in chips, relative to folding (0). */
    ev: number,
    /** Plain equity against everyone to showdown, as if nobody bets again. */
    equity: number,
    /** Chance someone bets the next street, and the share of those bets hero keeps calling. */
    barrel: number,
    continue_vs_barrel: number,
    /** Chips from betting after the next street's bet: what hero's strong hands win and weak ones lose when stacks go in. */
    implied: number,
    /** Calling's value against what the plain equity would give: (ev + call) / (equity x pot after the call). */
    realization: number,
    iterations: number
}

/**
 * How much a hand is worth putting money in with on later streets: "strong" is two pair from both hole cards, a set
 * or trips with a hole card, or a straight or better that uses a hole card; "top" is top pair or an overpair (also
 * two pair where one pair is on the board); "weak" is any other pair that uses a hole card; "none" is the rest
 * (a pair or trips only on the board count as nothing). Finer than StrengthClass, which calls any pocket pair on a
 * paired board "strong".
 */
type Stake = "strong" | "top" | "weak" | "none";
/**
 * Later betting, when both hands are worth putting money in: the share of the chips still behind (up to
 * IMPLIED_POTS times the pot) that goes in on average, by hero's stake and the opponent's on the final board.
 * Set from the stored hands, then discounted: where two players both showed down after seeing the turn, the
 * matched money put in on the turn and river came to these shares of min(stack behind, 1.5 x the turn pot):
 * strong vs strong 0.86 (55 hands), strong vs top pair 0.82 (37), strong vs a weaker pair 0.72 (48), top vs top
 * 0.63 (18), top vs weaker 0.59 (41), weaker vs weaker 0.23 (43). Showdowns overstate it, since a hand that folds
 * to a later bet never shows; on your own hands (cards always known) the hands that reached the river put in
 * about 50-80% of what the showdown hands did. So: about 85% of the showdown share when both are strong, 60%
 * with top pair against strong or top pair, 40% with a weaker pair. Rough, from small samples; bluffs into made
 * hands (a hand with nothing that bets and gets called) count only a little.
 */
const STACK_IN: Record<Stake, Record<Stake, number>> = {
    strong: { strong: 0.7, top: 0.5, weak: 0.3, none: 0.05 },
    top:    { strong: 0.5, top: 0.35, weak: 0.25, none: 0.03 },
    weak:   { strong: 0.3, top: 0.25, weak: 0.1, none: 0.02 },
    none:   { strong: 0.05, top: 0.03, weak: 0.02, none: 0 }
};

/** A hand's Stake on a board of 3-5 cards (`value`: the evaluator's value of hole + board). */
function stakeOf(hole: string[], board: string[], value: number): Stake {
    const cat = category(value);
    const ranks = board.map((c) => c[0]);
    const h0 = hole[0][0], h1 = hole[1][0];
    const pocket = h0 === h1;
    const count = (r: string) => ranks.filter((x) => x === r).length;
    if (cat <= 4) {
        // the board alone makes it (a five-card straight or flush): nothing of hero's own
        if (board.length === 5 && evaluate(board.map(code)) === value) return "none";
        return "strong";
    }
    if (cat === 5) return pocket ? (count(h0) >= 1 ? "strong" : "none") : (count(h0) >= 2 || count(h1) >= 2) ? "strong" : "none";
    const top = Math.max(...ranks.map((r) => RANKS.indexOf(r)));
    const pairs_top = (r: string) => RANKS.indexOf(r) === top && count(r) >= 1;
    if (cat === 6) {
        if (!pocket && count(h0) >= 1 && count(h1) >= 1) return "strong";      // both hole cards pair the board
        if (pocket && RANKS.indexOf(h0) > top) return "top";                    // overpair plus a board pair
        if (pairs_top(h0) || pairs_top(h1)) return "top";
        if (pocket || count(h0) >= 1 || count(h1) >= 1) return "weak";
        return "none";                                                          // two pair on the board
    }
    if (cat === 7) {
        if (pocket) return RANKS.indexOf(h0) > top ? "top" : "weak";
        if (pairs_top(h0) || pairs_top(h1)) return "top";
        return count(h0) >= 1 || count(h1) >= 1 ? "weak" : "none";
    }
    return "none";
}
/**
 * Later betting against several players: the biggest amount (won or lost against one player) counts fully, the
 * rest half, since the money that goes in late usually comes down to two players (assumption).
 */
function multiwayLater(total: number, top: number): number {
    return top + 0.5 * (total - top);
}
/** How many pots (after the call) later betting can add at most: more streets left, more money. */
export const IMPLIED_POTS: Record<PostflopStreet, number> = { flop: 1.5, turn: 0.6, river: 0 };
/** Players other than the bettor lead the next street at this share of their bet rate (leads into the aggressor are rarer). */
const OTHERS_BET_SHARE = 0.4;
/**
 * Turn bet weights are measured from shown hands, and turn bettors who give up on the river never show, so the
 * measured weights lean stronger than the truth (see showdown-calibration.ts). For the chance of a turn bet they
 * are flattened toward even by this power (an air weight of 0.34 counts as 0.52). River bets that get called are
 * always shown, so river weights are used as they are.
 */
const TURN_BET_FLATTEN = 0.6;
/** When someone bets the next street multiway and hero calls, each other player who holds a better hand stays in this often (assumption). */
const OVERCALL = 0.35;

/**
 * Values a call on the flop or turn over the next street instead of with a flat realization share. In each
 * simulated hand the next card comes, each opponent bets it with a chance that follows their hand on the
 * new board (bet action weights, scaled to their measured rate of betting again); hero calls that bet only
 * on the cards where, against the hands that bet, calling pays (equity times the pot against the bet), and
 * otherwise folds and keeps nothing. When nobody bets, hero keeps their equity in the pot. On top, the
 * money that goes in later when both hands are strong (STACK_IN): this is where deep stacks pay draws and
 * sets (implied odds) and cost one-pair hands that run into better ones (reverse implied odds). Hero's own
 * bets and raises on the next street aren't modeled apart from that.
 */
export function callTree(input: CallTreeInput): CallTreeResult {
    const rand = seededRandom(input.seed ?? (Date.now() & 0x7fffffff));
    const hero = input.hero.map(code);
    const board = input.board.map(code);
    const dead = new Set([...hero, ...board]);
    const samplers = input.opponents.map((o) => buildSampler(o, dead, input.board, false));
    const n_opp = samplers.length;
    const street: PostflopStreet = input.board.length >= 4 ? "turn" : "flop";
    const next_street: PostflopStreet = street === "flop" ? "turn" : "river";
    const bet_rows = input.opponents.map((o) => {
        const row = weightsFor(o.aggression, next_street).bet;
        if (next_street !== "turn") return row;
        const flat = {} as Record<StrengthClass, number>;
        for (const cls of CLASSES) flat[cls] = Math.pow(row[cls], TURN_BET_FLATTEN);
        return flat;
    });
    const P2 = input.pot + input.to_call;
    const B = Math.max(0, Math.min(input.next_bet_share * P2, input.stack_behind));
    // later betting: up to IMPLIED_POTS pots when nobody bets the next street; when someone does, that bet is counted
    // on its own, so only what goes in beyond it
    const S_check = Math.max(0, Math.min(input.stack_behind, IMPLIED_POTS[street] * P2));
    const S_bet = Math.max(0, Math.min(input.stack_behind - B, IMPLIED_POTS[street] * P2 - B));
    // after a call on the flop, the river is still to come: a little equity is lost to later bets out of position
    const tail = street === "flop" && !input.in_position && input.stack_behind > 0 ? 0.95 : 1;
    const deck = DECK.filter((c) => !dead.has(c));
    const used = new Uint8Array(64);
    const final_board = new Array<number>(5);
    for (let i = 0; i < board.length; i++) final_board[i] = board[i];
    const next_len = board.length + 1;
    const cards_needed = 5 - board.length;
    const opp_cards: [number, number][] = new Array(n_opp);
    const opp_values = new Array<number>(n_opp);
    const bet_p = new Float64Array(n_opp);
    const hole = (c: [number, number]) => [cardString(c[0]), cardString(c[1])];

    // each opponent's average bet weight over their range on the next street, so their bet chance averages to bet_next
    const scale = new Float64Array(n_opp);
    {
        const pre = seededRandom((input.seed ?? 1) ^ 0x5bd1e995);
        for (let i = 0; i < n_opp; i++) {
            const s = samplers[i];
            if (!(s.total > 0) || !(input.bet_next[i] > 0)) continue;
            let w = 0, n = 0;
            for (let k = 0; k < 400; k++) {
                const c = s.combos[sample(s, pre)].cards;
                let card: number;
                do { card = deck[Math.floor(pre() * deck.length)]; } while (card === c[0] || card === c[1]);
                const nb = [...input.board, cardString(card)];
                w += bet_rows[i][classify(hole(c), nb, evaluate([c[0], c[1], ...board, card]))];
                n++;
            }
            scale[i] = n > 0 && w > 0 ? input.bet_next[i] / (w / n) : 0;
        }
    }

    // per next card: weight and hero's pot share when someone bets / nobody bets, and the later-betting chips
    const N = new Float64Array(52), Wb = new Float64Array(52), Sb = new Float64Array(52), Sc = new Float64Array(52), Xb = new Float64Array(52), Xc = new Float64Array(52);
    const card_index = new Map(DECK.map((c, i) => [c, i]));
    const max_iterations = input.iterations ?? 20000;
    const deadline = Date.now() + (input.time_budget_ms ?? 80);
    let share_sum = 0, done = 0;
    outer:
    for (let it = 0; it < max_iterations; it++) {
        if ((it & 511) === 0 && it > 0 && Date.now() > deadline) break;
        used.fill(0);
        for (let i = 0; i < n_opp; i++) {
            const s = samplers[i];
            let picked = -1;
            for (let tries = 0; tries < 30; tries++) {
                const k = sample(s, rand);
                const c = s.combos[k].cards;
                if (!used[c[0]] && !used[c[1]]) { picked = k; break; }
            }
            if (picked < 0) continue outer;
            const c = s.combos[picked].cards;
            used[c[0]] = 1;
            used[c[1]] = 1;
            opp_cards[i] = c;
        }
        for (let k = 0; k < cards_needed; k++) {
            let c: number;
            do { c = deck[Math.floor(rand() * deck.length)]; } while (used[c]);
            used[c] = 1;
            final_board[board.length + k] = c;
        }
        const next_card = final_board[board.length];
        const next_board = final_board.slice(0, next_len);
        const next_names = next_board.map(cardString);
        const final_names = final_board.map(cardString);
        const hero_value = evaluate([hero[0], hero[1], ...final_board]);
        const hero_stake = stakeOf(input.hero, final_names, hero_value);
        let best = hero_value, tied = 1, hero_best = true;
        let no_bet = 1, extra = 0, extra_top = 0, bet_weight = 0, bet_share = 0, beaten_by = 0;
        const p_bet = bet_p;
        for (let i = 0; i < n_opp; i++) {
            const c = opp_cards[i];
            const v = evaluate([c[0], c[1], ...final_board]);
            opp_values[i] = v;
            if (v < best) { best = v; tied = 1; hero_best = false; }
            else if (v === best) tied++;
            p_bet[i] = 0;
            if (scale[i] > 0) {
                const value_next = next_len === 5 ? v : evaluate([c[0], c[1], ...next_board]);
                const p = Math.min(0.97, scale[i] * bet_rows[i][classify(hole(c), next_names, value_next)] * (i === input.bettor ? 1 : OTHERS_BET_SHARE));
                no_bet *= 1 - p;
                p_bet[i] = p;
            }
            if (v < hero_value) beaten_by++;
            if (S_check > 0 && input.bet_next[i] > 0) {
                // per chip of later betting: + when hero wins, - when hero loses
                const into = STACK_IN[hero_stake][stakeOf(hole(c), final_names, v)];
                if (into > 0) {
                    const x = into * (v > hero_value ? 1 : v === hero_value ? 0 : -1);
                    extra += x;
                    if (Math.abs(x) > Math.abs(extra_top)) extra_top = x;
                }
            }
        }
        const share = hero_best && best === hero_value ? 1 / tied : 0;
        // facing a bet multiway: hero against the bettor, plus each other player with a better hand who overcalls
        for (let i = 0; i < n_opp; i++) {
            if (p_bet[i] <= 0) continue;
            const vs = opp_values[i] > hero_value ? 1 : opp_values[i] === hero_value ? 0.5 : 0;
            const others_better = beaten_by - (opp_values[i] < hero_value ? 1 : 0);
            bet_weight += p_bet[i];
            bet_share += p_bet[i] * vs * Math.pow(1 - OVERCALL, others_better);
        }
        const share_b = bet_weight > 0 ? bet_share / bet_weight : share;
        const unit = Math.max(-1, Math.min(n_opp, multiwayLater(extra, extra_top)));
        const q = 1 - no_bet;
        const ci = card_index.get(next_card)!;
        N[ci]++;
        Wb[ci] += q;
        Sb[ci] += q * share_b;
        Sc[ci] += (1 - q) * share;
        Xb[ci] += q * unit * S_bet;
        Xc[ci] += (1 - q) * unit * S_check;
        share_sum += share;
        done++;
    }
    if (done === 0) return { ev: -input.to_call, equity: 0, barrel: 0, continue_vs_barrel: 0, implied: 0, realization: 0, iterations: 0 };
    let value = 0, barrel = 0, kept = 0, implied = 0;
    for (let ci = 0; ci < 52; ci++) {
        if (N[ci] === 0) continue;
        value += tail * Sc[ci] * P2 + Xc[ci];
        implied += Xc[ci];
        barrel += Wb[ci];
        // calling the next bet on this card: hero's share of the bigger pot, minus the bet, plus later betting
        const call_next = tail * Sb[ci] * (P2 + 2 * B) - Wb[ci] * B + Xb[ci];
        if (B <= 0 || call_next > 0) {
            value += call_next;
            kept += Wb[ci];
            implied += Xb[ci];
        }
    }
    const eq = share_sum / done;
    const ev = value / done - input.to_call;
    return {
        ev, equity: eq,
        barrel: barrel / done,
        continue_vs_barrel: barrel > 0 ? kept / barrel : 1,
        implied: implied / done,
        realization: eq > 0 ? (ev + input.to_call) / (eq * P2) : 0,
        iterations: done
    };
}
