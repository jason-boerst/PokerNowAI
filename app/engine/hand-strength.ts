import { category, code, evaluate, RANKS, SUITS } from "./cards.ts";
import { classOf } from "./hand-classes.ts";

export interface HandStrength {
    /** Plain description of the made hand, e.g. "Top pair, K kicker" or "Set of 7s". */
    made: string,
    /** Draws, e.g. ["Nut flush draw", "Gutshot"]. Empty on the river or with no draws. */
    draws: string[],
    /** Unseen cards that complete a straight or flush (not a guarantee of the best hand). */
    outs: number,
    /** Chance of hitting an out on the next card. */
    hit_next: number,
    /** Chance of hitting an out by the river (flop only; equals hit_next on the turn). */
    hit_by_river: number
}

const RANK_NAME: Record<string, string> = { "A": "Ace", "K": "King", "Q": "Queen", "J": "Jack", "T": "Ten", "9": "9", "8": "8", "7": "7", "6": "6", "5": "5", "4": "4", "3": "3", "2": "2" };
const PLURAL: Record<string, string> = { "A": "Aces", "K": "Kings", "Q": "Queens", "J": "Jacks", "T": "Tens", "9": "9s", "8": "8s", "7": "7s", "6": "6s", "5": "5s", "4": "4s", "3": "3s", "2": "2s" };
const value = (rank: string) => RANKS.indexOf(rank) + 2;

/** Rank values present (Ace also counts as 1 for the wheel). */
function rankSet(cards: string[]): Set<number> {
    const set = new Set<number>();
    for (const c of cards) {
        const v = value(c[0]);
        set.add(v);
        if (v === 14) set.add(1);
    }
    return set;
}

function hasStraight(ranks: Set<number>): boolean {
    for (let lo = 1; lo <= 10; lo++) {
        if ([0, 1, 2, 3, 4].every((d) => ranks.has(lo + d))) return true;
    }
    return false;
}

function describeMade(hole: string[], board: string[]): string {
    const cat = category(evaluate([...hole, ...board].map(code)));
    const [h1, h2] = hole.map((c) => c[0]);
    const board_ranks = board.map((c) => c[0]);
    const board_sorted = [...new Set(board_ranks)].sort((a, b) => value(b) - value(a));
    const top = board_sorted[0];
    const pocket_pair = h1 === h2;
    const count = (r: string) => board_ranks.filter((x) => x === r).length;

    switch (cat) {
        case 0: return "Straight flush";
        case 1: return "Four of a kind";
        case 2: return "Full house";
        case 3: {
            const suit = [...SUITS].find((s) => [...hole, ...board].filter((c) => c[1] === s).length >= 5)!;
            const mine = hole.filter((c) => c[1] === suit);
            if (mine.length === 0) return "Flush on the board";
            const best = mine.map((c) => c[0]).sort((a, b) => value(b) - value(a))[0];
            const higher_missing = [...RANKS].filter((r) => value(r) > value(best) && !board.includes(r + suit));
            return higher_missing.length === 0 ? "Nut flush" : `Flush, ${RANK_NAME[best]} high`;
        }
        case 4: {
            const board_only = hasStraight(rankSet(board));
            return board_only ? "Straight (on the board)" : "Straight";
        }
        case 5:
            if (pocket_pair && count(h1) === 1) return `Set of ${PLURAL[h1]}`;
            if (board_sorted.some((r) => count(r) === 3)) return "Trips on the board";
            return `Trips, ${PLURAL[board_ranks.find((r) => count(r) === 2 && (r === h1 || r === h2))!]}`;
        case 6: {
            const pairs_with_hole = [h1, h2].filter((r) => board_ranks.includes(r));
            if (!pocket_pair && pairs_with_hole.length === 2) return "Two pair (both your cards)";
            if (pocket_pair && board_sorted.some((r) => count(r) === 2)) return `${PLURAL[h1]} with a paired board`;
            if (pairs_with_hole.length === 1) return "Two pair (one pair on the board)";
            return "Two pair on the board";
        }
        case 7: {
            if (pocket_pair) {
                if (value(h1) > value(top)) return `Overpair (${PLURAL[h1]})`;
                return `Pocket ${PLURAL[h1]} below the board's top card`;
            }
            const paired = [h1, h2].find((r) => board_ranks.includes(r));
            if (!paired) return `Pair on the board only, ${RANK_NAME[[h1, h2].sort((a, b) => value(b) - value(a))[0]]} high`;
            const kicker = paired === h1 ? h2 : h1;
            const index = board_sorted.indexOf(paired);
            if (index === 0) return `Top pair, ${RANK_NAME[kicker]} kicker`;
            if (index === 1) return `Second pair (${PLURAL[paired]})`;
            return `Low pair (${PLURAL[paired]})`;
        }
        default: {
            const high = [h1, h2].sort((a, b) => value(b) - value(a))[0];
            const overcards = [h1, h2].filter((r) => value(r) > value(top)).length;
            return `${RANK_NAME[high]} high${overcards ? `, ${overcards} overcard${overcards > 1 ? "s" : ""}` : ""}`;
        }
    }
}

