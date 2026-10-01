import default_config from "../configs/preflop-ranges.json" with { type: "json" };
import { HandState, HeroView, SeatState } from "./hand-parser.ts";
import { classOf, HandClass } from "./hand-classes.ts";
import { MIN_HANDS_FOR_STATS, ObservedStats, POPULATION_TENDENCIES } from "./opponent-range.ts";
import { parseRange } from "./range-notation.ts";
import type { PlayerRef } from "./player-profile.ts";
import { preflopEv, PreflopEvOption, PreflopEvResult, PreflopProfile, robustPreflop } from "./preflop-ev.ts";

export type PreflopConfig = typeof default_config;

export interface PreflopAdvice {
    action: "fold" | "check" | "call" | "raise" | "all-in",
    /** Raise-to size in big blinds (0 for other actions). */
    size_bb: number,
    scenario: string,
    reason: string,
    /** The chart's actions for this spot, most aggressive first, so mixing.ts can mix hands at the edges of each range. */
    tiers?: PreflopTier[],
    /** When hero closes the action facing a bet: the call priced by equity (decided: the price made the call or fold). */
    price?: PriceInfo,
    /**
     * A hand the chart 3-bets or squeezes as a bluff part of the time (three_bet_bluff): the raise's frequency and size,
     * and the hand's usual play the rest of the time. mixing.ts splits the random number between them.
     */
    mixed_raise?: { freq: number, size_bb: number, usual: { action: PreflopAdvice["action"], size_bb: number } },
    /** Every option priced by EV (preflop-ev.ts), and whether that overruled the chart's play. */
    ev?: PreflopEvResult & { overruled: boolean, chart: { action: PreflopAdvice["action"], size_bb: number } }
}

/** A call priced by equity when hero closes the action (see priceNumbers). */
export interface PriceInfo {
    /** The call's EV in big blinds, counting only the equity the hand keeps. */
    ev_bb: number,
    /** Equity against the players still in (0-1), the share a hand like this keeps out of position, and what remains. */
    equity: number,
    realization: number,
    realized: number,
    /** Equity the call needs (0-1). */
    need: number,
    /** True when the price made the decision; false when a chart did (the numbers are then for the panel). */
    decided: boolean
}

/**
 * The price of a call when hero closes the action: equity kept after realization against the equity the call
 * needs, and the call's EV. Null when hero doesn't close the action or has nothing to call.
 */
export function priceNumbers(s: HandState, v: HeroView, config: PreflopConfig, cls: HandClass, eq: number, multiway: boolean):
    { need: number, r: number, realized: number, ev_bb: number, showdown: boolean, spr_after: number } | null {
    const hero = s.seats.find((p) => p.id === s.hero_id);
    if (!hero || v.to_call <= 0) return null;
    // hero closes the action when everyone else still able to act has already matched the bet
    const closes = s.seats.every((p) => p.id === hero.id || p.folded || p.all_in || p.street_contribution >= s.current_bet - 1e-9);
    if (!closes) return null;
    // only the chips hero can win: a deeper player's all-in counts up to hero's own stack
    const hero_max = hero.total_contribution + hero.stack;
    const pot_after = s.seats.reduce((sum, p) => sum + Math.min(p.total_contribution, hero_max), 0) + v.to_call;
    const need = v.to_call / pot_after;
    const spr_after = Math.max(0, v.effective_stack - s.current_bet) / pot_after;
    // everyone else still in is all-in: no more betting, the cards are simply dealt out
    const showdown = s.seats.every((p) => p.id === hero.id || p.folded || p.all_in);
    const r = showdown ? 1 : realizationOf(config, cls, multiway, spr_after);
    const realized = eq * r;
    return { need, r, realized, ev_bb: (realized * pot_after - v.to_call) / s.big_blind, showdown, spr_after };
}

/** One action of a chart spot and the hands that take it. */
export interface PreflopTier {
    action: PreflopAdvice["action"],
    /** Raise-to size in big blinds (0 for other actions). */
    size_bb: number,
    /** Range notations whose hands take this action (hands in a tier above count there); empty for the last tier: every other hand. */
    ranges: string[],
    /** How hands are ranked to find the range's edge: by strength (value raises) or by playability (opens, calls). */
    order: "strength" | "playability",
    /** Short name used in reasons, e.g. "3-bet for value", "call". */
    reason: string
}

/** Table rules that aren't in the hand log, and the live equity estimate. */
export interface PreflopContext {
    /** 7-2 bounty each opponent pays, in chips (0 or missing: no bounty). */
    seven_deuce_bounty?: number,
    /**
     * Hero's equity (0-1) against the likely hands of every player still in the hand. When set and hero
     * closes the action facing one raise, call or fold is decided by price instead of a fixed range.
     */
    equity?: number,
    /**
     * Price every option by EV and overrule the chart when it says so clearly (config ev_pricing). `profile`
     * gives each player's preflop rates; `time_budget_ms` limits the simulation.
     */
    ev?: { profile?: (seat: SeatState) => PreflopProfile | undefined, time_budget_ms?: number }
}

const RANK_ORDER = "23456789TJQKA";

/**
 * Share of its raw equity a hand typically keeps when it calls a raise and plays the flop out of position.
 * Suited and connected hands keep more (they make strong draws and hands), offsuit unconnected hands less;
 * a low stack-to-pot ratio after the call keeps more because the hand is played to showdown sooner. Multiway,
 * offsuit hands keep less and pairs and suited connectors keep theirs; deep stacks add implied odds to pairs
 * and suited hands (more with several opponents, who can pay off a set, straight or flush).
 */
export function realizationOf(config: PreflopConfig, cls: HandClass, multiway: boolean, spr_after_call: number): number {
    const r = config.price_defense.realization;
    const hi = RANK_ORDER.indexOf(cls[0]), lo = RANK_ORDER.indexOf(cls[1]);
    const connected = hi - lo <= 2;
    const base = cls.length === 2 ? r.pair
        : cls.endsWith("s") ? (connected ? r.suited_connected : r.suited)
        : lo >= RANK_ORDER.indexOf("T") ? r.offsuit_broadway
        : connected ? r.offsuit_connected
        : cls[0] === "A" ? r.offsuit_ace
        : r.offsuit;
    const pd = config.price_defense;
    const offsuit = cls.length === 3 && cls.endsWith("o");
    const kind = cls.length === 2 ? "pair" : cls.endsWith("s") ? (connected ? "suited_connected" : "suited") : "offsuit";
    const implied = kind === "offsuit" ? 0
        : pd.deep_implied_bonus[kind] * Math.max(0, Math.min(1, (spr_after_call - pd.deep_implied_from_spr) / (pd.deep_implied_full_spr - pd.deep_implied_from_spr)))
            * (multiway ? pd.deep_implied_multiway_scale : 1);
    const adjusted = base * (multiway ? pd.multiway_factor[kind] : 1)
        + (spr_after_call < pd.short_spr_below ? pd.short_spr_bonus : 0)
        - (offsuit && spr_after_call >= pd.deep_spr_at_least ? pd.deep_offsuit_penalty : 0)
        + implied;
    // implied odds can lift a hand past its raw equity (it wins more than its share when it hits)
    return Math.max(0.3, Math.min(1.15, adjusted));
}

