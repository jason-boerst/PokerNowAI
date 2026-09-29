// What a bet, raise, call or check means, measured from the hands players showed down in your games.
//
// The range narrowing in equity.ts weighs each possible opponent hand by how likely that kind of
// hand ("strong", "pair", "draw", "air") is to take the action seen. Those weights started as
// guesses; this learns them from stored hands: every action a player took on a street in a hand
// whose cards were later shown is counted with the hand's class on the board at the time.
//
// Selection bias: only shown hands count (at showdown, or shown by choice after winning), and
// which hands get shown depends on the action.
// - A river bet or raise that gets called is always shown (the bettor shows first), and whether it
//   gets called doesn't depend on the bettor's cards, so shown river bets and raises are a fair
//   sample of what bettors hold. Flop and turn bets are shown only when the hand reaches showdown,
//   which bettors who give up later don't, so those lean stronger than the truth. Bet and raise
//   weights compare the shown hands with what a typical range holds on the same boards (how much
//   more or less often each class bets than it would by chance). That baseline also ignores
//   narrowing from earlier streets, so turn and river weights come out somewhat steeper than the
//   truth, which errs toward respecting bets.
// - Calls and checks are shown mostly when they win: losers can muck and hands that fold later are
//   never seen, so shown callers and checkers look far stronger than they are. Their weights
//   compare them with all shown actions on the street instead, where much of that bias cancels.
// Measured weights are blended with the built-in ones by sample size, and equity.ts still scales
// bluffing up for aggressive players.
import { cardName, code, seededRandom } from "./cards.ts";
import { HandState, SeatState } from "./hand-parser.ts";
import { PostflopAction, strengthClass } from "./equity.ts";
import { isHoldem } from "./player-profile.ts";
import { expandRange, topRange } from "./ranges.ts";

export type StrengthClass = ReturnType<typeof strengthClass>;
/** How likely each kind of hand is to take each action, relative to the others (largest 1). */
export type ActionWeights = Record<PostflopAction, Record<StrengthClass, number>>;
export type PostflopStreet = "flop" | "turn" | "river";

export interface CalibratedActionWeights {
    weights: Record<PostflopStreet, ActionWeights>,
    /** Shown-hand actions each street's weights were measured from. */
    samples: Record<PostflopStreet, number>
}

/** The built-in guesses (equity.ts ACTION_WEIGHTS), used alone until there are shown hands. */
export const DEFAULT_ACTION_WEIGHTS: ActionWeights = {
    bet:   { strong: 1.0, pair: 0.9, draw: 0.6, air: 0.25 },
    raise: { strong: 1.0, pair: 0.4, draw: 0.45, air: 0.1 },
    call:  { strong: 0.8, pair: 1.0, draw: 0.9, air: 0.3 },
    check: { strong: 0.5, pair: 0.9, draw: 0.9, air: 1.0 }
};

const STREETS: PostflopStreet[] = ["flop", "turn", "river"];
const ACTIONS: PostflopAction[] = ["bet", "raise", "call", "check"];
const CLASSES: StrengthClass[] = ["strong", "pair", "draw", "air"];
const BOARD_CARDS: Record<PostflopStreet, number> = { flop: 3, turn: 4, river: 5 };
/** Actions whose shown hands are a fair sample, compared with a typical range on the board. */
const RANGE_BASELINE = new Set<PostflopAction>(["bet", "raise"]);
/** The typical range: about the hands a loose home player sees the flop with. */
const BASELINE_RANGE_PERCENT = 35;
/**
 * Range hands classed per bet or raise for the baseline: a random sample keeps loading fast, and
 * over many actions the sums converge on the range's true class shares.
 */
const BASELINE_SAMPLE = 20;
/** Smallest expected count a class is compared with, so one surprising hand can't dominate. */
const MIN_EXPECTED = 0.5;
/** Floor for a measured weight: no kind of hand is treated as never taking an action. */
const MIN_WEIGHT = 0.03;
/** Shown actions that count as much as the built-in guess, per street and action. */
export const ACTION_PRIOR_WEIGHT = 40;

type ClassCounts = Record<StrengthClass, number>;
type Counts = Record<PostflopStreet, Record<PostflopAction, ClassCounts>>;

function emptyCounts(): Counts {
    const counts = {} as Counts;
    for (const street of STREETS) {
        counts[street] = {} as Counts[PostflopStreet];
        for (const action of ACTIONS) counts[street][action] = { strong: 0, pair: 0, draw: 0, air: 0 };
    }
    return counts;
}

let baseline_combos: { names: [string, string], codes: [number, number], weight: number }[] | null = null;

/** Estimated share of each class among the typical range's hands on a board (hands using a board card left out). */
function rangeClasses(board: string[], rand: () => number): ClassCounts {
    baseline_combos ??= expandRange(topRange(BASELINE_RANGE_PERCENT))
        .map((c) => ({ codes: c.cards, names: [cardName(c.cards[0]), cardName(c.cards[1])], weight: c.weight }));
    const dead = new Set(board.map(code));
    const out: ClassCounts = { strong: 0, pair: 0, draw: 0, air: 0 };
    for (let n = 0; n < BASELINE_SAMPLE;) {
        const c = baseline_combos[Math.floor(rand() * baseline_combos.length)];
        // the class at the range's edge is only partly in it
        if (dead.has(c.codes[0]) || dead.has(c.codes[1]) || rand() >= c.weight) continue;
        out[strengthClass(c.names, board)] += 1 / BASELINE_SAMPLE;
        n++;
    }
    return out;
}

