// Rebuilds every decision you made in your stored hands (the log up to your action) and asks the
// engine what it would have done there, the way the live bot does: the preflop engine with its
// price check, and the post-flop engine's top option with the AI off.
//
// Opponent profiles: by default each game is evaluated with profiles, action weights and the
// response table built from every OTHER game (leave one game out), so the engine never sees the
// hands it is judged on. The engine's built-in constants were tuned on these same games, which no
// replay can undo.
import { allInAdjustedNet } from "../engine/allin-ev.ts";
import { equity, rangeProfile } from "../engine/equity.ts";
import { bountyFromHands } from "../engine/game-rules.ts";
import { HandState, heroView, HeroView, netResult, parseHand, Street } from "../engine/hand-parser.ts";
import { opponentModels, seatModel, TABLE_RULES } from "../engine/opponent-range.ts";
import { analyzePostflop, PostflopAnalysis, setResponseTable } from "../engine/postflop.ts";
import { preflopAdvice } from "../engine/preflop.ts";
import { setActionWeights } from "../engine/equity.ts";
import { mixPostflop, mixPreflop, MixStrategy, MixStyle } from "../engine/mixing.ts";
import { classOf } from "../engine/hand-classes.ts";
import { opponentTendencies } from "../helpers/decision-maker.ts";
import type { PlayerRef } from "../engine/player-profile.ts";
import type { ObservedStats } from "../engine/opponent-range.ts";
import type { HandRecorder, HandRow } from "../services/hand-recorder.ts";
import { PlayerLookup, ProfileService } from "../services/profile-service.ts";

/** A decision reduced to its kind: bets, raises and all-ins that raise count as "raise". */
export type Kind = "fold" | "check" | "call" | "raise";

export interface EngineChoice {
    kind: Kind,
    /** Bet or raise-to in chips (0 otherwise). */
    to: number,
    label: string,
    /** The engine's pick is a bluff or semi-bluff bet or raise (post-flop). */
    bluff?: boolean,
    /** With AdvisorOptions.mix_styles: the mixed strategy under each style (roll 50; only the frequencies matter). */
    mixes?: Partial<Record<MixStyle, MixedChoice>>
}

/** A mixed strategy reduced to what the mixing report needs. */
export interface MixedChoice {
    pure: boolean,
    /** EV given up by mixing, big blinds (post-flop). */
    cost_bb?: number,
    options: { kind: Kind, freq: number, bluff: boolean }[],
    baseline?: Record<string, number>
}

function mixedChoice(m: MixStrategy, s: HandState, a: PostflopAnalysis | null): MixedChoice {
    const bb = s.big_blind;
    return {
        pure: m.pure,
        ...(m.cost_bb !== undefined ? { cost_bb: m.cost_bb } : {}),
        options: m.options.map((o) => {
            const c = a?.candidates.find((x) => x.label === o.label);
            return { kind: kindOf(o.action, o.size_bb * bb, s), freq: o.freq, bluff: !!c?.purpose && c.purpose !== "value" };
        }),
        ...(m.baseline ? { baseline: m.baseline } : {})
    };
}

export type Advisor = (s: HandState, v: HeroView) => EngineChoice | null;

export interface HeroDecision {
    street: Street,
    /** The hand as it stood when you acted. */
    state: HandState,
    view: HeroView,
    actual: Kind,
    actual_to: number,
    /** What the engine suggests (null: no advice, e.g. unknown cards). */
    engine: EngineChoice | null
}

export interface HeroHand {
    game_id: string,
    hand_number: number,
    big_blind: number,
    /** The whole hand, with your id and cards. */
    full: HandState,
    hero_id: string,
    decisions: HeroDecision[],
    /** Your result in big blinds, and the same with all-ins before the river counted at your equity. */
    net_bb: number,
    adjusted_bb: number
}

const ACTION = /^"(.+?) @ ([^"]+)" (folds|checks|calls|bets|raises)(?: to)? ?([\d,]+(?:\.\d+)?)?/;
const EPS = 1e-6;

/** The kind of a logged action verb. */
export function actualKind(verb: string): Kind {
    return verb === "folds" ? "fold" : verb === "checks" ? "check" : verb === "calls" ? "call" : "raise";
}

/**
 * The kind of an engine action in state `s`: bets and raises are "raise"; an all-in is a raise when
 * it goes above the current bet and a call when it doesn't (a short stack calling off).
 */
