import { category, code, DECK, evaluate, RANKS, seededRandom } from "./cards.ts";
import { expandRange, Range, WeightedCombo } from "./ranges.ts";

export type PostflopAction = "bet" | "raise" | "call" | "check";

export interface OpponentModel {
    range: Range,
    /** The opponent's post-flop actions so far, with the board at the time (used to narrow the range). */
    postflop_actions?: { board: string[], action: PostflopAction }[],
    /** Share of the opponent's post-flop actions that are bets or raises (0-1); aggressive players bluff more. */
    aggression?: number
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

type StrengthClass = "strong" | "pair" | "draw" | "air";

// How likely a player is to take each action with each kind of hand, relative to other hands.
// Heuristics aimed at loose-passive home players (bets and raises mostly mean real hands).
// These are assumptions, not measured frequencies.
const ACTION_WEIGHTS: Record<PostflopAction, Record<StrengthClass, number>> = {
    bet:   { strong: 1.0, pair: 0.9, draw: 0.6, air: 0.25 },
    raise: { strong: 1.0, pair: 0.4, draw: 0.45, air: 0.1 },
    call:  { strong: 0.8, pair: 1.0, draw: 0.9, air: 0.3 },
    check: { strong: 0.5, pair: 0.9, draw: 0.9, air: 1.0 }
};

/** Rough strength class of two hole cards on a board (3-5 cards). */
export function strengthClass(hole: string[], board: string[]): StrengthClass {
    const all = [...hole, ...board];
    const cat = category(evaluate(all.map(code)));
    const board_ranks = board.map((c) => c[0]);
    const pocket_pair = hole[0][0] === hole[1][0];
    const pairs_board = hole.some((c) => board_ranks.includes(c[0]));
    // straight or better, or two pair / trips / set that uses a hole card
    // (a pair or trips that is only on the board doesn't count)
    if (cat <= 4) return "strong";
    if (cat <= 6 && (pocket_pair || pairs_board)) return "strong";
    if (pocket_pair || pairs_board) return "pair";
    if (board.length < 5 && (hasFlushDraw(hole, board) || hasOpenEnder(hole, board))) return "draw";
    return "air";
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

const AVERAGE_AGGRESSION = 0.35;

/**
 * Action weights adjusted for how aggressive this opponent is: someone who bets twice as often as
 * average is assumed to bet and raise with weak hands and draws about twice as often.
 */
export function weightsFor(aggression: number | undefined): Record<PostflopAction, Record<StrengthClass, number>> {
    if (aggression === undefined) return ACTION_WEIGHTS;
    const f = Math.max(0.5, Math.min(2.5, aggression / AVERAGE_AGGRESSION));
    const scaled = (w: number) => Math.min(1, w * f);
    return {
        ...ACTION_WEIGHTS,
        bet: { ...ACTION_WEIGHTS.bet, draw: scaled(ACTION_WEIGHTS.bet.draw), air: scaled(ACTION_WEIGHTS.bet.air) },
        raise: { ...ACTION_WEIGHTS.raise, pair: scaled(ACTION_WEIGHTS.raise.pair), draw: scaled(ACTION_WEIGHTS.raise.draw), air: scaled(ACTION_WEIGHTS.raise.air) }
    };
}

function actionWeight(combo: [number, number], actions: OpponentModel["postflop_actions"], weights: Record<PostflopAction, Record<StrengthClass, number>>): number {
    if (!actions || actions.length === 0) return 1;
    let w = 1;
    const hole = [cardString(combo[0]), cardString(combo[1])];
    for (const a of actions) {
        if (a.board.length < 3) continue;
        w *= weights[a.action][strengthClass(hole, a.board)];
    }
    return w;
}

interface Sampler {
    combos: WeightedCombo[],
    cumulative: Float64Array,
    total: number
}

function buildSampler(model: OpponentModel, dead: Set<number>): Sampler {
    let combos = expandRange(model.range, dead);
    if (combos.length === 0) {
        // no information: fall back to any two cards
        combos = [];
        for (let i = 0; i < DECK.length; i++) for (let j = i + 1; j < DECK.length; j++) {
            if (!dead.has(DECK[i]) && !dead.has(DECK[j])) combos.push({ cards: [DECK[i], DECK[j]], weight: 1 });
        }
    }
    const weights = weightsFor(model.aggression);
    const weighted = combos.map((c) => ({ ...c, weight: c.weight * actionWeight(c.cards, model.postflop_actions, weights) }))
        .filter((c) => c.weight > 0);
    const cumulative = new Float64Array(weighted.length);
    let total = 0;
    weighted.forEach((c, i) => { total += c.weight; cumulative[i] = total; });
    return { combos: weighted, cumulative, total };
}

function sample(s: Sampler, rand: () => number): WeightedCombo {
    const x = rand() * s.total;
    let lo = 0, hi = s.cumulative.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (s.cumulative[mid] < x) lo = mid + 1; else hi = mid;
    }
    return s.combos[lo];
}

/** Monte Carlo equity of hero's hand against one or more opponent range models. */
export function equity(input: EquityInput): EquityResult {
    const rand = seededRandom(input.seed ?? (Date.now() & 0x7fffffff));
    const hero = input.hero.map(code);
    const board = input.board.map(code);
    const dead = new Set([...hero, ...board]);
    const samplers = input.opponents.map((o) => buildSampler(o, dead));
    const max_iterations = input.iterations ?? 20000;
    const deadline = Date.now() + (input.time_budget_ms ?? 150);
    const deck = DECK.filter((c) => !dead.has(c));
    const used = new Uint8Array(64);
    const cards_needed = 5 - board.length;
    const final_board = new Array<number>(5);
    for (let i = 0; i < board.length; i++) final_board[i] = board[i];

    let share = 0;
    let done = 0;
    outer:
    for (let it = 0; it < max_iterations; it++) {
        if ((it & 511) === 0 && it > 0 && Date.now() > deadline) break;
        used.fill(0);
        const opp_cards: [number, number][] = [];
        for (const s of samplers) {
            let picked: WeightedCombo | null = null;
            for (let tries = 0; tries < 30; tries++) {
                const c = sample(s, rand);
                if (!used[c.cards[0]] && !used[c.cards[1]]) { picked = c; break; }
            }
            if (!picked) continue outer;
            used[picked.cards[0]] = 1;
            used[picked.cards[1]] = 1;
            opp_cards.push(picked.cards);
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
        for (const oc of opp_cards) {
            const s = evaluate([oc[0], oc[1], ...final_board]);
            if (s < best) { best = s; tied = 1; hero_best = false; }
            else if (s === best) { tied++; }
        }
        if (hero_best && best === hero_strength) share += 1 / tied;
        done++;
    }
    return { equity: done ? share / done : 0, iterations: done };
}
