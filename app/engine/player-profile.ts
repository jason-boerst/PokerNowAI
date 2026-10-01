import { ActionRecord, HandState, netResult, POST_TYPES, SeatState } from "./hand-parser.ts";
import { classOf } from "./hand-classes.ts";

/** Identifies a player at the table: PokerNow's player id (stable across names) and display name. */
export interface PlayerRef {
    id: string,
    name: string
}

/** A rate with its evidence: `k` times out of `n` chances, blended toward a prior for small samples. */
export interface Rate {
    k: number,
    n: number,
    /** Shrunk estimate, 0-1. */
    value: number
}

export interface Showdown {
    hand_number: number | null,
    cards: string[],
    hand_class: string,
    board: string[],
    /** Their actions by street, e.g. "preflop: call | flop: call | turn: check | river: check". */
    line: string,
    won: boolean,
    at?: string
}

export type PlayerType = "unknown" | "calling station" | "maniac" | "nit" | "loose-passive" | "LAG" | "TAG" | "regular";
export type PositionGroup = "early" | "middle" | "late" | "blinds";

export const RATE_KEYS = [
    "vpip", "pfr", "limp", "three_bet", "fold_to_three_bet", "steal", "fold_to_steal",
    "cbet", "fold_to_cbet", "aggression", "went_to_showdown", "won_at_showdown",
    "fold_to_bet_flop", "fold_to_bet_turn", "fold_to_bet_river", "raise_vs_bet", "bet_when_checked_to",
    "fold_to_small_bet", "fold_to_big_bet"
] as const;
export type RateKey = typeof RATE_KEYS[number];

export interface PlayerProfile extends Record<RateKey, Rate> {
    /** Identity key (a person id: one or more linked PokerNow ids). */
    key: string,
    /** Most recently used display name, and every name seen. */
    name: string,
    names: string[],
    /** Hold'em hands used for the tendency stats (bomb pots and other games excluded). */
    hands: number,
    /** Total chips won or lost across all hands, in big blinds, and the win rate. */
    net_bb: number,
    bb_per_100: number,
    /** Hands the result counts (the win rate's denominator). */
    result_hands?: number,
    avg_bet_to_pot: number,
    bets_seen: number,
    vpip_by_position: Record<PositionGroup, Rate>,
    showdowns: Showdown[],
    last_seen: string,
    type: PlayerType,
    exploit: string
}

/**
 * Population priors: assumed averages for a loose home-game field, and how many chances of evidence
 * they count as. A player's stat moves from the prior to their own numbers as their sample grows.
 */
export const PRIORS: Record<RateKey, { mean: number, weight: number }> = {
    vpip: { mean: 0.35, weight: 15 },
    pfr: { mean: 0.12, weight: 15 },
    limp: { mean: 0.20, weight: 15 },
    three_bet: { mean: 0.05, weight: 20 },
    fold_to_three_bet: { mean: 0.45, weight: 10 },
    steal: { mean: 0.30, weight: 10 },
    fold_to_steal: { mean: 0.55, weight: 10 },
    cbet: { mean: 0.55, weight: 10 },
    fold_to_cbet: { mean: 0.40, weight: 10 },
    aggression: { mean: 0.35, weight: 15 },
    went_to_showdown: { mean: 0.32, weight: 10 },
    won_at_showdown: { mean: 0.50, weight: 10 },
    // folding to the first bet of each street heads-up (players give up more often on the river),
    // raising when facing a bet, and betting when everyone before them checked
    fold_to_bet_flop: { mean: 0.40, weight: 10 },
    fold_to_bet_turn: { mean: 0.40, weight: 10 },
    fold_to_bet_river: { mean: 0.50, weight: 10 },
    raise_vs_bet: { mean: 0.10, weight: 15 },
    bet_when_checked_to: { mean: 0.40, weight: 10 },
    // folding to the first bet of a street heads-up by its size (any street): up to 40% of the pot, and over 80%.
    // Measured on 2,569 heads-up bets in the games this was built from: about 33% and 60%
    fold_to_small_bet: { mean: 0.33, weight: 10 },
    fold_to_big_bet: { mean: 0.60, weight: 10 }
};

const DEFAULT_PRIORS: Record<RateKey, { mean: number, weight: number }> = structuredClone(PRIORS);