type StatsLookup = (player: PlayerRef) => ObservedStats | undefined;

/** Opening range keys from widest to tightest, indexed by the number of non-blind players left to act. */
const PREFLOP_ORDER_FROM_BUTTON = ["BU", "CO", "HJ", "LJ", "MP", "UTG+1", "UTG"];
const AFTER_UTG = ["MP", "LJ", "HJ", "CO", "BU", "SB", "BB"];

/** Preflop acting rank of a position: UTG, UTG+1, UTG+2, ..., MP, LJ, HJ, CO, BU, SB, BB (unknown seats first). */
function preflopRank(position: string): number {
    if (position === "UTG") return 0;
    const m = position.match(/^UTG\+(\d+)$/);
    if (m) return Number(m[1]);
    const i = AFTER_UTG.indexOf(position);
    return i < 0 ? -1 : 100 + i;
}

/** Acting rank after the flop: the blinds first, the button last. */
export function postflopRank(position: string): number {
    return position === "SB" ? -3 : position === "BB" ? -2 : preflopRank(position);
}

function categoryOf(position: string): "early" | "middle" | "late" | "blinds" {
    if (position === "SB" || position === "BB") return "blinds";
    if (position === "MP" || position.startsWith("UTG")) return "early";
    if (position === "LJ" || position === "HJ") return "middle";
    return "late";
}

// parsed ranges are cached per config object
const cache = new WeakMap<object, Map<string, Set<HandClass>>>();
function inRange(config: PreflopConfig, notation: string, cls: HandClass): boolean {
    let m = cache.get(config);
    if (!m) { m = new Map(); cache.set(config, m); }
    let set = m.get(notation);
    if (!set) { set = parseRange(notation); m.set(notation, set); }
    return set.has(cls);
}
/** The raise frequency three_bet_bluff gives a hand in a spot (0: not a bluff hand there). */
function bluffFrequency(config: PreflopConfig, spot: "squeeze" | "vs_early" | "vs_late", cls: HandClass): number {
    const table = (config as { three_bet_bluff?: Record<string, unknown> }).three_bet_bluff?.[spot] as Record<string, number> | undefined;
    for (const [notation, freq] of Object.entries(table ?? {})) {
        if (typeof freq === "number" && freq > 0 && inRange(config, notation, cls)) return Math.min(1, freq);
    }
    return 0;
}
const inAny = (config: PreflopConfig, notations: (string | undefined)[], cls: HandClass) =>
    notations.some((n) => !!n && inRange(config, n, cls));

/** Preflop acting order: UTG ... BU, SB, BB, then straddlers (they act last). */
function preflopOrder(s: HandState, straddlers: string[]): SeatState[] {
    const rank = (p: SeatState) => straddlers.includes(p.id) ? 1000 + straddlers.indexOf(p.id) : preflopRank(p.position);
    return [...s.seats].sort((a, b) => rank(a) - rank(b));
}

type PlayerType = "loose" | "nit" | "loose_raiser" | "unknown";
function playerType(config: PreflopConfig, stats: ObservedStats | undefined): Set<PlayerType> {
    const t = config.player_types;
    const types = new Set<PlayerType>();
    if (!stats || stats.hands < t.min_hands) { types.add("unknown"); return types; }
    if (stats.vpip >= t.loose_vpip) types.add("loose");
    if (stats.pfr >= t.loose_raiser_pfr) types.add("loose_raiser");
    if (stats.pfr <= t.nit_pfr) types.add("nit");
    return types;
}
const vpipOf = (stats: ObservedStats | undefined) =>
    stats && stats.hands >= MIN_HANDS_FOR_STATS ? stats.vpip : POPULATION_TENDENCIES.vpip;

/** Measured 3-bet %, when there's enough history to trust it (or it's already blended toward the averages). */
function threeBetOf(config: PreflopConfig, stats: ObservedStats | undefined): number | undefined {
    if (stats?.three_bet === undefined) return undefined;
    return stats.shrunk || stats.hands >= config.facing_three_bet.min_hands ? stats.three_bet : undefined;
}

type FourBetRanges = Omit<PreflopConfig["facing_four_bet"], "_about">;
interface DeepTier {
    add_to_calls?: string,
    add_to_calls_from_blinds?: string,
    add_to_multiway_calls?: string,
    remove_from_calls?: string,
    add_to_three_bet_calls_in_position?: string,
    facing_four_bet?: Partial<FourBetRanges>
}
/** The deep-stack tier for an effective stack in blind levels: the highest tier at or below it (null when shallower). */
function deepTier(config: PreflopConfig, depth: number): DeepTier | null {
    let best: { at: number, tier: DeepTier } | null = null;
    for (const [key, tier] of Object.entries(config.deep_stacks)) {
        const at = Number(key);
        if (Number.isFinite(at) && depth >= at && (!best || at > best.at)) best = { at, tier: tier as DeepTier };
    }
    return best?.tier ?? null;
}

/** Big blinds for reasons: whole numbers from 10 up, one decimal below. */
const roundBb = (x: number) => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);

/**
 * Deterministic preflop advice for hero. Returns null if the spot can't be analyzed (e.g. unknown cards).
 * `context` carries table rules that aren't in the log (the 7-2 bounty); omit it for none.
 */
