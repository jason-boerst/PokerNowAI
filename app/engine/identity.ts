// The same person under two ids: PokerNow gives a player a new id when they join without their account (or from
// another device), and only "changed the ID" messages are linked automatically. Their history then splits into
// thinner profiles. This finds likely pairs for you to confirm; it never links anything itself, because different
// people do use the same name.
//
// A pair qualifies only if the two never sat in the same hand (one person can't hold two seats) and share a display
// name (ignoring case, spaces and symbols) or one name starts with the other. Pairs are ranked by the name match,
// then by how alike their play is (VPIP, PFR and aggression, each gap in standard errors).
import { HandState, SeatState } from "./hand-parser.ts";
import { PlayerProfile } from "./player-profile.ts";

export interface SameProfileCandidate {
    a: string,
    b: string,
    names_a: string[],
    names_b: string[],
    hands_a: number,
    hands_b: number,
    games_a: number,
    games_b: number,
    match: "same name" | "name starts the same",
    /** The largest gap between their VPIP, PFR and aggression, in standard errors (small: they play alike). */
    style_gap: number,
    note: string
}

/** Names compared without case, spaces or symbols. */
export const normalizeName = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
/** Shortest name that counts for "starts the same". */
const MIN_PREFIX = 4;

function nameMatch(a: string[], b: string[]): SameProfileCandidate["match"] | null {
    const na = a.map(normalizeName).filter(Boolean), nb = b.map(normalizeName).filter(Boolean);
    if (na.some((x) => nb.includes(x))) return "same name";
    const prefix = (x: string, y: string) => x.length >= MIN_PREFIX && y.startsWith(x);
    return na.some((x) => nb.some((y) => prefix(x, y) || prefix(y, x))) ? "name starts the same" : null;
}

function styleGap(p: PlayerProfile, q: PlayerProfile): number {
    let worst = 0;
    for (const key of ["vpip", "pfr", "aggression"] as const) {
        const a = p[key], b = q[key];
        if (!(a.n > 0 && b.n > 0)) continue;
        const pa = a.k / a.n, pb = b.k / b.n;
        const se = Math.sqrt(Math.max(pa * (1 - pa), 0.01) / a.n + Math.max(pb * (1 - pb), 0.01) / b.n);
        worst = Math.max(worst, Math.abs(pa - pb) / se);
    }
    return Math.round(worst * 10) / 10;
}

/**
 * Likely same-person pairs among the identity keys (`keyOf`, so already linked ids count as one), from every hand
 * with its game. `profile(key)` gives each key's profile (names, hands, stats).
 */
export function sameProfileCandidates(hands: { state: HandState, game_id: string }[], keyOf: (seat: SeatState) => string,
    profile: (key: string) => PlayerProfile | undefined, limit = 50): SameProfileCandidate[] {
    const together = new Set<string>();
    const games = new Map<string, Set<string>>();
    const pair = (x: string, y: string) => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);
    for (const h of hands) {
        const keys = [...new Set(h.state.seats.map(keyOf))];
        for (const k of keys) (games.get(k) ?? games.set(k, new Set()).get(k)!).add(h.game_id);
        for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) together.add(pair(keys[i], keys[j]));
    }
    // group keys by each normalized name and its first MIN_PREFIX letters, so only plausible pairs are compared
    const keys = [...games.keys()];
    const profiles = new Map(keys.map((k) => [k, profile(k)]));
    const buckets = new Map<string, Set<string>>();
    for (const k of keys) {
        for (const name of profiles.get(k)?.names ?? []) {
            const n = normalizeName(name);
            if (!n) continue;
            const bucket = n.slice(0, MIN_PREFIX) || n;
            (buckets.get(bucket) ?? buckets.set(bucket, new Set()).get(bucket)!).add(k);
        }
    }
    const seen = new Set<string>();
    const out: SameProfileCandidate[] = [];
    for (const group of buckets.values()) {
        const ks = [...group];
        for (let i = 0; i < ks.length; i++) {
            for (let j = i + 1; j < ks.length; j++) {
                const id = pair(ks[i], ks[j]);
                if (seen.has(id) || together.has(id)) continue;
                seen.add(id);
                const p = profiles.get(ks[i]), q = profiles.get(ks[j]);
                if (!p || !q) continue;
                const match = nameMatch(p.names, q.names);
                if (!match) continue;
                const [a, b, pa, pb] = p.hands >= q.hands ? [ks[i], ks[j], p, q] : [ks[j], ks[i], q, p];
                const gap = styleGap(pa, pb);
                out.push({
                    a, b, names_a: pa.names, names_b: pb.names, hands_a: pa.hands, hands_b: pb.hands,
                    games_a: games.get(a)!.size, games_b: games.get(b)!.size, match, style_gap: gap,
                    note: `${match === "same name" ? "Same name" : "Names start the same"}, never at the same table hand; ` +
                        (gap < 2 ? "they play alike (VPIP, PFR and aggression within 2 standard errors)." : `their play differs (a gap of ${gap} standard errors), so check before linking.`)
                });
            }
        }
    }
    return out.sort((x, y) => (x.match === y.match ? x.style_gap - y.style_gap : x.match === "same name" ? -1 : 1)).slice(0, limit);
}
