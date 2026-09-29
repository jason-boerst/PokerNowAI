import { HandState } from "./hand-parser.ts";
import { classOf } from "./hand-classes.ts";

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
    /** Their actions by street, e.g. "preflop: call | flop: call | turn: call | river: check". */
    line: string,
    won: boolean
}

export type PlayerType = "unknown" | "calling station" | "maniac" | "nit" | "loose-passive" | "LAG" | "TAG" | "regular";

export interface PlayerProfile {
    name: string,
    hands: number,
    vpip: Rate,
    pfr: Rate,
    limp: Rate,
    three_bet: Rate,
    fold_to_three_bet: Rate,
    cbet: Rate,
    fold_to_cbet: Rate,
    /** Share of post-flop actions that are bets or raises. */
    aggression: Rate,
    went_to_showdown: Rate,
    won_at_showdown: Rate,
    /** Average post-flop bet or raise as a share of the pot, and how many were seen. */
    avg_bet_to_pot: number,
    bets_seen: number,
    showdowns: Showdown[],
    type: PlayerType,
    exploit: string
}

/**
 * Population priors: assumed averages for a loose home-game field, and how many hands of evidence
 * they count as. A player's stat moves from the prior to their own numbers as their sample grows.
 */
export const PRIORS = {
    vpip: { mean: 0.35, weight: 15 },
    pfr: { mean: 0.12, weight: 15 },
    limp: { mean: 0.20, weight: 15 },
    three_bet: { mean: 0.05, weight: 20 },
    fold_to_three_bet: { mean: 0.45, weight: 10 },
    cbet: { mean: 0.55, weight: 10 },
    fold_to_cbet: { mean: 0.40, weight: 10 },
    aggression: { mean: 0.35, weight: 15 },
    went_to_showdown: { mean: 0.32, weight: 10 },
    won_at_showdown: { mean: 0.50, weight: 10 }
};

/** Hands before a player is given a type other than "unknown". */
export const MIN_HANDS_FOR_TYPE = 20;

type Counter = { k: number, n: number };
interface Accumulator {
    name: string,
    hands: number,
    c: Record<keyof typeof PRIORS, Counter>,
    bet_to_pot_sum: number,
    bets_seen: number,
    showdowns: Showdown[]
}

function newAccumulator(name: string): Accumulator {
    const c = {} as Record<keyof typeof PRIORS, Counter>;
    for (const key of Object.keys(PRIORS) as (keyof typeof PRIORS)[]) c[key] = { k: 0, n: 0 };
    return { name, hands: 0, c, bet_to_pot_sum: 0, bets_seen: 0, showdowns: [] };
}

const MAX_SHOWDOWNS = 10;

/** Builds profiles for every player seen in a set of completed hands. */
export class ProfileBuilder {
    private players = new Map<string, Accumulator>();

    addHand(s: HandState): void {
        const pre = s.actions.filter((a) => a.street === "preflop");
        const raises = pre.filter((a) => a.type === "raise" || a.type === "bet");
        const opener = raises[0]?.player_id;
        const three_bettor = raises[1]?.player_id;
        const last_pf_raiser = raises[raises.length - 1]?.player_id;
        const flop_actions = s.actions.filter((a) => a.street === "flop");
        const saw_flop = new Set(flop_actions.map((a) => a.player_id));
        const unfolded_at_end = s.seats.filter((p) => !p.folded);
        const showdown = unfolded_at_end.length >= 2 && s.board.length === 5;

        for (const seat of s.seats) {
            const acc = this.players.get(seat.name) ?? newAccumulator(seat.name);
            this.players.set(seat.name, acc);
            acc.hands++;
            const mine = pre.filter((a) => a.player_id === seat.id);
            const voluntary = mine.filter((a) => a.type === "call" || a.type === "raise" || a.type === "bet");

            // VPIP / PFR over all hands dealt
            acc.c.vpip.n++;
            acc.c.pfr.n++;
            if (voluntary.length > 0) acc.c.vpip.k++;
            if (mine.some((a) => a.type === "raise" || a.type === "bet")) acc.c.pfr.k++;

            // limp: first voluntary action was a call with no raise before it
            const first_vol = voluntary[0];
            if (first_vol) {
                const raises_before = raises.filter((r) => s.actions.indexOf(r) < s.actions.indexOf(first_vol)).length;
                if (raises_before === 0) {
                    acc.c.limp.n++;
                    if (first_vol.type === "call") acc.c.limp.k++;
                }
            }

            // 3-bet: had a chance when facing exactly one raise
            const first_action = mine.find((a) => a.type !== "post_sb" && a.type !== "post_bb" && a.type !== "post_straddle" && a.type !== "post_dead");
            if (first_action && opener && opener !== seat.id) {
                const raises_before = raises.filter((r) => s.actions.indexOf(r) < s.actions.indexOf(first_action)).length;
                if (raises_before === 1) {
                    acc.c.three_bet.n++;
                    if (first_action.type === "raise") acc.c.three_bet.k++;
                }
            }

            // fold to 3-bet: opened, then faced a 3-bet
            if (opener === seat.id && three_bettor && three_bettor !== seat.id) {
                const response = mine.find((a) => s.actions.indexOf(a) > s.actions.indexOf(raises[1]));
                if (response) {
                    acc.c.fold_to_three_bet.n++;
                    if (response.type === "fold") acc.c.fold_to_three_bet.k++;
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
                const at_showdown = showdown && !seat.folded;
                if (at_showdown) {
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
                    won: seat.collected > 0
                });
                acc.showdowns.length = Math.min(acc.showdowns.length, MAX_SHOWDOWNS);
            }
        }
    }

