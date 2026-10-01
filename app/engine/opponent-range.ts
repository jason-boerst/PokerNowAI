import { ActionRecord, HandState, positionLabels, SeatState } from "./hand-parser.ts";
import { OpponentModel, PostflopAction } from "./equity.ts";
import type { PlayerRef } from "./player-profile.ts";
import type { TellReading } from "./seven-deuce-tells.ts";
import { PreflopLine, PreflopTendencies, positionWidth, preflopRange, topRange } from "./ranges.ts";

/**
 * Population defaults for players with too few hands to judge (assumed loose home-game field).
 * Replaced by your own games' averages when profiles load (ProfileService).
 */
export const POPULATION_TENDENCIES: PreflopTendencies = { vpip: 35, pfr: 12 };
/** Hands observed before a player's own stats replace the population default. */
export const MIN_HANDS_FOR_STATS = 20;
/**
 * House rules that change what players raise with. Every one of your stored games paid a bounty
 * for winning a hand with 7-2, so it is on by default; set it to false for a game without one.
 */
export const TABLE_RULES = { seven_deuce_bounty: true };

/**
 * Reads 7-2 sizing tells for a seat in a hand (seven-deuce-tells.ts), set from your stored hands when they load;
 * null until then, or when no tell is significant in your games.
 */
let seven_deuce_tells: ((s: HandState, seat: SeatState) => TellReading) | null = null;
export function setSevenDeuceTells(reader: ((s: HandState, seat: SeatState) => TellReading) | null): void {
    seven_deuce_tells = reader;
}
/** What the 7-2 sizing tells say about this seat in this hand (null: no tells, or no bounty). */
export function sevenDeuceTell(s: HandState, seat: SeatState): TellReading | null {
    return TABLE_RULES.seven_deuce_bounty && seven_deuce_tells ? seven_deuce_tells(s, seat) : null;
}
/**
 * Each player's own flop and turn bluff scale relative to the pool (bluff-calibration.ts fitPlayerBluffScales), set
 * from your stored hands when they load and only when it predicts held-out games better than the pool; null otherwise.
 */
let bluff_scales: ((seat: SeatState) => PlayerBluffReading | undefined) | null = null;
export interface PlayerBluffReading { scale: number, note: string }
export function setPlayerBluffScales(reader: ((seat: SeatState) => PlayerBluffReading | undefined) | null): void {
    bluff_scales = reader;
}
/** This player's own bluff scale and a line for their card (undefined: like the pool, or the scales are off). */
export function playerBluff(seat: SeatState): PlayerBluffReading | undefined {
    const b = bluff_scales?.(seat);
    return b && b.scale !== 1 ? b : undefined;
}
/** Most weight 7-2 can get in a range after a tell (range weights are a share of the class's combos). */
const MAX_TELL_WEIGHT = 4;

export interface ObservedStats {
    /** Percent, 0-100. */
    vpip: number,
    /** Percent, 0-100. */
    pfr: number,
    hands: number,
    /** Post-flop aggression share, 0-1 (optional). */
    aggression?: number,
    /** Preflop 3-bet frequency, percent 0-100 (optional). */
    three_bet?: number,
    /** True when vpip/pfr are already blended toward population averages, so they can be used at any sample size. */
    shrunk?: boolean
}

/**
 * What a player did preflop, in terms the range estimate understands. Forced posts (blinds,
 * straddles, dead blinds, antes, bomb pot bets) are not actions: calling the big blind or a
 * straddle is a limp, and a big blind or straddler who checks is "check_bb". A player who posted
 * a missed big blind can check before the action is over; that counts as a limp if they act again.
 */
export function preflopLine(s: HandState, player_id: string): PreflopLine {
    let raises = 0;
    // limped, or checked a posted blind: in only for the big blind so far
    let limped = false;
    let line: PreflopLine = "unknown";
    for (const a of s.actions) {
        if (a.street !== "preflop") break;
        const raise = a.type === "raise" || a.type === "bet";
        if (a.player_id === player_id) {
            if (raise) {
                line = limped ? "limp_raise" : raises === 0 ? "raise" : raises === 1 ? "3bet" : "4bet";
            } else if (a.type === "call") {
                if (raises === 0) {
                    line = "limp";
                    limped = true;
                } else if (line === "raise") {
                    line = "call_3bet";
                } else if (line === "unknown") {
                    line = raises === 1 ? "call_raise" : "cold_call_3bet";
                } else if (line === "limp" || line === "check_bb") {
                    // like a cold call, with a limp (or a posted blind) already in
                    line = raises === 1 ? "call_raise" : "cold_call_3bet";
                }
                // a re-raiser or a caller calling a further raise keeps their line
            } else if (a.type === "check") {
                line = "check_bb";
                limped = true;
            }
        }
        if (raise) raises++;
    }
    return line;
}

/**
 * 1.2 against a likely steal (an open from the cutoff, button or small blind), 0.8 against an open
 * from 4 or more seats before the button (UTG to MP at a full table), else 1. Counted from the
 * button so it also works at short tables, where the "UTG" seat can be the cutoff.
 */
function openerFactor(position: string, players: number): number {
    if (position === "SB") return 1.2;
    const labels = positionLabels(players);
    const i = labels.indexOf(position);
    if (i < 2) return 1;   // big blind, or a seat we can't place
    const from_button = labels.length - 1 - i;
    return from_button <= 1 ? 1.2 : from_button >= 4 ? 0.8 : 1;
}