/**
 * How many chances the built-in guesses above count as when averaged with your own games. With a
 * few thousand hands stored, the averages of the players you actually play against take over.
 */
export const POOL_PRIOR_WEIGHT = 200;

/**
 * Replaces the built-in population guesses with the average of the players in your games (pooled
 * over every opponent's chances, blended with the built-in guess for small databases). Players
 * with little or no history are then assumed to play like your pool, not like a generic table.
 */
export function calibratePriors(pool: Record<RateKey, { k: number, n: number }>): void {
    for (const key of RATE_KEYS) {
        const d = DEFAULT_PRIORS[key].mean;
        PRIORS[key].mean = (pool[key].k + d * POOL_PRIOR_WEIGHT) / (pool[key].n + POOL_PRIOR_WEIGHT);
    }
}

/** Back to the built-in guesses (tests). */
export function resetPriors(): void {
    for (const key of RATE_KEYS) PRIORS[key].mean = DEFAULT_PRIORS[key].mean;
}

/** Hands before a player is given a type other than "unknown". */
export const MIN_HANDS_FOR_TYPE = 20;

export type Counter = { k: number, n: number };
interface Accumulator {
    key: string,
    names: Map<string, string>,   // name -> last seen
    last_name: string,
    hands: number,
    /** Counts as used for the player's stats (recency weighted when a weight is given), and unweighted. */
    c: Record<RateKey, Counter>,
    raw: Record<RateKey, Counter>,
    by_position: Record<PositionGroup, Counter>,
    net_bb: number,
    result_hands: number,
    bet_to_pot_sum: number,
    bets_seen: number,
    showdowns: Showdown[],
    last_seen: string
}

export function newCounters(): Record<RateKey, Counter> {
    const c = {} as Record<RateKey, Counter>;
    for (const k of RATE_KEYS) c[k] = { k: 0, n: 0 };
    return c;
}
const POSITION_GROUPS: PositionGroup[] = ["early", "middle", "late", "blinds"];
function newPositionCounters(): Record<PositionGroup, Counter> {
    return { early: { k: 0, n: 0 }, middle: { k: 0, n: 0 }, late: { k: 0, n: 0 }, blinds: { k: 0, n: 0 } };
}

function newAccumulator(key: string): Accumulator {
    return {
        key, names: new Map(), last_name: "", hands: 0, c: newCounters(), raw: newCounters(),
        by_position: newPositionCounters(),
        net_bb: 0, result_hands: 0, bet_to_pot_sum: 0, bets_seen: 0, showdowns: [], last_seen: ""
    };
}

const MAX_SHOWDOWNS = 20;
const GROUP: Record<string, PositionGroup> = {
    "UTG": "early", "UTG+1": "early", "UTG+2": "early", "MP": "early",
    "LJ": "middle", "HJ": "middle", "CO": "late", "BU": "late", "SB": "blinds", "BB": "blinds"
};

export function isHoldem(s: HandState): boolean {
    return s.game_type === "" || /hold'?em/i.test(s.game_type);
}

/** Builds profiles for every player seen in a set of completed hands. */
export class ProfileBuilder {
    private players = new Map<string, Accumulator>();

    /** @param keyOf maps a seat to its identity key (default: the PokerNow player id). */
    constructor(private keyOf: (seat: SeatState) => string = (seat) => seat.id) {}

