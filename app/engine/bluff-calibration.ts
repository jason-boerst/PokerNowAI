// How often bettors are bluffing: a correction for the showdown bias in the flop and turn bet weights.
//
// The action weights (showdown-calibration.ts) are learned from shown hands. A flop or turn bettor who gives up
// later never shows, so the hands shown after flop and turn bets lean stronger than what bettors really hold, and
// the engine narrows a bettor's range too far toward strong hands. That makes it fold too often against bets.
//
// River bets and raises that get called are a fair sample: the bettor must show whatever they hold. For each of
// them this rebuilds the bettor's range the way the engine does (their stats, their line before the flop, every
// action after it) and asks which share of it the engine expects to be air, a pair or a strong hand on the river.
// On 345 called river bettors in the games this was built from, the engine expected 15.7% air and 20.6% pairs;
// they showed 22.6% air and 15.7% pairs. Scaling the flop and turn bet and raise weights of air and draws by about
// 2.5 matched them (log-likelihood -312.4 -> -298.6); scaling the river weights too, or the pair weights, fit worse.
//
// fitBluffScale finds that scale by maximum likelihood on your stored hands each time they load, pulled toward no
// correction (1) while the sample is small, and applyBluffScale puts it into the weights.
import { code } from "./cards.ts";
import { ActionWeights, isSevenDeuce, PostflopAction, PostflopStreet, scaleForAggression, strengthClass, StrengthClass } from "./equity.ts";
import { HandState, SeatState } from "./hand-parser.ts";
import { isHoldem, PlayerRef } from "./player-profile.ts";
import { ObservedStats, seatModel } from "./opponent-range.ts";
import { expandRange } from "./ranges.ts";

export interface BluffFit {
    /** Multiplier for the air and draw weights of flop and turn bets and raises (1: no change). */
    scale: number,
    /** The best-fitting scale before it is pulled toward 1. */
    best: number,
    /** Called river bettors it was fit on. */
    samples: number,
    /** Share of them that showed air (no pair, a missed draw), and what the engine expected before and after. */
    observed_air: number,
    expected_air: number,
    expected_air_fitted: number,
    /** Log-likelihood of what they showed without the correction and with it (higher fits better). */
    log_likelihood: number,
    log_likelihood_fitted: number
}

/** The scales tried. */
const GRID = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.5, 4];
/** Samples that count as much as "no correction" when the fit is pulled toward 1 (in log scale). */
const PRIOR_SAMPLES = 100;
/** Streets whose bet and raise weights are corrected (river bets that get called are shown, so they are fair). */
const CORRECTED: PostflopStreet[] = ["flop", "turn"];
const BOARD_CARDS: Record<PostflopStreet, number> = { flop: 3, turn: 4, river: 5 };

/** One called river bettor: each hand in their range, its weight and its class at each of their actions, and what they showed. */
interface Sample {
    aggression: number | undefined,
    actions: { street: PostflopStreet, action: PostflopAction }[],
    /** Per combo: range weight, class at each action (same order as `actions`), class on the river. */
    combos: { weight: number, at: StrengthClass[], river: StrengthClass }[],
    shown: StrengthClass
}

/** Air or a missed draw on the river count as one class (no showdown value). */
const showdownClass = (c: StrengthClass): "strong" | "pair" | "air" => (c === "draw" ? "air" : c);

/** The bet weights with flop and turn bets and raises of air and draws scaled by `scale` (never above a strong hand's). */
export function applyBluffScale(weights: Record<PostflopStreet, ActionWeights>, scale: number): Record<PostflopStreet, ActionWeights> {
    const out = structuredClone(weights);
    if (scale === 1) return out;
    for (const street of CORRECTED) {
        for (const action of ["bet", "raise"] as const) {
            const row = out[street][action];
            for (const cls of ["air", "draw"] as const) row[cls] = Math.min(row.strong, row[cls] * scale);
        }
    }
    return out;
}

