import { HandState, SeatState } from "./hand-parser.ts";
import { OpponentModel, PostflopAction } from "./equity.ts";
import { PreflopLine, PreflopTendencies, preflopRange } from "./ranges.ts";

/** Population defaults for players with too few hands to judge (assumed loose home-game field). */
export const POPULATION_TENDENCIES: PreflopTendencies = { vpip: 35, pfr: 12 };
/** Hands observed before a player's own stats replace the population default. */
export const MIN_HANDS_FOR_STATS = 20;

export interface ObservedStats {
    /** Percent, 0-100. */
    vpip: number,
    /** Percent, 0-100. */
    pfr: number,
    hands: number,
    /** Post-flop aggression share, 0-1 (optional). */
    aggression?: number,
    /** True when vpip/pfr are already blended toward population averages, so they can be used at any sample size. */
    shrunk?: boolean
}

/** What a player did preflop, in terms the range estimate understands. */
export function preflopLine(s: HandState, player_id: string): PreflopLine {
    let raises = 0;
    let line: PreflopLine = "unknown";
    for (const a of s.actions) {
        if (a.street !== "preflop") break;
        if (a.player_id === player_id) {
            if (a.type === "raise" || a.type === "bet") line = raises === 0 ? "raise" : raises === 1 ? "3bet" : "4bet";
            else if (a.type === "call") line = raises === 0 ? "limp" : "call_raise";
            else if (a.type === "check") line = "check_bb";
        }
        if (a.type === "raise" || a.type === "bet") raises++;
    }
    return line;
}

/** The player's post-flop actions with the board at the time of each. */
export function postflopActions(s: HandState, player_id: string): { board: string[], action: PostflopAction }[] {
    const board_at = { flop: s.board.slice(0, 3), turn: s.board.slice(0, 4), river: s.board.slice(0, 5) };
    return s.actions
        .filter((a) => a.player_id === player_id && a.street !== "preflop" && ["bet", "raise", "call", "check"].includes(a.type))
        .map((a) => ({ board: board_at[a.street as "flop" | "turn" | "river"], action: a.type as PostflopAction }));
}

/** Range models for every opponent still in the hand. `stats` returns observed stats by player name. */
export function opponentModels(s: HandState, stats: (name: string) => ObservedStats | undefined): { seat: SeatState, model: OpponentModel, tendencies: PreflopTendencies }[] {
    return s.seats
        .filter((p) => p.id !== s.hero_id && !p.folded)
        .map((seat) => {
            const observed = stats(seat.name);
            const usable = observed && (observed.shrunk || observed.hands >= MIN_HANDS_FOR_STATS);
            const tendencies = usable ? { vpip: observed.vpip, pfr: observed.pfr } : POPULATION_TENDENCIES;
            return {
                seat,
                tendencies,
                model: {
                    range: preflopRange(preflopLine(s, seat.id), tendencies),
                    postflop_actions: postflopActions(s, seat.id),
                    aggression: observed?.aggression
                }
            };
        });
}