    /**
     * @param weightOf how much this hand counts toward each player's stats (by identity key; default 1). Recency
     * weighting gives older games less; the raw counts behind the pool's averages always count 1.
     */
    addHand(s: HandState, at: string = "", weightOf?: (key: string) => number): void {
        const holdem_stats = isHoldem(s) && !s.bomb_pot;
        const pre = s.actions.filter((a) => a.street === "preflop");
        const voluntary_all = pre.filter((a) => !POST_TYPES.has(a.type) && a.type !== "fold" && a.type !== "check");
        const raises = pre.filter((a) => a.type === "raise" || a.type === "bet");
        const opener = raises[0]?.player_id;
        const three_bettor = raises[1]?.player_id;
        const last_pf_raiser = raises[raises.length - 1]?.player_id;
        const flop_actions = s.actions.filter((a) => a.street === "flop");
        const streets = holdem_stats ? streetContexts(s) : [];
        const saw_flop = new Set(flop_actions.map((a) => a.player_id));
        const unfolded_at_end = s.seats.filter((p) => !p.folded);
        const showdown = unfolded_at_end.length >= 2 && s.board.length === 5;
        const big_blind = s.big_blind || 1;
        // a steal: the first voluntary action is a raise from CO, BU or SB
        const first_voluntary = voluntary_all[0];
        const steal_raise = first_voluntary && first_voluntary.type === "raise" &&
            ["CO", "BU", "SB"].includes(s.seats.find((p) => p.id === first_voluntary.player_id)?.position ?? "") ? first_voluntary : null;

        for (const seat of s.seats) {
            const key = this.keyOf(seat);
            const acc = this.players.get(key) ?? newAccumulator(key);
            this.players.set(key, acc);
            if (at >= acc.last_seen) { acc.last_seen = at; acc.last_name = seat.name; }
            if (!acc.last_name) acc.last_name = seat.name;
            acc.names.set(seat.name, at);

            // results count for every hand (bomb pots and other games included)
            acc.net_bb += netResult(s, seat.id) / big_blind;
            acc.result_hands++;
            if (!holdem_stats) continue;

            acc.hands++;
            // this hand's counts, added to the player's totals with the hand's weight (recency) and unweighted
            const c = newCounters();
            const bp = newPositionCounters();
            const mine = pre.filter((a) => a.player_id === seat.id);
            const voluntary = mine.filter((a) => a.type === "call" || a.type === "raise" || a.type === "bet");
            const index = (a: { player_id: string }) => s.actions.indexOf(a as never);

            // VPIP / PFR over all hands dealt, VPIP by position group
            c.vpip.n++;
            c.pfr.n++;
            const group = GROUP[seat.position];
            if (group) bp[group].n++;
            if (voluntary.length > 0) {
                c.vpip.k++;
                if (group) bp[group].k++;
            }
            if (mine.some((a) => a.type === "raise" || a.type === "bet")) c.pfr.k++;

            // limp: first voluntary action was a call with no raise before it
            const first_vol = voluntary[0];
            if (first_vol) {
                const raises_before = raises.filter((r) => index(r) < index(first_vol)).length;
                if (raises_before === 0) {
                    c.limp.n++;
                    if (first_vol.type === "call") c.limp.k++;
                }
            }

            // 3-bet: had a chance when facing exactly one raise
            const first_action = mine.find((a) => !POST_TYPES.has(a.type));
            if (first_action && opener && opener !== seat.id) {
                const raises_before = raises.filter((r) => index(r) < index(first_action)).length;
                if (raises_before === 1) {
                    c.three_bet.n++;
                    if (first_action.type === "raise") c.three_bet.k++;
                }
            }

            // fold to 3-bet: opened, then faced a 3-bet
            if (opener === seat.id && three_bettor && three_bettor !== seat.id) {
                const response = mine.find((a) => index(a) > index(raises[1]));
                if (response) {
                    c.fold_to_three_bet.n++;
                    if (response.type === "fold") c.fold_to_three_bet.k++;
                }
            }

            // steal: in CO/BU/SB with everyone before them folded
            if (["CO", "BU", "SB"].includes(seat.position) && first_action) {
                const voluntary_before = voluntary_all.filter((a) => index(a) < index(first_action)).length;
                if (voluntary_before === 0) {
                    c.steal.n++;
                    if (first_action.type === "raise") c.steal.k++;
                }
            }

            // fold to steal: in the blinds facing a steal raise and nothing else yet
            if ((seat.position === "SB" || seat.position === "BB") && steal_raise && steal_raise.player_id !== seat.id) {
                const response = mine.find((a) => index(a) > index(steal_raise));
                const others_between = voluntary_all.filter((a) => index(a) > index(steal_raise) && response && index(a) < index(response)).length;
                if (response && others_between === 0) {
                    c.fold_to_steal.n++;
                    if (response.type === "fold") c.fold_to_steal.k++;
                }
            }

            // c-bet: last preflop raiser, first to have a chance to bet on the flop
            if (last_pf_raiser === seat.id && saw_flop.has(seat.id)) {
                const my_first = flop_actions.find((a) => a.player_id === seat.id);
                const bet_before = my_first && flop_actions.some((a) => (a.type === "bet" || a.type === "raise") && flop_actions.indexOf(a) < flop_actions.indexOf(my_first));
                if (my_first && !bet_before) {
                    c.cbet.n++;
                    if (my_first.type === "bet") c.cbet.k++;
                }
            }

            // fold to c-bet: faced the preflop raiser's first flop bet
            const cbet = flop_actions.find((a) => a.type === "bet" && a.player_id === last_pf_raiser);
            if (cbet && seat.id !== last_pf_raiser) {
                const response = flop_actions.find((a) => a.player_id === seat.id && flop_actions.indexOf(a) > flop_actions.indexOf(cbet));
                if (response) {
                    c.fold_to_cbet.n++;
                    if (response.type === "fold") c.fold_to_cbet.k++;
                }
            }

            // post-flop aggression and bet sizing
            for (const a of s.actions) {
                if (a.player_id !== seat.id || a.street === "preflop") continue;
                if (a.type === "bet" || a.type === "raise") {
                    c.aggression.n++;
                    c.aggression.k++;
                    if (a.pot_before > 0) {
                        acc.bet_to_pot_sum += a.amount / a.pot_before;
                        acc.bets_seen++;
                    }
                } else if (a.type === "call" || a.type === "fold") {
                    c.aggression.n++;
                }
            }
            for (const street of streets) countStreet(street, seat.id, c);

            // showdown
            if (saw_flop.has(seat.id)) {
                c.went_to_showdown.n++;
                if (showdown && !seat.folded) {
                    c.went_to_showdown.k++;
                    c.won_at_showdown.n++;
                    if (seat.collected > 0) c.won_at_showdown.k++;
                }
            }
            if (seat.shown_cards && seat.shown_cards.length === 2) {
                acc.showdowns.unshift({
                    hand_number: s.hand_number,
                    cards: seat.shown_cards,
                    hand_class: classOf(seat.shown_cards),
                    board: s.board,
                    line: describeLine(s, seat.id),
                    won: seat.collected > 0,
                    at
                });
                acc.showdowns.length = Math.min(acc.showdowns.length, MAX_SHOWDOWNS);
            }
            const w = weightOf ? weightOf(key) : 1;
            for (const stat of RATE_KEYS) {
                acc.c[stat].k += w * c[stat].k;
                acc.c[stat].n += w * c[stat].n;
                acc.raw[stat].k += c[stat].k;
                acc.raw[stat].n += c[stat].n;
            }
            for (const g of POSITION_GROUPS) {
                acc.by_position[g].k += w * bp[g].k;
                acc.by_position[g].n += w * bp[g].n;
            }
        }
    }