export function preflopAdvice(s: HandState, v: HeroView, stats: StatsLookup, config: PreflopConfig = default_config, context: PreflopContext = {}): PreflopAdvice | null {
    const advice = withEv(s, v, stats, config, context, chartAdvice(s, v, stats, config, context));
    // a chart decision when hero closes the action: the price numbers too, so the panel can show the equity the
    // hand keeps (a raw equity above the price can still be a fold once position is counted)
    if (!advice || advice.price || context.equity === undefined || s.hero_cards.length !== 2) return advice;
    const hero = s.seats.find((p) => p.id === s.hero_id);
    const others = s.seats.filter((p) => p.id !== s.hero_id && !p.folded);
    // the realization shares are for playing out of position; in position the raw equity is the better guide
    const in_position = !!hero && (s.seats.length === 2 ? hero.position === "SB" : others.every((p) => postflopRank(hero.position) > postflopRank(p.position)));
    if (in_position) return advice;
    const n = priceNumbers(s, v, config, classOf(s.hero_cards), context.equity, others.length > 1);
    if (!n) return advice;
    return { ...advice, price: { ev_bb: Math.round(n.ev_bb * 100) / 100, equity: context.equity, realized: n.realized, realization: n.r, need: n.need, decided: false } };
}

const family = (a: string) => (a === "raise" || a === "all-in" ? "aggressive" : a);

/** The raise size to price: the chart's own raise (its play, or its raise tier), else a standard size for the spot. */
function raiseSizeOf(s: HandState, advice: PreflopAdvice, config: PreflopConfig): number {
    if (advice.action === "raise" || advice.action === "all-in") return advice.size_bb;
    const tier = advice.tiers?.find((t) => t.action === "raise" || t.action === "all-in");
    if (tier) return tier.size_bb;
    const bb = s.big_blind;
    const pre = s.actions.filter((a) => a.street === "preflop");
    const level = Math.max(bb, ...pre.filter((a) => a.type === "post_bb" || a.type === "post_straddle").map((a) => a.street_total)) / bb;
    const raises = pre.filter((a) => a.type === "raise" || a.type === "bet");
    const size = config.sizing;
    if (raises.length === 0) {
        const limpers = pre.filter((a) => a.type === "call").length;
        return limpers ? (size.isolate_base_bb + limpers * size.isolate_per_limper_bb) * level : size.open_bb * level;
    }
    const last = raises[raises.length - 1].street_total / bb;
    return raises.length === 1 ? last * size.three_bet_multiplier_in_position : last * size.four_bet_multiplier;
}

/**
 * Prices the chart's play and the alternatives by EV (preflop-ev.ts). A different kind of play (fold, check/call,
 * raise) replaces the chart's only when its EV, less its risk, beats the chart's by at least ev_pricing.margin_bb.
 * 7-2 under the bounty keeps the chart's play (its value is the bounty, which the EV doesn't count).
 */