/**
 * How much wider (above 1) or tighter (below 1) than their usual 3-bet range a player's 3-bet is
 * likely to be, from whose raise they re-raised and how big. 1 unless the player made the hand's
 * first re-raise. Assumptions for loose home games, not measured values: 3-bets against a
 * late-position open (often a steal) are wider and against an early-position open tighter, a
 * short-stack all-in (25 BB or less) is wider, and an unusually big 3-bet (5 times the open or
 * more, plus one open per caller in between) leans toward big hands.
 */
export function reraiseFactor(s: HandState, player_id: string): number {
    let open: ActionRecord | undefined;
    let callers = 0;
    for (const a of s.actions) {
        if (a.street !== "preflop") break;
        if (a.type !== "raise" && a.type !== "bet") {
            if (open && a.type === "call") callers++;
            continue;
        }
        if (!open) {
            open = a;
            continue;
        }
        if (a.player_id !== player_id) return 1;
        const opener_id = open.player_id;
        let f = openerFactor(s.seats.find((p) => p.id === opener_id)?.position ?? "", s.seats.length);
        if (a.all_in && a.street_total <= 25 * (s.big_blind || 1)) f *= 1.25;
        else if (a.street_total >= open.street_total * (5 + callers)) f *= 0.85;
        return Math.max(0.7, Math.min(1.4, f));
    }
    return 1;
}

/**
 * How much wider than their usual 4-bet range a player's 4-bet (or 5-bet) is: wider when it is all-in.
 * Measured on the stored hands: all-in 4-bets and 5-bets are always shown when called, and whether they
 * get called doesn't depend on the raiser's cards, so the 55 shown ones (stacks over 30 BB) are a fair
 * sample. They looked like the top 8 to 9% of hands (half were in the top 4.4%, three quarters in the top
 * 6.2%, with hands like AJo, JTo, 97s and 55 among them), while the usual 4-bet estimate is about 3.6% for
 * your games' 9% 3-bets. 1 for anyone who didn't make the hand's last re-raise all-in.
 */
export const ALL_IN_FOUR_BET_WIDTH = 2;
export function fourBetFactor(s: HandState, player_id: string): number {
    const raises = s.actions.filter((a) => a.street === "preflop" && (a.type === "raise" || a.type === "bet"));
    const last = raises[raises.length - 1];
    return raises.length >= 3 && last.player_id === player_id && last.all_in ? ALL_IN_FOUR_BET_WIDTH : 1;
}

/** The player's post-flop actions with the board at the time of each. */
export function postflopActions(s: HandState, player_id: string): { board: string[], action: PostflopAction }[] {
    const board_at = { flop: s.board.slice(0, 3), turn: s.board.slice(0, 4), river: s.board.slice(0, 5) };
    return s.actions
        .filter((a) => a.player_id === player_id && a.street !== "preflop" && ["bet", "raise", "call", "check"].includes(a.type))
        .map((a) => ({ board: board_at[a.street as "flop" | "turn" | "river"], action: a.type as PostflopAction }));
}

/** Range models for every opponent still in the hand. `stats` returns observed stats by player name. */
export function opponentModels(s: HandState, stats: (player: PlayerRef) => ObservedStats | undefined): { seat: SeatState, model: OpponentModel, tendencies: PreflopTendencies }[] {
    return s.seats
        .filter((p) => p.id !== s.hero_id && !p.folded)
        .map((seat) => ({ seat, ...seatModel(s, seat, stats) }));
}

/**
 * The range model for one seat: their likely hands from their stats and what they did this hand. For hero's
 * own seat this is hero's range as the other players can estimate it (used to balance hero's play).
 */
export function seatModel(s: HandState, seat: SeatState, stats: (player: PlayerRef) => ObservedStats | undefined): { model: OpponentModel, tendencies: PreflopTendencies } {
    const observed = stats(seat);
    const usable = observed && (observed.shrunk || observed.hands >= MIN_HANDS_FOR_STATS);
    // preflopRange checks three_bet and falls back to PFR when it's missing or unusable
    const tendencies: PreflopTendencies = usable ? { vpip: observed.vpip, pfr: observed.pfr, three_bet: observed.three_bet } : POPULATION_TENDENCIES;
    const line = preflopLine(s, seat.id);
    // a bomb pot has no preflop decisions: everyone is in with any two cards
    let range = s.bomb_pot ? topRange(100)
        : preflopRange(line, tendencies, positionWidth(seat.position, s.seats.length), {
            reraise: line === "3bet" ? reraiseFactor(s, seat.id) : line === "4bet" ? fourBetFactor(s, seat.id) : 1,
            seven_deuce_bounty: TABLE_RULES.seven_deuce_bounty
        });
    // a sizing tell measured in your games moves the odds of 7-2 in their range (only if 7-2 is in it at all)
    const tell = s.bomb_pot ? null : sevenDeuceTell(s, seat);
    if (tell && tell.lr !== 1 && (range.has("72o") || range.has("72s"))) {
        range = new Map(range);
        for (const cls of ["72o", "72s"]) {
            const w = range.get(cls);
            if (w) range.set(cls, Math.min(MAX_TELL_WEIGHT, w * tell.lr));
        }
    }
    return {
        tendencies,
        model: {
            range,
            postflop_actions: postflopActions(s, seat.id),
            aggression: observed?.aggression,
            bounty_72: TABLE_RULES.seven_deuce_bounty,
            ...(playerBluff(seat) ? { bluff_scale: playerBluff(seat)!.scale } : {})
        }
    };
}