    profile(key: string): PlayerProfile | undefined {
        const acc = this.players.get(key);
        return acc ? finalize(acc) : undefined;
    }

    keys(): string[] {
        return [...this.players.keys()];
    }

    /** Raw counts summed over every player except `exclude` (the pool's averages). */
    poolCounts(exclude: (key: string) => boolean = () => false): Record<RateKey, Counter> {
        const pool = {} as Record<RateKey, Counter>;
        for (const key of RATE_KEYS) pool[key] = { k: 0, n: 0 };
        for (const [key, acc] of this.players) {
            if (exclude(key)) continue;
            for (const stat of RATE_KEYS) {
                pool[stat].k += acc.raw[stat].k;
                pool[stat].n += acc.raw[stat].n;
            }
        }
        return pool;
    }

    /** Each player's unweighted counts (identity key -> stat -> {k, n}). */
    rawCounts(): Map<string, Record<RateKey, Counter>> {
        return new Map([...this.players].map(([key, acc]) => [key, acc.raw]));
    }

    all(): PlayerProfile[] {
        return [...this.players.values()].map(finalize);
    }
}

const POSTFLOP_STREETS = ["flop", "turn", "river"] as const;
const isAggressive = (a: ActionRecord) => a.type === "bet" || a.type === "raise";

