// Where you lose (or win) money, from your stored hands: results by the line you took, how often you take each line
// compared with the players in your games, and the spots where the outcome can be judged exactly (river calls and
// river bluffs). Each finding says what it rests on; results by line are correlational (the cards you were dealt
// decide most of them), the river checks are exact on the hands they cover.
import { strengthClass } from "../engine/equity.ts";
import { HandState, parseHand, SeatState } from "../engine/hand-parser.ts";
import { summarizeWinrate, WinrateSummary } from "../engine/winrate.ts";
import { isHoldem, RATE_KEYS, RateKey } from "../engine/player-profile.ts";
import type { HandRow } from "../services/hand-recorder.ts";
import { ME, type ProfileService } from "../services/profile-service.ts";
import { HeroHand, isHeroHoldemHand, replayHand } from "./replay.ts";

export type LeakArea = "preflop" | "postflop" | "river" | "frequency" | "engine";

export interface LeakLine {
    area: LeakArea,
    /** e.g. "Open from early position". */
    label: string,
    /** Hands or chances behind it. */
    n: number,
    /** Your result (all-in adjusted bb/100) when it is a results line. */
    result?: WinrateSummary,
    /** Your rate and the comparison rate (0-1) when it is a frequency or success-rate line. */
    rate?: number,
    benchmark?: number,
    /** The gap in standard errors: rate minus benchmark for rate lines, the mean result for results lines. */
    z?: number,
    /** Shown as a finding: enough data, and |z| past the bar for the number of lines tested (`LeakReport.z_bar`). */
    flagged: boolean,
    /** What it means, in one line. */
    note: string
}

export interface LeakReport {
    lines: LeakLine[],
    /** Lines with enough data to be tested, and the |z| a line needed to be flagged (Bonferroni: 5% for all of them together). */
    tested: number,
    z_bar: number
}

/** Your stats from your profile ({k, n} per rate) and your games' average player (0-1 per rate). */
export interface RateComparison {
    mine: Partial<Record<RateKey, { k: number, n: number }>>,
    pool: Partial<Record<RateKey, number>>
}

/** Lines need this many hands (or chances) before they can be flagged. */
const MIN_HANDS = 20;
/** A frequency gap smaller than this (share points) isn't worth flagging even when significant. */
const MIN_GAP = 0.08;
/** Chance of one or more false flags across everything tested. */
const FAMILY_ALPHA = 0.05;

/** Standard normal upper-tail probability. */
function upperTail(z: number): number {
    // Abramowitz and Stegun 7.1.26 for erfc, error below 1.5e-7
    const x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
    return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}