/** Describes hero's hand, draws and outs. Preflop (no board) it just names the starting hand. */
export function describeHand(hole: string[], board: string[]): HandStrength {
    if (board.length < 3) {
        const cls = classOf(hole);
        const made = cls.length === 2 ? `Pocket ${PLURAL[cls[0]]}` : `${cls} (${cls[2] === "s" ? "suited" : "offsuit"})`;
        return { made, draws: [], outs: 0, hit_next: 0, hit_by_river: 0 };
    }
    const made = describeMade(hole, board);
    const cat = category(evaluate([...hole, ...board].map(code)));
    const draws: string[] = [];
    const outs = new Set<string>();
    const known = new Set([...hole, ...board]);

    if (board.length < 5 && cat > 3) {
        // flush draw: four of a suit that includes at least one hole card
        for (const suit of SUITS) {
            const all = [...hole, ...board].filter((c) => c[1] === suit);
            const mine = hole.filter((c) => c[1] === suit);
            if (all.length === 4 && mine.length > 0) {
                const best_mine = mine.map((c) => c[0]).sort((a, b) => value(b) - value(a))[0];
                const higher_missing = [...RANKS].filter((r) => value(r) > value(best_mine) && !known.has(r + suit));
                draws.push(higher_missing.length === 0 ? "Nut flush draw" : "Flush draw");
                for (const r of RANKS) if (!known.has(r + suit)) outs.add(r + suit);
            }
        }
    }
    if (board.length < 5 && cat > 4) {
        // straight draws: ranks that would complete a straight using a hole card
        const mine = rankSet([...hole, ...board]);
        const board_only = rankSet(board);
        const completing: string[] = [];
        for (const r of RANKS) {
            const with_card = new Set(mine);
            const v = value(r);
            with_card.add(v);
            if (v === 14) with_card.add(1);
            const board_with = new Set(board_only);
            board_with.add(v);
            if (v === 14) board_with.add(1);
            if (hasStraight(with_card) && !hasStraight(board_with)) completing.push(r);
        }
        if (completing.length >= 2) draws.push("Open-ended straight draw");
        else if (completing.length === 1) draws.push("Gutshot straight draw");
        for (const r of completing) for (const s of SUITS) if (!known.has(r + s)) outs.add(r + s);
    }

    const unseen = 52 - hole.length - board.length;
    const n = outs.size;
    const hit_next = n / unseen;
    const hit_by_river = board.length === 3 ? 1 - ((unseen - n) * (unseen - n - 1)) / (unseen * (unseen - 1)) : hit_next;
    return { made, draws, outs: n, hit_next, hit_by_river };
}