/** One post-flop street of a hand, as the per-street stats need it. */
interface StreetContext {
    street: typeof POSTFLOP_STREETS[number],
    /** Everyone's actions on the street, in order. */
    acts: ActionRecord[],
    /** Index in `acts` of the street's first bet or raise, and of its first check (-1: none). */
    first_bet: number,
    first_check: number,
    /** Only two players were left in the hand (all-in players count) when the first bet was made. */
    heads_up: boolean,
    /**
     * Per action: the player could have bet or raised (chips beyond the call, someone with chips to
     * play against, and betting reopened since they last acted: an all-in for less than a full raise
     * doesn't reopen it).
     */
    could_raise: boolean[]
}

function streetContexts(s: HandState): StreetContext[] {
    // seats missing from "Player stacks" have an unknown stack: the parser treats it as unlimited
    const stack = new Map(s.seats.map((p) => [p.id, p.seat === 99 ? Infinity : p.stack_start]));
    const folded = new Set<string>();
    const all_in = new Set<string>();
    const out: StreetContext[] = [];
    let ctx = null as StreetContext | null;
    let last_raise_size = 0, last_full_raise = -1;
    // when each player last put chips in on this street (a check doesn't close their betting)
    let last_acted = new Map<string, number>();
    for (const a of s.actions) {
        if (a.street !== "preflop" && !POST_TYPES.has(a.type)) {
            if (ctx?.street !== a.street) {
                out.push(ctx = { street: a.street, acts: [], first_bet: -1, first_check: -1, heads_up: false, could_raise: [] });
                last_raise_size = s.big_blind;
                last_full_raise = -1;
                last_acted = new Map();
            }
            const i = ctx.acts.length;
            const to_call = a.bet_to_call_before - (a.street_total - a.amount);
            const others_with_chips = s.seats.some((p) => p.id !== a.player_id && !folded.has(p.id) && !all_in.has(p.id));
            const acted = last_acted.get(a.player_id);
            const reopened = acted === undefined || last_full_raise > acted;
            ctx.could_raise.push((stack.get(a.player_id) ?? 0) > to_call + 1e-9 && others_with_chips && reopened);
            if (isAggressive(a)) {
                if (ctx.first_bet < 0) {
                    ctx.first_bet = i;
                    ctx.heads_up = s.seats.filter((p) => !folded.has(p.id)).length === 2;
                }
                const increment = a.street_total - a.bet_to_call_before;
                if (increment >= last_raise_size - 1e-9) {
                    last_raise_size = increment;
                    last_full_raise = i;
                }
            }
            if (a.type === "check" && ctx.first_check < 0) ctx.first_check = i;
            if (a.type !== "check") last_acted.set(a.player_id, i);
            ctx.acts.push(a);
        }
        stack.set(a.player_id, (stack.get(a.player_id) ?? 0) - a.amount);
        if (a.type === "fold") folded.add(a.player_id);
        if (a.all_in) all_in.add(a.player_id);
    }
    return out;
}

/** Bet sizes (share of the pot) for fold_to_small_bet (up to SMALL_BET) and fold_to_big_bet (over BIG_BET). */
export const SMALL_BET = 0.4;
export const BIG_BET = 0.8;

/**
 * One player's counts on one post-flop street:
 * - fold to bet: their response to the street's first bet, made by someone else, heads-up (only
 *   the two of them left in the hand). Multiway, players fold far more often (in the games
 *   measured, 62% vs 42% on the flop); the engine multiplies each opponent's fold chance, so
 *   heads-up rates are right heads-up and on the safe side multiway.
 * - raise vs bet: every action taken facing a bet (more than they have put in on the street),
 *   when raising was possible
 * - bet when checked to: acting with no bet yet on the street after at least one player checked
 */
