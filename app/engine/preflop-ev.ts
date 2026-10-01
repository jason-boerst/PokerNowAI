// Preflop options priced by EV: fold, check, call, a raise to the chart's size and (short) all-in, against the
// players still in, using how players in your games answer raises (preflop-responses.ts) adjusted for each player.
//
//   call / check : hero's equity against everyone still in (players still to act join at their overcall rate)
//                  x the share a hand like hero's keeps (realization: suited, connected, position, stack depth)
//                  x the pot, minus the call; a raise behind (a squeeze) is answered by calling only when it pays.
//   raise        : everyone folds -> hero wins the pot. Called -> hero's share of the bigger pot against the hands
//                  that continue (each player continues with the strongest part of their range: any two cards for
//                  players still to act, their range so far for the others). Re-raised -> hero calls only when
//                  their equity against a re-raising range pays for it.
// This is the same model the post-flop engine uses for bets (continuationEquity). Later streets enter only through
// realization. The chart stays the prior: preflop.ts uses this to overrule a chart play only when the EV gap is
// bigger than the noise of the measured answers (see preflopAdvice).
import { continuationEquity, equity, OpponentModel } from "./equity.ts";
import { HandState, HeroView, SeatState } from "./hand-parser.ts";
import { HandClass } from "./hand-classes.ts";
import { ObservedStats, opponentModels } from "./opponent-range.ts";
import { PlayerRef, PRIORS } from "./player-profile.ts";
import { PreflopSituation, preflopResponseTable, preflopSize, PreflopResponse, ResponderGroup } from "./preflop-responses.ts";
import { PreflopConfig, postflopRank, realizationOf } from "./preflop.ts";
import { RANKED_CLASSES, rangePercent, topRange } from "./ranges.ts";

/** A player's preflop rates (0-1) for adjusting the pool's answers to them. */
export interface PreflopProfile { vpip: number, three_bet: number, fold_to_three_bet: number }

export interface PreflopEvOption {
    action: "fold" | "check" | "call" | "raise" | "all-in",
    /** Raise-to in big blinds (0 for fold, check, call). */
    size_bb: number,
    label: string,
    /** EV in big blinds relative to folding now. */
    ev_bb: number,
    /** How far the EV could be off through the measured answers (big blinds). */
    risk_bb: number,
    /** Raises: everyone folds; someone re-raises; hero's equity when called. Calls: someone raises behind. */
    fold_chance?: number,
    raise_chance?: number,
    called_equity?: number
}

export interface PreflopEvResult {
    options: PreflopEvOption[],
    /** Hero's equity against everyone still in, as they are now. */
    equity: number
}

/** Answers measured on few cases count as this many when their uncertainty is estimated (as in postflop.ts). */
const PRIOR_CASES = 25;
const MODEL_ERROR = 0.1;
const RISK_Z = 0.75;
/**
 * The config's realization shares (price_defense) are for defending marginal hands. Strong hands keep more of their
 * equity (they win bigger pots and can bet and raise later), so the share rises toward all of it with the hand's
 * rank among the 169 starting hands: share + (1 - share) x strength^3 (72o keeps the config share, AKo about 97%,
 * QJo about 82%). An assumption in line with how equity realization grows with hand strength.
 */
function realization(config: PreflopConfig, cls: HandClass, multiway: boolean, spr_after: number): number {
    const base = realizationOf(config, cls, multiway, spr_after);
    const rank = RANKED_CLASSES.indexOf(cls);
    const strength = rank < 0 ? 0 : 1 - rank / (RANKED_CLASSES.length - 1);
    return base >= 1 ? base : base + (1 - base) * strength ** 3;
}
/** In position a hand keeps more of its equity than the out-of-position shares in the config (assumption). */
const IN_POSITION_BONUS = 1.12;
/** Most of its equity a hand is credited with keeping (implied odds deep, or a strong hand in position, can exceed all of it). */
const MAX_REALIZATION = 1.15;
/** How far a realization share could be off (relative), for the risk of a call or check. */
const REALIZATION_ERROR = 0.15;
/** A re-raise of hero's raise is to this multiple of it. */
const RERAISE_MULTIPLE = 3;
/** All-in is offered when the effective stack is at most this many big blinds. */
const SHOVE_DEPTH_BB = 30;
/** How far each player's own rates may move the pool's answers. */
const PLAYER_FACTOR = { lo: 0.5, hi: 1.8 };

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const product = (xs: number[]) => xs.reduce((p, x) => p * x, 1);