const sameCards = (a: string[], b: string[]) => a.length === b.length && a.every((c) => b.includes(c));

/** Counts shown hands' actions by street, action and hand class; hands can be added as they finish. */
export class ShowdownCalibrator {
    private counts = emptyCounts();
    /** For bets and raises: the class shares a typical range would have had on the same boards, summed. */
    private expected = emptyCounts();
    /** Fixed seed: the same stored hands always give the same weights. */
    private rand = seededRandom(1);

    /** @param include which shown seats to learn from (e.g. everyone but you). */
    constructor(private include: (seat: SeatState) => boolean = () => true) {}

    /**
     * Adds one finished hand (only Hold'em hands that aren't bomb pots are used). Your own shown
     * hands (the hand's hole cards) are skipped too: they say nothing about how opponents bet.
     */
    add(s: HandState): void {
        if (!isHoldem(s) || s.bomb_pot) return;
        for (const seat of s.seats) {
            const hole = seat.shown_cards;
            if (!hole || hole.length !== 2 || seat.folded || !this.include(seat) || sameCards(hole, s.hero_cards)) continue;
            for (const a of s.actions) {
                if (a.player_id !== seat.id || a.street === "preflop" || !ACTIONS.includes(a.type as PostflopAction)) continue;
                const action = a.type as PostflopAction;
                const board = s.board.slice(0, BOARD_CARDS[a.street]);
                if (board.length !== BOARD_CARDS[a.street] || new Set([...hole, ...board]).size !== hole.length + board.length) continue;
                this.counts[a.street][action][strengthClass(hole, board)]++;
                if (RANGE_BASELINE.has(action)) {
                    const shares = rangeClasses(board, this.rand);
                    for (const cls of CLASSES) this.expected[a.street][action][cls] += shares[cls];
                }
            }
        }
    }

    samples(): Record<PostflopStreet, number> {
        const out = {} as Record<PostflopStreet, number>;
        for (const street of STREETS) out[street] = ACTIONS.reduce((n, action) => n + sum(this.counts[street][action]), 0);
        return out;
    }

    /**
     * Weights per street: for each action, how much more (or less) often each class of hand took
     * it than the baseline (see the top of this file) predicts, scaled so the most likely class is
     * 1 and floored at MIN_WEIGHT. Then blended with `defaults` by sample size, n / (n +
     * prior_weight), so a handful of showdowns barely moves the built-in guesses and a few hundred
     * mostly replace them.
     */
    weights(defaults: ActionWeights = DEFAULT_ACTION_WEIGHTS, prior_weight = ACTION_PRIOR_WEIGHT): CalibratedActionWeights {
        const weights = {} as Record<PostflopStreet, ActionWeights>;
        for (const street of STREETS) {
            const shown: ClassCounts = { strong: 0, pair: 0, draw: 0, air: 0 };
            for (const action of ACTIONS) for (const cls of CLASSES) shown[cls] += this.counts[street][action][cls];
            const shown_total = sum(shown);
            weights[street] = {} as ActionWeights;
            for (const action of ACTIONS) {
                const row = this.counts[street][action];
                const n = sum(row);
                // observed over expected; a class neither seen nor expected (e.g. draws on the river) carries no information
                const expected = (cls: StrengthClass) => RANGE_BASELINE.has(action) ? this.expected[street][action][cls]
                    : shown_total > 0 ? shown[cls] / shown_total * n : 0;
                const ratio = (cls: StrengthClass) => row[cls] === 0 && expected(cls) === 0 ? null : row[cls] / Math.max(expected(cls), MIN_EXPECTED);
                const top = n > 0 ? Math.max(...CLASSES.map((cls) => ratio(cls) ?? 0)) : 0;
                const share = n / (n + prior_weight);
                weights[street][action] = {} as Record<StrengthClass, number>;
                for (const cls of CLASSES) {
                    const fallback = defaults[action][cls];
                    const r = top > 0 ? ratio(cls) : null;
                    const measured = r === null ? null : Math.max(MIN_WEIGHT, Math.min(1, r / top));
                    weights[street][action][cls] = measured === null ? fallback : share * measured + (1 - share) * fallback;
                }
            }
        }
        return { weights, samples: this.samples() };
    }
}

function sum(row: Record<string, number>): number {
    return Object.values(row).reduce((a, b) => a + b, 0);
}

/**
 * Action weights per street learned from every shown hand in `states` (see the top of this file
 * for how, and for the selection bias). `include` picks whose shown hands count.
 */
export function calibrateActionWeights(states: HandState[], defaults: ActionWeights = DEFAULT_ACTION_WEIGHTS, prior_weight = ACTION_PRIOR_WEIGHT,
    include: (seat: SeatState) => boolean = () => true): CalibratedActionWeights {
    const calibrator = new ShowdownCalibrator(include);
    for (const s of states) calibrator.add(s);
    return calibrator.weights(defaults, prior_weight);
}