function countStreet(st: StreetContext, player_id: string, c: Record<RateKey, Counter>): void {
    const { acts, first_bet } = st;
    const fold_to_bet = c[`fold_to_bet_${st.street}`];
    let faced_bet = false;
    for (let i = 0; i < acts.length; i++) {
        const a = acts[i];
        if (a.player_id !== player_id) continue;
        if (a.bet_to_call_before > a.street_total - a.amount) {
            if (st.could_raise[i]) {
                c.raise_vs_bet.n++;
                if (a.type === "raise") c.raise_vs_bet.k++;
            }
            // heads-up, nobody else can raise the first bet before this player responds to it
            if (!faced_bet && st.heads_up && acts[first_bet].player_id !== player_id) {
                fold_to_bet.n++;
                if (a.type === "fold") fold_to_bet.k++;
                // and by the bet's size
                const bet = acts[first_bet];
                const share = bet.amount / Math.max(bet.pot_before, 1e-9);
                const by_size = share <= SMALL_BET ? c.fold_to_small_bet : share > BIG_BET ? c.fold_to_big_bet : null;
                if (by_size) {
                    by_size.n++;
                    if (a.type === "fold") by_size.k++;
                }
            }
            faced_bet = true;
        } else if ((first_bet < 0 || i <= first_bet) && st.first_check >= 0 && st.first_check < i && st.could_raise[i]) {
            c.bet_when_checked_to.n++;
            if (isAggressive(a)) c.bet_when_checked_to.k++;
        }
    }
}

function describeLine(s: HandState, player_id: string): string {
    const parts: string[] = [];
    for (const street of ["preflop", "flop", "turn", "river"] as const) {
        const acts = s.actions.filter((a) => a.street === street && a.player_id === player_id && !POST_TYPES.has(a.type));
        if (acts.length) parts.push(`${street}: ${acts.map((a) => a.type).join("/")}`);
    }
    return parts.join(" | ");
}

function shrink(c: Counter, prior: { mean: number, weight: number }): Rate {
    return { k: c.k, n: c.n, value: (c.k + prior.mean * prior.weight) / (c.n + prior.weight) };
}

function finalize(acc: Accumulator): PlayerProfile {
    const r = {} as Record<RateKey, Rate>;
    for (const key of RATE_KEYS) r[key] = shrink(acc.c[key], PRIORS[key]);
    const by_position = {} as Record<PositionGroup, Rate>;
    for (const g of ["early", "middle", "late", "blinds"] as PositionGroup[]) by_position[g] = shrink(acc.by_position[g], PRIORS.vpip);
    const profile: PlayerProfile = {
        key: acc.key,
        name: acc.last_name,
        names: [...acc.names.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([n]) => n),
        hands: acc.hands,
        ...r,
        net_bb: acc.net_bb,
        bb_per_100: acc.result_hands ? acc.net_bb / acc.result_hands * 100 : 0,
        result_hands: acc.result_hands,
        avg_bet_to_pot: acc.bets_seen ? acc.bet_to_pot_sum / acc.bets_seen : 0,
        bets_seen: acc.bets_seen,
        vpip_by_position: by_position,
        showdowns: acc.showdowns,
        last_seen: acc.last_seen,
        type: "unknown",
        exploit: ""
    };
    [profile.type, profile.exploit] = classify(profile);
    return profile;
}

/** Player type from shrunk stats, with the main exploit against it. */
export function classify(p: PlayerProfile): [PlayerType, string] {
    if (p.hands < MIN_HANDS_FOR_TYPE) {
        return ["unknown", `Only ${p.hands} hand(s) seen; assume a typical loose home player.`];
    }
    const vpip = p.vpip.value, pfr = p.pfr.value, agg = p.aggression.value;
    const passive = pfr / Math.max(vpip, 1e-9) < 0.35;
    if (vpip >= 0.40 && pfr >= 0.20 && agg >= 0.45) {
        return ["maniac", "Bets and raises a lot with weak hands: call down lighter, let them bluff, trap with strong hands."];
    }
    if (vpip >= 0.40 && passive && (p.fold_to_cbet.value <= 0.35 || p.went_to_showdown.value >= 0.35)) {
        return ["calling station", "Calls too much and rarely folds: value bet thinner and bigger, don't bluff; their raises mean a strong hand."];
    }
    const loose_passive = "Plays too many hands and calls more than raises: isolate them preflop, value bet, and respect their raises.";
    if (vpip >= 0.33 && passive) return ["loose-passive", loose_passive];
    if (vpip >= 0.28 && pfr >= 0.18) {
        return ["LAG", "Loose and aggressive: widen value ranges against them, 3-bet strong hands, avoid thin bluffs."];
    }
    // loose players with a modest raise rate (e.g. 40% VPIP, 15% PFR) are not tight, whatever their PFR
    if (vpip >= 0.30) return ["loose-passive", loose_passive];
    if (vpip <= 0.18 && pfr <= 0.13) {
        return ["nit", "Plays very few hands: steal their blinds, fold to their raises and 3-bets without a strong hand."];
    }
    if (vpip >= 0.15 && pfr >= 0.11) {
        return ["TAG", "Solid and aggressive: play close to standard, their ranges are strong when they bet big."];
    }
    return ["regular", "No strong tendency yet."];
}

