import { ActionRecord, HandState, HeroView, heroView, parseHand } from "./hand-parser.ts";

export function bb(chips: number, big_blind: number): number {
    return Math.round(chips / big_blind * 100) / 100;
}

/** One-line summary of hero's spot, e.g. "HJ | flop [Ks 7d 2c] | pot 6 BB | to call 2 BB (pot odds 25%) | ...". */
export function formatSpot(s: HandState, v: HeroView): string {
    const inBB = (chips: number) => `${bb(chips, s.big_blind)} BB`;
    const parts = [
        v.position,
        `${s.street}${s.board.length ? ` [${s.board.join(" ")}]` : ""}`,
        `pot ${inBB(v.pot)}`,
        v.to_call > 0 ? `to call ${inBB(v.to_call)} (pot odds ${Math.round(v.pot_odds * 100)}%)` : "no bet to call",
        v.min_raise_to !== null ? `min raise to ${inBB(v.min_raise_to)}` : "can't raise",
        `eff. stack ${inBB(v.effective_stack)}`,
        `SPR ${Math.round(v.spr * 10) / 10}`,
        `${v.active_opponents.length} opponent(s)`
    ];
    if (s.street === "preflop" && v.limpers > 0) parts.push(`${v.limpers} limper(s)`);
    return parts.join(" | ");
}

function describeAction(a: ActionRecord, s: HandState): string {
    const amount = bb(a.street_total, s.big_blind);
    switch (a.type) {
        case "post_sb": return `posts SB ${amount}`;
        case "post_bb": return `posts BB ${amount}`;
        case "post_straddle": return `straddles ${amount}`;
        case "post_dead": return `posts dead ${bb(a.amount, s.big_blind)}`;
        case "fold": return "folds";
        case "check": return "checks";
        case "call": return `calls ${amount}${a.all_in ? " (all-in)" : ""}`;
        case "bet": return `bets ${amount}${a.all_in ? " (all-in)" : ""}`;
        case "raise": return `raises to ${amount}${a.all_in ? " (all-in)" : ""}`;
    }
}

/** Action history by street with positions and amounts in BB, hero marked. */
export function formatActions(s: HandState): string[] {
    const pos = new Map(s.seats.map((p) => [p.id, p.id === s.hero_id ? `${p.position} (you)` : p.position]));
    const lines: string[] = [];
    let street = "";
    let current: string[] = [];
    for (const a of s.actions) {
        if (a.street !== street) {
            if (current.length) lines.push(`${street}: ${current.join(", ")}`);
            street = a.street;
            current = [];
        }
        current.push(`${pos.get(a.player_id) ?? "?"} ${describeAction(a, s)}`);
    }
    if (current.length) lines.push(`${street}: ${current.join(", ")}`);
    return lines;
}

/** Rebuilds the state and hero view of a recorded decision. */
export function spotFromRecord(messages: string[], hero_name: string, hero_cards: string, big_blind: number): { state: HandState, view: HeroView | null } {
    const state = parseHand(messages, { hero_name, hero_cards: hero_cards ? hero_cards.split(/\s+/).filter(Boolean) : [], big_blind });
    return { state, view: heroView(state) };
}
