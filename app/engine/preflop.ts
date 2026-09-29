import default_config from "../configs/preflop-ranges.json" with { type: "json" };
import { HandState, HeroView, SeatState } from "./hand-parser.ts";
import { classOf, HandClass } from "./hand-classes.ts";
import { MIN_HANDS_FOR_STATS, ObservedStats, POPULATION_TENDENCIES } from "./opponent-range.ts";
import { parseRange } from "./range-notation.ts";

export type PreflopConfig = typeof default_config;

export interface PreflopAdvice {
    action: "fold" | "check" | "call" | "raise" | "all-in",
    /** Raise-to size in big blinds (0 for other actions). */
    size_bb: number,
    scenario: string,
    reason: string
}

type StatsLookup = (name: string) => ObservedStats | undefined;

const PREFLOP_ORDER_FROM_BUTTON = ["BU", "CO", "HJ", "LJ", "MP", "UTG+1", "UTG"];
const CATEGORY: Record<string, "early" | "middle" | "late" | "blinds"> = {
    "UTG": "early", "UTG+1": "early", "MP": "early", "LJ": "middle", "HJ": "middle", "CO": "late", "BU": "late", "SB": "blinds", "BB": "blinds"
};

// parsed ranges are cached per config object
const cache = new WeakMap<object, Map<string, Set<HandClass>>>();
function inRange(config: PreflopConfig, notation: string, cls: HandClass): boolean {
    let m = cache.get(config);
    if (!m) { m = new Map(); cache.set(config, m); }
    let set = m.get(notation);
    if (!set) { set = parseRange(notation); m.set(notation, set); }
    return set.has(cls);
}

