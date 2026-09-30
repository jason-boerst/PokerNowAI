// Mixed strategies played with a random number from 1 to 100 (an "RNG"), the way players use solver
// output: every suggestion comes with a roll, and in close spots the roll picks the action. Low numbers
// are the passive options and high numbers the aggressive ones (the "high RNG" convention of solver
// trainers), so a high roll always means "the more aggressive choice".
//
// Where the frequencies come from:
//  1. Only near-equal options mix. At equilibrium a hand mixes only between actions with the same EV; the
//     engine's EVs are estimates, so options within the style's band of the best one count as equal.
//     Anything further behind is never picked: when the exploit is clear, it is played every time.
//  2. Among those, the starting weights follow balanced-range (GTO) rules for the spot, from hero's own
//     range on this board as other players can estimate it:
//       facing a bet: a balanced defense continues with the minimum defense frequency of its range,
//         pot / (pot + bet) (split between the players facing the bet), so hands ranked inside that share
//         continue, hands below it fold, and hands near the line mix;
//       betting: value hands (top pair or better) bet, and bluffs bet as often as the balanced ratio of
//         bluffs to value allows: bet / (pot + bet) bluffs per value bet, draws first, then air. That is
//         the river's ratio; earlier a balanced range bluffs more (its bluffs have equity), but the engine's
//         EVs already count that equity, so these weights for close spots stay on the careful side;
//       preflop: hands at the edge of a chart range (the weakest ones in it, the strongest ones just
//         outside) mix the two actions, which keeps the range's overall frequency the same.
//  3. The weights lean toward the better EV (a softmax with the style's temperature), which keeps the
//     exploit in the mix. A bluff's EV counts the engine's bluff margin less (0.5 BB or 5% of the pot, the
//     margin of error of its fold estimates), so with mixing off the pick is exactly the engine's own, and
//     a bluff that is only barely ahead mixes in rarely instead of being played every time.
//  4. Balance only pays against players who notice patterns and adjust. Against recreational types
//     (calling stations, loose-passive players, maniacs, nits) the band and the preflop edges shrink, so
//     the exploit is played more purely; against regulars and unknown players they stay at full width.
// Frequencies under 5% are dropped (not worth rolling for); the rest are rounded to whole numbers on 1-100.
import { randomInt } from "node:crypto";
import { HandState, HeroView } from "./hand-parser.ts";
import { RangeProfile, strengthClass } from "./equity.ts";
import { Candidate, PostflopAnalysis } from "./postflop.ts";
import { comboCount, HandClass } from "./hand-classes.ts";
import { PLAYABILITY_CLASSES, RANKED_CLASSES } from "./ranges.ts";
import { parseRange } from "./range-notation.ts";
import type { PreflopAdvice, PreflopTier } from "./preflop.ts";

/** off: always the single best option; exploit: mixes only near-ties; balanced (default); gto: mixes more, closer to balanced frequencies. */
export type MixStyle = "off" | "exploit" | "balanced" | "gto";
export type MixAction = "fold" | "check" | "call" | "bet" | "raise" | "all-in";

interface StyleParams {
    /** Post-flop, options within max(band_bb big blinds, band_pot x pot) of the best EV count as equal and mix. */
    band_bb: number,
    band_pot: number,
    /** How strongly the mix leans to the better EV: the softmax temperature as a share of the band (smaller leans more). */
    temperature: number,
    /** How much the balanced-range weights count: 0 = EV only, 1 = fully. */
    prior_power: number,
    /** No option inside the band gets a starting weight below this, so a better EV can still pull toward it. */
    prior_floor: number,
    /** Preflop: share of a range, counted in combos from its edge, whose hands mix with the neighboring action. */
    edge: number
}

/**
 * The styles' settings. Assumptions chosen for this app, not solver output: the balanced band equals the
 * margin the engine already treats as noise in its fold estimates (0.5 BB or 5% of the pot).
 */
export const MIX_STYLES: Record<Exclude<MixStyle, "off">, StyleParams> = {
    exploit: { band_bb: 0.25, band_pot: 0.025, temperature: 0.33, prior_power: 0.5, prior_floor: 0.25, edge: 0.05 },
    balanced: { band_bb: 0.5, band_pot: 0.05, temperature: 0.5, prior_power: 1, prior_floor: 0.15, edge: 0.1 },
    gto: { band_bb: 1, band_pot: 0.1, temperature: 1, prior_power: 1, prior_floor: 0.05, edge: 0.2 }
};

