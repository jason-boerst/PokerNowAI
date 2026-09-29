// Card helpers on top of phe's integer card codes.
// @ts-ignore phe has no type definitions
import phe from "phe";

export const RANKS = "23456789TJQKA";
export const SUITS = "shdc";

/** Card code for a card like "As" or "Td". */
export function code(card: string): number {
    return phe.cardCode(card[0], card[1]);
}

export function codes(cards: string[]): number[] {
    return cards.map(code);
}

export function cardName(c: number): string {
    return phe.stringifyCardCode(c);
}

/** All 52 card codes. */
export const DECK: number[] = [...RANKS].flatMap((r) => [...SUITS].map((s) => code(r + s)));

/** Hand strength of 5-7 card codes; smaller is better. */
export function evaluate(card_codes: number[]): number {
    return phe.evaluateCardCodes(card_codes);
}

/** Hand category: 0 straight flush, 1 quads, 2 full house, 3 flush, 4 straight, 5 trips, 6 two pair, 7 pair, 8 high card. */
export function category(strength: number): number {
    return phe.handRank(strength);
}

/** Deterministic PRNG (mulberry32) so simulations can be reproduced in tests. */
export function seededRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