/** The z with upper-tail probability p (by bisection). */
export function zFor(p: number): number {
    let lo = 0, hi = 10;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (upperTail(mid) > p) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

/** The profile stats compared with your games' average, and what a gap means. */
const RATE_LINES: { key: RateKey, label: string, note: string }[] = [
    { key: "vpip", label: "Hands played (VPIP)", note: "Share of hands you put money in voluntarily." },
    { key: "pfr", label: "Raises before the flop (PFR)", note: "Share of hands you raise before the flop." },
    { key: "three_bet", label: "3-bets", note: "Re-raises when facing one raise before the flop." },
    { key: "fold_to_three_bet", label: "Folds to a 3-bet", note: "After you raised and got re-raised." },
    { key: "steal", label: "Steal attempts", note: "Raises when folded to you in the cutoff, button or small blind." },
    { key: "fold_to_steal", label: "Blind folds to a steal", note: "In the blinds facing a late-position raise." },
    { key: "cbet", label: "Continuation bets", note: "Flop bets after raising before the flop." },
    { key: "fold_to_cbet", label: "Folds to a continuation bet", note: "Facing the preflop raiser's flop bet." },
    { key: "fold_to_bet_flop", label: "Folds to a flop bet", note: "Facing the first bet of the flop heads-up." },
    { key: "fold_to_bet_turn", label: "Folds to a turn bet", note: "Facing the first bet of the turn heads-up." },
    { key: "fold_to_bet_river", label: "Folds to a river bet", note: "Facing the first bet of the river heads-up." },
    { key: "raise_vs_bet", label: "Raises when facing a bet", note: "After the flop." },
    { key: "went_to_showdown", label: "Went to showdown", note: "Of hands where you saw the flop." },
    { key: "won_at_showdown", label: "Won at showdown", note: "Low with a high showdown rate usually means calling down too light." }
];

type Group = "early" | "middle" | "late" | "SB" | "BB";
function groupOf(position: string): Group {
    if (position === "SB" || position === "BB") return position;
    if (position === "MP" || position.startsWith("UTG")) return "early";
    if (position === "LJ" || position === "HJ") return "middle";
    return "late";
}
const GROUP_NAME: Record<Group, string> = { early: "early position", middle: "middle position", late: "the cutoff or button", SB: "the small blind", BB: "the big blind" };

/** Your preflop line in a hand: what you did facing what. */
function preflopLine(s: HandState, hero: string): string | null {
    const pre = s.actions.filter((a) => a.street === "preflop" && !["post_sb", "post_bb", "post_straddle", "post_dead", "post_ante", "post_bomb"].includes(a.type));
    let raises = 0, limps = 0;
    let line: string | null = null;
    for (const a of pre) {
        const aggressive = a.type === "raise" || a.type === "bet";
        if (a.player_id === hero && line === null) {
            if (raises === 0) line = aggressive ? (limps ? "raise over limpers" : "open") : a.type === "call" ? (limps ? "limp behind" : "open limp") : a.type === "check" ? "check the big blind" : "fold first in";
            else if (raises === 1) line = aggressive ? "3-bet" : a.type === "call" ? "call a raise" : "fold to a raise";
            else line = aggressive ? "4-bet or more" : a.type === "call" ? "call a 3-bet or more" : "fold to a 3-bet or more";
        } else if (a.player_id === hero && line && (line === "open" || line === "raise over limpers") && raises >= 2 && ["fold", "call", "raise"].includes(a.type)) {
            line = a.type === "fold" ? "open, then fold to a 3-bet" : a.type === "call" ? "open, then call a 3-bet" : "open, then 4-bet";
        }
        if (aggressive) raises++;
        else if (a.type === "call" && raises === 0) limps++;
    }
    return line;
}

/**
 * Leak lines from your replayed hands (engine suggestions are used when present), all hands for your games'
 * averages by seat, and optionally your profile stats against the pool's. Results lines are flagged only when
 * losing; rate lines when the gap is large, in either direction unless the line says otherwise. The bar for
 * flagging grows with the number of lines tested, so a long report doesn't flag noise.
 */
export function findLeaks(hands: HeroHand[], states: HandState[] = [], rates?: RateComparison): LeakReport {
    const lines: LeakLine[] = [];
    // how each line may be flagged, decided once the number of tested lines is known
    const rules = new Map<LeakLine, (z_bar: number) => boolean>();
    const result = (area: LeakArea, label: string, xs: number[], note: string) => {
        const w = summarizeWinrate(xs);
        const se = (w.ci_high - w.ci_low) / (2 * 1.96);
        const z = xs.length > 1 && se > 0 && Number.isFinite(se) ? w.bb_per_100 / se : 0;
        const line: LeakLine = { area, label, n: xs.length, result: w, z, flagged: false, note };
        lines.push(line);
        if (xs.length >= MIN_HANDS) rules.set(line, (bar) => z <= -bar);
    };
    const rate = (area: LeakArea, label: string, k: number, n: number, benchmark: number, note: string, flag_low = true, flag_high = true) => {
        const p = n ? k / n : 0;
        const z = n && benchmark > 0 && benchmark < 1 ? (p - benchmark) / Math.sqrt(benchmark * (1 - benchmark) / n) : 0;
        const line: LeakLine = { area, label, n, rate: p, benchmark, z, flagged: false, note };
        lines.push(line);
        if (n >= MIN_HANDS) rules.set(line, (bar) => Math.abs(p - benchmark) >= MIN_GAP && ((z >= bar && flag_high) || (z <= -bar && flag_low)));
    };

    // --- preflop: results by line and position ---
    const by_line = new Map<string, number[]>();
    for (const h of hands) {
        const me = h.full.seats.find((p) => p.id === h.hero_id);
        if (!me) continue;
        const line = preflopLine(h.full, h.hero_id);
        if (!line || line === "fold first in" || line === "fold to a raise" || line === "fold to a 3-bet or more") continue;
        const key = `${line} from ${GROUP_NAME[groupOf(me.position)]}`;
        (by_line.get(key) ?? by_line.set(key, []).get(key)!).push(h.adjusted_bb);
    }
    for (const [key, xs] of [...by_line].sort((a, b) => b[1].length - a[1].length)) {
        result("preflop", key[0].toUpperCase() + key.slice(1), xs, "Your result in these hands (all-in adjusted); correlational: the cards decide much of it.");
    }

    // --- after the flop: results by what you did the first time you faced a bet on each street, and as the
    // preflop raiser on the flop when checked to (or first to act) ---
    const by_spot = new Map<string, number[]>();
    const add = (key: string, x: number) => (by_spot.get(key) ?? by_spot.set(key, []).get(key)!).push(x);
    for (const h of hands) {
        const s = h.full;
        const pre = s.actions.filter((a) => a.street === "preflop" && (a.type === "raise" || a.type === "bet"));
        const raiser = pre.length ? pre[pre.length - 1].player_id : null;
        for (const street of ["flop", "turn", "river"] as const) {
            const acts = s.actions.filter((a) => a.street === street);
            const mine = acts.filter((a) => a.player_id === h.hero_id);
            if (!mine.length) continue;
            const first = mine[0];
            const verb = (a: typeof first) => a.type === "raise" || a.type === "bet" ? "raise" : a.type;
            // c-bet or check, when nobody bet before you
            if (street === "flop" && raiser === h.hero_id && first.bet_to_call_before === 0) add(`As the preflop raiser on the flop: ${verb(first) === "raise" ? "bet" : "check"}`, h.adjusted_bb);
            // the first bet you faced on the street (also after checking). Folds aren't listed: a fold always shows
            // the loss of what you had put in, which says nothing about whether folding was right.
            const facing = mine.find((a) => a.bet_to_call_before > 0);
            if (facing && verb(facing) !== "fold") add(`Facing a ${street} bet: ${verb(facing) === "raise" ? "raise" : "call"}`, h.adjusted_bb);
        }
    }
    for (const [key, xs] of [...by_spot].sort((a, b) => a[0].localeCompare(b[0]))) {
        result("postflop", key, xs, "Your result in these hands (all-in adjusted); correlational: you fold weak hands and continue with strong ones, so compare lines with care.");
    }

    // --- how often you play, against the other players in your games, by position ---
    const pool = poolRates(states, new Set(hands.map((h) => h.hero_id)));
    const mine = { vpip: {} as Record<Group, { k: number, n: number }>, pfr: {} as Record<Group, { k: number, n: number }> };
    for (const h of hands) {
        const me = h.full.seats.find((p) => p.id === h.hero_id);
        if (!me) continue;
        const g = groupOf(me.position);
        const acts = h.full.actions.filter((a) => a.street === "preflop" && a.player_id === h.hero_id);
        const vp = acts.some((a) => a.type === "call" || a.type === "raise" || a.type === "bet");
        const pf = acts.some((a) => a.type === "raise" || a.type === "bet");
        (mine.vpip[g] ??= { k: 0, n: 0 }).n++;
        (mine.pfr[g] ??= { k: 0, n: 0 }).n++;
        if (vp) mine.vpip[g].k++;
        if (pf) mine.pfr[g].k++;
    }
    const SEAT_NOTE = "Against the average other player in your games from the same seat. Different isn't wrong by itself: in loose games playing tighter than average is usually right.";
    for (const g of ["early", "middle", "late", "SB", "BB"] as Group[]) {
        if (mine.vpip[g] && pool.vpip[g]) rate("frequency", `Hands played (VPIP) from ${GROUP_NAME[g]}`, mine.vpip[g].k, mine.vpip[g].n, pool.vpip[g]!, SEAT_NOTE);
        if (mine.pfr[g] && pool.pfr[g]) rate("frequency", `Raises before the flop (PFR) from ${GROUP_NAME[g]}`, mine.pfr[g].k, mine.pfr[g].n, pool.pfr[g]!, SEAT_NOTE);
    }
    // the rest of your profile against your games' average player
    if (rates) {
        for (const r of RATE_LINES) {
            const m = rates.mine[r.key], b = rates.pool[r.key];
            if (!m || !m.n || b === undefined) continue;
            rate("frequency", r.label, m.k, m.n, b, `${r.note} Against the average other player in your games; different isn't wrong by itself.`);
        }
    }

    // --- river: exact checks ---
    // river calls: how often your call won, against how often the price needed it to
    let calls = 0, won = 0, need_sum = 0;
    // river bets with no pair (bluffs): how often everyone folded, against how often the bet needed
    let bluffs = 0, folded = 0, bluff_need = 0;
    for (const h of hands) {
        const s = h.full;
        if (s.board.length < 5) continue;
        const river = s.actions.filter((a) => a.street === "river");
        // your last river action was a call (a call you later folded after a raise doesn't count)
        const hero_river = river.filter((a) => a.player_id === h.hero_id);
        const call = hero_river.length && hero_river[hero_river.length - 1].type === "call" ? hero_river[hero_river.length - 1] : undefined;
        const me = s.seats.find((p) => p.id === h.hero_id);
        if (call && me && !me.folded && call.amount > 0) {
            calls++;
            need_sum += call.amount / Math.max(call.pot_before + call.amount, 1e-9);
            // won (or split) the pot: from what you collected, so it counts hands where the bettor mucked
            if (me.collected > 0) won++;
        }
        const bet = river.find((a) => a.player_id === h.hero_id && (a.type === "bet" || a.type === "raise"));
        if (bet && s.hero_cards.length === 2 && strengthClass(s.hero_cards, s.board) === "air") {
            bluffs++;
            bluff_need += bet.amount / Math.max(bet.pot_before + bet.amount, 1e-9);
            const after = river.slice(river.indexOf(bet) + 1);
            if (!after.some((a) => a.type === "call" || a.type === "raise")) folded++;
        }
    }
    if (calls) rate("river", "River calls that won", won, calls, need_sum / calls,
        `Your river calls won ${won} of ${calls}; at the prices you called they needed to win about ${Math.round(need_sum / calls * 100)}%. Below that your river calls lose money. Above it they make money; whether you fold too often isn't measured here (folded hands rarely show cards). A split pot counts as a win.`, true, false);
    if (bluffs) rate("river", "River bluffs that got folds", folded, bluffs, bluff_need / bluffs,
        `Your river bets with no pair got everyone to fold ${folded} of ${bluffs} times; at your sizes they needed about ${Math.round(bluff_need / bluffs * 100)}%. Below that your river bluffs lose money.`, true, false);

    // --- where you and the engine disagree, and your results there (when the replay had engine suggestions) ---
    const decided = hands.flatMap((h) => h.decisions.filter((d) => d.engine).map((d) => ({ d, h })));
    if (decided.length) {
        const groups = new Map<string, number[]>();
        for (const { d, h } of decided) {
            if (d.engine!.kind === d.actual) continue;
            const key = `${d.street}: you ${d.actual}, engine ${d.engine!.kind}`;
            (groups.get(key) ?? groups.set(key, []).get(key)!).push(h.adjusted_bb);
        }
        for (const [key, xs] of [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
            result("engine", key[0].toUpperCase() + key.slice(1), xs, "Hands where you went against the engine this way, and your result in them (correlational).");
        }
    }

    const tested = rules.size;
    const z_bar = tested ? zFor(FAMILY_ALPHA / (2 * tested)) : Infinity;
    for (const [line, rule] of rules) line.flagged = rule(z_bar);
    return { lines, tested, z_bar };
}

/** The other players' VPIP and PFR by seat group in your stored hands (0-1). */
function poolRates(states: HandState[], hero_ids: Set<string>): { vpip: Partial<Record<Group, number>>, pfr: Partial<Record<Group, number>> } {
    const c: Record<Group, { n: number, vp: number, pf: number }> = { early: { n: 0, vp: 0, pf: 0 }, middle: { n: 0, vp: 0, pf: 0 }, late: { n: 0, vp: 0, pf: 0 }, SB: { n: 0, vp: 0, pf: 0 }, BB: { n: 0, vp: 0, pf: 0 } };
    for (const s of states) {
        if (s.bomb_pot) continue;
        for (const p of s.seats as SeatState[]) {
            if (hero_ids.has(p.id) || p.position === "?") continue;
            const g = groupOf(p.position);
            const acts = s.actions.filter((a) => a.street === "preflop" && a.player_id === p.id);
            if (!acts.length) continue;
            c[g].n++;
            if (acts.some((a) => a.type === "call" || a.type === "raise" || a.type === "bet")) c[g].vp++;
            if (acts.some((a) => a.type === "raise" || a.type === "bet")) c[g].pf++;
        }
    }
    const out = { vpip: {} as Partial<Record<Group, number>>, pfr: {} as Partial<Record<Group, number>> };
    for (const g of Object.keys(c) as Group[]) if (c[g].n) { out.vpip[g] = c[g].vp / c[g].n; out.pfr[g] = c[g].pf / c[g].n; }
    return out;
}

/** Every stored Hold'em hand (not bomb pots), parsed; unreadable rows are skipped. */
export function holdemStates(rows: HandRow[]): HandState[] {
    const out: HandState[] = [];
    for (const r of rows) {
        try {
            const s = parseHand(JSON.parse(r.messages_json), { big_blind: r.big_blind ?? undefined });
            if (isHoldem(s) && !s.bomb_pot) out.push(s);
        } catch {
            // a hand the parser can't read adds nothing here
        }
    }
    return out;
}

/** Your stats and the pool's from loaded profiles. */
export function rateComparison(profiles: ProfileService): RateComparison | undefined {
    const me = profiles.everyone().find((e) => e.key === ME)?.info.long;
    if (!me) return undefined;
    const pool = profiles.poolSummary();
    const out: RateComparison = { mine: {}, pool: {} };
    for (const key of RATE_KEYS) {
        out.mine[key] = { k: me[key].k, n: me[key].n };
        out.pool[key] = pool[key];
    }
    return out;
}

/**
 * The leak report from stored hands without the engine (fast: results, frequencies and river checks). Pass
 * `hands` from replayAll to add the lines where you and the engine disagreed.
 */
export function leakReport(rows: HandRow[], profiles?: ProfileService, hands?: HeroHand[]): LeakReport & { hands: number } {
    const mine = hands ?? rows.filter(isHeroHoldemHand).map((r) => replayHand(r, null)).filter((h): h is HeroHand => !!h);
    return { ...findLeaks(mine, holdemStates(rows), profiles ? rateComparison(profiles) : undefined), hands: mine.length };
}