function withEv(s: HandState, v: HeroView, stats: StatsLookup, config: PreflopConfig, context: PreflopContext, advice: PreflopAdvice | null): PreflopAdvice | null {
    const settings = (config as { ev_pricing?: { enabled: boolean, overrule?: boolean, margin_bb: number } }).ev_pricing;
    if (!advice || !context.ev || !settings?.enabled || s.hero_cards.length !== 2) return advice;
    const cls = classOf(s.hero_cards);
    if ((context.seven_deuce_bounty ?? 0) > 0 && (cls === "72o" || cls === "72s")) return advice;
    const ev = preflopEv(s, v, cls, stats, config, v.min_raise_to === null ? null : raiseSizeOf(s, advice, config), context.ev.profile, context.ev.time_budget_ms);
    if (!ev) return advice;
    const chart = { action: advice.action, size_bb: advice.size_bb };
    const chart_option = ev.options.find((o) => family(o.action) === family(advice.action));
    // the model is trusted to overrule only before any re-raise and not against an all-in: deeper re-raise wars and
    // shoves depend on stack-off dynamics and shove ranges that the charts encode better
    const pre = s.actions.filter((a) => a.street === "preflop");
    const raises = pre.filter((a) => a.type === "raise" || a.type === "bet");
    const trusted = raises.length <= 1 && !raises.some((a) => a.all_in);
    // what the model measures well: folding or continuing, and checking or raising in the big blind. Calling versus
    // re-raising, and limping first in, stay with the chart (the model's re-raise wars and limp lines are rough)
    const continuing = (a: string) => a !== "fold";
    const open_limp = (o: PreflopEvOption) => o.action === "call" && raises.length === 0 && !pre.some((a) => a.type === "call")
        && !["SB", "BB"].includes(s.seats.find((p) => p.id === s.hero_id)?.position ?? "");
    const allowed = ev.options.filter((o) => !open_limp(o) && (continuing(o.action) !== continuing(advice.action) || (advice.action === "check" && o.action === "raise")));
    const best = allowed.reduce<PreflopEvOption | undefined>((x, o) => (!x || robustPreflop(o) > robustPreflop(x) ? o : x), undefined);
    // what the chart's play stands for: folding, or the best way to continue (calling or raising), counted at its best
    const optimistic = (o: PreflopEvOption) => o.ev_bb + o.risk_bb;
    const chart_side = continuing(advice.action)
        ? ev.options.filter((o) => continuing(o.action) && !open_limp(o)).reduce<PreflopEvOption | undefined>((x, o) => (!x || optimistic(o) > optimistic(x) ? o : x), undefined)
        : chart_option;
    // overrule (when allowed) only when the alternative, counted at its worst, beats the chart's side at its best
    const overrule = !!settings.overrule && trusted && !!best && !!chart_side && robustPreflop(best) - optimistic(chart_side) >= settings.margin_bb;
    if (!overrule || !best) return { ...advice, ev: { ...ev, overruled: false, chart } };
    const signed = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 10) / 10}`;
    const why = best.action === "fold" ? "the price and the hands that continue make every other play lose"
        : best.fold_chance !== undefined ? `they fold about ${Math.round(best.fold_chance * 100)}% of the time${best.called_equity !== undefined ? ` and you have ${Math.round(best.called_equity * 100)}% equity when called` : ""}`
        : `you have ${Math.round((best.called_equity ?? ev.equity) * 100)}% equity against the hands that stay in`;
    const verb = best.action === "fold" ? "Fold" : best.action === "check" ? "Check" : best.action === "call" ? "Call" : best.action === "all-in" ? "Go all-in" : `Raise to ${roundBb(best.size_bb)} BB`;
    return {
        action: best.action, size_bb: best.size_bb, scenario: `${advice.scenario}, priced by EV`,
        reason: `${verb} with ${cls}: priced against how players in your games answer, ${best.label} is worth about ${signed(best.ev_bb)} BB against ${signed(chart_side!.ev_bb)} BB for ${chart_side!.label}; ${why}.`,
        ...(advice.price ? { price: advice.price } : {}),
        ev: { ...ev, overruled: true, chart }
    };
}

function chartAdvice(s: HandState, v: HeroView, stats: StatsLookup, config: PreflopConfig, context: PreflopContext): PreflopAdvice | null {
    if (s.street !== "preflop" || s.hero_cards.length !== 2) return null;
    const hero = s.seats.find((p) => p.id === s.hero_id);
    const bb = s.big_blind;
    if (!hero || !(bb > 0)) return null;
    const cls = classOf(s.hero_cards);
    const size = config.sizing;
    const preflop = s.actions.filter((a) => a.street === "preflop");
    // a straddle is a bigger blind, not a raise: the straddler acts last preflop and sizes scale up from it
    const straddlers = preflop.filter((a) => a.type === "post_straddle").map((a) => a.player_id);
    const straddled = straddlers.length > 0;
    const order = preflopOrder(s, straddlers);
    const hero_index = order.findIndex((p) => p.id === hero.id);
    const total = (p: SeatState) => p.stack + p.street_contribution;
    const hero_total_stack_bb = total(hero) / bb;

    // what happened before hero's turn
    const voluntary = preflop.filter((a) => ["call", "raise", "bet"].includes(a.type));
    const raises = voluntary.filter((a) => a.type === "raise" || a.type === "bet");
    const hero_raised = raises.some((a) => a.player_id === hero.id);
    const last_raise = raises[raises.length - 1];
    // blind level: the big blind, or a straddle if one was posted; config sizes are multiples of it
    const blind_level = Math.max(bb, ...preflop.filter((a) => a.type === "post_bb" || a.type === "post_straddle").map((a) => a.street_total));
    const level = blind_level / bb;
    const limpers = raises.length === 0
        ? voluntary.filter((a) => a.type === "call" && a.bet_to_call_before <= blind_level + 1e-9 && a.player_id !== hero.id)
        : [];
    const callers_after_raise = last_raise ? voluntary.filter((a) => a.type === "call" && s.actions.indexOf(a) > s.actions.indexOf(last_raise)) : [];
    const seatById = new Map(s.seats.map((p) => [p.id, p]));

    // hero's seat for calling ranges: the straddler defends like a big blind, and with a straddle on the
    // big blind (half a straddle in) like a small blind
    const hero_straddled = straddlers.includes(hero.id);
    const role: "in_position" | "small_blind" | "big_blind" = hero_straddled ? "big_blind"
        : hero.position === "SB" ? "small_blind"
        : hero.position === "BB" ? (straddled ? "small_blind" : "big_blind")
        : "in_position";
    const out_of_position = role !== "in_position";
    const seat_name = hero_straddled ? "straddle" : hero.position === "SB" ? "small blind" : hero.position === "BB" ? "big blind" : hero.position;

    // dead money (blinds, antes, straddle, dead blinds) in blind levels: more of it makes stealing worth more.
    // Only one big blind counts: a missed big blind posted live is an extra player who can still defend.
    const chipsOf = (types: string[]) => preflop.filter((a) => types.includes(a.type)).reduce((sum, a) => sum + a.amount, 0);
    const big_blind_post = Math.max(0, ...preflop.filter((a) => a.type === "post_bb").map((a) => a.amount));
    const dead_chips = big_blind_post + chipsOf(["post_sb", "post_dead", "post_ante", "post_straddle"]);
    const dead_money = dead_chips / blind_level;
    const antes_bb = chipsOf(["post_ante"]) / bb;
    const ante = config.antes;
    const widen = dead_money >= ante.widen_two_steps_when_dead_money_bb_at_least - 1e-9 ? 2
        : dead_money >= ante.widen_when_dead_money_bb_at_least - 1e-9 ? 1 : 0;
    const ante_extra_bb = antes_bb * ante.open_extra_bb_per_bb_of_antes;
    const straddle_note = straddled ? ` Sizes are based on the ${roundBb(level)} BB straddle.` : "";
    /** Effective stack against one player, in blind levels. */
    const depthVs = (p: SeatState) => Math.min(total(hero), total(p)) / blind_level;
    /** True when hero acts after this player on the flop and later streets. */
    const heroActsAfter = (p: SeatState) => s.seats.length === 2 ? hero.position === "SB" : postflopRank(hero.position) > postflopRank(p.position);
    /** 3-bets a lot (when measured) or raises a lot preflop. */
    const looseRaiser = (p: SeatState) =>
        (threeBetOf(config, stats(p)) ?? 0) >= config.facing_three_bet.loose_at_least || playerType(config, stats(p)).has("loose_raiser");

    // raise sizes in big blinds
    const openTo = (loose_field: boolean) => (size.open_bb + (loose_field ? size.open_extra_bb_vs_loose_field : 0)) * level + ante_extra_bb;
    const isolateTo = (n_limpers: number, loose_limpers: boolean) => (size.isolate_base_bb + n_limpers * size.isolate_per_limper_bb
        + (out_of_position ? size.out_of_position_extra_bb : 0) + (loose_limpers ? size.isolate_extra_bb_vs_loose_limpers : 0)) * level + ante_extra_bb;
    const threeBetTo = (raise_to_bb: number, callers: number) =>
        raise_to_bb * (out_of_position ? size.three_bet_multiplier_out_of_position : size.three_bet_multiplier_in_position)
        + callers * size.three_bet_extra_per_caller * raise_to_bb;

    const finish = (advice: PreflopAdvice): PreflopAdvice => {
        if (advice.action !== "raise") return advice;
        const min_bb = (v.min_raise_to ?? Infinity) / bb;
        if (v.min_raise_to === null) {
            return { ...advice, action: v.to_call > 0 ? "call" : "check", size_bb: 0, reason: advice.reason + " Raising isn't possible here, so " + (v.to_call > 0 ? "call." : "check.") };
        }
        let raise_to = Math.max(advice.size_bb, min_bb);
        raise_to = Math.round(raise_to * 2) / 2; // half-BB steps
        if (raise_to >= hero_total_stack_bb * size.all_in_when_raise_uses_share_of_stack || raise_to >= v.max_raise_to / bb) {
            return { ...advice, action: "all-in", size_bb: Math.round(v.max_raise_to / bb * 100) / 100 };
        }
        return { ...advice, size_bb: raise_to };
    };
    const fold = (scenario: string, reason: string): PreflopAdvice =>
        v.to_call > 0 ? { action: "fold", size_bb: 0, scenario, reason } : { action: "check", size_bb: 0, scenario, reason: reason.replace(/fold/i, "check") };

    // the chart's actions for a spot, most aggressive first (see PreflopTier)
    const fold_tier: PreflopTier = { action: v.to_call > 0 ? "fold" : "check", size_bb: 0, ranges: [], order: "strength", reason: v.to_call > 0 ? "fold" : "check" };
    const raiseTier = (size_bb: number, ranges: (string | undefined)[], order: PreflopTier["order"], reason: string): PreflopTier => {
        const f = finish({ action: "raise", size_bb, scenario: "", reason: "" });
        return { action: f.action, size_bb: f.size_bb, ranges: ranges.filter((r): r is string => !!r), order, reason };
    };
    const callTier = (ranges: (string | undefined)[], reason = "call"): PreflopTier =>
        ({ action: "call", size_bb: 0, ranges: ranges.filter((r): r is string => !!r), order: "playability", reason });
    /** A price decision (call or fold by equity) takes every hand below the raise tier. */
    const pricedTier = (priced: PreflopAdvice): PreflopTier => ({ action: priced.action, size_bb: 0, ranges: [], order: "playability", reason: priced.action });
    const tiered = (advice: PreflopAdvice, tiers: PreflopTier[]): PreflopAdvice => ({ ...advice, tiers });
    const setMineOk = () => {
        const small_pair = cls.length === 2 && "23456789".includes(cls[0]);
        return !small_pair || v.effective_stack / Math.max(v.to_call, 1e-9) >= size.set_mine_min_stack_to_call_ratio;
    };
    /**
     * Call or fold by price when hero closes the action: equity against the players still in, times the share
     * a hand like this keeps out of position, against the equity the call needs. Null when it doesn't apply.
     */
    const priceDefense = (scenario: string, multiway: boolean): PreflopAdvice | null => {
        const pd = config.price_defense;
        const eq = context.equity;
        if (!pd.enabled || eq === undefined) return null;
        const n = priceNumbers(s, v, config, cls, eq, multiway);
        if (!n) return null;
        const { need, r, realized, ev_bb, showdown } = n;
        const ip = s.seats.filter((p) => p.id !== hero.id && !p.folded).every((p) => heroActsAfter(p));
        const pct = (x: number) => `${Math.round(x * 100)}%`;
        const numbers = showdown
            ? `about ${pct(eq)} equity against their likely hands, and nobody left can bet, so all of it counts`
            : r >= 0.999 ? `about ${pct(eq)} equity against their likely hands; with this little left behind the hand plays nearly to showdown, so all of it counts`
            : r > 1.005 ? `about ${pct(eq)} equity against their likely hands; with stacks this deep a hand like this wins more than its share when it hits (implied odds), worth about ${pct(r)} of that (${pct(realized)})`
            : `about ${pct(eq)} equity against their likely hands; ${ip ? "" : "out of position "}a hand like this keeps roughly ${pct(r)} of that (${pct(realized)})`;
        const priced = `${scenario}, priced`;
        const price: PriceInfo = { ev_bb: Math.round(ev_bb * 100) / 100, equity: eq, realized, realization: r, need, decided: true };
        if (realized >= need + pd.margin) {
            return { action: "call", size_bb: 0, scenario: priced, reason: `Call ${cls}: ${numbers}, more than the ${pct(need)} this call needs (worth about +${roundBb(ev_bb)} BB).`, price };
        }
        const close = Math.abs(ev_bb) <= pd.close_spot_bb ? ` Close spot: calling would lose only about ${roundBb(-ev_bb)} BB on average, so either choice costs little.` : "";
        return { ...fold(priced, `Fold ${cls}: ${numbers}, less than the ${pct(need)} this call needs.${close}`), price };
    };

    /**
     * Facing a re-raise (a 3-bet or more) that hero closes, a hand the charts fold still calls when the price is
     * right: against an all-in (a short stack's all-in comes from a wider range and lays a big price), and against
     * a 3-bet that leaves a stack-to-pot ratio under price_defense.three_bet_spr_below after the call (at most one
     * more bet gets the stacks in, so the hand plays close to showdown and its equity counts almost fully).
     * Deeper, the chart decides. Hands the charts play are left alone.
     */
    const foldUnlessPriced = (scenario: string, reason: string): PreflopAdvice => {
        const others_in = s.seats.filter((p) => p.id !== hero.id && !p.folded).length;
        const n = context.equity !== undefined ? priceNumbers(s, v, config, cls, context.equity, others_in > 1) : null;
        const short = raises.length === 2 && !!n && n.spr_after < config.price_defense.three_bet_spr_below;
        const priced = raises.length >= 2 && (last_raise?.all_in || short)
            ? priceDefense(`${scenario}${last_raise?.all_in ? ", all-in" : ", short stacks"}`, others_in > 1) : null;
        return priced?.action === "call" ? priced : fold(scenario, reason);
    };

    // hero opened and nobody re-raised: not a normal preflop decision point, let the caller decide
    if (raises.length === 1 && hero_raised) return null;

    // --- 7-2 bounty: winning with 72 collects a side payment from everyone dealt in, so it's worth a bluff
    const bounty = context.seven_deuce_bounty ?? 0;
    if (bounty > 0 && (cls === "72o" || cls === "72s")) {
        const value_bb = bounty * (s.seats.length - 1) / bb;
        const note = ` 7-2 bounty is on: winning this hand with 72 is worth about ${roundBb(value_bb)} BB extra.`;
        if (raises.length === 0) {
            const heads_up = s.seats.length === 2 && !straddled;
            const to = limpers.length > 0
                ? (heads_up ? config.heads_up.bb_raise_vs_limp_bb : isolateTo(limpers.length, false))
                : (heads_up ? config.heads_up.sb_open_bb : openTo(false));
            const scenario = limpers.length > 0 ? "7-2 bounty, limped pot" : "7-2 bounty, unopened";
            return finish({ action: "raise", size_bb: to, scenario, reason: `Raise ${cls} as a bluff.${note}` });
        }
        if (raises.length >= 2) {
            return foldUnlessPriced("7-2 bounty, facing a 3-bet", `Fold ${cls}: against a 3-bet the price is too high, even with the bounty.${note}`);
        }
        if (callers_after_raise.length <= config.bounty.max_callers_for_three_bet && v.min_raise_to !== null) {
            const advice = finish({ action: "raise", size_bb: threeBetTo(last_raise.street_total / bb, callers_after_raise.length), scenario: "7-2 bounty, facing a raise", reason: "" });
            const cost_bb = advice.size_bb - hero.street_contribution / bb;
            if (advice.size_bb > 0 && value_bb >= config.bounty.three_bet_when_bounty_at_least_x_cost * cost_bb) {
                const verb = advice.action === "all-in" ? "Go all-in" : "3-bet";
                return { ...advice, reason: `${verb} with ${cls} as a bluff: the bounty covers the ${roundBb(cost_bb)} BB it costs.${note}` };
            }
        }
        // otherwise 72 is played like any other hand (a fold) below
    }

    // --- heads-up: the small blind is the button, so ranges are much wider
    if (s.seats.length === 2 && raises.length <= 2 && !straddled) {
        const hu = config.heads_up;
        const villain = s.seats.find((p) => p.id !== hero.id)!;
        const villain_types = playerType(config, stats(villain));
        if (hero.position === "SB") {
            if (raises.length === 0) {
                const scenario = "heads-up, small blind (button) first in";
                const loose = villain_types.has("loose");
                const to = hu.sb_open_bb + (loose ? hu.sb_open_extra_bb_vs_loose : 0);
                const tiers = [raiseTier(to, [hu.sb_open], "playability", "heads-up open"), fold_tier];
                if (inRange(config, hu.sb_open, cls)) {
                    return tiered(finish({ action: "raise", size_bb: to, scenario, reason: `Raise ${cls}: heads-up the small blind is the button and plays most hands (you act last after the flop).${loose ? " The big blind calls too much, so raise a bit bigger." : ""}` }), tiers);
                }
                return tiered(fold(scenario, `Fold ${cls}: one of the weakest hands, even heads-up.`), tiers);
            }
            if (raises.length === 2 && hero_raised) {
                const scenario = "heads-up, facing a 3-bet";
                const four_bet_to = last_raise.street_total / bb * size.four_bet_multiplier;
                const tiers = [raiseTier(four_bet_to, [hu.sb_four_bet_value], "strength", "4-bet for value"), callTier([hu.sb_call_vs_three_bet]), fold_tier];
                if (inRange(config, hu.sb_four_bet_value, cls)) {
                    return tiered(finish({ action: "raise", size_bb: four_bet_to, scenario, reason: `4-bet ${cls} for value.` }), tiers);
                }
                if (inRange(config, hu.sb_call_vs_three_bet, cls)) {
                    return tiered({ action: "call", size_bb: 0, scenario, reason: `Call the 3-bet with ${cls}: good enough heads-up, and you have position after the flop.` }, tiers);
                }
                return tiered(foldUnlessPriced(scenario, `Fold ${cls} to the 3-bet.`), tiers);
            }
        }
        if (hero.position === "BB" || (hero.position === "SB" && raises.length === 1)) {
            if (raises.length === 0) {
                const scenario = "heads-up, small blind limped";
                const tiers = [raiseTier(hu.bb_raise_vs_limp_bb, [hu.bb_raise_vs_limp], "strength", "raise over the limp"), fold_tier];
                if (inRange(config, hu.bb_raise_vs_limp, cls)) {
                    return tiered(finish({ action: "raise", size_bb: hu.bb_raise_vs_limp_bb, scenario, reason: `Raise ${cls} over the limp for value.` }), tiers);
                }
                return tiered({ action: "check", size_bb: 0, scenario, reason: `Check ${cls} and see a free flop.` }, tiers);
            }
            if (raises.length === 1) {
                const scenario = "heads-up, facing a raise";
                const value = villain_types.has("loose_raiser") ? hu.bb_three_bet_value_vs_loose : hu.bb_three_bet_value;
                const three_bet_to = last_raise.street_total / bb * size.three_bet_multiplier_out_of_position;
                const priced = priceDefense(scenario, false);
                const tiers = [raiseTier(three_bet_to, [value], "strength", "3-bet for value"),
                    ...(priced ? [pricedTier(priced)] : [callTier([hu.bb_call_vs_raise]), fold_tier])];
                if (inRange(config, value, cls)) {
                    return tiered(finish({ action: "raise", size_bb: three_bet_to, scenario, reason: `3-bet ${cls} for value.` }), tiers);
                }
                if (priced) return tiered(priced, tiers);
                if (inRange(config, hu.bb_call_vs_raise, cls)) {
                    return tiered({ action: "call", size_bb: 0, scenario, reason: `Call with ${cls}: heads-up the raiser's range is wide, so this hand is worth defending.` }, tiers);
                }
                return tiered(fold(scenario, `Fold ${cls}: too weak to defend even against a wide heads-up range.`), tiers);
            }
        }
        // anything else (e.g. hero 3-bet and faces a 4-bet) uses the general rules below
    }

    // --- facing a 4-bet or more
    if (raises.length >= 3) {
        const scenario = `facing a ${raises.length + 1}-bet`;
        const raiser = seatById.get(last_raise.player_id)!;
        const depth = depthVs(raiser);
        const deep = deepTier(config, depth);
        // deeper stacks put more money in against a range that is mostly KK+ and AK, so fewer hands want it all in
        const ranges: FourBetRanges = { ...config.facing_four_bet, ...deep?.facing_four_bet };
        const loose = looseRaiser(raiser);
        const loose_note = loose ? ` ${raiser.position} raises a lot, so their range is wider.` : "";
        const deep_note = deep ? ` Stacks are about ${Math.round(depth * level)} BB deep.` : "";
        if (inRange(config, loose ? ranges.vs_loose_all_in : ranges.all_in, cls)) {
            return finish({ action: "raise", size_bb: hero_total_stack_bb, scenario, reason: `${cls} is at the top of any range; get it in ${scenario.replace("facing", "against")}.${loose_note}` });
        }
        if (inRange(config, loose ? ranges.vs_loose_call : ranges.call, cls)) {
            // a 4-bet that already uses a big share of the stack leaves nothing to play for later: get it in
            if (last_raise.street_total >= Math.min(total(hero), total(raiser)) * size.all_in_when_raise_uses_share_of_stack) {
                return finish({ action: "raise", size_bb: hero_total_stack_bb, scenario, reason: `Get it in with ${cls}: the raise already puts a big share of the stack in the pot.${loose_note}` });
            }
            return { action: "call", size_bb: 0, scenario, reason: `Call with ${cls}: too strong to fold, but too deep to put it all in with ${cls}.${deep_note}${loose_note}` };
        }
        return foldUnlessPriced(scenario, `Fold ${cls}: ${raises.length + 1}-bets in home games are almost always very strong.${deep_note}`);
    }

    // --- facing a 3-bet
    if (raises.length === 2) {
        const scenario = hero_raised ? "facing a 3-bet after opening" : "facing a 3-bet cold";
        const three_bettor = seatById.get(last_raise.player_id)!;
        const ft = config.facing_three_bet;
        const three_bet = threeBetOf(config, stats(three_bettor));
        const kind = three_bet === undefined ? "normal" : three_bet < ft.tight_below ? "tight" : three_bet >= ft.loose_at_least ? "loose" : "normal";
        const ranges = ft[kind];
        const who = three_bettor.position;
        const freq = three_bet === undefined
            ? ` No 3-bet history on ${who} yet, so assume a typical 3-bet range.`
            : ` ${who} 3-bets ${Math.round(three_bet)}% of the time${kind === "tight" ? ", a tight range" : kind === "loose" ? ", a wide range" : ""}.`;
        const four_bet_to = last_raise.street_total / bb * size.four_bet_multiplier;
        const in_position = heroActsAfter(three_bettor);
        const deep_extra = deepTier(config, depthVs(three_bettor))?.add_to_three_bet_calls_in_position;
        const base = hero_raised ? ranges.call_after_opening : ranges.call_cold;
        const extras = hero_raised && in_position ? [ranges.in_position_extra, deep_extra] : [];
        const tiers = [raiseTier(four_bet_to, [ranges.four_bet_value], "strength", "4-bet for value"), callTier([base, ...extras]), fold_tier];
        if (inRange(config, ranges.four_bet_value, cls)) {
            return tiered(finish({ action: "raise", size_bb: four_bet_to, scenario, reason: `4-bet ${cls} for value.${freq}` }), tiers);
        }
        if (inAny(config, [base, ...extras], cls)) {
            if (!setMineOk()) {
                return foldUnlessPriced(scenario, `Fold ${cls}: stacks are too short to call a 3-bet hoping to hit a set (need ${size.set_mine_min_stack_to_call_ratio}x the call).`);
            }
            const why = inRange(config, base, cls) ? `strong enough to call, not to 4-bet for value${in_position ? ", and you have position" : ""}`
                : inAny(config, [ranges.in_position_extra], cls) ? "worth a call because you have position"
                : `stacks are deep and you have position, so you can win a big pot when you hit`;
            return tiered({ action: "call", size_bb: 0, scenario, reason: `Call the 3-bet with ${cls}: ${why}.${freq}` }, tiers);
        }
        return tiered(foldUnlessPriced(scenario, `Fold ${cls} to the 3-bet.${freq}`), tiers);
    }

    // --- facing one raise
    if (raises.length === 1 && !hero_raised) {
        const raiser = seatById.get(last_raise.player_id)!;
        const raiser_types = playerType(config, stats(raiser));
        const raise_to_bb = last_raise.street_total / bb;
        const multiway = callers_after_raise.length > 0;
        // raises from late position (CO, BU, SB) come from much wider ranges
        const late = !multiway && ["CO", "BU", "SB"].includes(raiser.position);
        const vs_late = config.vs_late_position_raise;
        const scenario = multiway ? `facing a raise and ${callers_after_raise.length} caller(s)` : `facing a raise from ${raiser.position}`;
        const value = multiway ? config.three_bet_value.default
            : raiser_types.has("nit") ? config.three_bet_value.vs_nit
            : late ? vs_late.three_bet_value
            : raiser_types.has("loose_raiser") ? config.three_bet_value.vs_loose
            : config.three_bet_value.default;
        const three_bet_to = threeBetTo(raise_to_bb, callers_after_raise.length);
        // closing the action (e.g. the big blind): the price decides, using equity against the actual ranges
        const priced = priceDefense(scenario, multiway);
        const vs_nit = !multiway && raiser_types.has("nit");
        const calls = multiway ? config.call_raise_multiway
            : vs_nit ? config.call_raise.vs_nit
            : late ? vs_late[role]
            : config.call_raise[role];
        // deep stacks pay off hands that make sets, straights and flushes, and punish dominated offsuit hands
        // (a nit's range stays respected: the vs_nit range is used as it is)
        const depth = depthVs(raiser);
        const deep = deepTier(config, depth);
        const deep_add = vs_nit ? undefined : role === "in_position" ? deep?.add_to_calls : deep?.add_to_calls_from_blinds;
        // deep and multiway in position: more speculative hands (more players to pay off a set, straight or flush)
        const deep_multi = multiway && role === "in_position" ? deep?.add_to_multiway_calls : undefined;
        // with antes in the pot the blinds get a better price
        const ante_add = widen === 0 || vs_nit ? undefined : role === "big_blind" ? ante.big_blind_defense_extra : role === "small_blind" ? ante.small_blind_defense_extra : undefined;
        const tiers = [raiseTier(three_bet_to, [value], "strength", "3-bet for value"),
            ...(priced ? [pricedTier(priced)] : [callTier([calls, deep_add, deep_multi, ante_add]), fold_tier])];
        if (inRange(config, value, cls)) {
            const why = raiser_types.has("loose_raiser") ? ` ${raiser.position} raises a lot, so 3-bet a wider value range.` : "";
            return tiered(finish({ action: "raise", size_bb: three_bet_to, scenario, reason: `3-bet ${cls} for value.${why}` }), tiers);
        }
        // the hand's usual play here (priced call or fold, call, or fold)
        const usual = ((): PreflopAdvice => {
            if (priced) return tiered(priced, tiers);
            const in_base = inRange(config, calls, cls);
            const removed = !late && !!deep?.remove_from_calls && inRange(config, deep.remove_from_calls, cls);
            if (removed && (in_base || inAny(config, [deep_add, deep_multi, ante_add], cls))) {
                return fold(scenario, `Fold ${cls}: stacks are about ${Math.round(depth * level)} BB deep, and ${cls} too often loses a big pot to a better hand from ${raiser.position}.`);
            }
            if (in_base || inAny(config, [deep_add, deep_multi, ante_add], cls)) {
                if (!setMineOk()) {
                    return fold(scenario, `Fold ${cls}: stacks are too short to call just hoping to hit a set (need ${size.set_mine_min_stack_to_call_ratio}x the call).`);
                }
                const why = in_base ? `good enough to see a flop, not strong enough to 3-bet for value${multiway ? " into several players" : ""}`
                    : inAny(config, [deep_add], cls) ? `stacks are about ${Math.round(depth * level)} BB deep, so a hand that can make a set, straight or flush is worth a call`
                    : inAny(config, [deep_multi], cls) ? `stacks are about ${Math.round(depth * level)} BB deep and ${callers_after_raise.length + 1} players are in, so a hand that can make a set, straight or flush gets paid when it hits`
                    : "the antes make the pot bigger, so the blinds defend a little wider";
                return tiered({ action: "call", size_bb: 0, scenario, reason: `Call with ${cls}: ${why}.` }, tiers);
            }
            return tiered(fold(scenario, `Fold ${cls} against a raise from ${raiser.position}.`), tiers);
        })();
        // solver-style mixed 3-bets and squeezes with blocker and playability hands (three_bet_bluff)
        const bluff = bluffFrequency(config, multiway ? "squeeze" : late ? "vs_late" : "vs_early", cls);
        if (bluff > 0 && v.min_raise_to !== null) {
            const raise = finish({ action: "raise", size_bb: three_bet_to, scenario, reason: "" });
            // a raise that would be all-in isn't a bluff to mix: keep the usual play
            if (raise.action === "raise") {
                const verb = multiway ? "squeeze" : "3-bet";
                const usual_verb = usual.action === "call" ? "call" : usual.action === "check" ? "check" : "fold";
                const why = cls[0] === "A" ? "the ace makes AA and AK less likely and the hand plays well when called"
                    : "it makes straights and flushes when called, and raising it sometimes keeps your 3-bets from being only big hands";
                const mix = `${verb[0].toUpperCase()}${verb.slice(1)} ${cls} as a bluff ${Math.round(bluff * 100)}% of the time and ${usual_verb} the rest: ${why} (solver charts mix it).`;
                const mixed_raise = { freq: bluff, size_bb: raise.size_bb, usual: { action: usual.action, size_bb: usual.size_bb } };
                const chosen = bluff >= 0.5 ? { ...raise, reason: mix } : { ...usual, reason: `${mix} ${usual.reason}` };
                return { ...chosen, tiers: usual.tiers ?? tiers, mixed_raise };
            }
        }
        return usual;
    }

    // --- limped pot (no raise yet)
    if (limpers.length > 0 && raises.length === 0) {
        const scenario = `${limpers.length} limper(s)`;
        const category = out_of_position ? "blinds" : categoryOf(hero.position);
        const loose_limpers = limpers.some((a) => playerType(config, stats(seatById.get(a.player_id)!)).has("loose"));
        const iso_to = isolateTo(limpers.length, loose_limpers);
        const deep = deepTier(config, v.effective_stack / blind_level);
        const iso = raiseTier(iso_to, [config.isolate_limpers[category]], "strength", "raise to isolate");
        const tiers = v.to_call === 0 ? [iso, fold_tier]
            : role === "small_blind" ? [iso, callTier([config.complete_small_blind], "complete"), fold_tier]
            : category === "late" || category === "middle" ? [iso, callTier([config.overlimp_in_position, deep?.add_to_calls], "limp behind"), fold_tier]
            : [iso, fold_tier];
        if (inRange(config, config.isolate_limpers[category], cls)) {
            const why = loose_limpers ? " The limpers call too much, so size up." : "";
            return tiered(finish({ action: "raise", size_bb: iso_to, scenario, reason: `Raise ${cls} to isolate the limpers and play a bigger pot with a strong hand.${why}${straddle_note}` }), tiers);
        }
        if (v.to_call === 0) {
            return tiered({ action: "check", size_bb: 0, scenario, reason: `Check ${cls} in the ${seat_name} and see a free flop.` }, tiers);
        }
        if (role === "small_blind" && inRange(config, config.complete_small_blind, cls)) {
            return tiered({ action: "call", size_bb: 0, scenario, reason: `Complete ${cls} from the ${seat_name}: cheap price with several players in.` }, tiers);
        }
        if ((category === "late" || category === "middle") && inAny(config, [config.overlimp_in_position, deep?.add_to_calls], cls)) {
            return tiered({ action: "call", size_bb: 0, scenario, reason: `Limp behind with ${cls}: it plays well multiway and in position.` }, tiers);
        }
        return tiered(fold(scenario, `Fold ${cls}: not strong enough to raise and not good enough to limp in behind.`), tiers);
    }

    // --- unopened
    if (v.to_call === 0) {
        return { action: "check", size_bb: 0, scenario: "unopened", reason: "Everyone folded or checked to you." };
    }
    const behind = order.slice(hero_index + 1);
    // the straddler counts as a player behind even in a blind seat (heads-up or 3-handed)
    const non_blind_behind = behind.filter((p) => (p.position !== "SB" && p.position !== "BB") || straddlers.includes(p.id)).length;
    const seat_key = role === "small_blind" ? "SB" : PREFLOP_ORDER_FROM_BUTTON[Math.min(non_blind_behind, PREFLOP_ORDER_FROM_BUTTON.length - 1)];
    // antes: open with a later seat's range (the small blind widens to the button's)
    const seat_index = seat_key === "SB" ? 1 : PREFLOP_ORDER_FROM_BUTTON.indexOf(seat_key);
    const open_key = widen > 0 ? PREFLOP_ORDER_FROM_BUTTON[Math.max(0, seat_index - widen)] : seat_key;
    const widened = open_key !== seat_key;
    const open_range = (config.open as Record<string, string>)[open_key];
    const scenario = `unopened (${open_key} range${widened ? ", wider for the antes" : ""})`;
    const avg_vpip = behind.length ? behind.reduce((sum, p) => sum + vpipOf(stats(p)), 0) / behind.length : 0;
    const loose_field = avg_vpip >= config.player_types.loose_vpip;
    // completing is cheap with only one player left to act; with a straddle behind too, play tighter
    const complete = behind.length <= 1 ? config.complete_small_blind_when_folded_to : config.complete_small_blind;
    const open = raiseTier(openTo(loose_field), [open_range], "playability", "open");
    const tiers = role === "small_blind" ? [open, callTier([complete], "complete"), fold_tier] : [open, fold_tier];
    if (inRange(config, open_range, cls)) {
        const notes = (loose_field ? " Players behind call too much, so open bigger." : "")
            + (widened ? ` The blinds and antes already make a ${roundBb(dead_chips / bb)} BB pot, so open wider than usual from ${hero.position}.` : "")
            + straddle_note;
        return tiered(finish({ action: "raise", size_bb: openTo(loose_field), scenario, reason: `Open ${cls} from ${hero.position}: it's in the ${open_key} opening range.${notes}` }), tiers);
    }
    if (role === "small_blind" && inRange(config, complete, cls)) {
        return tiered({ action: "call", size_bb: 0, scenario, reason: `Complete ${cls} from the ${seat_name}: not strong enough to raise, but cheap to see a flop${behind.length <= 1 ? ` against the ${straddled ? "straddle" : "big blind"}` : ""}.` }, tiers);
    }
    return tiered(fold(scenario, `Fold ${cls}: outside the ${open_key} opening range.`), tiers);
}
