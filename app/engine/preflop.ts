import default_config from "../configs/preflop-ranges.json" with { type: "json" };
import { HandState, HeroView, SeatState } from "./hand-parser.ts";
import { classOf, HandClass } from "./hand-classes.ts";
import { MIN_HANDS_FOR_STATS, ObservedStats, POPULATION_TENDENCIES } from "./opponent-range.ts";
import { parseRange } from "./range-notation.ts";
import type { PlayerRef } from "./player-profile.ts";

export type PreflopConfig = typeof default_config;

export interface PreflopAdvice {
    action: "fold" | "check" | "call" | "raise" | "all-in",
    /** Raise-to size in big blinds (0 for other actions). */
    size_bb: number,
    scenario: string,
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
    equity?: number
}

const RANK_ORDER = "23456789TJQKA";

/**
 * Share of its raw equity a hand typically keeps when it calls a raise and plays the flop out of position.
 * Suited and connected hands keep more (they make strong draws and hands), offsuit unconnected hands less;
 * a low stack-to-pot ratio after the call keeps more because the hand is played to showdown sooner.
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
    const adjusted = base * (multiway ? pd.multiway_factor : 1)
        + (spr_after_call < pd.short_spr_below ? pd.short_spr_bonus : 0)
        - (offsuit && spr_after_call >= pd.deep_spr_at_least ? pd.deep_offsuit_penalty : 0);
    return Math.max(0.3, Math.min(1, adjusted));
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
function postflopRank(position: string): number {
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
    const setMineOk = () => {
        const small_pair = cls.length === 2 && "23456789".includes(cls[0]);
        return !small_pair || v.effective_stack / Math.max(v.to_call, 1e-9) >= size.set_mine_min_stack_to_call_ratio;
    };
    // hero closes the action when everyone else still able to act has already matched the bet
    const closes_action = s.seats.every((p) => p.id === hero.id || p.folded || p.all_in || p.street_contribution >= s.current_bet - 1e-9);
    /**
     * Call or fold by price when hero closes the action: equity against the players still in, times the share
     * a hand like this keeps out of position, against the equity the call needs. Null when it doesn't apply.
     */
    const priceDefense = (scenario: string, multiway: boolean): PreflopAdvice | null => {
        const pd = config.price_defense;
        const eq = context.equity;
        if (!pd.enabled || eq === undefined || !closes_action || v.to_call <= 0) return null;
        const pot_after = v.pot + v.to_call;
        const need = v.to_call / pot_after;
        const spr_after = Math.max(0, v.effective_stack - s.current_bet) / pot_after;
        const r = realizationOf(config, cls, multiway, spr_after);
        const realized = eq * r;
        const ev_bb = (realized * pot_after - v.to_call) / bb;
        const pct = (x: number) => `${Math.round(x * 100)}%`;
        const numbers = `about ${pct(eq)} equity against their likely hands; out of position a hand like this keeps roughly ${pct(r)} of that (${pct(realized)})`;
        const priced = `${scenario}, priced`;
        if (realized >= need + pd.margin) {
            return { action: "call", size_bb: 0, scenario: priced, reason: `Call ${cls}: ${numbers}, more than the ${pct(need)} this call needs (worth about +${roundBb(ev_bb)} BB).` };
        }
        const close = Math.abs(ev_bb) <= pd.close_spot_bb ? ` Close spot: calling would lose only about ${roundBb(-ev_bb)} BB on average, so either choice costs little.` : "";
        return fold(priced, `Fold ${cls}: ${numbers}, less than the ${pct(need)} this call needs.${close}`);
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
            return fold("7-2 bounty, facing a 3-bet", `Fold ${cls}: against a 3-bet the price is too high, even with the bounty.${note}`);
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
                if (inRange(config, hu.sb_open, cls)) {
                    const loose = villain_types.has("loose");
                    const to = hu.sb_open_bb + (loose ? hu.sb_open_extra_bb_vs_loose : 0);
                    return finish({ action: "raise", size_bb: to, scenario, reason: `Raise ${cls}: heads-up the small blind is the button and plays most hands (you act last after the flop).${loose ? " The big blind calls too much, so raise a bit bigger." : ""}` });
                }
                return fold(scenario, `Fold ${cls}: one of the weakest hands, even heads-up.`);
            }
            if (raises.length === 2 && hero_raised) {
                const scenario = "heads-up, facing a 3-bet";
                if (inRange(config, hu.sb_four_bet_value, cls)) {
                    return finish({ action: "raise", size_bb: last_raise.street_total / bb * size.four_bet_multiplier, scenario, reason: `4-bet ${cls} for value.` });
                }
                if (inRange(config, hu.sb_call_vs_three_bet, cls)) {
                    return { action: "call", size_bb: 0, scenario, reason: `Call the 3-bet with ${cls}: good enough heads-up, and you have position after the flop.` };
                }
                return fold(scenario, `Fold ${cls} to the 3-bet.`);
            }
        }
        if (hero.position === "BB" || (hero.position === "SB" && raises.length === 1)) {
            if (raises.length === 0) {
                const scenario = "heads-up, small blind limped";
                if (inRange(config, hu.bb_raise_vs_limp, cls)) {
                    return finish({ action: "raise", size_bb: hu.bb_raise_vs_limp_bb, scenario, reason: `Raise ${cls} over the limp for value.` });
                }
                return { action: "check", size_bb: 0, scenario, reason: `Check ${cls} and see a free flop.` };
            }
            if (raises.length === 1) {
                const scenario = "heads-up, facing a raise";
                const value = villain_types.has("loose_raiser") ? hu.bb_three_bet_value_vs_loose : hu.bb_three_bet_value;
                if (inRange(config, value, cls)) {
                    return finish({ action: "raise", size_bb: last_raise.street_total / bb * size.three_bet_multiplier_out_of_position, scenario, reason: `3-bet ${cls} for value.` });
                }
                const priced = priceDefense(scenario, false);
                if (priced) return priced;
                if (inRange(config, hu.bb_call_vs_raise, cls)) {
                    return { action: "call", size_bb: 0, scenario, reason: `Call with ${cls}: heads-up the raiser's range is wide, so this hand is worth defending.` };
                }
                return fold(scenario, `Fold ${cls}: too weak to defend even against a wide heads-up range.`);
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
        return fold(scenario, `Fold ${cls}: ${raises.length + 1}-bets in home games are almost always very strong.${deep_note}`);
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
        if (inRange(config, ranges.four_bet_value, cls)) {
            return finish({ action: "raise", size_bb: last_raise.street_total / bb * size.four_bet_multiplier, scenario, reason: `4-bet ${cls} for value.${freq}` });
        }
        const in_position = heroActsAfter(three_bettor);
        const deep_extra = deepTier(config, depthVs(three_bettor))?.add_to_three_bet_calls_in_position;
        const base = hero_raised ? ranges.call_after_opening : ranges.call_cold;
        const extras = hero_raised && in_position ? [ranges.in_position_extra, deep_extra] : [];
        if (inAny(config, [base, ...extras], cls)) {
            if (!setMineOk()) {
                return fold(scenario, `Fold ${cls}: stacks are too short to call a 3-bet hoping to hit a set (need ${size.set_mine_min_stack_to_call_ratio}x the call).`);
            }
            const why = inRange(config, base, cls) ? `strong enough to call, not to 4-bet for value${in_position ? ", and you have position" : ""}`
                : inAny(config, [ranges.in_position_extra], cls) ? "worth a call because you have position"
                : `stacks are deep and you have position, so you can win a big pot when you hit`;
            return { action: "call", size_bb: 0, scenario, reason: `Call the 3-bet with ${cls}: ${why}.${freq}` };
        }
        return fold(scenario, `Fold ${cls} to the 3-bet.${freq}`);
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
        if (inRange(config, value, cls)) {
            const why = raiser_types.has("loose_raiser") ? ` ${raiser.position} raises a lot, so 3-bet a wider value range.` : "";
            return finish({ action: "raise", size_bb: threeBetTo(raise_to_bb, callers_after_raise.length), scenario, reason: `3-bet ${cls} for value.${why}` });
        }
        // closing the action (e.g. the big blind): the price decides, using equity against the actual ranges
        const priced = priceDefense(scenario, multiway);
        if (priced) return priced;
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
        // with antes in the pot the blinds get a better price
        const ante_add = widen === 0 || vs_nit ? undefined : role === "big_blind" ? ante.big_blind_defense_extra : role === "small_blind" ? ante.small_blind_defense_extra : undefined;
        const in_base = inRange(config, calls, cls);
        const removed = !late && !!deep?.remove_from_calls && inRange(config, deep.remove_from_calls, cls);
        if (removed && (in_base || inAny(config, [deep_add, ante_add], cls))) {
            return fold(scenario, `Fold ${cls}: stacks are about ${Math.round(depth * level)} BB deep, and ${cls} too often loses a big pot to a better hand from ${raiser.position}.`);
        }
        if (in_base || inAny(config, [deep_add, ante_add], cls)) {
            if (!setMineOk()) {
                return fold(scenario, `Fold ${cls}: stacks are too short to call just hoping to hit a set (need ${size.set_mine_min_stack_to_call_ratio}x the call).`);
            }
            const why = in_base ? `good enough to see a flop, not strong enough to 3-bet for value${multiway ? " into several players" : ""}`
                : inAny(config, [deep_add], cls) ? `stacks are about ${Math.round(depth * level)} BB deep, so a hand that can make a set, straight or flush is worth a call`
                : "the antes make the pot bigger, so the blinds defend a little wider";
            return { action: "call", size_bb: 0, scenario, reason: `Call with ${cls}: ${why}.` };
        }
        return fold(scenario, `Fold ${cls} against a raise from ${raiser.position}.`);
    }

    // --- limped pot (no raise yet)
    if (limpers.length > 0 && raises.length === 0) {
        const scenario = `${limpers.length} limper(s)`;
        const category = out_of_position ? "blinds" : categoryOf(hero.position);
        const loose_limpers = limpers.some((a) => playerType(config, stats(seatById.get(a.player_id)!)).has("loose"));
        if (inRange(config, config.isolate_limpers[category], cls)) {
            const why = loose_limpers ? " The limpers call too much, so size up." : "";
            return finish({ action: "raise", size_bb: isolateTo(limpers.length, loose_limpers), scenario, reason: `Raise ${cls} to isolate the limpers and play a bigger pot with a strong hand.${why}${straddle_note}` });
        }
        if (v.to_call === 0) {
            return { action: "check", size_bb: 0, scenario, reason: `Check ${cls} in the ${seat_name} and see a free flop.` };
        }
        if (role === "small_blind" && inRange(config, config.complete_small_blind, cls)) {
            return { action: "call", size_bb: 0, scenario, reason: `Complete ${cls} from the ${seat_name}: cheap price with several players in.` };
        }
        const deep = deepTier(config, v.effective_stack / blind_level);
        if ((category === "late" || category === "middle") && inAny(config, [config.overlimp_in_position, deep?.add_to_calls], cls)) {
            return { action: "call", size_bb: 0, scenario, reason: `Limp behind with ${cls}: it plays well multiway and in position.` };
        }
        return fold(scenario, `Fold ${cls}: not strong enough to raise and not good enough to limp in behind.`);
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
    if (inRange(config, open_range, cls)) {
        const avg_vpip = behind.length ? behind.reduce((sum, p) => sum + vpipOf(stats(p)), 0) / behind.length : 0;
        const loose_field = avg_vpip >= config.player_types.loose_vpip;
        const notes = (loose_field ? " Players behind call too much, so open bigger." : "")
            + (widened ? ` The blinds and antes already make a ${roundBb(dead_chips / bb)} BB pot, so open wider than usual from ${hero.position}.` : "")
            + straddle_note;
        return finish({ action: "raise", size_bb: openTo(loose_field), scenario, reason: `Open ${cls} from ${hero.position}: it's in the ${open_key} opening range.${notes}` });
    }
    // completing is cheap with only one player left to act; with a straddle behind too, play tighter
    const complete = behind.length <= 1 ? config.complete_small_blind_when_folded_to : config.complete_small_blind;
    if (role === "small_blind" && inRange(config, complete, cls)) {
        return { action: "call", size_bb: 0, scenario, reason: `Complete ${cls} from the ${seat_name}: not strong enough to raise, but cheap to see a flop${behind.length <= 1 ? ` against the ${straddled ? "straddle" : "big blind"}` : ""}.` };
    }
    return fold(scenario, `Fold ${cls}: outside the ${open_key} opening range.`);
}