/**
 * Prices hero's preflop options. `raise_to_bb` is the raise size to price (the chart's size); null when hero
 * can't raise. Null when the spot can't be priced (no cards, nobody left).
 */
export function preflopEv(s: HandState, v: HeroView, cls: HandClass, stats: (p: PlayerRef) => ObservedStats | undefined, config: PreflopConfig,
    raise_to_bb: number | null, profile: (seat: SeatState) => PreflopProfile | undefined = () => undefined, time_budget_ms = 60): PreflopEvResult | null {
    const hero = s.seats.find((p) => p.id === s.hero_id);
    if (!hero || s.hero_cards.length !== 2 || s.street !== "preflop") return null;
    const bb = s.big_blind;
    const pre = s.actions.filter((a) => a.street === "preflop");
    const level = Math.max(bb, ...pre.filter((a) => a.type === "post_bb" || a.type === "post_straddle").map((a) => a.street_total));
    const raises = pre.filter((a) => a.type === "raise" || a.type === "bet");
    const limps = raises.length ? 0 : pre.filter((a) => a.type === "call").length;
    const acted = new Set(pre.filter((a) => ["call", "raise", "bet", "check"].includes(a.type)).map((a) => a.player_id));
    const entries = opponentModels(s, stats);
    if (!entries.length) return null;
    // players still to act hold any two cards; their answer picks the part that continues
    const models: OpponentModel[] = entries.map((e) => acted.has(e.seat.id) ? e.model : { ...e.model, range: topRange(100), postflop_actions: [] });
    const seats = entries.map((e) => e.seat);
    const pot = s.pot;
    const hero_in = hero.street_contribution;
    const last = raises[raises.length - 1];
    const hu = s.seats.length === 2;
    const ip = seats.every((p) => hu ? hero.position === "SB" : postflopRank(hero.position) > postflopRank(p.position));
    const table = preflopResponseTable();

    /** One player's answer (fold, call, raise) to hero putting in `to` chips in total, by situation. */
    const answer = (i: number, raise_by_hero: boolean, to: number): { r: PreflopResponse, n: number } | null => {
        const p = seats[i];
        if (p.all_in) return null;
        const group: ResponderGroup = p.position === "SB" || p.position === "BB" ? "blinds" : "field";
        let situation: PreflopSituation;
        if (!raise_by_hero) {
            // hero calls (or completes): only players still to act can still raise
            if (acted.has(p.id)) return { r: { fold: 0, call: 1, raise: 0 }, n: 1e6 };
            situation = raises.length === 0 ? "open" : raises.length === 1 ? "squeeze" : "cold3bet";
        } else if (raises.length === 0) {
            situation = acted.has(p.id) ? "iso" : "open";
        } else if (raises.length === 1) {
            situation = p.id === last.player_id ? "threebet" : "cold3bet";
        } else {
            situation = p.id === last.player_id ? "fourbet" : "cold3bet";
        }
        const x = situation === "open" || situation === "squeeze" || situation === "iso"
            ? (raise_by_hero ? to : (last?.street_total ?? level)) / level - limps
            : to / Math.max(last?.street_total ?? level, 1e-9);
        const cell = table[situation][group][preflopSize(situation, x)];
        let { fold, raise } = cell;
        // this player's own tendencies, against your games' averages
        const prof = profile(p);
        if (prof) {
            if ((situation === "open" || situation === "squeeze") && !acted.has(p.id)) {
                const loose = clamp(prof.vpip / Math.max(PRIORS.vpip.mean, 0.05), PLAYER_FACTOR.lo, PLAYER_FACTOR.hi);
                fold = clamp(1 - (1 - fold) * loose, 0.02, 0.98);
                raise *= clamp(prof.three_bet / Math.max(PRIORS.three_bet.mean, 0.01), PLAYER_FACTOR.lo, PLAYER_FACTOR.hi);
            } else if (situation === "threebet") {
                fold = clamp(fold * clamp(prof.fold_to_three_bet / Math.max(PRIORS.fold_to_three_bet.mean, 0.05), PLAYER_FACTOR.lo, PLAYER_FACTOR.hi), 0.02, 0.98);
            }
        }
        raise = Math.min(raise, 1 - fold);
        return { r: { fold, raise, call: 1 - fold - raise }, n: cell.n };
    };

    interface Plan { to: number, invest: number, raise: boolean, folds: number[], raises: number[], adds: number[], fold_error: number }
    const plan = (to: number, raise_by_hero: boolean): Plan => {
        const folds: number[] = [], rs: number[] = [], adds: number[] = [], errs: number[] = [];
        seats.forEach((p, i) => {
            const a = answer(i, raise_by_hero, to);
            if (!a) { folds.push(0); rs.push(0); adds.push(0); errs.push(0); return; }
            folds.push(a.r.fold);
            rs.push(a.r.raise);
            adds.push(Math.max(0, Math.min(to - p.street_contribution, p.stack)));
            errs.push(Math.sqrt(a.r.fold * (1 - a.r.fold) / (a.n + PRIOR_CASES) + (MODEL_ERROR * a.r.fold) ** 2));
        });
        const pf = product(folds);
        const fold_error = pf * Math.sqrt(folds.reduce((sum, f, i) => sum + (f > 0 ? (errs[i] / f) ** 2 : 0), 0));
        return { to, invest: to - hero_in, raise: raise_by_hero, folds, raises: rs, adds, fold_error };
    };

    const plans: Plan[] = [];
    const call_to = s.current_bet;
    const can_call = v.to_call > 1e-9;
    plans.push(plan(Math.min(call_to, hero_in + hero.stack), false));    // call, or check when there is nothing to call
    const max_to = v.max_raise_to;
    const raise_sizes: number[] = [];
    if (v.min_raise_to !== null && raise_to_bb !== null) raise_sizes.push(Math.min(max_to, Math.max(v.min_raise_to, raise_to_bb * bb)));
    if (v.min_raise_to !== null && v.effective_stack / bb <= SHOVE_DEPTH_BB && !raise_sizes.includes(max_to)) raise_sizes.push(max_to);
    for (const to of raise_sizes) plans.push(plan(to, true));

    const main = continuationEquity({ hero: s.hero_cards, board: [], opponents: models, time_budget_ms, seed: 31 },
        plans.map((p) => ({ continue_fraction: p.folds.map((f) => 1 - f), raise_chance: p.raises, adds: p.adds })));
    const eq_now = equity({ hero: s.hero_cards, board: [], opponents: entries.map((e) => e.model), iterations: 4000, time_budget_ms: time_budget_ms / 3, seed: 37 }).equity;

    // equity against a re-raise: the top of a range as wide as the likeliest re-raiser's re-raising hands
    const eq_rr = new Map<Plan, number>();
    const equityVsReraise = (p: Plan) => eq_rr.get(p) ?? (() => {
        const i = p.raises.reduce((best, q, j) => (q > p.raises[best] ? j : best), 0);
        // the share of their range that re-raises: of any two cards for a player still to act, of their range so far otherwise
        const width = clamp((acted.has(seats[i].id) ? rangePercent(models[i].range) : 100) * p.raises[i], 1.5, 25);
        const e = equity({ hero: s.hero_cards, board: [], opponents: [{ range: topRange(width) }], iterations: 3000, time_budget_ms: time_budget_ms / 4, seed: 41 }).equity;
        eq_rr.set(p, e);
        return e;
    })();

    const options: PreflopEvOption[] = [];
    const fmt = (chips: number) => Math.round(chips / bb * 100) / 100;
    plans.forEach((p, k) => {
        const called = main.results[k];
        const pf = p.raise ? product(p.folds) : 0;
        const pr = Math.min(1 - product(p.raises.map((q) => 1 - q)), 1 - pf);
        const pot_called = pot + p.invest + called.added;
        const multiway = called.callers > 1.4 || (!p.raise && entries.length > 1);
        const spr_after = Math.max(0, v.effective_stack - p.to) / Math.max(pot_called, 1e-9);
        const all_in = p.to >= max_to - 1e-9;
        const R = all_in ? 1 : clamp(realization(config, cls, multiway, spr_after) * (ip ? IN_POSITION_BONUS : 1), 0.3, MAX_REALIZATION);
        // a call (or check) puts in chips against a bet already in the pot: always matched. A raise is matched only
        // when someone puts more in (else it comes back, as with an all-in player left alone)
        const called_ev = p.raise
            ? (called.equity * pot + called.equity_x_matched * p.invest + called.equity_x_added) * R - called.matched * p.invest
            : (called.equity * (pot + p.invest) + called.equity_x_added) * R - p.invest;
        let raised_ev = -p.invest;
        if (pr > 0 && !all_in) {
            // a raise of hero's raise is to about 3x it; a raise behind hero's limp or call is an isolation raise
            // (about the chart's size over the limps) or a squeeze (3.5x the raise plus one more per caller)
            const callers = pre.filter((a) => a.type === "call").length + 1;
            const rr_target = p.raise ? RERAISE_MULTIPLE * p.to
                : raises.length === 0 ? (config.sizing.isolate_base_bb + callers * config.sizing.isolate_per_limper_bb) * level
                : (last.street_total) * (3.5 + callers);
            const rr_to = Math.min(Math.max(rr_target, p.to * 2), v.effective_stack);
            const call_cost = rr_to - p.to;
            const final_pot = pot + p.invest + rr_to + call_cost;
            const r_rr = rr_to >= v.effective_stack - 1e-9 ? 1 : clamp(realization(config, cls, false, (v.effective_stack - rr_to) / final_pot), 0.3, 1.1);
            raised_ev = Math.max(-p.invest, equityVsReraise(p) * final_pot * r_rr - p.invest - call_cost);
        }
        const ev = pf * pot + (1 - pf - pr) * called_ev + pr * raised_ev;
        if (process.env.PREFLOP_EV_DEBUG) console.log(`  [ev] to ${fmt(p.to)} pf ${pf.toFixed(2)} pr ${pr.toFixed(2)} called_ev ${fmt(called_ev)} (eq ${called.equity.toFixed(2)} callers ${called.callers.toFixed(2)} added ${fmt(called.added)} R ${R.toFixed(2)}) raised_ev ${fmt(raised_ev)} pot ${fmt(pot)}`);
        // raises: how far the answers to them could be off; calls and checks: how far the realization share could be
        // (later streets, implied odds), which decides close calls
        const risk = p.raise ? RISK_Z * p.fold_error * Math.abs(pot - called_ev)
            : RISK_Z * REALIZATION_ERROR * called.equity * (pot + p.invest + called.added);
        const action: PreflopEvOption["action"] = !p.raise ? (can_call ? "call" : "check") : all_in ? "all-in" : "raise";
        options.push({
            action, size_bb: p.raise ? fmt(p.to) : 0, ev_bb: fmt(ev), risk_bb: fmt(risk),
            label: action === "call" ? `call ${fmt(v.to_call)} BB` : action === "check" ? "check" : action === "all-in" ? `all-in ${fmt(p.to)} BB` : `raise to ${fmt(p.to)} BB`,
            ...(p.raise ? { fold_chance: pf } : {}), raise_chance: pr, called_equity: called.equity
        });
    });
    if (can_call) options.unshift({ action: "fold", size_bb: 0, label: "fold", ev_bb: 0, risk_bb: 0 });
    return { options, equity: eq_now };
}

/** EV minus risk: what options are ranked by. */
export const robustPreflop = (o: PreflopEvOption) => o.ev_bb - o.risk_bb;
