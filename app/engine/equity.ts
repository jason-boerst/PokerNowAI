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
    adds?: number[]
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
    raise_rate: number
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
    const sums = Array.from({ length: n_sc }, () => ({ called: 0, raised: 0, share: 0, callers: 0, added: 0, share_added: 0, matched: 0, share_matched: 0 }));
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
        scenario:
        for (let k = 0; k < n_sc; k++) {
            const sc = scenarios![k];
            let n = 0, beaten = false, ties = 0, added = 0;
            for (let i = 0; i < n_opp; i++) {
                if (raise_draw[i] < raise_scale[k][i] * opp_raise_w[i]) { sums[k].raised++; continue scenario; }
                const f = sc.continue_fraction[i];
                if (f < 1 && position[i] >= f) continue;   // folds
                n++;
                added += sc.adds ? sc.adds[i] : 1;
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
        }
        done++;
    }
    const results: ContinueResult[] = sums.map((t) => t.called > 0
        ? { equity: t.share / t.called, callers: t.callers / t.called, added: t.added / t.called, equity_x_added: t.share_added / t.called,
            matched: t.matched / t.called, equity_x_matched: t.share_matched / t.called, call_rate: t.called / done, raise_rate: t.raised / done }
        : { equity: 0, callers: 0, added: 0, equity_x_added: 0, matched: 0, equity_x_matched: 0, call_rate: 0, raise_rate: done ? t.raised / done : 0 });
    return { equity: done ? share / done : 0, iterations: done, results };
}
