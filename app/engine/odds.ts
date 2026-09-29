/** Share of the final pot a call must win to break even. */
export function requiredEquity(to_call: number, pot: number): number {
    return to_call > 0 ? to_call / (pot + to_call) : 0;
}

/** Minimum defense frequency: how often to continue against a bet so a pure bluff doesn't profit automatically. */
export function mdf(bet: number, pot_before_bet: number): number {
    return pot_before_bet / (pot_before_bet + bet);
}

/** How often a bluff of `bet` into `pot_before_bet` must work to break even. */
export function bluffBreakeven(bet: number, pot_before_bet: number): number {
    return bet / (pot_before_bet + bet);
}
