import { RANKS } from "./cards.ts";
import { HandClass } from "./hand-classes.ts";

/**
 * Parses standard range notation into hand classes:
 *   "77+"      pairs 77 and up          "TT-66"   pairs from TT down to 66
 *   "ATs+"     ATs, AJs, AQs, AKs       "A5s-A2s" A5s, A4s, A3s, A2s
 *   "KQo"      one class                "KQ"      KQs and KQo
 * Items are separated by commas or spaces.
 */
export function parseRange(notation: string): Set<HandClass> {
    const out = new Set<HandClass>();
    for (const raw of notation.split(/[,\s]+/).filter(Boolean)) {
        for (const cls of parseItem(raw)) out.add(cls);
    }
    return out;
}

const r = (c: string) => RANKS.indexOf(c.toUpperCase());

function parseItem(item: string): HandClass[] {
    const plus = item.endsWith("+");
    const body = plus ? item.slice(0, -1) : item;

    if (body.includes("-")) {
        const [a, b] = body.split("-");
        if (a.length === 2 && a[0] === a[1]) {
            // pair range "TT-66"
            const [hi, lo] = [r(a[0]), r(b[0])].sort((x, y) => y - x);
            return range(lo, hi).map((i) => RANKS[i] + RANKS[i]);
        }
        // kicker range "A5s-A2s"
        const suffix = a.slice(2);
        const [hi, lo] = [r(a[1]), r(b[1])].sort((x, y) => y - x);
        return range(lo, hi).flatMap((k) => withSuffix(a[0] + RANKS[k], suffix));
    }

    if (body.length === 2 && body[0] === body[1]) {
        const i = r(body[0]);
        return plus ? range(i, RANKS.length - 1).map((k) => RANKS[k] + RANKS[k]) : [body];
    }

    const high = body[0].toUpperCase();
    const low = body[1].toUpperCase();
    const suffix = body.slice(2);
    if (r(high) < 0 || r(low) < 0) throw new Error(`Invalid range item "${item}"`);
    if (!plus) return withSuffix(high + low, suffix);
    // "ATs+": raise the kicker up to one below the high card
    return range(r(low), r(high) - 1).flatMap((k) => withSuffix(high + RANKS[k], suffix));
}

function withSuffix(two: string, suffix: string): HandClass[] {
    if (suffix === "s" || suffix === "o") return [two + suffix];
    return [two + "s", two + "o"];
}

function range(lo: number, hi: number): number[] {
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
}
