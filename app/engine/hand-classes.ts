import { code, RANKS, SUITS } from "./cards.ts";

/** A starting-hand class such as "AA", "AKs" or "AKo" (169 in total). */
export type HandClass = string;

/** All 169 classes, pairs and suited/offsuit combinations, high card first. */
export const ALL_CLASSES: HandClass[] = (() => {
    const out: HandClass[] = [];
    for (let i = RANKS.length - 1; i >= 0; i--) {
        for (let j = i; j >= 0; j--) {
            if (i === j) out.push(RANKS[i] + RANKS[j]);
            else out.push(RANKS[i] + RANKS[j] + "s", RANKS[i] + RANKS[j] + "o");
        }
    }
    return out;
})();

/** Number of card combinations in a class: 6 for pairs, 4 suited, 12 offsuit. */
export function comboCount(cls: HandClass): number {
    return cls.length === 2 ? 6 : cls[2] === "s" ? 4 : 12;
}

/** All two-card combinations of a class, as card code pairs. */
export function combosOf(cls: HandClass): [number, number][] {
    const [r1, r2] = [cls[0], cls[1]];
    const out: [number, number][] = [];
    for (let a = 0; a < 4; a++) {
        for (let b = 0; b < 4; b++) {
            if (cls.length === 2) {
                if (b > a) out.push([code(r1 + SUITS[a]), code(r2 + SUITS[b])]);
            } else if (cls[2] === "s") {
                if (a === b) out.push([code(r1 + SUITS[a]), code(r2 + SUITS[b])]);
            } else if (a !== b) {
                out.push([code(r1 + SUITS[a]), code(r2 + SUITS[b])]);
            }
        }
    }
    return out;
}

/** Class of two concrete cards, e.g. ["Kd", "As"] -> "AKo". */
export function classOf(cards: string[]): HandClass {
    const [a, b] = cards;
    const ia = RANKS.indexOf(a[0]);
    const ib = RANKS.indexOf(b[0]);
    const [hi, lo] = ia >= ib ? [a, b] : [b, a];
    if (hi[0] === lo[0]) return hi[0] + lo[0];
    return hi[0] + lo[0] + (hi[1] === lo[1] ? "s" : "o");
}