/** Collects the fair sample from stored hands (only seats `include` accepts) and fits the scale. */
export function fitBluffScale(states: HandState[], weights: Record<PostflopStreet, ActionWeights>,
    stats: (player: PlayerRef) => ObservedStats | undefined, include: (seat: SeatState) => boolean = () => true): BluffFit {
    const samples: Sample[] = [];
    for (const s of states) {
        const sample = riverBettor(s, stats, include);
        if (sample) samples.push(sample);
    }
    const n = samples.length;
    const observed_air = n ? samples.filter((x) => showdownClass(x.shown) === "air").length / n : 0;
    if (n === 0) return { scale: 1, best: 1, samples: 0, observed_air, expected_air: 0, expected_air_fitted: 0, log_likelihood: 0, log_likelihood_fitted: 0 };
    let best = 1, best_ll = -Infinity;
    const fits = new Map<number, { ll: number, air: number }>();
    for (const k of GRID) {
        const fit = likelihood(samples, applyBluffScale(weights, k));
        fits.set(k, fit);
        if (fit.ll > best_ll) { best_ll = fit.ll; best = k; }
    }
    // pulled toward no correction while the sample is small
    const scale = Math.round(Math.exp(Math.log(best) * n / (n + PRIOR_SAMPLES)) * 100) / 100;
    const fitted = likelihood(samples, applyBluffScale(weights, scale));
    return {
        scale, best, samples: n, observed_air,
        expected_air: fits.get(1)!.air, expected_air_fitted: fitted.air,
        log_likelihood: Math.round(fits.get(1)!.ll * 10) / 10, log_likelihood_fitted: Math.round(fitted.ll * 10) / 10
    };
}

/** Log-likelihood of what the bettors showed under `weights`, and the average expected share of air. */
function likelihood(samples: Sample[], weights: Record<PostflopStreet, ActionWeights>): { ll: number, air: number } {
    let ll = 0, air = 0;
    for (const x of samples) {
        const rows = x.actions.map((a) => scaleForAggression(weights[a.street], x.aggression)[a.action]);
        const mass = { strong: 0, pair: 0, air: 0 };
        let total = 0;
        for (const c of x.combos) {
            let w = c.weight;
            for (let i = 0; i < rows.length; i++) w *= rows[i][c.at[i]];
            mass[showdownClass(c.river)] += w;
            total += w;
        }
        if (!(total > 0)) continue;
        ll += Math.log(Math.max(1e-4, mass[showdownClass(x.shown)] / total));
        air += mass.air / total;
    }
    return { ll, air: samples.length ? air / samples.length : 0 };
}

/** The last river bet or raise of a Hold'em hand when it was called and the bettor showed, else null. */
function riverBettor(s: HandState, stats: (player: PlayerRef) => ObservedStats | undefined, include: (seat: SeatState) => boolean): Sample | null {
    if (!isHoldem(s) || s.bomb_pot || s.board.length < 5) return null;
    const river = s.actions.filter((a) => a.street === "river");
    const aggressive = river.filter((a) => a.type === "bet" || a.type === "raise");
    const last = aggressive[aggressive.length - 1];
    if (!last || !river.slice(river.indexOf(last) + 1).some((a) => a.type === "call")) return null;
    const seat = s.seats.find((p) => p.id === last.player_id);
    const shown = seat?.shown_cards;
    if (!seat || !shown || shown.length !== 2 || !include(seat)) return null;
    // the bettor's range as the engine builds it just after the bet
    const at_bet: HandState = { ...s, actions: s.actions.slice(0, s.actions.indexOf(last) + 1) };
    const model = seatModel(at_bet, seat, stats).model;
    const actions = (model.postflop_actions ?? [])
        .filter((a) => a.board.length >= 3)
        .map((a) => ({ street: (a.board.length >= 5 ? "river" : a.board.length === 4 ? "turn" : "flop") as PostflopStreet, action: a.action }));
    const boards = actions.map((a) => s.board.slice(0, BOARD_CARDS[a.street]));
    const dead = new Set(s.board.map(code));
    const names = (c: [number, number]) => [cardName(c[0]), cardName(c[1])];
    const combos = expandRange(model.range, dead).map((c) => {
        const hole = names(c.cards);
        // under the 7-2 bounty, 7-2 acts like a strong hand (as in the engine's narrowing)
        const acts_strong = !!model.bounty_72 && isSevenDeuce(hole);
        return { weight: c.weight, at: boards.map((b) => (acts_strong ? "strong" as const : strengthClass(hole, b))), river: strengthClass(hole, s.board) };
    });
    if (!combos.length) return null;
    return { aggression: model.aggression, actions, combos, shown: strengthClass(shown, s.board) };
}

const RANK = "23456789TJQKA";
const SUIT = "shdc";
const CARD_NAMES = new Map<number, string>();
for (const r of RANK) for (const u of SUIT) CARD_NAMES.set(code(r + u), r + u);
const cardName = (c: number) => CARD_NAMES.get(c)!;