/** How many chances of long-term history a session's numbers are weighed against. */
export const SESSION_PRIOR_WEIGHT = 30;

/**
 * Current-form estimate: this session's raw numbers blended toward the player's own long-term
 * rate (instead of the population), so a player who is clearly playing differently today moves
 * the estimate while a few odd hands don't.
 */
export function blendSession(long: PlayerProfile | undefined, session: PlayerProfile | undefined): PlayerProfile | undefined {
    if (!session) return long;
    if (!long) return session;
    const blended = { ...long, showdowns: [...session.showdowns, ...long.showdowns].slice(0, MAX_SHOWDOWNS), name: session.name, last_seen: session.last_seen } as PlayerProfile;
    for (const key of RATE_KEYS) {
        const s = session[key], l = long[key];
        blended[key] = { k: l.k + s.k, n: l.n + s.n, value: (s.k + l.value * SESSION_PRIOR_WEIGHT) / (s.n + SESSION_PRIOR_WEIGHT) };
    }
    blended.hands = long.hands + session.hands;
    [blended.type, blended.exploit] = classify(blended);
    return blended;
}

export interface Deviation {
    stat: RateKey,
    label: string,
    session: number,
    usual: number,
    chances: number,
    text: string
}

const DEVIATION_STATS: [RateKey, string, string, string][] = [
    ["vpip", "VPIP", "playing more hands", "playing fewer hands"],
    ["pfr", "PFR", "raising more preflop", "raising less preflop"],
    ["aggression", "aggression", "betting and raising more", "more passive"],
    ["three_bet", "3-bet", "3-betting more", "3-betting less"],
    ["fold_to_cbet", "fold to c-bet", "folding to c-bets more", "folding to c-bets less"],
    ["went_to_showdown", "showdown", "going to showdown more", "going to showdown less"]
];

/**
 * Stats where this session clearly differs from the player's usual play: at least 15 chances this
 * session and a gap larger than both 10 points and about two standard errors.
 */
export function sessionDeviations(long: PlayerProfile | undefined, session: PlayerProfile | undefined, min_chances = 15): Deviation[] {
    if (!long || !session || long.hands < MIN_HANDS_FOR_TYPE) return [];
    const out: Deviation[] = [];
    for (const [stat, label, up, down] of DEVIATION_STATS) {
        const s = session[stat];
        if (s.n < min_chances) continue;
        const now = s.k / s.n;
        const usual = long[stat].value;
        const standard_error = Math.sqrt(Math.max(usual * (1 - usual), 0.01) / s.n);
        if (Math.abs(now - usual) >= Math.max(0.10, 2 * standard_error)) {
            out.push({
                stat, label, session: now, usual, chances: s.n,
                text: `${now > usual ? up : down}: ${label} ${Math.round(now * 100)}% this game vs ${Math.round(usual * 100)}% usually (${s.n} chances)`
            });
        }
    }
    return out;
}

/** Short one-line summary for the terminal and prompts. */
export function describeProfile(p: PlayerProfile): string {
    const pct = (r: Rate) => `${Math.round(r.value * 100)}%`;
    const n = (r: Rate) => Math.round(r.value * 100);
    return `${p.name}: ${p.type} (${p.hands} hands; VPIP ${pct(p.vpip)}, PFR ${pct(p.pfr)}, 3-bet ${pct(p.three_bet)}, ` +
        `fold to c-bet ${pct(p.fold_to_cbet)} [${p.fold_to_cbet.n}], ` +
        `folds to a heads-up bet on flop/turn/river ${n(p.fold_to_bet_flop)}/${n(p.fold_to_bet_turn)}/${n(p.fold_to_bet_river)}% ` +
        `[${p.fold_to_bet_flop.n}/${p.fold_to_bet_turn.n}/${p.fold_to_bet_river.n}], ` +
        `aggression ${pct(p.aggression)}, showdown ${pct(p.went_to_showdown)})`;
}
