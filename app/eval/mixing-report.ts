// What mixing with the random number (engine/mixing.ts) does over your replayed decisions: how often a
// spot mixes, what it costs by the engine's own EV estimates, and how the overall action frequencies move
// compared with the engine's single best pick and with the balanced-range (GTO) baselines of each spot.
// Everything here is the engine's model of your games: it shows what mixing changes, not whether it wins.
import type { MixStyle } from "../engine/mixing.ts";
import type { HeroHand, Kind } from "./replay.ts";

const KINDS: Kind[] = ["fold", "check", "call", "raise"];
const STREETS = ["preflop", "flop", "turn", "river"] as const;

export interface MixingReport {
    style: MixStyle,
    hands: number,
    decisions: number,
    /** Per street: decisions, how many mixed (two or more options), and their average number of options. */
    by_street: Record<(typeof STREETS)[number], { decisions: number, mixed: number, options: number }>,
    /** Post-flop EV given up by mixing instead of always taking the best option (engine estimate), BB. */
    cost_bb: number,
    cost_per_100: number,
    /** Share of decisions of each kind: the engine's single pick vs the mix's expected frequencies. */
    kinds: { engine: Record<Kind, number>, mix: Record<Kind, number> },
    /** Post-flop: share of decisions that are bluffs or semi-bluffs. */
    bluffs: { spots: number, engine: number, mix: number },
    /** Post-flop facing a bet: continue rate of the engine, of the mix, and of a balanced defense (MDF). */
    defense: { spots: number, engine: number, mix: number, balanced: number },
    /** Post-flop not facing a bet: bet rate of the engine, of the mix, and of a balanced range. */
    betting: { spots: number, engine: number, mix: number, balanced: number }
}

export function mixingReport(hands: HeroHand[], style: MixStyle): MixingReport {
    const by_street = Object.fromEntries(STREETS.map((st) => [st, { decisions: 0, mixed: 0, options: 0 }])) as MixingReport["by_street"];
    const engine_kinds = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;
    const mix_kinds = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;
    let decisions = 0, cost = 0;
    const bluffs = { spots: 0, engine: 0, mix: 0 };
    const defense = { spots: 0, engine: 0, mix: 0, balanced: 0, balanced_n: 0 };
    const betting = { spots: 0, engine: 0, mix: 0, balanced: 0, balanced_n: 0 };
    for (const h of hands) {
        for (const d of h.decisions) {
            const m = d.engine?.mixes?.[style];
            if (!d.engine || !m) continue;
            decisions++;
            const st = by_street[d.street as keyof typeof by_street];
            if (st) {
                st.decisions++;
                if (!m.pure) { st.mixed++; st.options += m.options.length; }
            }
            engine_kinds[d.engine.kind]++;
            for (const o of m.options) mix_kinds[o.kind] += o.freq;
            if (d.street === "preflop") continue;
            cost += m.cost_bb ?? 0;
            bluffs.spots++;
            if (d.engine.bluff) bluffs.engine++;
            bluffs.mix += m.options.filter((o) => o.bluff).reduce((sum, o) => sum + o.freq, 0);
            const raise_share = m.options.filter((o) => o.kind === "raise").reduce((sum, o) => sum + o.freq, 0);
            if (d.view.to_call > 0) {
                defense.spots++;
                if (d.engine.kind !== "fold") defense.engine++;
                defense.mix += 1 - m.options.filter((o) => o.kind === "fold").reduce((sum, o) => sum + o.freq, 0);
                if (m.baseline?.continue !== undefined) { defense.balanced += m.baseline.continue; defense.balanced_n++; }
            } else {
                betting.spots++;
                if (d.engine.kind === "raise") betting.engine++;
                betting.mix += raise_share;
                if (m.baseline?.bet !== undefined) { betting.balanced += m.baseline.bet; betting.balanced_n++; }
            }
        }
    }
    const share = (x: number, n: number) => (n > 0 ? x / n : 0);
    for (const st of Object.values(by_street)) st.options = st.mixed ? st.options / st.mixed : 0;
    return {
        style, hands: hands.length, decisions, by_street,
        cost_bb: cost, cost_per_100: share(cost, hands.length) * 100,
        kinds: {
            engine: Object.fromEntries(KINDS.map((k) => [k, share(engine_kinds[k], decisions)])) as Record<Kind, number>,
            mix: Object.fromEntries(KINDS.map((k) => [k, share(mix_kinds[k], decisions)])) as Record<Kind, number>
        },
        bluffs: { spots: bluffs.spots, engine: share(bluffs.engine, bluffs.spots), mix: share(bluffs.mix, bluffs.spots) },
        defense: { spots: defense.spots, engine: share(defense.engine, defense.spots), mix: share(defense.mix, defense.spots), balanced: share(defense.balanced, defense.balanced_n) },
        betting: { spots: betting.spots, engine: share(betting.engine, betting.spots), mix: share(betting.mix, betting.spots), balanced: share(betting.balanced, betting.balanced_n) }
    };
}
