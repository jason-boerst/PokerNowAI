// Did you follow the suggestion, and what did it earn? Matches each recorded suggestion to what
// hero actually did in the finished hand, then compares results by where the suggestion came from
// (preflop chart, post-flop engine, AI, ...), luck adjusted, with 95% ranges.
import { allInAdjustedNet } from "./allin-ev.ts";
import { HandState, netResult, parseCards, parseHand, Street } from "./hand-parser.ts";
import { actionsAgree, ActionKind, parseSuggestedAction, SuggestedAction } from "./legality.ts";
import { summarizeWinrate } from "./winrate.ts";

export const OUTCOME_SOURCES = ["Preflop chart", "Post-flop engine", "AI", "AI fallback", "Basic AI prompt"] as const;
export type OutcomeSource = typeof OUTCOME_SOURCES[number];

/** The original (pre-engine) prompt starts like this; the post-flop AI prompt doesn't. */
const BASIC_PROMPT = /^\s*Help me decide my action/i;

/**
 * Where a recorded suggestion came from, from the Decisions row's `model` and `source`.
 * `prompt` (its first few words are enough) tells the basic AI prompt from the post-flop AI,
 * since both are recorded as source "llm".
 */
export function mapSource(model: string | null | undefined, source: string | null | undefined, prompt?: string | null): OutcomeSource {
    const m = (model ?? "").toLowerCase();
    const s = (source ?? "").toLowerCase();
    if (s.includes("fallback") || m.includes("fallback")) return "AI fallback";
    if (s.includes("basic") || (prompt && BASIC_PROMPT.test(prompt))) return "Basic AI prompt";
    if (s === "engine" || /-engine$/.test(m)) return /pre-?flop/.test(m) ? "Preflop chart" : "Post-flop engine";
    return "AI";
}

// ---------------------------------------------------------------------------------------------
// Matching suggestions to what hero did

const VOLUNTARY: ReadonlySet<string> = new Set(["fold", "check", "call", "bet", "raise"]);

export interface HeroAction {
    street: Street,
    type: "fold" | "check" | "call" | "bet" | "raise",
    /** For bet/raise: the total bet or raise-to, in big blinds. */
    size_bb: number,
    all_in: boolean
}

/** A Decisions row, as much of it as matching needs. */
export interface DecisionToMatch {
    id: number,
    street: string | null,
    /** The bot action: { action_str, bet_size_in_BBs, reason }. */
    action_json: string | null,
    /** The hand's log at decision time; used to tell which of hero's actions the suggestion was for. */
    messages_json?: string | null,
    hero_cards?: string | null
}

export interface DecisionOutcome {
    id: number,
    /**
     * 1 followed, 0 not; null when not counted: no matching action, an unreadable suggestion, or an
     * earlier suggestion for an action that got a newer one.
     */
    followed: number | null,
    /**
     * What hero did, e.g. "raise 7.5", "call (all in)"; "" when no action matched the suggestion;
     * null when hero isn't found in the hand (left for a later try, e.g. after an import links your ids).
     */
    actual_action: string | null,
    hand_net_bb: number | null,
    /** All-in adjusted result when the adjustment applies, else the actual result. */
    adjusted_net_bb: number | null
}