export function kindOf(action: string, to_chips: number, s: HandState): Kind {
    if (action === "fold" || action === "check" || action === "call") return action;
    if (action === "all-in") return to_chips > s.current_bet + EPS ? "raise" : "call";
    return "raise";
}

/** Rows that are your Hold'em hands with known cards (not bomb pots). */
export function isHeroHoldemHand(row: HandRow): boolean {
    if (!row.hero_id || !row.big_blind) return false;
    const messages: string[] = JSON.parse(row.messages_json);
    if (!messages.some((m) => m.startsWith("Your hand is"))) return false;
    const s = parseHand(messages, { big_blind: row.big_blind });
    return !s.bomb_pot && /Hold/.test(s.game_type) && s.seats.some((p) => p.id === row.hero_id);
}

/** Parses `messages` with `hero_id` as hero (by id, so duplicate display names can't confuse it). */
export function parseAsHero(messages: string[], hero_id: string, big_blind: number): HandState {
    const s = parseHand(messages, { big_blind });
    s.hero_id = s.seats.some((p) => p.id === hero_id) ? hero_id : null;
    return s;
}

/** Every decision of yours in one hand, with the engine's suggestion at each (advisor null: none). */
export function replayHand(row: Pick<HandRow, "game_id" | "hand_number" | "big_blind" | "messages_json" | "hero_id">, advisor: Advisor | null): HeroHand | null {
    const hero_id = row.hero_id;
    const bb = row.big_blind ?? 0;
    if (!hero_id || !(bb > 0)) return null;
    const messages: string[] = JSON.parse(row.messages_json);
    const full = parseAsHero(messages, hero_id, bb);
    if (!full.hero_id || full.hero_cards.length !== 2) return null;
    const decisions: HeroDecision[] = [];
    for (let j = 0; j < messages.length; j++) {
        const m = messages[j].match(ACTION);
        if (!m || m[2] !== hero_id) continue;
        const state = parseAsHero(messages.slice(0, j), hero_id, bb);
        const view = heroView(state);
        if (!view || state.hero_cards.length !== 2) continue;
        const actual = actualKind(m[3]);
        const actual_to = actual === "raise" && m[4] ? Number(m[4].replace(/,/g, "")) : 0;
        decisions.push({ street: state.street, state, view, actual, actual_to, engine: advisor ? advisor(state, view) : null });
    }
    const big = full.big_blind || bb;
    const net = netResult(full, hero_id);
    const adjusted = allInAdjustedNet(full, hero_id);
    return {
        game_id: row.game_id, hand_number: row.hand_number, big_blind: big, full, hero_id, decisions,
        net_bb: net / big, adjusted_bb: (adjusted ?? net) / big
    };
}

export interface AdvisorOptions {
    stats: (player: PlayerRef) => ObservedStats | undefined,
    players: PlayerLookup,
    /** Post-flop engine time budget per decision in ms (the live bot uses 120). */
    time_budget_ms?: number,
    /** Time budget for the preflop equity estimate the price check uses (the live bot uses 150). */
    preflop_equity_ms?: number,
    /** 7-2 bounty in chips (0: none). */
    seven_deuce_bounty?: number,
    /** Also record the mixed strategy under these styles (see engine/mixing.ts). */
    mix_styles?: MixStyle[]
}

