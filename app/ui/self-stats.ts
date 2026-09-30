// Your own stats for the bottom of the in-game panel: the same numbers the opponents get, over all your
// hands (earlier games plus today) and over today's session, against your games' averages.
import { PlayerProfile, PRIORS, RateKey } from "../engine/player-profile.ts";
import type { PlayerInfo } from "../services/profile-service.ts";
import { statLevel, typeTone } from "./opponent-cards.ts";
import { SelfStatRow, SelfStats } from "./panel-model.ts";

/** The stats shown, in order, with what each measures. */
const ROWS: [RateKey, string, string][] = [
    ["vpip", "VPIP", "share of hands you play"],
    ["pfr", "PFR", "share of hands you raise preflop"],
    ["three_bet", "3-bet", "how often you re-raise a single raise"],
    ["fold_to_three_bet", "Fold to 3-bet", "after you open and get re-raised"],
    ["steal", "Steal", "opens from the cutoff, button and small blind when folded to"],
    ["cbet", "C-bet", "flop bets after raising preflop"],
    ["fold_to_cbet", "Fold to c-bet", "when the preflop raiser bets the flop"],
    ["aggression", "Aggression", "bets and raises among your post-flop actions"],
    ["went_to_showdown", "Went to showdown", "of the hands you saw a flop with"],
    ["won_at_showdown", "Won at showdown", "of the showdowns you reached"]
];

/** A raw rate (count over chances), or undefined without chances. */
function raw(k: number, n: number): { value: number, n: number } | undefined {
    return n > 0 ? { value: k / n, n } : undefined;
}

/**
 * Your stats from your player info (the profile service groups your ids as one person): all your hands
 * are your earlier games plus today's, counted together; today is the live game alone. Rates are raw
 * counts, not blended toward the averages, so what you see is exactly what you did. Undefined when there
 * is no history at all.
 */
export function selfStats(info: PlayerInfo): SelfStats | undefined {
    const long = info.long, today = info.session;
    const hands = (long?.hands ?? 0) + (today?.hands ?? 0);
    if (hands === 0) return undefined;
    const rows: SelfStatRow[] = [];
    for (const [key, label, hint] of ROWS) {
        const all = raw((long?.[key].k ?? 0) + (today?.[key].k ?? 0), (long?.[key].n ?? 0) + (today?.[key].n ?? 0));
        if (!all) continue;
        const now = today ? raw(today[key].k, today[key].n) : undefined;
        const pool = PRIORS[key].mean;
        rows.push({
            label, all, pool, level: statLevel(all.value, all.n, pool), hint,
            ...(now ? { today: now, today_level: statLevel(now.value, now.n, pool) } : {})
        });
    }
    const result = (p: PlayerProfile | undefined) => ({ hands: p?.hands ?? 0, net_bb: p?.net_bb ?? 0, result_hands: p?.result_hands ?? p?.hands ?? 0 });
    const a = result(long), t = result(today);
    const rate = (net: number, n: number) => (n > 0 ? net / n * 100 : undefined);
    const net_all = a.net_bb + t.net_bb;
    // how your play reads to others: the classification from your current form, as for any opponent
    const type = info.current?.type ?? "unknown";
    return {
        type, type_tone: typeTone(type),
        ...(info.current?.exploit && type !== "unknown" ? { counter: info.current.exploit } : {}),
        all: { hands, net_bb: round1(net_all), ...(rate(net_all, a.result_hands + t.result_hands) !== undefined ? { bb_per_100: round1(rate(net_all, a.result_hands + t.result_hands)!) } : {}) },
        today: { hands: t.hands, net_bb: round1(t.net_bb), ...(rate(t.net_bb, t.result_hands) !== undefined ? { bb_per_100: round1(rate(t.net_bb, t.result_hands)!) } : {}) },
        rows
    };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