export interface HeroIdentity {
    id?: string | null,
    /** Other player ids known to be yours (PlayerLinks to "me"). */
    ids?: ReadonlySet<string>,
    name?: string | null
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function findHero(s: HandState, hero: HeroIdentity): string | null {
    if (hero.id && s.seats.some((p) => p.id === hero.id)) return hero.id;
    return s.seats.find((p) => hero.ids?.has(p.id))?.id
        ?? (hero.name ? s.seats.find((p) => p.name === hero.name)?.id : undefined)
        ?? null;
}

function heroActions(s: HandState, hero_id: string, big_blind: number): HeroAction[] {
    return s.actions
        .filter((a) => a.player_id === hero_id && VOLUNTARY.has(a.type))
        .map((a) => ({
            street: a.street,
            type: a.type as HeroAction["type"],
            size_bb: (a.type === "bet" || a.type === "raise") && big_blind > 0 ? round2(a.street_total / big_blind) : 0,
            all_in: a.all_in
        }));
}

export function describeAction(a: HeroAction): string {
    const size = a.type === "bet" || a.type === "raise" ? ` ${a.size_bb}` : "";
    return `${a.type}${size}${a.all_in ? " (all in)" : ""}`;
}

/** The suggested action from a Decisions row's action_json, or null if it can't be read. */
export function suggestedAction(action_json: string | null | undefined): SuggestedAction | null {
    if (!action_json) return null;
    try {
        const a = JSON.parse(action_json);
        const kind = String(a?.action_str ?? a?.action ?? "");
        const size = Number(a?.bet_size_in_BBs ?? a?.size_bb ?? 0);
        return parseSuggestedAction(`${kind} ${Number.isFinite(size) && size > 0 ? size : ""}`);
    } catch {
        return null;
    }
}

/** True if what hero did is the suggested action (bet and raise alike, sizes within 25%). */
export function followedSuggestion(suggested: SuggestedAction, actual: HeroAction): boolean {
    // an all-in suggestion is followed by any action that put hero all in (a shove, or calling one)
    if (suggested.action === "all-in") return actual.all_in;
    if (actionsAgree(suggested, { action: actual.type as ActionKind, size_bb: actual.size_bb })) return true;
    if (actual.all_in && (suggested.action === "bet" || suggested.action === "raise")) {
        // short-stacked: all in for no more than the suggested size, or a call that was all hero had
        return actual.type === "call" || suggested.size_bb >= actual.size_bb;
    }
    return false;
}

/**
 * How many of hero's actions on the decision's street were already in the log when the suggestion
 * was made, i.e. which action it was for. Null when the decision's log can't tell (missing, or not
 * this hand in progress).
 */
function actionsBefore(d: DecisionToMatch, hero: HeroIdentity, hand_number: number | null): number | null {
    if (!d.messages_json) return null;
    try {
        const messages = JSON.parse(d.messages_json);
        if (!Array.isArray(messages) || messages.length === 0) return null;
        const s = parseHand(messages);
        if (s.ended || s.hand_number !== hand_number || s.street !== d.street) return null;
        const hero_id = findHero(s, hero);
        if (!hero_id) return null;
        return heroActions(s, hero_id, 0).filter((a) => a.street === d.street).length;
    } catch {
        return null;
    }
}

/**
 * Matches one finished hand's suggestions (in the order they were made) to hero's actions: each
 * suggestion on a street goes with hero's next action on that street not yet matched. When the
 * suggestion's own log shows how many times hero had already acted on that street, that picks the
 * action instead: the suggestion is compared with what hero did in the spot it was made for, and a
 * missed suggestion doesn't shift the others. When several suggestions were shown for the same
 * action, only the last one (what you saw when you acted) counts; the others get followed = null.
 */
export function matchHandDecisions(messages: string[], decisions: DecisionToMatch[], hero: HeroIdentity, big_blind?: number | null): DecisionOutcome[] {
    const cards = decisions.map((d) => parseCards(d.hero_cards ?? "")).find((c) => c.length >= 2);
    const s = parseHand(messages, { big_blind: big_blind ?? undefined, hero_cards: cards });
    const hero_id = findHero(s, hero);
    const bb = s.big_blind || big_blind || 0;
    if (!hero_id) {
        return decisions.map((d) => ({ id: d.id, followed: null, actual_action: null, hand_net_bb: null, adjusted_net_bb: null }));
    }
    const net = netResult(s, hero_id);
    const adjusted = allInAdjustedNet(s, hero_id) ?? net;
    const hand_net_bb = bb > 0 ? round2(net / bb) : null;
    const adjusted_net_bb = bb > 0 ? round2(adjusted / bb) : null;

    const actions = heroActions(s, hero_id, bb);
    const next = new Map<string, number>();
    const picks = decisions.map((d) => {
        const street = d.street ?? "";
        const index = actionsBefore(d, { ...hero, id: hero_id }, s.hand_number) ?? next.get(street) ?? 0;
        const actual = actions.filter((a) => a.street === street)[index];
        if (actual) next.set(street, Math.max(next.get(street) ?? 0, index + 1));
        return { d, key: `${street}#${index}`, actual };
    });
    const last = new Map(picks.map((p, i) => [p.key, i]));
    return picks.map(({ d, key, actual }, i) => {
        if (!actual) return { id: d.id, followed: null, actual_action: "", hand_net_bb, adjusted_net_bb };
        const suggested = suggestedAction(d.action_json);
        return {
            id: d.id,
            followed: suggested && last.get(key) === i ? (followedSuggestion(suggested, actual) ? 1 : 0) : null,
            actual_action: describeAction(actual),
            hand_net_bb,
            adjusted_net_bb
        };
    });
}

// ---------------------------------------------------------------------------------------------
// Results by source

/** A Decisions row with its outcome filled in (see HandRecorder.outcomeRows). */
export interface OutcomeRow {
    game_id: string,
    hand_number: number | null,
    model: string | null,
    source: string | null,
    /** The prompt, or just its start: tells the basic AI prompt from the post-flop AI. */
    prompt?: string | null,
    followed: number | boolean | null,
    hand_net_bb: number | null,
    adjusted_net_bb: number | null
}

export interface GroupResult {
    hands: number,
    /** Luck-adjusted win rate over these hands. */
    bb_per_100: number,
    /** 95% range for the true bb/100. */
    ci_low: number,
    ci_high: number
}

export interface SourceOutcome {
    source: string,
    /** Suggestions matched to what you did. */
    decisions: number,
    /** Share of those you followed, 0 to 1. */
    follow_rate: number,
    /** Hands where you followed every suggestion from this source. */
    followed: GroupResult,
    /** Hands where you went against at least one of them. */
    not_followed: GroupResult
}

export interface OutcomeSummary {
    sources: SourceOutcome[],
    /** Plain-language verdict. */
    note: string
}

/**
 * Smallest per-hand standard deviation (BB) assumed for the 95% range. A handful of hands can
 * happen to have nearly equal results, which would make the range look falsely narrow; real
 * No-Limit results spread far more than this.
 */
export const MIN_SD_BB = 5;
/** Fewer hands than this in a group: no verdict about it either way. */
export const MIN_VERDICT_HANDS = 30;

function groupResult(results_bb: number[]): GroupResult {
    if (results_bb.length === 0) return { hands: 0, bb_per_100: 0, ci_low: 0, ci_high: 0 };
    const w = summarizeWinrate(results_bb);
    const floor = 1.96 * MIN_SD_BB / Math.sqrt(w.hands) * 100;
    const half = Number.isFinite(w.ci_high) ? Math.max((w.ci_high - w.ci_low) / 2, floor) : floor;
    return { hands: w.hands, bb_per_100: w.bb_per_100, ci_low: w.bb_per_100 - half, ci_high: w.bb_per_100 + half };
}

const fmt = (x: number) => (x >= 0 ? "+" : "-") + Math.abs(x).toFixed(1);
const range = (g: GroupResult) => `${fmt(g.bb_per_100)} bb/100, 95% range ${fmt(g.ci_low)} to ${fmt(g.ci_high)}`;
/** "the preflop chart", "the AI", ... for use mid-sentence. */
const the = (source: string) => "the " + (source.startsWith("AI") ? source : source[0].toLowerCase() + source.slice(1));

/**
 * Findings where the 95% ranges don't overlap (or don't include zero), most useful first. Sources
 * aren't compared with each other: they advise in different spots (every cheap preflop fold vs
 * hands that saw a flop), so their results differ even when the advice is equally good.
 */
function verdicts(sources: SourceOutcome[]): string[] {
    const enough = (g: GroupResult) => g.hands >= MIN_VERDICT_HANDS;
    const out: string[] = [];
    for (const s of sources) {
        const f = s.followed, n = s.not_followed;
        if (!enough(f) || !enough(n)) continue;
        if (f.ci_low > n.ci_high) out.push(`Following ${the(s.source)} has paid off: ${fmt(f.bb_per_100)} bb/100 when you followed it vs ${fmt(n.bb_per_100)} when you didn't.`);
        if (f.ci_high < n.ci_low) out.push(`You have done better going against ${the(s.source)}: ${fmt(n.bb_per_100)} bb/100 when you didn't follow it vs ${fmt(f.bb_per_100)} when you did.`);
    }
    for (const s of sources) {
        for (const [g, how] of [[s.followed, "followed"], [s.not_followed, "went against"]] as const) {
            if (!enough(g)) continue;
            if (g.ci_low > 0) out.push(`Hands where you ${how} ${the(s.source)} are winning (${range(g)}).`);
            if (g.ci_high < 0) out.push(`Hands where you ${how} ${the(s.source)} are losing (${range(g)}).`);
        }
    }
    return out;
}

/**
 * Follow rate and results by suggestion source. A hand counts as "followed" for a source when you
 * followed every one of that source's suggestions in it that could be matched. Results are the
 * hand's all-in adjusted net in BB (the actual net when the adjustment doesn't apply).
 */
export function summarizeOutcomes(rows: OutcomeRow[]): OutcomeSummary {
    const decided = rows.filter((r) => r.followed !== null && r.followed !== undefined);
    const unmatched = rows.length - decided.length;
    const by_source = new Map<OutcomeSource, { decisions: number, followed: number, hands: Map<string, { all_followed: boolean, result: number | null }> }>();
    for (const r of decided) {
        const source = mapSource(r.model, r.source, r.prompt);
        const entry = by_source.get(source) ?? { decisions: 0, followed: 0, hands: new Map() };
        by_source.set(source, entry);
        const followed = Boolean(r.followed);
        entry.decisions++;
        if (followed) entry.followed++;
        if (r.hand_number === null) continue;
        const key = `${r.game_id}#${r.hand_number}`;
        const hand = entry.hands.get(key) ?? { all_followed: true, result: null };
        hand.all_followed &&= followed;
        hand.result ??= r.adjusted_net_bb ?? r.hand_net_bb ?? null;
        entry.hands.set(key, hand);
    }

    const sources: SourceOutcome[] = [];
    for (const source of OUTCOME_SOURCES) {
        const e = by_source.get(source);
        if (!e) continue;
        const hands = [...e.hands.values()].filter((h) => h.result !== null);
        sources.push({
            source,
            decisions: e.decisions,
            follow_rate: e.decisions ? e.followed / e.decisions : 0,
            followed: groupResult(hands.filter((h) => h.all_followed).map((h) => h.result!)),
            not_followed: groupResult(hands.filter((h) => !h.all_followed).map((h) => h.result!))
        });
    }

    const plural = (n: number) => `${n} suggestion${n === 1 ? "" : "s"}`;
    const later = unmatched
        ? ` ${plural(unmatched)} ${unmatched === 1 ? "wasn't" : "weren't"} counted (hand not stored yet, no matching action, or shown again for the same spot).`
        : "";
    if (decided.length === 0) {
        return { sources, note: `No suggestions matched to your actions yet. Play some hands with the assistant and check back.${later}` };
    }
    const followed = decided.filter((r) => Boolean(r.followed)).length;
    const found = verdicts(sources);
    const verdict = found.length
        ? found.slice(0, 4).join(" ")
        : "Too few hands to tell yet: the 95% ranges cross zero or overlap, so the differences so far could be luck. A real difference usually takes a few thousand hands to show.";
    return {
        sources,
        note: `${verdict} You followed ${Math.round(followed / decided.length * 100)}% of ${plural(decided.length)}.${later} ` +
            "Results are all-in adjusted bb/100 with 95% ranges."
    };
}
