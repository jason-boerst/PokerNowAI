import { code, DECK, evaluate } from "./cards.ts";
import { HandState } from "./hand-parser.ts";

/** Exact equity of hero's two cards against one known hand, enumerating every remaining board. */
export function exactEquity(hero: string[], villain: string[], board: string[]): number {
    const dead = new Set([...hero, ...villain, ...board].map(code));
    const rest = DECK.filter((c) => !dead.has(c));
    const need = 5 - board.length;
    const h = hero.map(code), v = villain.map(code), b = board.map(code);
    const full = new Array<number>(5);
    b.forEach((c, i) => full[i] = c);
    let share = 0, n = 0;
    const recurse = (start: number, depth: number) => {
        if (depth === need) {
            const hs = evaluate([h[0], h[1], ...full]);
            const vs = evaluate([v[0], v[1], ...full]);
            share += hs < vs ? 1 : hs === vs ? 0.5 : 0;
            n++;
            return;
        }
        for (let i = start; i < rest.length; i++) {
            full[b.length + depth] = rest[i];
            recurse(i + 1, depth + 1);
        }
    };
    recurse(0, 0);
    return n ? share / n : 0;
}

const BOARD_SIZE = { preflop: 0, flop: 3, turn: 4, river: 5 } as const;

/**
 * Luck-adjusted result for hero in a finished hand: when the money went in heads-up before the
 * river and both hands were shown, hero is credited with their equity share of the pot instead of
 * the actual outcome. Returns null when the adjustment doesn't apply.
 */
export function allInAdjustedNet(s: HandState, hero_id: string): number | null {
    const hero = s.seats.find((p) => p.id === hero_id);
    const others = s.seats.filter((p) => p.id !== hero_id && !p.folded);
    if (!hero || hero.folded || others.length !== 1) return null;
    const villain = others[0];
    if (!(hero.all_in || villain.all_in)) return null;
    if (s.hero_cards.length !== 2 || villain.shown_cards?.length !== 2) return null;

    const last_money = [...s.actions].reverse().find((a) => ["bet", "raise", "call"].includes(a.type));
    if (!last_money || last_money.street === "river") return null;
    const board = s.board.slice(0, BOARD_SIZE[last_money.street]);
    const eq = exactEquity(s.hero_cards, villain.shown_cards, board);
    return eq * s.pot - hero.total_contribution;
}