/**
 * How much balance matters against each player type (1 = full band): regulars and aggressive players study
 * and adjust, unknown players might; the recreational types rarely notice patterns, so exploiting them is
 * worth more than balancing. Assumptions following common advice (GTO against unknowns and strong regulars,
 * exploits against weaker players), not measured values. The "gto" style ignores it.
 */
export const BALANCE_NEED: Record<string, number> = {
    TAG: 1, LAG: 1, regular: 1, unknown: 0.75, nit: 0.5, "loose-passive": 0.35, "calling station": 0.35, maniac: 0.35
};

/** The most balance any opponent still in the hand calls for (0.75 when nothing is known). */
export function balanceNeed(types: string[]): number {
    return types.length ? Math.max(...types.map((t) => BALANCE_NEED[t] ?? 0.75)) : 0.75;
}

/** Options mixed less often than this are dropped. */
export const MIN_FREQ = 0.05;
/** Facing a bet, hands within this share of your range on either side of the defense line mix fold and continue. */
const DEFENSE_EDGE = 0.08;
/** Value hands facing a bet: starting split between calling and raising (the EV decides the rest). */
const VALUE_RAISE_SHARE = 0.5;
/**
 * Value hands not facing a bet: the share a balanced range checks anyway, so its checks aren't all weak
 * hands (an assumption; solvers check some strong hands in most spots, more out of position).
 */
const VALUE_CHECK_SHARE = 0.15;
/** Preflop: at least this many combos mix at each edge of a range, so a small range still has one. */
const MIN_EDGE_COMBOS = 4;
/** The engine's margin for bluffs (the same as in postflop.ts): a bluff must beat the passive option by this much to be played every time. */
const BLUFF_MARGIN_BB = 0.5;
const BLUFF_MARGIN_POT = 0.05;

export interface MixOption {
    action: MixAction,
    /** Total bet or raise-to in big blinds (0 for fold, check and call). */
    size_bb: number,
    /** e.g. "raise to 12 BB", "check". */
    label: string,
    /** The engine's EV in big blinds (post-flop). */
    ev_bb?: number,
    /** Share of the time to play it, 0-1 (its RNG range's width / 100). */
    freq: number,
    /** Its RNG range, inclusive, e.g. 1-45. */
    from: number,
    to: number
}

export interface MixStrategy {
    style: MixStyle,
    /** Passive to aggressive; their RNG ranges cover 1-100 in that order. */
    options: MixOption[],
    /** One option at 100%. */
    pure: boolean,
    /** This turn's random number, 1-100. */
    roll: number,
    /** The option the roll lands on. */
    pick: MixOption,
    /** Post-flop: options within this many BB of the best one mix. */
    band_bb?: number,
    /** Post-flop: EV given up on average by mixing instead of always taking the best option (engine estimate, BB). */
    cost_bb?: number,
    /** How a balanced range plays this spot as a whole (shares of your range), e.g. { fold: 0.33, continue: 0.67 }. */
    baseline?: Record<string, number>,
    /** Why these frequencies, in short plain lines. */
    reasons: string[]
}

/** The style from the config: "off", "exploit", "balanced" (default) or "gto"; true/false also work. */
export function parseMixStyle(x: unknown): MixStyle {
    if (x === false) return "off";
    const s = String(x ?? "").trim().toLowerCase();
    if (["off", "false", "none", "no", "0"].includes(s)) return "off";
    if (s === "exploit" || s === "exploitative") return "exploit";
    if (s === "gto") return "gto";
    return "balanced";
}

