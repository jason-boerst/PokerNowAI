// Small statistics helpers for the evaluation report: intervals for a sum of per-spot results.
import { seededRandom } from "../engine/cards.ts";

export interface SumInterval {
    n: number,
    total: number,
    /** 95% interval for the total from the normal approximation (sum +- 1.96 sd sqrt(n)). */
    normal_low: number,
    normal_high: number,
    /** 95% percentile bootstrap interval for the total (resampling the spots). */
    boot_low: number,
    boot_high: number
}

/** 95% intervals for the sum of `xs`: normal approximation and a seeded percentile bootstrap. */
export function sumInterval(xs: number[], resamples = 4000, seed = 12345): SumInterval {
    const n = xs.length;
    const total = xs.reduce((a, b) => a + b, 0);
    if (n < 2) return { n, total, normal_low: total, normal_high: total, boot_low: total, boot_high: total };
    const mean = total / n;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
    const half = 1.96 * sd * Math.sqrt(n);
    const rand = seededRandom(seed);
    const sums = new Float64Array(resamples);
    for (let r = 0; r < resamples; r++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += xs[Math.floor(rand() * n)];
        sums[r] = s;
    }
    sums.sort();
    return {
        n, total, normal_low: total - half, normal_high: total + half,
        boot_low: sums[Math.floor(0.025 * (resamples - 1))], boot_high: sums[Math.ceil(0.975 * (resamples - 1))]
    };
}
