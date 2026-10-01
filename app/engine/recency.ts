// Do recent games say more about how a player plays now than old ones? Players change (new habits, a bad night,
// learning), so a player's profile could weight their recent games more. Whether that helps is measured, not
// assumed: profiles built from each player's earlier games, with older games counting less, predict what they do
// in a later game, and a half-life is used only when it predicts clearly better than counting every game the same.
//
// The half-life is in the player's own games: a game counts 0.5^(n / H), where n is how many games that player has
// played since. A player seen rarely keeps their old data until new data replaces it.
import { HandState, SeatState } from "./hand-parser.ts";
import { Counter, newCounters, PRIORS, ProfileBuilder, RateKey } from "./player-profile.ts";

/** Half-lives tried, in the player's games (Infinity: every game counts the same). */
export const HALF_LIVES = [Infinity, 20, 10, 6, 3];
/** The stats predicted (the ones the engine leans on most). */
const PREDICTED: RateKey[] = [
    "vpip", "pfr", "three_bet", "fold_to_three_bet", "cbet", "fold_to_cbet", "aggression",
    "fold_to_bet_flop", "fold_to_bet_turn", "fold_to_bet_river", "bet_when_checked_to", "raise_vs_bet"
];
/** Games needed before the check runs (it tests on the newest third, and needs history before them). */
export const MIN_GAMES = 4;

/** Each player's counts in each game. */
export type PlayerGameCounts = Map<string, Map<string, Record<RateKey, Counter>>>;

/** Counts per player per game, from hands with their game (each hand counted once, unweighted). */
export function playerGameCounts(hands: { state: HandState, game_id: string }[], keyOf: (seat: SeatState) => string): PlayerGameCounts {
    const out: PlayerGameCounts = new Map();
    for (const h of hands) {
        const b = new ProfileBuilder(keyOf);
        b.addHand(h.state);
        for (const [key, c] of b.rawCounts()) {
            const games = out.get(key) ?? out.set(key, new Map()).get(key)!;
            const g = games.get(h.game_id) ?? games.set(h.game_id, newCounters()).get(h.game_id)!;
            for (const stat of PREDICTED) {
                g[stat].k += c[stat].k;
                g[stat].n += c[stat].n;
            }
        }
    }
    return out;
}

/** Game ids from oldest to newest, by each game's first hand. */
export function gameOrder(hands: { game_id: string, at: string }[]): string[] {
    const first = new Map<string, string>();
    for (const h of hands) if (!first.has(h.game_id) || h.at < first.get(h.game_id)!) first.set(h.game_id, h.at);
    return [...first].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1)).map(([g]) => g);
}

export const recencyWeight = (games_since: number, half_life: number) => (Number.isFinite(half_life) ? Math.pow(0.5, games_since / half_life) : 1);

/** For each player, how many of their games came after each of their games (0 for their newest). */
export function gamesSince(counts: PlayerGameCounts, order: string[]): Map<string, Map<string, number>> {
    const index = new Map(order.map((g, i) => [g, i]));
    const out = new Map<string, Map<string, number>>();
    for (const [key, games] of counts) {
        const mine = [...games.keys()].sort((a, b) => (index.get(b) ?? 0) - (index.get(a) ?? 0));
        out.set(key, new Map(mine.map((g, i) => [g, i])));
    }
    return out;
}

export interface HalfLifeCheck {
    /** The half-life in use (Infinity: none, every game counts the same). */
    half_life: number,
    /** Player-games predicted, the games they were in, and per half-life the log loss and its gain over Infinity (± one SE). */
    cases: number,
    test_games: number,
    results: { half_life: number, log_loss: number, gain: number, se: number }[],
    reason: string
}

/**
 * Picks the half-life that best predicts each player's play in the newest third of games from their games before
 * it. Used only when it beats counting every game the same by more than two standard errors; otherwise Infinity.
 */
export function chooseHalfLife(counts: PlayerGameCounts, order: string[], include: (key: string) => boolean = () => true): HalfLifeCheck {
    const none = (reason: string): HalfLifeCheck => ({ half_life: Infinity, cases: 0, test_games: 0, results: [], reason });
    if (order.length < MIN_GAMES) return none(`${order.length} games; the check needs ${MIN_GAMES}.`);
    const index = new Map(order.map((g, i) => [g, i]));
    const first_test = Math.max(1, order.length - Math.max(1, Math.round(order.length / 3)));
    // per player-game in the test games: the loss under each half-life
    const losses: number[][] = [];
    for (const [key, games] of counts) {
        if (!include(key)) continue;
        for (const [game, actual] of games) {
            const t = index.get(game) ?? -1;
            if (t < first_test) continue;
            const earlier = [...games.keys()].filter((g) => (index.get(g) ?? -1) < t).sort((a, b) => index.get(b)! - index.get(a)!);
            if (!earlier.length) continue;
            const row = HALF_LIVES.map((h) => {
                let loss = 0;
                for (const stat of PREDICTED) {
                    const a = actual[stat];
                    if (!(a.n > 0)) continue;
                    let k = 0, n = 0;
                    earlier.forEach((g, i) => {
                        const w = recencyWeight(i, h);
                        k += w * games.get(g)![stat].k;
                        n += w * games.get(g)![stat].n;
                    });
                    const prior = PRIORS[stat];
                    const p = Math.min(0.999, Math.max(0.001, (k + prior.mean * prior.weight) / (n + prior.weight)));
                    loss -= a.k * Math.log(p) + (a.n - a.k) * Math.log(1 - p);
                }
                return loss;
            });
            losses.push(row);
        }
    }
    if (!losses.length) return none("No player appears both in the newest games and before them.");
    const results = HALF_LIVES.map((h, j) => {
        const gains = losses.map((row) => row[0] - row[j]);
        const n = gains.length;
        const mean = gains.reduce((a, b) => a + b, 0) / n;
        const sd = n > 1 ? Math.sqrt(gains.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
        const r = (x: number) => Math.round(x * 10) / 10;
        return { half_life: h, log_loss: r(losses.reduce((a, row) => a + row[j], 0)), gain: r(mean * n), se: r(sd * Math.sqrt(n)) };
    });
    const best = results.slice(1).reduce((x, y) => (y.gain > x.gain ? y : x));
    const passes = best.gain > 2 * best.se && best.se > 0;
    const test_games = order.length - first_test;
    return {
        half_life: passes ? best.half_life : Infinity, cases: losses.length, test_games, results,
        reason: passes
            ? `A half-life of ${best.half_life} games predicts the newest ${test_games} games better (log loss ${best.gain} lower, ± ${best.se}).`
            : `No half-life beat counting every game the same by more than two standard errors (best: ${best.half_life} games, ${best.gain} ± ${best.se}).`
    };
}