    profile(name: string): PlayerProfile | undefined {
        const acc = this.players.get(name);
        return acc ? finalize(acc) : undefined;
    }

    all(): PlayerProfile[] {
        return [...this.players.values()].map(finalize);
    }
}

function describeLine(s: HandState, player_id: string): string {
    const parts: string[] = [];
    for (const street of ["preflop", "flop", "turn", "river"] as const) {
        const acts = s.actions.filter((a) => a.street === street && a.player_id === player_id && !a.type.startsWith("post"));
        if (acts.length) parts.push(`${street}: ${acts.map((a) => a.type).join("/")}`);
    }
    return parts.join(" | ");
}

function shrink(c: Counter, prior: { mean: number, weight: number }): Rate {
    return { k: c.k, n: c.n, value: (c.k + prior.mean * prior.weight) / (c.n + prior.weight) };
}

function finalize(acc: Accumulator): PlayerProfile {
    const r = {} as Record<keyof typeof PRIORS, Rate>;
    for (const key of Object.keys(PRIORS) as (keyof typeof PRIORS)[]) r[key] = shrink(acc.c[key], PRIORS[key]);
    const profile: PlayerProfile = {
        name: acc.name,
        hands: acc.hands,
        ...r,
        avg_bet_to_pot: acc.bets_seen ? acc.bet_to_pot_sum / acc.bets_seen : 0,
        bets_seen: acc.bets_seen,
        showdowns: acc.showdowns,
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
    if (vpip >= 0.33 && passive) {
        return ["loose-passive", "Plays too many hands passively: isolate them preflop, value bet, and respect their raises."];
    }
    if (vpip <= 0.18 && pfr <= 0.13) {
        return ["nit", "Plays very few hands: steal their blinds, fold to their raises and 3-bets without a strong hand."];
    }
    if (vpip >= 0.28 && pfr >= 0.18) {
        return ["LAG", "Loose and aggressive: widen value ranges against them, 3-bet strong hands, avoid thin bluffs."];
    }
    if (vpip >= 0.15 && pfr >= 0.11) {
        return ["TAG", "Solid and aggressive: play close to standard, their ranges are strong when they bet big."];
    }
    return ["regular", "No strong tendency yet."];
}

/** Short one-line summary for the terminal and prompts. */
export function describeProfile(p: PlayerProfile): string {
    const pct = (r: Rate) => `${Math.round(r.value * 100)}%`;
    return `${p.name}: ${p.type} (${p.hands} hands; VPIP ${pct(p.vpip)}, PFR ${pct(p.pfr)}, 3-bet ${pct(p.three_bet)}, ` +
        `fold to c-bet ${pct(p.fold_to_cbet)} [${p.fold_to_cbet.n}], aggression ${pct(p.aggression)}, ` +
        `showdown ${pct(p.went_to_showdown)})`;
}
