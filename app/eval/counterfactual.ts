// Real counterfactuals: your decisions facing a bet or raise, heads-up, where the opponent's cards
// became known later in the hand. Against those actual cards, calling is worth
//     share x (pot + call) - call          (chips, relative to folding, which is worth 0)
// where `share` is your share of the pot at showdown: on the actual board when all five cards were
// dealt, else your exact equity against their cards over every remaining board. Later betting is
// ignored (the call is valued as if the hand were checked down), which is exact when the call puts
// someone all-in and on the river. A raise is valued like a call (their response to it is unknown).
//
// Selection bias: an opponent's cards are known mostly when the hand went to showdown, which
// usually means you called. Spots where you folded are rarely in the sample, and the opponents who
// show are not a random draw of the hands they bet with. Read the totals as "on the spots we can
// check", not as a win rate.
import { code, evaluate } from "../engine/cards.ts";
import { exactEquity } from "../engine/allin-ev.ts";
import { Street } from "../engine/hand-parser.ts";
import { HeroHand, Kind } from "./replay.ts";
import { sumInterval, SumInterval } from "./stats.ts";

export interface CallValue {
    /** Your exact equity against their cards from the board at the decision. */
    equity: number,
    /** Your share of the pot on the actual final board (equity when the board wasn't run out). */
    share: number,
    /** Call minus fold, in chips: on the actual board when known, and by equity. */
    value: number,
    value_equity: number
}

/**
 * What calling `to_call` into `pot` (which already holds their bet) is worth against known cards,
 * relative to folding. `final_board` is the board the hand actually ended with.
 */
export function callValue(hero: string[], villain: string[], board: string[], final_board: string[], pot: number, to_call: number): CallValue {
    const eq = exactEquity(hero, villain, board);
    let share = eq;
    const runout_known = final_board.length === 5 && board.every((c, i) => final_board[i] === c);
    if (runout_known) {
        const h = evaluate([...hero, ...final_board].map(code));
        const v = evaluate([...villain, ...final_board].map(code));
        share = h < v ? 1 : h === v ? 0.5 : 0;
    }
    const final_pot = pot + to_call;
    return { equity: eq, share, value: share * final_pot - to_call, value_equity: eq * final_pot - to_call };
}

/** What a policy's choice is worth in a spot: folding 0, calling or raising the call value. */
export function policyValue(kind: Kind, call_value: number): number {
    return kind === "fold" ? 0 : call_value;
}

export interface CounterfactualSpot {
    game_id: string,
    hand_number: number,
    street: Street,
    hero_cards: string[],
    villain_cards: string[],
    board: string[],
    final_board: string[],
    /** In big blinds: the pot (with their bet, minus any part you couldn't cover) and your call. */
    pot_bb: number,
    to_call_bb: number,
    actual: Kind,
    engine: Kind,
    engine_label: string,
    equity: number,
    share: number,
    /** Call minus fold in big blinds, on the actual board and by equity. */
    call_bb: number,
    call_equity_bb: number
}

/** Decisions facing a bet or raise, heads-up, with the opponent's cards shown later in the hand. */
export function counterfactualSpots(hands: HeroHand[]): CounterfactualSpot[] {
    const spots: CounterfactualSpot[] = [];
    for (const h of hands) {
        for (const d of h.decisions) {
            if (!d.engine || !(d.view.to_call > 0)) continue;
            const s = d.state;
            // facing a real bet or raise: preflop only after someone raised (not completing a blind)
            const raised = s.actions.some((a) => a.street === s.street && (a.type === "bet" || a.type === "raise"));
            if (!raised) continue;
            if (d.view.active_opponents.length !== 1) continue;
            const villain = d.view.active_opponents[0];
            const shown = h.full.seats.find((p) => p.id === villain.id)?.shown_cards;
            if (!shown || shown.length !== 2) continue;
            const hero = s.seats.find((p) => p.id === s.hero_id)!;
            // part of their bet you can't cover would come back to them
            const excess = Math.max(0, villain.street_contribution - (hero.street_contribution + d.view.to_call));
            const pot = s.pot - excess;
            const cv = callValue(s.hero_cards, shown, s.board, h.full.board, pot, d.view.to_call);
            const bb = h.big_blind;
            spots.push({
                game_id: h.game_id, hand_number: h.hand_number, street: s.street,
                hero_cards: s.hero_cards, villain_cards: shown, board: s.board, final_board: h.full.board,
                pot_bb: pot / bb, to_call_bb: d.view.to_call / bb, actual: d.actual, engine: d.engine.kind, engine_label: d.engine.label,
                equity: cv.equity, share: cv.share, call_bb: cv.value / bb, call_equity_bb: cv.value_equity / bb
            });
        }
    }
    return spots;
}

export interface PolicyComparison {
    spots: number,
    /** Both fold, or both continue (call or raise). */
    agree: number,
    /** Engine continues where you folded, and the reverse, with what the engine's choice gained there (BB). */
    engine_continue_you_fold: { n: number, gain_bb: number },
    engine_fold_you_continue: { n: number, gain_bb: number },
    /** Spots where either side raised (valued as a call). */
    raises: number,
    /** Totals in BB: the engine's choices, yours, and engine minus you, with 95% intervals. */
    engine: SumInterval,
    you: SumInterval,
    difference: SumInterval
}

/** Compares the engine's and your choices over `spots`, valued on the actual board (`by: "board"`) or by equity. */
export function comparePolicies(spots: CounterfactualSpot[], by: "board" | "equity" = "board", seed = 7): PolicyComparison {
    const val = (s: CounterfactualSpot) => by === "board" ? s.call_bb : s.call_equity_bb;
    const engine = spots.map((s) => policyValue(s.engine, val(s)));
    const you = spots.map((s) => policyValue(s.actual, val(s)));
    const diff = engine.map((x, i) => x - you[i]);
    const cont = (k: Kind) => k !== "fold";
    const ec = { n: 0, gain_bb: 0 }, ef = { n: 0, gain_bb: 0 };
    let agree = 0;
    spots.forEach((s, i) => {
        if (cont(s.engine) === cont(s.actual)) agree++;
        else if (cont(s.engine)) { ec.n++; ec.gain_bb += diff[i]; }
        else { ef.n++; ef.gain_bb += diff[i]; }
    });
    return {
        spots: spots.length, agree, engine_continue_you_fold: ec, engine_fold_you_continue: ef,
        raises: spots.filter((s) => s.engine === "raise" || s.actual === "raise").length,
        engine: sumInterval(engine, 4000, seed), you: sumInterval(you, 4000, seed), difference: sumInterval(diff, 4000, seed)
    };
}
