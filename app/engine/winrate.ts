export interface WinrateSummary {
    hands: number,
    /** Total won or lost, in big blinds. */
    total_bb: number,
    bb_per_100: number,
    /** Standard deviation in bb/100 (per-100-hands scale, the usual poker convention). */
    sd_per_100: number,
    /** 95% confidence interval for the true bb/100. */
    ci_low: number,
    ci_high: number,
    /** True when the interval includes both winning and losing, i.e. the sample can't tell yet. */
    inconclusive: boolean
}

/** Summarizes per-hand results (in big blinds) as a win rate with a 95% confidence interval. */
export function summarizeWinrate(results_bb: number[]): WinrateSummary {
    const n = results_bb.length;
    const total = results_bb.reduce((a, b) => a + b, 0);
    const mean = n > 0 ? total / n : 0;
    const variance = n > 1 ? results_bb.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
    const sd_hand = Math.sqrt(variance);
    const half_width = n > 1 ? 1.96 * sd_hand / Math.sqrt(n) * 100 : Infinity;
    const bb_per_100 = mean * 100;
    const ci_low = bb_per_100 - half_width;
    const ci_high = bb_per_100 + half_width;
    return {
        hands: n,
        total_bb: total,
        bb_per_100,
        sd_per_100: sd_hand * 10, // sd over 100 hands = sd_hand * sqrt(100)
        ci_low,
        ci_high,
        inconclusive: !(ci_low > 0 || ci_high < 0)
    };
}
