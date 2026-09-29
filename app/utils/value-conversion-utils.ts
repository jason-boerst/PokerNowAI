export function convertToBBs(bet_amount: number, stakes: number): number {
    // round to 2 decimals to avoid floating-point noise like 98.49999999999999
    return Math.round(bet_amount / stakes * 100) / 100;
}

export function convertToValue(bet_amount: number, stakes: number): number {
    // round to cents so decimal stakes (e.g. 0.1/0.2) are not truncated to 0
    return Math.round(bet_amount * stakes * 100) / 100;
}