/** The engine as the live bot runs it with the AI off (its deterministic pick; mixes on request). */
export function engineAdvisor(o: AdvisorOptions): Advisor {
    return (s, v) => {
        const bb = s.big_blind;
        const types = () => s.seats.filter((p) => p.id !== s.hero_id && !p.folded).map((p) => o.players(p).current?.type ?? "unknown");
        if (s.street === "preflop") {
            // the live bot prices calls with its equity estimate against the players still in
            let eq: number | undefined;
            if (v.to_call > 0 && v.active_opponents.length > 0) {
                const models = opponentModels(s, o.stats).map((m) => m.model);
                eq = equity({ hero: s.hero_cards, board: s.board, opponents: models, time_budget_ms: o.preflop_equity_ms ?? 40, iterations: 20000, seed: 97 }).equity;
            }
            const advice = preflopAdvice(s, v, o.stats, undefined, { seven_deuce_bounty: o.seven_deuce_bounty ?? 0, equity: eq });
            if (!advice) return null;
            const to = advice.action === "raise" || advice.action === "all-in" ? advice.size_bb * bb : 0;
            const choice: EngineChoice = { kind: kindOf(advice.action, to, s), to, label: advice.action + (to ? ` ${Math.round(advice.size_bb * 10) / 10} BB` : "") };
            if (o.mix_styles?.length) {
                const opponent_types = types();
                choice.mixes = {};
                for (const style of o.mix_styles) {
                    const m = mixPreflop({ advice, cls: classOf(s.hero_cards), style, roll: 50, pot_bb: v.pot / bb, opponent_types });
                    choice.mixes[style] = mixedChoice(m, s, null);
                }
            }
            return choice;
        }
        const tendencies = opponentTendencies(s, o.stats, o.players);
        const a = analyzePostflop(s, v, tendencies, o.time_budget_ms ?? 120);
        const best = a.candidates[0];
        if (!best) return null;
        const choice: EngineChoice = { kind: kindOf(best.action, best.to, s), to: best.to, label: best.label, bluff: !!best.purpose && best.purpose !== "value" };
        if (o.mix_styles?.length) {
            const hero = s.seats.find((p) => p.id === s.hero_id);
            const hero_range = hero ? rangeProfile(seatModel(s, hero, o.stats).model, s.board, s.hero_cards) : undefined;
            const opponent_types = types();
            choice.mixes = {};
            for (const style of o.mix_styles) {
                const m = mixPostflop({ analysis: a, state: s, view: v, style, roll: 50, hero_range, opponent_types });
                choice.mixes[style] = mixedChoice(m, s, a);
            }
        }
        return choice;
    };
}

export interface ReplayOptions {
    /** Use profiles built from every hand, including the game being evaluated (default: leave that game out). */
    in_sample?: boolean,
    time_budget_ms?: number,
    preflop_equity_ms?: number,
    /** Also record the mixed strategy under these styles at every decision. */
    mix_styles?: MixStyle[],
    /** Called after each game with (games done, games total). */
    progress?: (done: number, total: number) => void
}

/** A stand-in recorder that serves a fixed set of rows (for profiles that leave one game out). */
function rowsRecorder(rows: HandRow[], links: Map<string, string>): HandRecorder {
    return { hands: async () => rows, links: async () => links } as unknown as HandRecorder;
}

/**
 * Replays every one of your Hold'em hands through the engine. Profiles, action weights and the
 * response table are rebuilt per game from the other games (or from everything with `in_sample`).
 * Changes global engine state (population averages, action weights, response table, 7-2 rule)
 * the way the live bot does; the 7-2 rule is restored afterwards.
 */
export async function replayAll(rows: HandRow[], links: Map<string, string>, opts: ReplayOptions = {}): Promise<HeroHand[]> {
    const hero_rows = rows.filter(isHeroHoldemHand);
    const games = [...new Set(hero_rows.map((r) => r.game_id))];
    const out: HeroHand[] = [];
    const bounty_rule = TABLE_RULES.seven_deuce_bounty;
    let shared: ProfileService | null = null;
    try {
        for (const [i, game_id] of games.entries()) {
            let profiles: ProfileService;
            if (opts.in_sample) {
                profiles = shared ??= new ProfileService(rowsRecorder(rows, links));
                if (i === 0) await profiles.load();
            } else {
                profiles = new ProfileService(rowsRecorder(rows.filter((r) => r.game_id !== game_id), links));
                await profiles.load();
            }
            setActionWeights(profiles.actionWeights().weights);
            setResponseTable(profiles.responseTable().table);
            const game_messages = rows.filter((r) => r.game_id === game_id).map((r) => JSON.parse(r.messages_json) as string[]);
            const bounty = bountyFromHands(game_messages) ?? 0;
            TABLE_RULES.seven_deuce_bounty = bounty > 0;
            const advisor = engineAdvisor({
                stats: (p) => profiles.stats(p), players: (p) => profiles.info(p),
                time_budget_ms: opts.time_budget_ms, preflop_equity_ms: opts.preflop_equity_ms, seven_deuce_bounty: bounty,
                mix_styles: opts.mix_styles
            });
            for (const row of hero_rows) {
                if (row.game_id !== game_id) continue;
                const hand = replayHand(row, advisor);
                if (hand) out.push(hand);
            }
            opts.progress?.(i + 1, games.length);
        }
    } finally {
        TABLE_RULES.seven_deuce_bounty = bounty_rule;
    }
    return out;
}
