import { HandState, netResult, POST_TYPES, SeatState } from "./hand-parser.ts";
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
    "cbet", "fold_to_cbet", "aggression", "went_to_showdown", "won_at_showdown"
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
    won_at_showdown: { mean: 0.50, weight: 10 }
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

type Counter = { k: number, n: number };
interface Accumulator {
    key: string,
    names: Map<string, string>,   // name -> last seen
    last_name: string,
    hands: number,
    c: Record<RateKey, Counter>,
    by_position: Record<PositionGroup, Counter>,
    net_bb: number,
    result_hands: number,
    bet_to_pot_sum: number,
    bets_seen: number,
    showdowns: Showdown[],
    last_seen: string
}

function newAccumulator(key: string): Accumulator {
    const c = {} as Record<RateKey, Counter>;
    for (const k of RATE_KEYS) c[k] = { k: 0, n: 0 };
    return {
        key, names: new Map(), last_name: "", hands: 0, c,
        by_position: { early: { k: 0, n: 0 }, middle: { k: 0, n: 0 }, late: { k: 0, n: 0 }, blinds: { k: 0, n: 0 } },
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

    addHand(s: HandState, at: string = ""): void {
        const holdem_stats = isHoldem(s) && !s.bomb_pot;
        const pre = s.actions.filter((a) => a.street === "preflop");
        const voluntary_all = pre.filter((a) => !POST_TYPES.has(a.type) && a.type !== "fold" && a.type !== "check");
        const raises = pre.filter((a) => a.type === "raise" || a.type === "bet");
        const opener = raises[0]?.player_id;
        const three_bettor = raises[1]?.player_id;
        const last_pf_raiser = raises[raises.length - 1]?.player_id;
        const flop_actions = s.actions.filter((a) => a.street === "flop");
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
            const mine = pre.filter((a) => a.player_id === seat.id);
            const voluntary = mine.filter((a) => a.type === "call" || a.type === "raise" || a.type === "bet");
            const index = (a: { player_id: string }) => s.actions.indexOf(a as never);

            // VPIP / PFR over all hands dealt, VPIP by position group
            acc.c.vpip.n++;
            acc.c.pfr.n++;
            const group = GROUP[seat.position];
            if (group) acc.by_position[group].n++;
            if (voluntary.length > 0) {
                acc.c.vpip.k++;
                if (group) acc.by_position[group].k++;
            }
            if (mine.some((a) => a.type === "raise" || a.type === "bet")) acc.c.pfr.k++;

            // limp: first voluntary action was a call with no raise before it
            const first_vol = voluntary[0];
            if (first_vol) {
                const raises_before = raises.filter((r) => index(r) < index(first_vol)).length;
                if (raises_before === 0) {
                    acc.c.limp.n++;
                    if (first_vol.type === "call") acc.c.limp.k++;
                }
            }

            // 3-bet: had a chance when facing exactly one raise
            const first_action = mine.find((a) => !POST_TYPES.has(a.type));
            if (first_action && opener && opener !== seat.id) {
                const raises_before = raises.filter((r) => index(r) < index(first_action)).length;
                if (raises_before === 1) {
                    acc.c.three_bet.n++;
                    if (first_action.type === "raise") acc.c.three_bet.k++;
                }
            }

            // fold to 3-bet: opened, then faced a 3-bet
            if (opener === seat.id && three_bettor && three_bettor !== seat.id) {
                const response = mine.find((a) => index(a) > index(raises[1]));
                if (response) {
                    acc.c.fold_to_three_bet.n++;
                    if (response.type === "fold") acc.c.fold_to_three_bet.k++;
                }
            }

            // steal: in CO/BU/SB with everyone before them folded
            if (["CO", "BU", "SB"].includes(seat.position) && first_action) {
                const voluntary_before = voluntary_all.filter((a) => index(a) < index(first_action)).length;
                if (voluntary_before === 0) {
                    acc.c.steal.n++;
                    if (first_action.type === "raise") acc.c.steal.k++;
                }
            }

            // fold to steal: in the blinds facing a steal raise and nothing else yet
            if ((seat.position === "SB" || seat.position === "BB") && steal_raise && steal_raise.player_id !== seat.id) {
                const response = mine.find((a) => index(a) > index(steal_raise));
                const others_between = voluntary_all.filter((a) => index(a) > index(steal_raise) && response && index(a) < index(response)).length;
                if (response && others_between === 0) {
                    acc.c.fold_to_steal.n++;
                    if (response.type === "fold") acc.c.fold_to_steal.k++;
                }
            }

            // c-bet: last preflop raiser, first to have a chance to bet on the flop
            if (last_pf_raiser === seat.id && saw_flop.has(seat.id)) {
                const my_first = flop_actions.find((a) => a.player_id === seat.id);
                const bet_before = my_first && flop_actions.some((a) => (a.type === "bet" || a.type === "raise") && flop_actions.indexOf(a) < flop_actions.indexOf(my_first));
                if (my_first && !bet_before) {
                    acc.c.cbet.n++;
                    if (my_first.type === "bet") acc.c.cbet.k++;
                }
            }

            // fold to c-bet: faced the preflop raiser's first flop bet
            const cbet = flop_actions.find((a) => a.type === "bet" && a.player_id === last_pf_raiser);
            if (cbet && seat.id !== last_pf_raiser) {
                const response = flop_actions.find((a) => a.player_id === seat.id && flop_actions.indexOf(a) > flop_actions.indexOf(cbet));
                if (response) {
                    acc.c.fold_to_cbet.n++;
                    if (response.type === "fold") acc.c.fold_to_cbet.k++;
                }
            }

            // post-flop aggression and bet sizing
            for (const a of s.actions) {
                if (a.player_id !== seat.id || a.street === "preflop") continue;
                if (a.type === "bet" || a.type === "raise") {
                    acc.c.aggression.n++;
                    acc.c.aggression.k++;
                    if (a.pot_before > 0) {
                        acc.bet_to_pot_sum += a.amount / a.pot_before;
                        acc.bets_seen++;
                    }
                } else if (a.type === "call" || a.type === "fold") {
                    acc.c.aggression.n++;
                }
            }

            // showdown
            if (saw_flop.has(seat.id)) {
                acc.c.went_to_showdown.n++;
                if (showdown && !seat.folded) {
                    acc.c.went_to_showdown.k++;
                    acc.c.won_at_showdown.n++;
                    if (seat.collected > 0) acc.c.won_at_showdown.k++;
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
                pool[stat].k += acc.c[stat].k;
                pool[stat].n += acc.c[stat].n;
            }
        }
        return pool;
    }

    all(): PlayerProfile[] {
        return [...this.players.values()].map(finalize);
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
    return `${p.name}: ${p.type} (${p.hands} hands; VPIP ${pct(p.vpip)}, PFR ${pct(p.pfr)}, 3-bet ${pct(p.three_bet)}, ` +
        `fold to c-bet ${pct(p.fold_to_cbet)} [${p.fold_to_cbet.n}], aggression ${pct(p.aggression)}, ` +
        `showdown ${pct(p.went_to_showdown)})`;
}