/** Preflop acting order: UTG ... BU, SB, BB. */
function preflopOrder(s: HandState): SeatState[] {
    const order = ["UTG", "UTG+1", "MP", "LJ", "HJ", "CO", "BU", "SB", "BB"];
    return [...s.seats].sort((a, b) => order.indexOf(a.position) - order.indexOf(b.position));
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

/** Deterministic preflop advice for hero. Returns null if the spot can't be analyzed (e.g. unknown cards). */
export function preflopAdvice(s: HandState, v: HeroView, stats: StatsLookup, config: PreflopConfig = default_config): PreflopAdvice | null {
    if (s.street !== "preflop" || s.hero_cards.length !== 2) return null;
    const hero = s.seats.find((p) => p.id === s.hero_id);
    if (!hero) return null;
    const bb = s.big_blind;
    const cls = classOf(s.hero_cards);
    const size = config.sizing;
    const order = preflopOrder(s);
    const hero_index = order.findIndex((p) => p.id === hero.id);
    const in_blinds = hero.position === "SB" || hero.position === "BB";
    const hero_total_stack_bb = (hero.stack + hero.street_contribution) / bb;

    // what happened before hero's turn
    const voluntary = s.actions.filter((a) => a.street === "preflop" && ["call", "raise", "bet"].includes(a.type));
    const raises = voluntary.filter((a) => a.type === "raise" || a.type === "bet");
    const hero_raised = raises.some((a) => a.player_id === hero.id);
    const last_raise = raises[raises.length - 1];
    // blind level: the big blind, or a straddle if one was posted
    const blind_level = Math.max(bb, ...s.actions.filter((a) => a.street === "preflop" && (a.type === "post_bb" || a.type === "post_straddle")).map((a) => a.street_total));
    const limpers = raises.length === 0
        ? voluntary.filter((a) => a.type === "call" && a.bet_to_call_before <= blind_level + 1e-9 && a.player_id !== hero.id)
        : [];
    const callers_after_raise = last_raise ? voluntary.filter((a) => a.type === "call" && s.actions.indexOf(a) > s.actions.indexOf(last_raise)) : [];
    const seatById = new Map(s.seats.map((p) => [p.id, p]));
    const to_call_bb = v.to_call / bb;

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

    // hero opened and nobody re-raised: not a normal preflop decision point, let the caller decide
    if (raises.length === 1 && hero_raised) return null;

    // --- facing a 4-bet or more
    if (raises.length >= 3) {
        const scenario = "facing a 4-bet";
        return inRange(config, config.continue_vs_four_bet, cls)
            ? finish({ action: "raise", size_bb: hero_total_stack_bb, scenario, reason: `${cls} is at the top of any range; get it in against a 4-bet.` })
            : fold(scenario, `Fold ${cls}: 4-bets in home games are almost always very strong.`);
    }

    // --- facing a 3-bet
    if (raises.length === 2) {
        const scenario = hero_raised ? "facing a 3-bet after opening" : "facing a 3-bet cold";
        const three_bet_to_bb = last_raise.street_total / bb;
        if (inRange(config, config.four_bet_value, cls)) {
            return finish({ action: "raise", size_bb: three_bet_to_bb * size.four_bet_multiplier, scenario, reason: `4-bet ${cls} for value.` });
        }
        const calls = hero_raised ? config.call_three_bet : "QQ AKs";
        if (inRange(config, calls, cls)) {
            return { action: "call", size_bb: 0, scenario, reason: `${cls} is strong enough to call the 3-bet but not to 4-bet for value.` };
        }
        return fold(scenario, `Fold ${cls} to the 3-bet; passive players rarely 3-bet light.`);
    }

    // --- facing one raise
    if (raises.length === 1 && !hero_raised) {
        const raiser = seatById.get(last_raise.player_id)!;
        const raiser_types = playerType(config, stats(raiser.name));
        const raise_to_bb = last_raise.street_total / bb;
        const multiway = callers_after_raise.length > 0;
        const scenario = multiway ? `facing a raise and ${callers_after_raise.length} caller(s)` : "facing a raise";
        const value = multiway || raiser_types.has("unknown")
            ? config.three_bet_value.default
            : raiser_types.has("nit") ? config.three_bet_value.vs_nit
            : raiser_types.has("loose_raiser") ? config.three_bet_value.vs_loose
            : config.three_bet_value.default;
        if (inRange(config, value, cls)) {
            const mult = in_blinds ? size.three_bet_multiplier_out_of_position : size.three_bet_multiplier_in_position;
            const to = raise_to_bb * mult + callers_after_raise.length * size.three_bet_extra_per_caller * raise_to_bb;
            const why = raiser_types.has("loose_raiser") ? ` ${raiser.position} raises a lot, so 3-bet a wider value range.` : "";
            return finish({ action: "raise", size_bb: to, scenario, reason: `3-bet ${cls} for value.${why}` });
        }
        const calls = multiway ? config.call_raise_multiway
            : raiser_types.has("nit") ? config.call_raise.vs_nit
            : hero.position === "SB" ? config.call_raise.small_blind
            : hero.position === "BB" ? config.call_raise.big_blind
            : config.call_raise.in_position;
        if (inRange(config, calls, cls)) {
            if (!setMineOk()) {
                return fold(scenario, `Fold ${cls}: stacks are too short to call just hoping to hit a set (need ${size.set_mine_min_stack_to_call_ratio}x the call).`);
            }
            return { action: "call", size_bb: 0, scenario, reason: `Call with ${cls}: good enough to see a flop, not strong enough to 3-bet for value${multiway ? " into several players" : ""}.` };
        }
        return fold(scenario, `Fold ${cls} against a raise from ${raiser.position}.`);
    }

    // --- limped pot (no raise yet)
    if (limpers.length > 0 && raises.length === 0) {
        const scenario = `${limpers.length} limper(s)`;
        const category = CATEGORY[hero.position] ?? "late";
        const loose_limpers = limpers.filter((a) => playerType(config, stats(seatById.get(a.player_id)!.name)).has("loose")).length;
        if (inRange(config, config.isolate_limpers[category], cls)) {
            const to = size.isolate_base_bb + limpers.length * size.isolate_per_limper_bb
                + (in_blinds ? size.out_of_position_extra_bb : 0) + (loose_limpers > 0 ? 1 : 0);
            const why = loose_limpers > 0 ? " The limpers call too much, so size up." : "";
            return finish({ action: "raise", size_bb: to, scenario, reason: `Raise ${cls} to isolate the limpers and play a bigger pot with a strong hand.${why}` });
        }
        if (hero.position === "BB") {
            return { action: "check", size_bb: 0, scenario, reason: `Check ${cls} in the big blind and see a free flop.` };
        }
        if (hero.position === "SB" && inRange(config, config.complete_small_blind, cls)) {
            return { action: "call", size_bb: 0, scenario, reason: `Complete ${cls} from the small blind: cheap price with several players in.` };
        }
        if ((category === "late" || category === "middle") && inRange(config, config.overlimp_in_position, cls)) {
            return { action: "call", size_bb: 0, scenario, reason: `Limp behind with ${cls}: it plays well multiway and in position.` };
        }
        return fold(scenario, `Fold ${cls}: not strong enough to raise and not good enough to limp in behind.`);
    }

    // --- unopened
    if (hero.position === "BB") {
        return { action: "check", size_bb: 0, scenario: "unopened", reason: "Everyone folded or checked to you." };
    }
    const non_blind_behind = order.slice(hero_index + 1).filter((p) => p.position !== "SB" && p.position !== "BB").length;
    const open_key = hero.position === "SB" ? "SB" : PREFLOP_ORDER_FROM_BUTTON[Math.min(non_blind_behind, PREFLOP_ORDER_FROM_BUTTON.length - 1)];
    const open_range = (config.open as Record<string, string>)[open_key];
    const scenario = `unopened (${open_key} range)`;
    if (inRange(config, open_range, cls)) {
        const behind = order.slice(hero_index + 1);
        const avg_vpip = behind.length ? behind.reduce((sum, p) => sum + vpipOf(stats(p.name)), 0) / behind.length : 0;
        const loose_field = avg_vpip >= config.player_types.loose_vpip;
        const to = size.open_bb + (loose_field ? size.open_extra_bb_vs_loose_field : 0);
        return finish({ action: "raise", size_bb: to, scenario, reason: `Open ${cls} from ${hero.position}: it's in the ${open_key} opening range.${loose_field ? " Players behind call too much, so open bigger." : ""}` });
    }
    return fold(scenario, `Fold ${cls}: outside the ${open_key} opening range.`);
}
