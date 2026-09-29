// Candidate actions and rough EV estimates for post-flop decisions.
//
// Model (a deliberately simple one-street approximation; it ignores later betting rounds):
//   check / call : equity x pot x realization - cost
//   bet / raise  : P(everyone folds) x pot + P(called) x (equity when called x final pot - bet) x realization
// "equity when called" is measured against opponents' ranges narrowed by a call, so bluffs don't look
// better than they are. Fold probabilities come from opponent profiles (fold to c-bet, aggression) and
// grow with bet size. All the constants below are stated assumptions, not measured values.
import { HandState, HeroView } from "./hand-parser.ts";
import { equity, OpponentModel } from "./equity.ts";

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
    fold_to_raise: number
}

const BET_SIZES = [0.33, 0.66, 1.0];
const RAISE_MULTIPLIERS = [2.5, 3.5];
const REFERENCE_BET = 0.66;
const ALL_IN_SHARE = 0.6;

function realizationFor(street: string, in_position: boolean): number {
    if (street === "river") return 1;
    if (street === "turn") return in_position ? 1.0 : 0.9;
    return in_position ? 0.95 : 0.85;
}

/**
 * Hero acts last among the players still in the hand. Post-flop order is SB, BB, UTG ... BU;
 * heads-up the small blind is the button, so the big blind acts first.
 */
export function heroInPosition(s: HandState): boolean {
    const order = s.seats.length === 2 ? ["BB", "SB"] : ["SB", "BB", "UTG", "UTG+1", "MP", "LJ", "HJ", "CO", "BU"];
    const active = s.seats.filter((p) => !p.folded).sort((a, b) => order.indexOf(a.position) - order.indexOf(b.position));
    return active.length > 0 && active[active.length - 1].id === s.hero_id;
}

function foldProbability(opponents: OpponentTendency[], bet: number, pot: number, raise: boolean): number {
    const scale = Math.pow(Math.max(bet / Math.max(pot, 1e-9), 0.05) / REFERENCE_BET, 0.35);
    return opponents.reduce((all, o) => {
        const base = raise ? o.fold_to_raise : o.fold_to_bet;
        return all * Math.min(0.9, Math.max(0.03, base * scale));
    }, 1);
}

export function analyzePostflop(s: HandState, v: HeroView, opponents: OpponentTendency[], time_budget_ms = 120): PostflopAnalysis {
    const models = opponents.map((o) => o.model);
    const base = equity({ hero: s.hero_cards, board: s.board, opponents: models, time_budget_ms });
    // ranges that continue after a call on this board
    const called_models = models.map((m) => ({ ...m, postflop_actions: [...(m.postflop_actions ?? []), { board: s.board, action: "call" as const }] }));
    const called = equity({ hero: s.hero_cards, board: s.board, opponents: called_models, time_budget_ms });

    const in_position = heroInPosition(s);
    const R = realizationFor(s.street, in_position);
    const pot = v.pot;
    const hero_total = v.max_raise_to;
    const candidates: Candidate[] = [];
    const fold_probability = new Map<number, number>();
    const bb = s.big_blind;
    const fmt = (chips: number) => `${Math.round(chips / bb * 10) / 10} BB`;

    const aggressive = (to: number, raise: boolean): Candidate => {
        const all_in = to >= hero_total - 1e-9;
        const invest = to - (raise ? hero_street(s) : 0);
        const pf = foldProbability(opponents, invest, pot + (raise ? v.to_call : 0), raise);
        fold_probability.set(to, pf);
        // one caller, who adds the difference between hero's new total and their current bet
        const caller_adds = Math.max(0, Math.min(raise ? to - s.current_bet : to, v.effective_stack));
        const final_pot = pot + invest + caller_adds;
        const ev = pf * pot + (1 - pf) * (called.equity * final_pot * R - invest);
        const action = all_in ? "all-in" : raise ? "raise" : "bet";
        return { action, to, ev, label: `${action === "all-in" ? "all-in" : action === "raise" ? "raise to" : "bet"} ${fmt(to)}` };
    };

    if (v.to_call <= 1e-9) {
        candidates.push({ action: "check", to: 0, ev: base.equity * pot * R, label: "check" });
        if (v.min_raise_to !== null) {
            const sizes = new Set<number>();
            for (const f of BET_SIZES) {
                let to = Math.max(v.min_raise_to, pot * f);
                if (to >= hero_total * ALL_IN_SHARE) to = hero_total;
                sizes.add(Math.round(Math.min(to, hero_total) * 100) / 100);
            }
            for (const to of sizes) candidates.push(aggressive(to, false));
        }
    } else {
        candidates.push({ action: "fold", to: 0, ev: 0, label: "fold" });
        const call_cost = v.to_call;
        candidates.push({ action: "call", to: 0, ev: base.equity * (pot + call_cost) * R - call_cost, label: `call ${fmt(call_cost)}` });
        if (v.min_raise_to !== null) {
            const sizes = new Set<number>();
            // pot-sized raise: call, then raise the size of the pot after the call
            const pot_raise = s.current_bet + (pot + v.to_call);
            for (const target of [...RAISE_MULTIPLIERS.map((m) => s.current_bet * m), pot_raise]) {
                let to = Math.max(v.min_raise_to, target);
                if (to >= hero_total * ALL_IN_SHARE) to = hero_total;
                sizes.add(Math.round(Math.min(to, hero_total) * 100) / 100);
            }
            for (const to of sizes) candidates.push(aggressive(to, true));
        }
    }
    candidates.sort((a, b) => b.ev - a.ev);
    return {
        equity: base.equity,
        equity_when_called: called.equity,
        required_equity: v.to_call > 0 ? v.to_call / (pot + v.to_call) : 0,
        fold_probability,
        candidates,
        in_position,
        realization: R
    };
}

function hero_street(s: HandState): number {
    return s.seats.find((p) => p.id === s.hero_id)?.street_contribution ?? 0;
}

/** True when the best candidate is clearly ahead, so the engine can answer without the AI. */
export function isClearSpot(a: PostflopAnalysis, pot: number, big_blind: number): boolean {
    if (a.candidates.length < 2) return true;
    const gap = a.candidates[0].ev - a.candidates[1].ev;
    return gap >= Math.max(big_blind, 0.15 * pot);
}