/** A random whole number from 1 to 100, from the operating system's secure generator. */
export function rollRng(): number {
    return randomInt(1, 101);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const round2 = (x: number) => Math.round(x * 100) / 100;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const aggressive = (a: string) => a === "bet" || a === "raise" || a === "all-in";

const RANK: Record<MixAction, number> = { fold: 0, check: 1, call: 2, bet: 3, raise: 3, "all-in": 4 };
/** Passive first; bets and raises by size; all-in last. */
function byAggression(a: { action: MixAction, size_bb: number }, b: { action: MixAction, size_bb: number }): number {
    return RANK[a.action] - RANK[b.action] || a.size_bb - b.size_bb;
}

/**
 * Drops options under MIN_FREQ, rescales the rest, orders them passive to aggressive and gives each a
 * range of whole numbers on 1-100 (largest remainders get the leftover numbers).
 */
export function withRanges<T extends { action: MixAction, size_bb: number, freq: number }>(opts: T[]): (T & { from: number, to: number })[] {
    const valid = opts.filter((o) => Number.isFinite(o.freq) && o.freq > 0);
    if (!valid.length) throw new Error("a mix needs at least one option");
    let kept = valid.filter((o) => o.freq >= MIN_FREQ);
    if (!kept.length) kept = [valid.reduce((a, b) => (b.freq > a.freq ? b : a))];
    kept = [...kept].sort(byAggression);
    const total = kept.reduce((s, o) => s + o.freq, 0);
    const exact = kept.map((o) => o.freq / total * 100);
    const counts = exact.map((x) => Math.floor(x));
    let left = 100 - counts.reduce((s, x) => s + x, 0);
    const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
    for (let k = 0; left > 0; k = (k + 1) % order.length, left--) counts[order[k].i]++;
    // every kept option keeps at least one number (possible only when many options sit near 5%)
    for (let i = 0; i < counts.length; i++) {
        if (counts[i] > 0) continue;
        const donor = counts.indexOf(Math.max(...counts));
        counts[donor]--;
        counts[i]++;
    }
    let from = 1;
    return kept.map((o, i) => {
        const out = { ...o, freq: counts[i] / 100, from, to: from + counts[i] - 1 };
        from += counts[i];
        return out;
    });
}

/** The option whose range holds the roll. */
export function pickByRoll<T extends { from: number, to: number }>(options: T[], roll: number): T {
    const r = clamp(Math.round(roll), 1, 100);
    return options.find((o) => r >= o.from && r <= o.to) ?? options[options.length - 1];
}

/** e.g. "check 1-62 · bet 4 BB 63-100", or "call at any roll". */
export function describeMix(m: MixStrategy): string {
    if (m.pure) return `${m.options[0].label} at any roll`;
    return m.options.map((o) => `${o.label} ${o.from === o.to ? o.from : `${o.from}-${o.to}`}`).join(" · ");
}

function pure(style: MixStyle, option: Omit<MixOption, "freq" | "from" | "to">, roll: number, reasons: string[], extra: Partial<MixStrategy> = {}): MixStrategy {
    const only: MixOption = { ...option, freq: 1, from: 1, to: 100 };
    return { style, options: [only], pure: true, roll, pick: only, reasons, ...extra };
}

// ---------------------------------------------------------------------------------------------
// Post-flop

export interface PostflopMixInput {
    analysis: PostflopAnalysis,
    state: HandState,
    view: HeroView,
    style: MixStyle,
    roll: number,
    /** Hero's range on this board as the others can estimate it, with hero's hand placed in it (rangeProfile). */
    hero_range?: RangeProfile,
    /** Player types of the opponents still in the hand (e.g. "calling station", "TAG"), for balanceNeed. */
    opponent_types?: string[]
}

/** The band's scale for these opponents (1 for the gto style), and a reason line when it is narrowed. */
function need(style: MixStyle, types: string[] | undefined): { scale: number, line?: string } {
    if (style === "gto") return { scale: 1 };
    const scale = balanceNeed(types ?? []);
    // everyone left is a type that rarely adjusts
    if (scale >= 0.75) return { scale };
    const names = [...new Set(types ?? [])];
    const who = names.length === 1 ? `a ${names[0]}` : "players like these";
    const verb = names.length === 1 ? "doesn't" : "don't";
    return { scale, line: `Against ${who}, who ${verb} adjust to patterns, the exploit is worth more than balance, so only near-ties mix.` };
}

/** Balanced-range starting weights for each option, what a balanced range does here as a whole, and why. */
interface Priors {
    weight: Map<Candidate, number>,
    baseline?: Record<string, number>,
    lines: string[]
}

/** Players who still answer the current bet (hero included) plus those who already called it. */
function defendersOf(s: HandState, last_index: number, bettor: string | undefined): number {
    const called = new Set(s.actions.slice(last_index + 1).filter((a) => a.street === s.street && a.type === "call").map((a) => a.player_id));
    return Math.max(1, s.seats.filter((p) => p.id !== bettor && !p.folded && (!p.all_in || called.has(p.id))).length);
}

/**
 * Bluffs a balanced range makes per value bet for a bet of `risk` into `pot`: bet / (pot + bet), which makes a
 * bluff-catcher indifferent on the river (1 per 2 value bets for a pot-size bet, 1 per 3 for half the pot).
 */
function bluffRatio(risk: number, pot: number): number {
    return risk / Math.max(pot + risk, 1e-9);
}

/**
 * How often a bluff candidate like hero's hand bets (or raises) in a balanced range: the range makes
 * `value x ratio` bluffs (fewer into several players), taken from draws first on the flop and turn, then air.
 * A medium pair bets as a bluff only once the draws and air are used up, and never bluff-raises (it calls or folds).
 */
function bluffShare(r: RangeProfile, value: number, ratio: number, street: string, opponents: number, hero: "draw" | "air" | "medium", raise: boolean): number {
    const needed = value * ratio / Math.max(1, opponents);
    const draws = street === "river" ? 0 : r.draw;
    const air = street === "river" ? r.air + r.draw : r.air;
    if (hero === "draw" && street !== "river") return draws > 0 ? clamp(needed / draws, 0, 1) : 1;
    if (hero === "air" || (hero === "draw" && street === "river")) return air > 0 ? clamp((needed - draws) / air, 0, 1) : 0;
    if (raise) return 0;
    return r.medium > 0 ? clamp((needed - draws - air) / r.medium, 0, 1) : 0;
}

/** Which bluff group hero's hand is in when it bets without value: a draw, air, or a made hand used as a bluff. */
function heroGroup(hero_class: string | undefined): "draw" | "air" | "medium" {
    if (hero_class === "draw") return "draw";
    if (hero_class === "pair" || hero_class === "strong") return "medium";
    return "air";
}

function sizeText(risk: number, pot: number): string {
    const share = risk / Math.max(pot, 1e-9);
    if (share >= 1.25) return "overbet";
    if (share >= 0.85) return "pot-size bet";
    if (share >= 0.55) return "two-thirds-pot bet";
    if (share >= 0.4) return "half-pot bet";
    return "small bet";
}

function ratioText(ratio: number): string {
    if (ratio >= 1) return `${Math.round(ratio * 10) / 10} bluffs per value bet`;
    return `1 bluff per ${Math.round(1 / Math.max(ratio, 1e-9) * 10) / 10} value bets`;
}

function gtoPriors(a: PostflopAnalysis, s: HandState, v: HeroView, close: Candidate[], r: RangeProfile | undefined, hero_class: string | undefined): Priors {
    const weight = new Map<Candidate, number>();
    const lines: string[] = [];
    const street = a.street ?? "flop";
    const opponents = Math.max(1, v.active_opponents.length);
    const facing = v.to_call > 1e-9;
    const group = heroGroup(hero_class);

    if (facing) {
        // the last bet or raise on this street: what it risked and the pot it went into
        let last_index = -1;
        s.actions.forEach((x, i) => { if (x.street === s.street && (x.type === "bet" || x.type === "raise")) last_index = i; });
        const last = last_index >= 0 ? s.actions[last_index] : undefined;
        const risk = last && last.amount > 0 ? last.amount : v.to_call;
        const pot_before = last ? last.pot_before : Math.max(v.pot - v.to_call, 1e-9);
        const mdf = pot_before / (pot_before + risk);
        const k = defendersOf(s, last_index, last?.player_id);
        const mdf_each = 1 - Math.pow(1 - mdf, 1 / k);
        let g_continue = mdf_each;
        let where = "";
        if (r?.above !== undefined) {
            const q = r.above + (r.tied ?? 0) / 2;
            g_continue = clamp((mdf_each - q) / (2 * DEFENSE_EDGE) + 0.5, 0, 1);
            where = q <= mdf_each - DEFENSE_EDGE ? `your hand is in the top ${pct(Math.max(q, 0.01))} of your range, inside that`
                : q >= mdf_each + DEFENSE_EDGE ? `your hand ranks below that (top ${pct(Math.min(q, 1))} of your range)`
                : `your hand is right at that line (top ${pct(q)} of your range)`;
        }
        const share = k > 1 ? `, shared by ${k} players` : "";
        lines.push(`A balanced defense continues with ${pct(mdf_each)} of its range against this ${sizeText(risk, pot_before)} (minimum defense frequency${share})${where ? `; ${where}` : ""}.`);
        // bluff-raises: a balanced raising range adds bluffs to its value raises (half of its two pair or better)
        const raise_ratio = (c: Candidate) => bluffRatio(Math.max(c.to - (s.seats.find((p) => p.id === s.hero_id)?.street_contribution ?? 0), 0), v.pot + v.to_call);
        for (const c of close) {
            if (c.action === "fold") weight.set(c, 1 - g_continue);
            else if (c.action === "call") weight.set(c, g_continue * (1 - VALUE_RAISE_SHARE));
            else if (c.purpose === "value") weight.set(c, g_continue * VALUE_RAISE_SHARE);
            else weight.set(c, r ? bluffShare(r, r.strong * VALUE_RAISE_SHARE, raise_ratio(c), street, opponents, group, true) : 0.25);
        }
        // a call is the whole continue share when no raise is in the close set
        const call = close.find((c) => c.action === "call");
        if (call && !close.some((c) => aggressive(c.action) && c.purpose === "value")) weight.set(call, g_continue);
        return { weight, baseline: { fold: 1 - mdf_each, continue: mdf_each }, lines };
    }

    // not facing a bet: value bets, bluffs in the balanced ratio to them, and checks
    const bets = close.filter((c) => aggressive(c.action));
    const reference = bets.length ? bets.reduce((x, c) => (c.ev > x.ev ? c : x)) : a.candidates.find((c) => aggressive(c.action));
    // the value hands a balanced range actually bets (it checks a few)
    const value_bets = r ? r.value * (1 - VALUE_CHECK_SHARE) : 0;
    const g_of = (c: Candidate): number => {
        if (c.purpose === "value") return 1 - VALUE_CHECK_SHARE;
        if (!r) return 0.5;
        return bluffShare(r, value_bets, bluffRatio(c.to, v.pot), street, opponents, group, false);
    };
    let family = 0;
    for (const c of bets) family += g_of(c);
    family = bets.length ? family / bets.length : 0;
    for (const c of close) weight.set(c, aggressive(c.action) ? g_of(c) / Math.max(1, bets.length) : 1 - family);
    let baseline: Record<string, number> | undefined;
    if (r && reference) {
        const ratio = bluffRatio(reference.to, v.pot);
        const bluffs = Math.min(value_bets * ratio / opponents, r.air + r.draw);
        const bet = clamp(value_bets + bluffs, 0, 1);
        baseline = { check: 1 - bet, bet };
        const size = sizeText(reference.to, v.pot);
        if (reference.purpose === "value") {
            lines.push(`Value hand: a balanced range bets its value hands (top pair or better, ${pct(r.value)} of your range here) most of the time and checks a few, so its checks aren't all weak.`);
        } else {
            const what = group === "draw" && street !== "river" ? "draws" : group === "medium" ? "medium pairs" : "hands with no pair or draw";
            lines.push(`A balanced range bets about ${pct(bet)} here: most of its value (${pct(r.value)} of your range) plus ${ratioText(ratio / opponents)} with a ${size}, so ${what} like yours bet about ${pct(g_of(reference))} of the time.`);
        }
    }
    return { weight, baseline, lines };
}

/**
 * The mixed strategy for a post-flop decision: which options mix, how often, and which one this roll picks.
 * With style "off", or when one option is clearly best, it is a single option at every roll.
 */
export function mixPostflop(input: PostflopMixInput): MixStrategy {
    const { analysis: a, state: s, view: v, roll } = input;
    const bb = s.big_blind || 1;
    const fmt = (chips: number) => `${Math.round(chips / bb * 10) / 10} BB`;
    const optionOf = (c: Candidate) => ({ action: c.action as MixAction, size_bb: c.to > 0 ? round2(c.to / bb) : 0, label: c.label, ev_bb: round2(c.ev / bb) });
    // never fold when checking is free (the engine doesn't offer it, but an outside analysis might)
    const cands = a.candidates.filter((c) => !(c.action === "fold" && v.to_call <= 1e-9));
    // "off": the engine's own pick (its first option, after its bluff margin rule)
    if (input.style === "off") return pure("off", optionOf(cands[0]), roll, []);
    const p = MIX_STYLES[input.style];
    const balance = need(input.style, input.opponent_types);
    const band = Math.max(p.band_bb * bb, p.band_pot * v.pot) * balance.scale;
    // a bluff counts the engine's margin less: its fold estimates are the least certain numbers in the model
    // (the same margin the engine uses to pass on thin bluffs, so the best option below is the engine's own pick)
    const margin = Math.max(BLUFF_MARGIN_BB * bb, BLUFF_MARGIN_POT * v.pot);
    const bluff = (c: Candidate) => aggressive(c.action) && c.purpose !== undefined && c.purpose !== "value";
    const adj = (c: Candidate) => c.ev - (bluff(c) ? margin : 0);
    const anchor = cands.reduce((x, c) => (adj(c) > adj(x) ? c : x));
    const raw_best = cands.reduce((x, c) => (c.ev > x.ev ? c : x));
    const close = cands.filter((c) => adj(anchor) - adj(c) <= band + 1e-9);
    const hero_class = s.hero_cards.length === 2 && s.board.length >= 3 ? strengthClass(s.hero_cards, s.board) : undefined;
    const priors = gtoPriors(a, s, v, close, input.hero_range, hero_class);
    const extra = { band_bb: round2(band / bb), baseline: priors.baseline };
    // the bluff shading only changes the comparison when a bluff mixes with something that isn't one
    const shaded = close.some(bluff) && !close.every(bluff) ? `, with bluffs counted ${fmt(margin)} lower` : "";
    // a bluff that is best on the raw numbers but not after the shading: say so (it replaces the close-spot line)
    const lead: string[] = [];
    if (bluff(raw_best) && raw_best !== anchor) {
        lead.push(`A ${raw_best.purpose} (${raw_best.label}) is ahead of ${anchor.label} by only ${fmt(raw_best.ev - anchor.ev)} on the engine's numbers, inside the ${fmt(margin)} margin of error of its fold estimate, so ${close.includes(raw_best) ? `the roll picks between them, leaning to ${anchor.label}` : `${anchor.label} is the play`}.`);
    }
    // the balanced-range numbers explain the split only when the roll picks between different actions
    // (not between sizes of one bet, nor in a clear spot, where the exploit outweighs balance)
    const family = (c: Candidate) => (aggressive(c.action) ? "aggressive" : c.action);
    const families = new Set(close.map(family)).size;
    const tail = [...(families > 1 ? priors.lines : []), ...(balance.line ? [balance.line] : [])];
    if (close.length === 1) {
        const others = cands.filter((c) => c !== anchor);
        const gap = others.length ? ` by ${fmt(adj(anchor) - Math.max(...others.map(adj)))}${others.some(bluff) ? ` (bluffs counted ${fmt(margin)} lower)` : ""}` : "";
        const why = lead.length ? lead : [`Clear spot: ${anchor.label} is ahead of every other option${gap}, more than the ${fmt(band)} margin, so play it at any roll.`];
        return pure(input.style, optionOf(anchor), roll, [...why, ...tail], { ...extra, cost_bb: 0 });
    }
    // balanced-range weights, leaning toward the better EV; only the best option gets the minimum weight, so an
    // option the balanced range never takes here (a medium pair's bluff) is played only when it is the engine's pick
    const tau = Math.max(1e-9, p.temperature * band);
    const raw = close.map((c) => {
        const g = priors.weight.get(c) ?? 0.5;
        const start = c === anchor ? Math.max(g, p.prior_floor) : g;
        const w = start > 0 ? Math.pow(start, p.prior_power) * Math.exp(-(adj(anchor) - adj(c)) / tau) : 0;
        return { c, w };
    });
    const total = raw.reduce((sum, x) => sum + x.w, 0);
    const ranged = withRanges(raw.filter((x) => x.w > 0).map(({ c, w }) => ({ ...optionOf(c), freq: w / total, cand: c })));
    const options: MixOption[] = ranged.map(({ cand, ...o }) => o);
    // EV given up against the engine's own pick, with bluffs at their shaded value
    const cost = ranged.reduce((sum, o) => sum + o.freq * (adj(anchor) - adj(o.cand)), 0) / bb;
    const pick = pickByRoll(options, roll);
    if (options.length === 1) {
        const others = close.filter((c) => c.label !== pick.label).map((c) => c.label);
        return pure(input.style, { action: pick.action, size_bb: pick.size_bb, label: pick.label, ev_bb: pick.ev_bb }, roll,
            [...lead, `Close spot, but a balanced range plays ${pick.label} here; ${others.join(" and ")} would come up under ${pct(MIN_FREQ)} of the time, so play ${pick.label} at any roll.`, ...tail],
            { ...extra, cost_bb: round2(cost) });
    }
    const spread = Math.max(...ranged.map((o) => adj(o.cand))) - Math.min(...ranged.map((o) => adj(o.cand)));
    const names = options.map((o) => o.label);
    const list = names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    const apart = spread < 0.05 * bb ? "about equal" : `within ${fmt(spread)} of each other`;
    const why = lead.length ? lead : [`Close spot: ${list} are ${apart} on the engine's numbers${shaded} (margin ${fmt(band)}), so the roll picks.`];
    const reasons = [...why, ...tail];
    return { style: input.style, options, pure: false, roll, pick, ...extra, cost_bb: round2(cost), reasons };
}

// ---------------------------------------------------------------------------------------------
// Preflop

export interface PreflopMixInput {
    advice: PreflopAdvice,
    /** Hero's hand class, e.g. "AQo". */
    cls: HandClass,
    style: MixStyle,
    roll: number,
    /** The pot before hero acts, in big blinds (for the price band). */
    pot_bb: number,
    /** Player types of the opponents still in the hand, for balanceNeed. */
    opponent_types?: string[]
}

const parsed = new Map<string, Set<HandClass>>();
function rangeSet(notation: string): Set<HandClass> {
    let set = parsed.get(notation);
    if (!set) { set = parseRange(notation); parsed.set(notation, set); }
    return set;
}

/** Classes of each tier: in its ranges and in no tier above it; the last tier is everything else. */
function tierMembers(tiers: PreflopTier[]): Set<HandClass>[] {
    const taken = new Set<HandClass>();
    return tiers.map((t, i) => {
        const members = new Set<HandClass>();
        const all = i === tiers.length - 1 && t.ranges.length === 0;
        for (const cls of RANKED_CLASSES) {
            if (taken.has(cls)) continue;
            if (all || t.ranges.some((n) => rangeSet(n).has(cls))) members.add(cls);
        }
        for (const cls of members) taken.add(cls);
        return members;
    });
}

/**
 * Chance of taking the upper tier's action for a hand at the boundary between two tiers: the weakest
 * `edge` combos of the upper tier go from 50% (weakest) to 100%, and as many of the strongest combos of the
 * lower tier from 50% (strongest) to 0. Symmetric, so the upper tier's overall frequency stays the same.
 * Null when the hand is not near this boundary.
 */
function edgeChance(upper: Set<HandClass>, lower: Set<HandClass>, order: HandClass[], cls: HandClass, edge_share: number): number | null {
    const up_list = order.filter((c) => upper.has(c));
    const size = up_list.reduce((sum, c) => sum + comboCount(c), 0);
    if (size === 0) return null;
    const edge = Math.max(edge_share * size, MIN_EDGE_COMBOS);
    if (upper.has(cls)) {
        // combos of the upper tier ranked below this hand, to its middle
        const i = up_list.indexOf(cls);
        const depth = up_list.slice(i + 1).reduce((sum, c) => sum + comboCount(c), 0) + comboCount(cls) / 2;
        return depth < edge ? 0.5 + 0.5 * depth / edge : null;
    }
    if (lower.has(cls)) {
        const low_list = order.filter((c) => lower.has(c));
        const i = low_list.indexOf(cls);
        const height = low_list.slice(0, i).reduce((sum, c) => sum + comboCount(c), 0) + comboCount(cls) / 2;
        return height < edge ? 0.5 - 0.5 * height / edge : null;
    }
    return null;
}

/**
 * The mixed strategy for a preflop chart decision: hands at the edges of the chart's ranges mix with the
 * neighboring action (as solver charts do), and a call priced within the band mixes with folding.
 */
export function mixPreflop(input: PreflopMixInput): MixStrategy {
    const { advice, cls, roll } = input;
    const base = { action: advice.action as MixAction, size_bb: advice.action === "raise" || advice.action === "all-in" ? advice.size_bb : 0, label: labelOf(advice.action, advice.size_bb) };
    if (input.style === "off") return pure("off", base, roll, []);
    const p = MIX_STYLES[input.style];
    const tiers = advice.tiers;
    const clear = (why: string) => pure(input.style, base, roll, [why]);
    // facing a 4-bet or an all-in, and 7-2 bounty plays, have no chart edges to mix
    if (!tiers || tiers.length < 2) return clear(`The chart plays ${cls} the same way every time here, so play it at any roll.`);
    const members = tierMembers(tiers);
    const i = members.findIndex((m) => m.has(cls));
    // the advice isn't the tier's usual action (a set-mining fold, a deep-stack fold, a price override): keep it
    if (i < 0 || tiers[i].action !== advice.action) return clear(`The chart has a specific reason for this play with ${cls}, so play it at any roll.`);
    const orderOf = (t: PreflopTier) => (t.order === "playability" ? PLAYABILITY_CLASSES : RANKED_CLASSES);
    const balance = need(input.style, input.opponent_types);
    const edge = p.edge * balance.scale;
    const up = i > 0 ? edgeChance(members[i - 1], members[i], orderOf(tiers[i - 1]), cls, edge) : null;
    const down_keep = i < tiers.length - 1 ? edgeChance(members[i], members[i + 1], orderOf(tiers[i]), cls, edge) : null;
    let f_up = up ?? 0;
    let f_down = down_keep === null ? 0 : 1 - down_keep;
    if (f_up + f_down > 1) { const t = f_up + f_down; f_up /= t; f_down /= t; }
    const f_self = 1 - f_up - f_down;

    const raw: { action: MixAction, size_bb: number, label: string, freq: number }[] = [];
    const add = (t: PreflopTier, freq: number) => {
        if (freq <= 0) return;
        const size = t.action === "raise" || t.action === "all-in" ? t.size_bb : 0;
        const existing = raw.find((o) => o.action === t.action && o.size_bb === size);
        if (existing) existing.freq += freq;
        else raw.push({ action: t.action as MixAction, size_bb: size, label: labelOf(t.action, t.size_bb), freq });
    };
    if (i > 0) add(tiers[i - 1], f_up);
    // a priced call or fold (hero closes the action) splits its share by EV when the price is close
    const price = advice.price;
    const band_bb = Math.max(p.band_bb, p.band_pot * input.pot_bb) * balance.scale;
    if (price && (advice.action === "call" || advice.action === "fold") && Math.abs(price.ev_bb) <= band_bb) {
        const tau = Math.max(1e-9, p.temperature * band_bb);
        const w_call = Math.exp(price.ev_bb / tau), w_fold = 1;
        const call_share = w_call / (w_call + w_fold);
        raw.push({ action: "call", size_bb: 0, label: "call", freq: f_self * call_share });
        raw.push({ action: "fold", size_bb: 0, label: "fold", freq: f_self * (1 - call_share) });
    } else {
        add(tiers[i], f_self);
    }
    if (i < tiers.length - 1) add(tiers[i + 1], f_down);
    const options = withRanges(raw);
    const pick = pickByRoll(options, roll);
    if (options.length === 1) {
        return pure(input.style, { action: pick.action, size_bb: pick.size_bb, label: pick.label }, roll,
            [`${cls} is well inside the range for this play, so play it at any roll.`, ...(balance.line ? [balance.line] : [])]);
    }
    const reasons: string[] = [];
    const does = (t: PreflopTier) => TIER_VERB[t.reason] ?? `plays ${t.reason}`;
    if (f_up >= MIN_FREQ) reasons.push(`${cls} is one of the strongest hands just outside the ${tiers[i - 1].reason} range, so it ${does(tiers[i - 1])} some of the time (solver charts mix hands at the edges of each range).`);
    if (f_down >= MIN_FREQ) reasons.push(`${cls} is one of the weakest hands in the ${tiers[i].reason} range, so it ${does(tiers[i + 1])} some of the time instead (solver charts mix hands at the edges of each range).`);
    if (price && options.some((o) => o.action === "call") && options.some((o) => o.action === "fold")) {
        reasons.push(`Close price: calling is worth about ${price.ev_bb >= 0 ? "+" : ""}${round2(price.ev_bb)} BB, within ${round2(band_bb)} BB of folding, so the roll decides.`);
    }
    if (balance.line) reasons.push(balance.line);
    return { style: input.style, options, pure: false, roll, pick, reasons };
}

/** What a hand does in each chart tier, for reasons ("so it opens some of the time"). */
const TIER_VERB: Record<string, string> = {
    "open": "opens", "heads-up open": "opens", "3-bet for value": "3-bets", "4-bet for value": "4-bets",
    "raise to isolate": "raises", "raise over the limp": "raises", "call": "calls", "complete": "completes",
    "limp behind": "limps behind", "fold": "folds", "check": "checks"
};

/** "raise to 7.5 BB", "all-in", "call", "fold", "check". */
function labelOf(action: string, size_bb: number): string {
    if (action === "raise") return `raise to ${round2(size_bb)} BB`;
    if (action === "all-in") return "all-in";
    return action;
}
