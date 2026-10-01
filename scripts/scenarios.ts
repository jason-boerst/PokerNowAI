// Strategy scenario suite: hand-built spots run through the whole decision engine (preflop charts and
// pricing, post-flop EV model, opponent tendencies), each with a poker-sound expectation for loose home
// games and invariants that hold in every spot (legal action, no fold when checking is free, no fold with
// a nut hand, sizes within the legal range, no NaN EVs, fast enough for the action clock).
//   npm run scenarios                         (built-in defaults: deterministic, like the unit tests)
//   npm run scenarios -- <db file>            (your games' measured tables, from a copy of the database)
//   npm run scenarios -- <db file> --verbose  (every option's EV for every scenario)
//   npm run scenarios -- --only <id prefix>
// The same scenarios run in test/unit/scenarios.spec.ts with the built-in defaults.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { equity, rangeProfile, resetActionWeights, setActionWeights } from "../app/engine/equity.ts";
import { heroView, HandState, HeroView, parseHand, positionLabels } from "../app/engine/hand-parser.ts";
import { ActionKind, checkLegality } from "../app/engine/legality.ts";
import { ObservedStats, opponentModels, POPULATION_TENDENCIES, seatModel, TABLE_RULES } from "../app/engine/opponent-range.ts";
import { describeMix, mixPostflop, mixPreflop, MixStrategy, MixStyle } from "../app/engine/mixing.ts";
import { classOf } from "../app/engine/hand-classes.ts";
import { PlayerProfile, PlayerRef, PRIORS, RATE_KEYS, RateKey, resetPriors } from "../app/engine/player-profile.ts";
import { analyzePostflop, PostflopAnalysis, resetResponseTable, setPlayConstants, setResponseTable } from "../app/engine/postflop.ts";
import { preflopAdvice, PreflopAdvice } from "../app/engine/preflop.ts";
import { opponentTendencies, preflopProfiles } from "../app/helpers/decision-maker.ts";
import { resetPreflopResponseTable, setPreflopResponseTable } from "../app/engine/preflop-responses.ts";
import type { PlayerInfo } from "../app/services/profile-service.ts";

// ---------------------------------------------------------------------------------------------
// Opponent archetypes (long-term profiles as the profile service would report them)

export type Archetype = "station" | "nit" | "maniac" | "tag" | "pool";

interface ArchetypeStats {
    /** Percent, 0-100. */
    vpip: number, pfr: number, three_bet: number,
    /** 0-1. */
    rates: Partial<Record<RateKey, number>>
}

/**
 * Typical players in these games. "pool" is a player with no history (population averages). The rates
 * are chosen to sit clearly inside each type as classify() defines it.
 */
const ARCHETYPES: Record<Exclude<Archetype, "pool">, ArchetypeStats> = {
    // calls everything, rarely raises or folds
    station: { vpip: 55, pfr: 8, three_bet: 3, rates: {
        aggression: 0.2, fold_to_cbet: 0.22, fold_to_bet_flop: 0.2, fold_to_bet_turn: 0.2, fold_to_bet_river: 0.25,
        raise_vs_bet: 0.05, bet_when_checked_to: 0.25, went_to_showdown: 0.45, fold_to_three_bet: 0.25,
        fold_to_small_bet: 0.15, fold_to_big_bet: 0.3 } },
    // plays few hands, folds a lot, bets and raises mean strength
    nit: { vpip: 14, pfr: 6, three_bet: 2, rates: {
        aggression: 0.3, fold_to_cbet: 0.55, fold_to_bet_flop: 0.5, fold_to_bet_turn: 0.55, fold_to_bet_river: 0.62,
        raise_vs_bet: 0.06, bet_when_checked_to: 0.3, went_to_showdown: 0.22, fold_to_three_bet: 0.6,
        fold_to_small_bet: 0.5, fold_to_big_bet: 0.72 } },
    // bets and raises a lot with weak hands
    maniac: { vpip: 60, pfr: 40, three_bet: 18, rates: {
        aggression: 0.65, fold_to_cbet: 0.3, fold_to_bet_flop: 0.28, fold_to_bet_turn: 0.3, fold_to_bet_river: 0.35,
        raise_vs_bet: 0.25, bet_when_checked_to: 0.7, went_to_showdown: 0.4, fold_to_three_bet: 0.35,
        fold_to_small_bet: 0.25, fold_to_big_bet: 0.42 } },
    // solid and aggressive
    tag: { vpip: 22, pfr: 18, three_bet: 8, rates: {
        aggression: 0.45, fold_to_cbet: 0.45, fold_to_bet_flop: 0.45, fold_to_bet_turn: 0.45, fold_to_bet_river: 0.5,
        raise_vs_bet: 0.12, bet_when_checked_to: 0.45, went_to_showdown: 0.28, fold_to_three_bet: 0.5,
        fold_to_small_bet: 0.38, fold_to_big_bet: 0.62 } }
};
const ARCHETYPE_HANDS = 300;
/** The profile service's type name for each archetype (what the mix reads to decide how much balance matters). */
const PLAYER_TYPE: Record<Archetype, string> = { station: "calling station", nit: "nit", maniac: "maniac", tag: "TAG", pool: "unknown" };

function statsOf(type: Archetype | undefined): ObservedStats | undefined {
    if (!type || type === "pool") return undefined;
    const a = ARCHETYPES[type];
    return { vpip: a.vpip, pfr: a.pfr, three_bet: a.three_bet, hands: ARCHETYPE_HANDS, aggression: a.rates.aggression, shrunk: true };
}

function profileOf(ref: PlayerRef, type: Archetype | undefined): PlayerInfo {
    if (!type || type === "pool") return { deviations: [] };
    const a = ARCHETYPES[type];
    const value = (key: RateKey) => key === "vpip" ? a.vpip / 100 : key === "pfr" ? a.pfr / 100 : key === "three_bet" ? a.three_bet / 100 : a.rates[key] ?? PRIORS[key].mean;
    const rates = Object.fromEntries(RATE_KEYS.map((key) => {
        const v = value(key);
        return [key, { k: v * ARCHETYPE_HANDS, n: ARCHETYPE_HANDS, value: v }];
    })) as Record<RateKey, PlayerProfile[RateKey]>;
    const current = {
        ...rates, key: ref.id, name: ref.name, names: [ref.name], hands: ARCHETYPE_HANDS, net_bb: 0, bb_per_100: 0, avg_bet_to_pot: 0.6, bets_seen: 0,
        vpip_by_position: { early: rates.vpip, middle: rates.vpip, late: rates.vpip, blinds: rates.vpip },
        showdowns: [], last_seen: "", type: "unknown", exploit: ""
    } as PlayerProfile;
    return { current, long: current, deviations: [] };
}

// ---------------------------------------------------------------------------------------------
// Building PokerNow logs. Players are named by their seat (UTG, CO, BB...), so actions read naturally:
//   "UTG raises 6", "BB calls", "BB checks", "CO folds", "BU bets 10", "SB raises 200 allin", "BB calls allin",
//   "flop Ks 7d 2c", "turn 9h", "river 3c"
// Amounts are in chips; the big blind is 2 chips unless `bb` says otherwise. Preflop, players skipped
// between two actions (and between the last action and hero) fold, so only the interesting actions are written.

export interface TableSpec {
    /** Players dealt in (2-10). */
    n: number,
    /** Hero's seat name (a position label for n players, e.g. "BU"). */
    hero: string,
    /** Hero's cards, e.g. "As Kd". */
    cards: string,
    /** Starting stack in big blinds (default 100), for everyone or by seat. */
    stack_bb?: number,
    stacks_bb?: Record<string, number>,
    /** UTG posts a straddle of two big blinds (it then acts last preflop). */
    straddle?: boolean,
    /** Every player posts this ante, in big blinds. */
    ante_bb?: number,
    bb?: number
}

const quote = (name: string) => `"${name} @ id-${name.replace(/\+/g, "p")}"`;
const cardList = (cards: string) => cards.trim().split(/[\s,]+/).join(", ");

/** The PokerNow log lines for a spec and a short action script (see above). */
export function buildLog(t: TableSpec, script: string[]): string[] {
    const bb = t.bb ?? 2;
    const labels = positionLabels(t.n);
    if (!labels.includes(t.hero)) throw new Error(`hero seat ${t.hero} is not at a ${t.n}-player table (${labels.join(", ")})`);
    const dealer = t.n === 2 ? "SB" : "BU";
    const stackOf = (seat: string) => (t.stacks_bb?.[seat] ?? t.stack_bb ?? 100) * bb;
    const lines = [
        `-- starting hand #1 (id: scenario)  No Limit Texas Hold'em (dealer: ${quote(dealer)}) --`,
        `Player stacks: ${labels.map((seat, i) => `#${i + 1} ${quote(seat)} (${stackOf(seat)})`).join(" | ")}`,
        `Your hand is ${cardList(t.cards)}`
    ];
    if (t.ante_bb) for (const seat of labels) lines.push(`${quote(seat)} posts an ante of ${t.ante_bb * bb}`);
    lines.push(`${quote("SB")} posts a small blind of ${bb / 2}`, `${quote("BB")} posts a big blind of ${bb}`);
    const straddler = t.straddle ? labels[2] : null;
    if (straddler) lines.push(`${quote(straddler)} posts a straddle of ${2 * bb}`);

    // preflop acting order: UTG ... BU, SB, BB (heads-up SB, BB; the straddler last)
    const order = t.n === 2 ? ["SB", "BB"] : [...labels.slice(2), "SB", "BB"];
    if (straddler) order.push(order.splice(order.indexOf(straddler), 1)[0]);
    const out = new Set<string>();   // folded or all-in
    let last = -1;
    let street = "preflop";
    let current_bet = straddler ? 2 * bb : bb;
    const board: string[] = [];
    const foldUpTo = (seat: string) => {
        const target = order.indexOf(seat);
        if (target < 0) throw new Error(`unknown seat ${seat}`);
        for (let i = (last + 1) % order.length; i !== target; i = (i + 1) % order.length) {
            const skipped = order[i];
            if (out.has(skipped)) continue;
            if (skipped === t.hero) throw new Error(`the script skips hero (${t.hero}) before ${seat}`);
            lines.push(`${quote(skipped)} folds`);
            out.add(skipped);
        }
        last = target;
    };

    for (const step of script) {
        const words = step.trim().split(/\s+/);
        const deal = { flop: "Flop", turn: "Turn", river: "River" }[words[0]];
        if (deal) {
            const shown = board.join(", ");
            board.push(...words.slice(1));
            lines.push(words[0] === "flop" ? `Flop:  [${board.join(", ")}]` : `${deal}: ${shown} [${board[board.length - 1]}]`);
            street = words[0];
            current_bet = 0;
            continue;
        }
        const [seat, verb, amount, flag] = words;
        if (street === "preflop") foldUpTo(seat);
        const all_in = (flag ?? amount) === "allin" ? " and go all in" : "";
        if (verb === "folds" || verb === "checks") lines.push(`${quote(seat)} ${verb}`);
        else if (verb === "calls") lines.push(`${quote(seat)} calls ${current_bet}${all_in}`);
        else if (verb === "bets" || verb === "raises") {
            current_bet = Number(amount);
            lines.push(`${quote(seat)} ${verb === "bets" ? "bets" : "raises to"} ${amount}${all_in}`);
        } else throw new Error(`can't read "${step}"`);
        if (verb === "folds" || all_in) out.add(seat);
    }
    if (street === "preflop") foldUpTo(t.hero);
    return lines;
}

// ---------------------------------------------------------------------------------------------
// Scenarios

/** "aggressive" is any bet, raise or all-in; "continue" is anything but a fold. */
type Expected = ActionKind | "aggressive" | "continue";

export interface Scenario {
    id: string,
    description: string,
    table: TableSpec,
    script: string[],
    /** Opponent type by seat (anyone not listed has no history: your games' averages). */
    players?: Record<string, Archetype>,
    /** 7-2 bounty paid by each opponent, in big blinds. */
    bounty_bb?: number,
    /** Hero holds the nuts or close to it: folding is never right. */
    nut?: boolean,
    expect: {
        /** The engine's pick must be one of these. */
        action?: Expected | Expected[],
        /** ... and none of these. */
        not?: Expected[],
        /** Raise-to or bet size range in big blinds. */
        size_bb?: [number, number]
    }
}

const aggressive = (a: string) => a === "bet" || a === "raise" || a === "all-in";
function matches(action: string, e: Expected): boolean {
    if (e === "aggressive") return aggressive(action);
    if (e === "continue") return action !== "fold";
    if (e === "bet" || e === "raise") return aggressive(action) && action !== "all-in" || action === e;
    return action === e;
}

const nine = (hero: string, cards: string, extra: Partial<TableSpec> = {}): TableSpec => ({ n: 9, hero, cards, ...extra });
const ten = (hero: string, cards: string, extra: Partial<TableSpec> = {}): TableSpec => ({ n: 10, hero, cards, ...extra });
const hu = (hero: string, cards: string, extra: Partial<TableSpec> = {}): TableSpec => ({ n: 2, hero, cards, ...extra });

export const SCENARIOS: Scenario[] = [
    // ------------------------------------------------------------------ preflop, first in
    { id: "pre-utg-aa", description: "9-handed UTG opens aces", table: nine("UTG", "As Ad"), script: [], expect: { action: "raise", size_bb: [2.5, 4.5] } },
    { id: "pre-utg-72", description: "9-handed UTG folds 72o (no bounty)", table: nine("UTG", "7c 2d"), script: [], expect: { action: "fold" } },
    { id: "pre-utg-kjo", description: "9-handed UTG folds KJo (dominated from early position)", table: nine("UTG", "Kc Jd"), script: [], expect: { action: "fold" } },
    { id: "pre-10-utg-aks", description: "10-handed UTG opens AKs", table: ten("UTG", "Ah Kh"), script: [], expect: { action: "raise" } },
    { id: "pre-10-utg2-kqo", description: "10-handed UTG+2 folds KQo", table: ten("UTG+2", "Kh Qd"), script: [], expect: { action: "fold" } },
    { id: "pre-10-mp-jj", description: "10-handed MP opens JJ", table: ten("MP", "Jh Jd"), script: [], expect: { action: "raise" } },
    { id: "pre-hj-96o", description: "9-handed HJ folds 96o", table: nine("HJ", "9h 6d"), script: [], expect: { action: "fold" } },
    { id: "pre-co-22", description: "9-handed CO opens 22", table: nine("CO", "2h 2d"), script: [], expect: { action: "raise" } },
    { id: "pre-bu-k8o", description: "9-handed BU steals K8o", table: nine("BU", "Kh 8d"), script: [], expect: { action: "raise" } },
    { id: "pre-bu-32o", description: "9-handed BU folds 32o", table: nine("BU", "3h 2d"), script: [], expect: { action: "fold" } },
    { id: "pre-bu-loose-blinds", description: "BU opens bigger when both blinds are stations", table: nine("BU", "Ah Td"), script: [],
        players: { SB: "station", BB: "station" }, expect: { action: "raise", size_bb: [3.5, 5] } },
    { id: "pre-sb-t8o-folded", description: "Folded to the SB with T8o: complete or raise, not fold", table: nine("SB", "Th 8d"), script: [], expect: { action: ["call", "raise"] } },
    { id: "pre-sb-72-folded", description: "Folded to the SB with 72o: fold", table: nine("SB", "7h 2d"), script: [], expect: { action: "fold" } },
    { id: "pre-bb-walk-check", description: "Limped around to the BB with 72o: check, never fold", table: nine("BB", "7h 2d"), script: ["CO calls", "BU calls", "SB calls"], expect: { action: "check" } },

    // ------------------------------------------------------------------ preflop, facing a raise
    { id: "pre-bb-72-vs-utg", description: "BB folds 72o to a UTG open", table: nine("BB", "7c 2d"), script: ["UTG raises 6"], expect: { action: "fold" } },
    { id: "pre-bb-k5s-vs-bu", description: "BB defends K5s against a 2.5x button steal", table: nine("BB", "Kh 5h"), script: ["BU raises 5"], expect: { action: ["call", "raise"] } },
    { id: "pre-bb-aa-vs-utg", description: "BB 3-bets aces against a UTG open", table: nine("BB", "Ah Ad"), script: ["UTG raises 6"], expect: { action: "raise", size_bb: [10, 16] } },
    { id: "pre-bb-j4o-vs-4x", description: "BB folds J4o against a 4x UTG open", table: nine("BB", "Jh 4d"), script: ["UTG raises 8"], expect: { action: "fold" } },
    { id: "pre-bu-jj-vs-utg", description: "BU flats JJ against a UTG open (or 3-bets)", table: nine("BU", "Jh Jd"), script: ["UTG raises 6"], expect: { action: ["call", "raise"] } },
    { id: "pre-bu-k9o-vs-utg", description: "BU folds K9o against a UTG open", table: nine("BU", "Kh 9d"), script: ["UTG raises 6"], expect: { action: "fold" } },
    { id: "pre-co-qq-vs-nit", description: "Against a nit's open, QQ calls rather than 3-bets", table: nine("CO", "Qh Qd"), script: ["UTG raises 6"], players: { UTG: "nit" }, expect: { action: "call" } },
    { id: "pre-co-jj-vs-maniac", description: "Against a maniac's open, 3-bet JJ for value", table: nine("CO", "Jh Jd"), script: ["UTG raises 6"], players: { UTG: "maniac" }, expect: { action: "raise" } },
    { id: "pre-bu-65s-multiway", description: "BU calls 65s behind a raise and two callers deep (implied odds), not fold", table: nine("BU", "6h 5h", { stack_bb: 250 }),
        script: ["UTG raises 6", "MP calls", "CO calls"], expect: { action: ["call", "fold"], not: ["aggressive"] } },

    // ------------------------------------------------------------------ preflop, limped pots
    { id: "pre-bu-qq-iso", description: "BU raises QQ over two limpers", table: nine("BU", "Qh Qd"), script: ["UTG calls", "MP calls"], expect: { action: "raise", size_bb: [5, 8] } },
    { id: "pre-co-65s-overlimp", description: "CO limps behind with 65s", table: nine("CO", "6h 5h"), script: ["UTG calls", "MP calls"], expect: { action: "call" } },
    { id: "pre-bu-ajo-iso-station", description: "BU isolates a station limper with AJo, sized up", table: nine("BU", "Ah Jd"), script: ["HJ calls"], players: { HJ: "station" }, expect: { action: "raise", size_bb: [5, 7] } },
    { id: "pre-sb-98s-complete", description: "SB completes 98s in a limped pot", table: nine("SB", "9h 8h"), script: ["UTG calls", "CO calls"], expect: { action: ["call", "raise"] } },
    { id: "pre-bb-kk-limped", description: "BB raises KK over limpers", table: nine("BB", "Kh Kd"), script: ["UTG calls", "CO calls", "SB calls"], expect: { action: "raise" } },

    // ------------------------------------------------------------------ preflop, 3-bets and 4-bets
    { id: "pre-3b-co-ako-100", description: "CO opened AKo, 3-bet by the button at 100 BB: continue", table: nine("CO", "Ah Kd"),
        script: ["CO raises 6", "BU raises 18"], expect: { action: "continue" } },
    { id: "pre-3b-utg-ajs", description: "UTG opened AJs and faces a CO 3-bet at 100 BB: fold", table: nine("UTG", "Ah Js"),
        script: ["UTG raises 6", "CO raises 18"], expect: { action: "fold" } },
    { id: "pre-3b-bu-77-deep", description: "BU opened 77 at 300 BB, 3-bet from the SB: call in position", table: nine("BU", "7h 7d", { stack_bb: 300 }),
        script: ["BU raises 6", "SB raises 24"], expect: { action: "call" } },
    { id: "pre-3b-bu-77-100", description: "BU opened 77 at 100 BB, 3-bet from the SB: fold (not deep enough to set-mine a 3-bet)", table: nine("BU", "7h 7d"),
        script: ["BU raises 6", "SB raises 24"], expect: { action: "fold" } },
    { id: "pre-3b-co-jj-maniac", description: "CO opened JJ, 3-bet by a maniac: never fold", table: nine("CO", "Jh Jd"),
        script: ["CO raises 6", "BB raises 24"], players: { BB: "maniac" }, expect: { action: "continue" } },
    { id: "pre-3b-cold-aqo", description: "Cold AQo facing a raise and a 3-bet: fold", table: nine("BU", "Ah Qd"),
        script: ["HJ raises 6", "CO raises 18"], expect: { action: "fold" } },
    { id: "pre-3b-kk-4bet", description: "HJ opened KK and faces a 3-bet: 4-bet", table: nine("HJ", "Kh Kd"),
        script: ["HJ raises 6", "BU raises 18"], expect: { action: "aggressive" } },
    { id: "pre-4b-aa-100", description: "3-bet with AA and facing a 4-bet at 100 BB: get it in", table: nine("BU", "Ah Ad"),
        script: ["CO raises 6", "BU raises 18", "CO raises 42"], expect: { action: "aggressive" } },
    { id: "pre-4b-kk-100", description: "3-bet with KK and facing a 4-bet at 100 BB: get it in", table: nine("BU", "Kh Kd"),
        script: ["CO raises 6", "BU raises 18", "CO raises 42"], expect: { action: "aggressive" } },
    { id: "pre-4b-qq-300", description: "3-bet QQ at 300 BB, facing a 4-bet: don't stack off", table: nine("BU", "Qh Qd", { stack_bb: 300 }),
        script: ["CO raises 6", "BU raises 18", "CO raises 42"], expect: { action: ["fold", "call"] } },
    { id: "pre-4b-qq-shove-100", description: "3-bet QQ at 100 BB and the opener shoves: all-in 4-bets here are wide, call", table: nine("BU", "Qh Qd"),
        script: ["CO raises 6", "BU raises 18", "CO raises 200 allin"], expect: { action: ["call", "all-in"] } },
    { id: "pre-4b-a5s-shove-100", description: "3-bet A5s at 100 BB and the opener shoves: fold", table: nine("BU", "Ah 5h"),
        script: ["CO raises 6", "BU raises 18", "CO raises 200 allin"], expect: { action: "fold" } },
    { id: "pre-4b-ajs", description: "3-bet AJs (bounty off), facing a 4-bet: fold", table: nine("BB", "Ah Jh"),
        script: ["BU raises 5", "BB raises 18", "BU raises 42"], expect: { action: "fold" } },

    // ------------------------------------------------------------------ preflop, heads-up
    { id: "pre-hu-sb-q4o", description: "Heads-up SB (button) opens Q4o", table: hu("SB", "Qh 4d"), script: [], expect: { action: "raise", size_bb: [2, 3.5] } },
    { id: "pre-hu-sb-32o", description: "Heads-up SB folds 32o", table: hu("SB", "3h 2d"), script: [], expect: { action: "fold" } },
    { id: "pre-hu-bb-k3o-2x", description: "Heads-up BB defends K3o against a 2x open", table: hu("BB", "Kh 3d"), script: ["SB raises 4"], expect: { action: ["call", "raise"] } },
    { id: "pre-hu-bb-qto-3x", description: "Heads-up BB defends QTo against a 3x open", table: hu("BB", "Qh Td"), script: ["SB raises 6"], expect: { action: ["call", "raise"] } },
    { id: "pre-hu-bb-72o-3x", description: "Heads-up BB folds 72o against a 3x open", table: hu("BB", "7h 2d"), script: ["SB raises 6"], expect: { action: "fold" } },
    { id: "pre-hu-bb-a9o-4x", description: "Heads-up BB continues A9o against a 4x open", table: hu("BB", "Ah 9d"), script: ["SB raises 8"], expect: { action: ["call", "raise"] } },
    { id: "pre-hu-bb-aqo-limp", description: "Heads-up BB raises AQo over a limp", table: hu("BB", "Ah Qd"), script: ["SB calls"], expect: { action: "raise" } },
    { id: "pre-hu-bb-72o-limp", description: "Heads-up BB checks 72o after a limp, never folds", table: hu("BB", "7h 2d"), script: ["SB calls"], expect: { action: "check" } },
    { id: "pre-hu-sb-kk-3bet", description: "Heads-up SB opened KK, 3-bet: 4-bet", table: hu("SB", "Kh Kd"), script: ["SB raises 5", "BB raises 16"], expect: { action: "aggressive" } },
    { id: "pre-hu-sb-74o-3bet", description: "Heads-up SB opened 74o, 3-bet: fold", table: hu("SB", "7h 4d"), script: ["SB raises 5", "BB raises 16"], expect: { action: "fold" } },

    // ------------------------------------------------------------------ preflop, straddles, antes, short stacks, bounty
    { id: "pre-straddle-utg1-ako", description: "Straddled pot: UTG+1 opens AKo to about 3 straddles", table: nine("UTG+1", "Ah Kd", { straddle: true, stack_bb: 200 }), script: [],
        expect: { action: "raise", size_bb: [5, 8] } },
    { id: "pre-straddle-93o-vs-bu", description: "Straddler folds 93o to a button raise", table: nine("UTG", "9h 3d", { straddle: true, stack_bb: 200 }), script: ["BU raises 12"], expect: { action: "fold" } },
    { id: "pre-straddle-limped-check", description: "Straddler checks its option with trash in a limped pot", table: nine("UTG", "9h 3d", { straddle: true }), script: ["CO calls", "BU calls"], expect: { action: "check" } },
    { id: "pre-ante-mp-a9s", description: "0.5 BB antes: MP opens A9s (wider for the dead money)", table: nine("MP", "Ah 9h", { ante_bb: 0.5 }), script: [], expect: { action: "raise" } },
    { id: "pre-ante-bb-86s-vs-co", description: "Antes in: BB defends 86s against a CO open", table: nine("BB", "8h 6h", { ante_bb: 0.5 }), script: ["CO raises 6"], expect: { action: ["call", "raise"] } },
    { id: "pre-short-22-vs-open", description: "15 BB deep, BU folds 22 to a UTG open (no set-mining odds)", table: nine("BU", "2h 2d", { stack_bb: 15 }), script: ["UTG raises 6"], expect: { action: ["fold", "all-in"] } },
    { id: "pre-short-bb-ako-shove", description: "12 BB in the BB with AKo against a button steal: all-in", table: nine("BB", "Ah Kd", { stacks_bb: { BB: 12 } }), script: ["BU raises 5"], expect: { action: "all-in" } },
    { id: "pre-short-co-ajo", description: "15 BB at the CO with AJo first in: raise or shove", table: nine("CO", "Ah Jd", { stack_bb: 15 }), script: [], expect: { action: ["raise", "all-in"] } },
    { id: "pre-bu-aqo-vs-shove", description: "BU with AQo against a 10 BB UTG shove: call", table: nine("BU", "Ah Qd", { stacks_bb: { UTG: 10 } }), script: ["UTG raises 20 allin"], expect: { action: ["call", "all-in"] } },
    { id: "pre-bu-72-vs-shove", description: "BU with 72o against a 10 BB UTG shove: fold", table: nine("BU", "7h 2d", { stacks_bb: { UTG: 10 } }), script: ["UTG raises 20 allin"], expect: { action: "fold" } },
    { id: "pre-open-vs-short-3bet-shove", description: "CO opened AJo and a 12 BB button shoves: call, the price is too good to fold", table: nine("CO", "Ah Jd", { stacks_bb: { BU: 12 } }),
        script: ["CO raises 6", "BU raises 24 allin"], expect: { action: ["call", "all-in"] } },
    { id: "pre-3bet-vs-short-4bet-shove", description: "BU 3-bet JJ and the 25 BB opener shoves: call", table: nine("BU", "Jh Jd", { stacks_bb: { CO: 25 } }),
        script: ["CO raises 6", "BU raises 18", "CO raises 50 allin"], expect: { action: ["call", "all-in"] } },
    { id: "pre-4bet-vs-short-5bet-shove", description: "CO 4-bet AQs and the 40 BB 3-bettor shoves: call", table: nine("CO", "Ah Qh", { stacks_bb: { BU: 40 } }),
        script: ["CO raises 6", "BU raises 18", "CO raises 42", "BU raises 80 allin"], expect: { action: ["call", "all-in"] } },
    { id: "pre-bb-a8o-vs-short-shove", description: "BB with A8o against an 8 BB button shove: call", table: nine("BB", "Ah 8d", { stacks_bb: { BU: 8 } }),
        script: ["BU raises 16 allin"], expect: { action: ["call", "all-in"] } },
    { id: "pre-bb-72o-vs-short-shove", description: "BB with 72o against a 20 BB UTG shove: fold", table: nine("BB", "7h 2d", { stacks_bb: { UTG: 20 } }),
        script: ["UTG raises 40 allin"], expect: { action: "fold" } },
    { id: "pre-short-open-vs-deep-shove", description: "20 BB at the button, opened K8o and a 200 BB big blind shoves: fold (only 20 BB can be won)", table: nine("BU", "Kh 8d", { stacks_bb: { BU: 20, BB: 200 } }),
        script: ["BU raises 5", "BB raises 400 allin"], expect: { action: "fold" } },
    { id: "pre-hu-sb-vs-short-shove", description: "Heads-up SB opened A8o and the 6 BB big blind shoves: call the price", table: hu("SB", "Ah 8d", { stacks_bb: { BB: 6 } }),
        script: ["SB raises 5", "BB raises 12 allin"], expect: { action: ["call", "all-in"] } },
    { id: "pre-bounty-utg-72-on", description: "7-2 bounty on: UTG raises 72o", table: nine("UTG", "7h 2d"), script: [], bounty_bb: 3, expect: { action: "raise" } },
    { id: "pre-bounty-utg-72-off", description: "7-2 bounty off: UTG folds 72o", table: nine("UTG", "7h 2d"), script: [], bounty_bb: 0, expect: { action: "fold" } },
    { id: "pre-bounty-bu-72-vs-open", description: "7-2 bounty on: BU 3-bets 72o against a CO open", table: nine("BU", "7h 2h"), script: ["CO raises 6"], bounty_bb: 3, expect: { action: "raise" } },
    { id: "pre-bounty-72-vs-3bet", description: "7-2 bounty on: fold 72o to a 3-bet", table: nine("CO", "7h 2d"), script: ["CO raises 6", "BU raises 18"], bounty_bb: 3, expect: { action: "fold" } },

    // ------------------------------------------------------------------ post-flop, value with strong hands
    { id: "post-set-ip-vs-station", description: "Set of kings on K72r, station checks: bet for value", table: nine("BU", "Kh Kd"), nut: true,
        script: ["BU raises 6", "BB calls", "flop Ks 7d 2c", "BB checks"], players: { BB: "station" }, expect: { action: "aggressive" } },
    { id: "post-set-oop-facing-bet", description: "Set of sevens facing a station's flop bet: never fold", table: nine("BB", "7h 7c"), nut: true,
        script: ["BU raises 6", "BB calls", "flop Ks 7d 2c", "BB checks", "BU bets 8"], players: { BU: "station" }, expect: { action: "continue" } },
    { id: "post-nut-flush-river-station", description: "Nut flush on the river, station checks: bet", table: nine("BU", "Ah 5h"), nut: true,
        script: ["BU raises 6", "BB calls", "flop Kh 8h 2c", "BB checks", "BU bets 6", "BB calls", "turn 4d", "BB checks", "BU checks", "river 9h", "BB checks"],
        players: { BB: "station" }, expect: { action: "aggressive" } },
    { id: "post-straight-turn-maniac-bet", description: "Nut straight on the turn facing a maniac's bet: continue (raise or call)", table: nine("BU", "9h 8h"), nut: true,
        script: ["BU raises 6", "BB calls", "flop Td 7c 2s", "BB checks", "BU bets 6", "BB calls", "turn Jc", "BB bets 20"],
        players: { BB: "maniac" }, expect: { action: "continue" } },
    { id: "post-kflush-vs-nit-pot", description: "King-high flush facing a nit's pot-sized river bet: near-nuts, don't fold", table: nine("BU", "Kh Qh"), nut: true,
        script: ["BU raises 6", "BB calls", "flop 9h 5h 2c", "BB checks", "BU bets 8", "BB calls", "turn 3s", "BB checks", "BU checks", "river 7h", "BB bets 29"],
        players: { BB: "nit" }, expect: { action: "continue" } },
    { id: "post-topset-vs-checkraise", description: "Top set facing a flop check-raise: never fold", table: nine("CO", "Jh Jd"), nut: true,
        script: ["CO raises 6", "BB calls", "flop Js 8h 4c", "BB checks", "CO bets 8", "BB raises 26"], expect: { action: "continue" } },
    { id: "post-full-house-river-checked", description: "Full house on the river, checked to hero: bet", table: nine("BU", "8h 8d"), nut: true,
        script: ["BU raises 6", "BB calls", "flop 8s 5c 5d", "BB checks", "BU bets 5", "BB calls", "turn Kc", "BB checks", "BU bets 14", "BB calls", "river 2h", "BB checks"],
        expect: { action: "aggressive" } },
    { id: "post-nut-straight-river-shove", description: "Nut straight facing a river all-in: call", table: nine("BU", "Qh Jd"), nut: true,
        script: ["BU raises 6", "BB calls", "flop Kc Th 4s", "BB checks", "BU bets 8", "BB calls", "turn 2d", "BB checks", "BU bets 20", "BB calls", "river Ac", "BB raises 142 allin"],
        expect: { action: ["call", "all-in"] } },
    { id: "post-trips-vs-maniac-river", description: "Trips facing a maniac's river bet: don't fold", table: nine("BU", "Ah 9s"), nut: true,
        script: ["BU raises 6", "BB calls", "flop 9d 9c 4h", "BB checks", "BU bets 5", "BB calls", "turn 6s", "BB checks", "BU checks", "river Qd", "BB bets 12"],
        players: { BB: "maniac" }, expect: { action: "continue" } },

    // ------------------------------------------------------------------ post-flop, thin value and bluff-catching
    { id: "post-tpgk-turn-station", description: "Top pair good kicker, turn, station checks: bet (value)", table: nine("BU", "Ah Kd"),
        script: ["BU raises 6", "BB calls", "flop Kc 8h 3s", "BB checks", "BU bets 8", "BB calls", "turn 5d", "BB checks"],
        players: { BB: "station" }, expect: { action: "aggressive" } },
    { id: "post-tpwk-river-station", description: "Top pair weak kicker on the river vs a station who checks: value bet thin", table: nine("BU", "Kh 6h"),
        script: ["BU raises 6", "BB calls", "flop Kc 8d 3s", "BB checks", "BU checks", "turn 2c", "BB checks", "BU checks", "river 4d", "BB checks"],
        players: { BB: "station" }, expect: { action: "aggressive" } },
    { id: "post-bluffcatch-vs-maniac", description: "Top pair weak kicker facing a maniac's river pot bet: call", table: nine("BU", "Qh 6h"),
        script: ["BU raises 6", "BB calls", "flop Qc 8d 3s", "BB checks", "BU bets 6", "BB calls", "turn 2c", "BB checks", "BU checks", "river 5d", "BB bets 25"],
        players: { BB: "maniac" }, expect: { action: "continue" } },
    { id: "post-tptk-vs-maniac-turn", description: "Top pair top kicker facing a maniac's turn bet: don't fold", table: nine("BU", "Ah Qd"),
        script: ["BU raises 6", "BB calls", "flop Qc 8d 3s", "BB checks", "BU bets 6", "BB calls", "turn 2c", "BB bets 18"],
        players: { BB: "maniac" }, expect: { action: "continue" } },
    { id: "post-second-pair-vs-nit-river", description: "Second pair facing a nit's pot-sized river bet after two checks: call or fold, never raise a bluff-catcher", table: nine("BU", "8h 7h"),
        script: ["BU raises 6", "BB calls", "flop Kc 8d 3s", "BB checks", "BU checks", "turn 2c", "BB checks", "BU checks", "river 4d", "BB bets 13"],
        players: { BB: "nit" }, expect: { action: ["call", "fold"] } },
    { id: "post-second-pair-vs-nit-triple", description: "Second pair facing a nit's third barrel (pot-sized river bet): fold", table: nine("BU", "9h 8h"),
        script: ["UTG raises 6", "BU calls", "flop Kc 9d 4s", "UTG bets 8", "BU calls", "turn 2h", "UTG bets 20", "BU calls", "river 6c", "UTG bets 57"],
        players: { UTG: "nit" }, expect: { action: "fold" } },
    { id: "post-second-pair-vs-pool-river", description: "Second pair facing a pool player's pot-sized river bet after two checks: call or fold, never raise a bluff-catcher", table: nine("BU", "8h 7h"),
        script: ["BU raises 6", "BB calls", "flop Kc 8d 3s", "BB checks", "BU checks", "turn 2c", "BB checks", "BU checks", "river 4d", "BB bets 13"],
        expect: { action: ["call", "fold"] } },
    { id: "post-air-vs-nit-river", description: "Missed draw facing a nit's big river bet: fold", table: nine("BU", "Jh Th"),
        script: ["BU raises 6", "BB calls", "flop 9h 4h 2c", "BB checks", "BU bets 8", "BB calls", "turn Kd", "BB checks", "BU checks", "river 3s", "BB bets 29"],
        players: { BB: "nit" }, expect: { action: "fold" } },
    { id: "post-blocker-vs-nit-flush", description: "Ace-high holding the nut flush blocker vs a nit's pot bet when the flush comes in: fold (blockers ignored)", table: nine("BU", "Ah Qc"),
        script: ["BU raises 6", "BB calls", "flop 9h 4h 2c", "BB checks", "BU bets 8", "BB calls", "turn 7s", "BB checks", "BU checks", "river Jh", "BB bets 29"],
        players: { BB: "nit" }, expect: { action: "fold" } },

    // ------------------------------------------------------------------ post-flop, draws
    { id: "post-fd-vs-small-bet", description: "Nut flush draw facing a 1/3-pot flop bet: continue", table: nine("BB", "Ah 5h"),
        script: ["BU raises 6", "BB calls", "flop Kh 8h 2c", "BB checks", "BU bets 4"], expect: { action: "continue" } },
    { id: "post-oesd-vs-half-pot", description: "Open-ended straight draw facing a half-pot flop bet: continue", table: nine("BB", "9h 8d"),
        script: ["BU raises 6", "BB calls", "flop Tc 7s 2h", "BB checks", "BU bets 7"], expect: { action: "continue" } },
    { id: "post-gutshot-vs-nit-pot-turn", description: "Gutshot facing a nit's pot-sized turn bet: fold", table: nine("BU", "9h 8d"),
        script: ["BU raises 6", "BB calls", "flop Qc 6s 2h", "BB checks", "BU bets 7", "BB calls", "turn Tc", "BB bets 27"],
        players: { BB: "nit" }, expect: { action: "fold" } },
    { id: "post-fd-multiway-bet-call", description: "Flush draw multiway, bet and a call in front: continue", table: nine("BU", "Jh Th"),
        script: ["UTG raises 6", "CO calls", "BU calls", "BB calls", "flop Ah 7h 2c", "BB checks", "UTG bets 12", "CO calls"], expect: { action: "continue" } },

    // ------------------------------------------------------------------ post-flop, c-bets, leads, barrels
    { id: "post-overpair-wet-cbet", description: "QQ on JT4 two-tone as the raiser, checked to: bet", table: nine("CO", "Qc Qd"),
        script: ["CO raises 6", "BB calls", "flop Jh Th 4c", "BB checks"], expect: { action: "aggressive" } },
    { id: "post-cbet-ak-on-a72", description: "AK on A72 rainbow as the raiser, checked to: bet", table: nine("BU", "Ah Kd"),
        script: ["BU raises 6", "BB calls", "flop As 7d 2c", "BB checks"], expect: { action: "aggressive" } },
    { id: "post-no-bluff-station-flop", description: "KQ high on 752 rainbow vs a station: check, don't bluff", table: nine("BU", "Kh Qd"),
        script: ["BU raises 6", "BB calls", "flop 7s 5d 2c", "BB checks"], players: { BB: "station" }, expect: { action: "check" } },
    { id: "post-no-bluff-station-river", description: "Missed draw on the river vs a station: check, don't bluff", table: nine("BU", "Jh Th"),
        script: ["BU raises 6", "BB calls", "flop 9h 4h 2c", "BB checks", "BU bets 8", "BB calls", "turn Kd", "BB checks", "BU checks", "river 3s", "BB checks"],
        players: { BB: "station" }, expect: { action: "check" } },
    { id: "post-oop-no-lead-mid-pair", description: "BB called, flop A-high, middle pair: check, don't lead", table: nine("BB", "8h 7h"),
        script: ["BU raises 6", "BB calls", "flop Ac 8d 3s"], expect: { action: "check" } },
    { id: "post-oop-no-lead-air", description: "BB called, flop missed completely: check", table: nine("BB", "Jh 5h"),
        script: ["CO raises 6", "BB calls", "flop Kc 8d 3s"], expect: { action: "check" } },
    { id: "post-turn-barrel-station-tptk", description: "Top pair top kicker turn barrel vs a station", table: nine("CO", "Ah Jd"),
        script: ["CO raises 6", "BB calls", "flop Jc 7d 3s", "BB checks", "CO bets 8", "BB calls", "turn 2h", "BB checks"],
        players: { BB: "station" }, expect: { action: "aggressive" } },
    { id: "post-hu-limped-top-pair", description: "Heads-up limped pot, top pair on the flop, BB checks: bet", table: hu("SB", "Kh 9d"),
        script: ["SB calls", "BB checks", "flop Ks 6d 2c", "BB checks"], expect: { action: "aggressive" } },
    { id: "post-checkraise-weak-vs-nit", description: "Top pair weak kicker facing a nit's turn check-raise: call or fold, never shove", table: nine("BU", "Kh 5h"),
        script: ["BU raises 6", "BB calls", "flop Kc 9d 4s", "BB checks", "BU bets 8", "BB calls", "turn Jc", "BB checks", "BU bets 20", "BB raises 64"],
        players: { BB: "nit" }, expect: { action: ["call", "fold"] } },

    { id: "post-3bp-aa-spr3", description: "3-bet pot, aces on a low flop, checked to hero: bet", table: nine("BU", "Ah Ad"),
        script: ["CO raises 6", "BU raises 18", "CO calls", "flop 8c 5d 2s", "CO checks"], expect: { action: "aggressive" } },
    { id: "post-donk-lead-top-pair", description: "Hero raised preflop; the big blind leads the flop into hero with top pair good kicker: continue", table: nine("CO", "Ah Qd"),
        script: ["CO raises 6", "BB calls", "flop Qc 7d 3s", "BB bets 6"], expect: { action: "continue" } },
    { id: "post-hu-bb-vs-cbet-mid-pair", description: "Heads-up table: BB called, SB c-bets half pot, hero has middle pair: continue", table: hu("BB", "8h 7d"),
        script: ["SB raises 5", "BB calls", "flop Qc 8d 3s", "BB checks", "SB bets 5"], expect: { action: "continue" } },
    { id: "post-river-tiny-bet-weak-pair", description: "Bottom pair facing a quarter-pot river bet: call", table: nine("BB", "4h 3h"),
        script: ["BU raises 6", "BB calls", "flop Kc 9d 3s", "BB checks", "BU checks", "turn 7h", "BB checks", "BU checks", "river 2c", "BB checks", "BU bets 3"],
        expect: { action: "call" } },
    { id: "post-short-stack-turn-draw-shove", description: "10 BB behind, flush draw plus pair facing a turn shove: call the price", table: nine("BB", "Ah 9h", { stacks_bb: { BB: 16 } }),
        script: ["BU raises 6", "BB calls", "flop Kh 9d 4h", "BB checks", "BU bets 6", "BB calls", "turn 2c", "BB checks", "BU bets 40"],
        expect: { action: ["call", "all-in"] } },
    { id: "post-station-river-raise-nuts", description: "Nut straight facing a station's river bet: raise for value", table: nine("BU", "Jh Td"), nut: true,
        script: ["BU raises 6", "BB calls", "flop Qc 9d 4s", "BB checks", "BU bets 6", "BB calls", "turn 2h", "BB checks", "BU checks", "river 8c", "BB bets 10"],
        players: { BB: "station" }, expect: { action: "aggressive" } },
    { id: "post-side-pot-short-allin", description: "Short stack all-in preflop, big stack checks the flop, hero has top set: bet into the side pot", table: nine("BU", "Kh Kd", { stacks_bb: { SB: 6 } }), nut: true,
        script: ["BU raises 6", "SB raises 12 allin", "BB calls", "BU calls", "flop Ks 7d 2c", "BB checks"], expect: { action: "aggressive" } },

    { id: "post-oop-set-vs-station", description: "BB flops a set first to act against a station who rarely bets: bet (lead for value)", table: nine("BB", "4h 4d"), nut: true,
        script: ["BU raises 6", "BB calls", "flop Kc 9d 4s"], players: { BU: "station" }, expect: { action: "aggressive" } },
    { id: "post-oop-flush-river-vs-maniac", description: "Flush first to act on the river against a maniac: bet or check to raise, never fold", table: nine("BB", "Qh Th"), nut: true,
        script: ["CO raises 6", "BB calls", "flop Ah 7h 2c", "BB checks", "CO bets 8", "BB calls", "turn 5s", "BB checks", "CO bets 20", "BB calls", "river 3h"],
        players: { CO: "maniac" }, expect: { action: ["check", "aggressive"] } },

    // ------------------------------------------------------------------ post-flop, multiway
    { id: "post-10h-multi-overpair", description: "10-handed, three-way limped-raised pot, aces on a low flop, checked to hero: bet", table: ten("CO", "Ah Ad"),
        script: ["UTG+1 calls", "MP calls", "CO raises 12", "BB calls", "UTG+1 calls", "flop 9c 5d 2s", "BB checks", "UTG+1 checks"], expect: { action: "aggressive" } },
    { id: "post-multi-set-checked", description: "Set of fives, three opponents check to hero: bet", table: nine("BU", "5h 5d"), nut: true,
        script: ["UTG calls", "CO calls", "BU calls", "SB calls", "BB checks", "flop Kc 9d 5s", "SB checks", "BB checks", "UTG checks", "CO checks"],
        expect: { action: "aggressive" } },
    { id: "post-multi-air-oop-check", description: "Air out of position in a 3-way pot: check", table: nine("BB", "Qh 4d"),
        script: ["CO calls", "BU calls", "SB calls", "BB checks", "flop Kc 9d 6s", "SB checks"], expect: { action: "check" } },
    { id: "post-multi-lead-second-pair-oop", description: "BB first to act into three players with K-T on A-7-T (a real spot): check, a lead with second pair is a thin bluff", table: nine("BB", "Kh Td"),
        script: ["HJ raises 6", "CO calls", "BU calls", "BB calls", "flop Ac 7h Th"], expect: { action: "check" } },
    { id: "post-multi-lead-top-pair-draw", description: "SB first to act into three players with top pair and a flush draw: bet", table: nine("SB", "Kd Qd"),
        script: ["HJ raises 6", "CO calls", "BU calls", "SB calls", "BB folds", "flop 8d Qs 9d"], expect: { action: "aggressive" } },
    { id: "post-multi-top-pair-backdoor-oop", description: "SB first to act into three players with top pair and only a backdoor draw on a wet board: check or bet, both are played", table: nine("SB", "Ks Qs"),
        script: ["HJ raises 6", "CO calls", "BU calls", "SB calls", "BB folds", "flop 8s Qd 9d"], expect: { action: ["check", "aggressive"] } },
    { id: "post-multi-lead-second-pair-4way-limped", description: "BB first to act in a four-way limped pot with second pair: check", table: nine("BB", "Th 8d"),
        script: ["UTG calls", "CO calls", "BU calls", "SB folds", "BB checks", "flop Ac Tc 6d"], expect: { action: "check" } },
    { id: "post-multi-mid-pair-vs-bet-raise", description: "Middle pair facing a bet and a raise multiway: fold", table: nine("BU", "9h 8h"),
        script: ["UTG raises 6", "CO calls", "BU calls", "BB calls", "flop Kc 9d 4s", "BB checks", "UTG bets 14", "CO raises 45"], expect: { action: "fold" } },
    { id: "post-multi-two-pair-vs-bet", description: "Top two pair facing a bet in a 4-way pot: raise or call, never fold", table: nine("BB", "Kh 9h"), nut: true,
        script: ["UTG raises 6", "CO calls", "BU calls", "BB calls", "flop Kc 9d 4s", "BB checks", "UTG bets 14", "CO calls", "BU calls"], expect: { action: "continue" } },

    // ------------------------------------------------------------------ post-flop, short SPR and all-ins
    { id: "post-spr-aa-vs-shove", description: "Aces facing a flop shove at SPR about 1: call", table: nine("BB", "Ah Ad", { stack_bb: 20 }),
        script: ["BU raises 6", "BB raises 18", "BU calls", "flop Kc 8d 3s", "BB bets 10", "BU raises 22 allin"], expect: { action: ["call", "all-in"] } },
    { id: "post-spr-tptk-vs-shove", description: "Top pair top kicker facing a flop shove at SPR 1.5: call", table: nine("BB", "Ah Kd", { stack_bb: 25 }),
        script: ["BU raises 6", "BB raises 18", "BU calls", "flop Kc 8d 3s", "BB bets 12", "BU raises 32 allin"], expect: { action: ["call", "all-in"] } },
    { id: "post-spr-combo-draw-shove", description: "Nut flush draw with two overcards facing a small flop shove: call", table: nine("BB", "Ah Kh", { stack_bb: 20 }),
        script: ["BU raises 6", "BB calls", "flop 9h 6h 2c", "BB checks", "BU bets 34 allin"], expect: { action: ["call", "all-in"] } },
    { id: "post-spr-overpair-cbet-short", description: "Overpair at SPR under 1 on the flop, checked to: bet or shove", table: nine("CO", "Qh Qd", { stack_bb: 15 }),
        script: ["CO raises 6", "BB calls", "flop Jc 7d 3s", "BB checks"], expect: { action: "aggressive" } },
    { id: "post-straddle-set-station", description: "Straddled pot, set on the flop vs a station: bet", table: nine("BU", "9h 9d", { straddle: true, stack_bb: 200 }), nut: true,
        script: ["BU raises 12", "BB calls", "UTG calls", "flop 9s 6d 2c", "BB checks", "UTG checks"], players: { BB: "station", UTG: "station" },
        expect: { action: "aggressive" } },
    { id: "post-ante-overpair-turn", description: "Anted pot, overpair on the turn facing a small bet: continue", table: nine("CO", "Kh Kd", { ante_bb: 0.5 }),
        script: ["CO raises 8", "BB calls", "flop Tc 7d 3s", "BB checks", "CO bets 12", "BB calls", "turn 2h", "BB bets 12"], expect: { action: "continue" } },

    // ------------------------------------------------------------------ calling over several streets, deep multiway, sizing
    { id: "post-ace-high-vs-cbet", description: "Ace high with no draw facing a c-bet on K-8-7: fold (it rarely survives the turn and river bets)", table: nine("BB", "As 3d"),
        script: ["CO raises 6", "BB calls", "flop Kh 8c 7h", "BB checks", "CO bets 8"], expect: { action: "fold" } },
    { id: "post-deep-multi-nut-fd", description: "300 BB deep, nut flush draw facing a bet and a call in a four-way pot: continue (implied odds)", table: nine("BU", "Ah Th", { stack_bb: 300 }),
        script: ["HJ raises 6", "CO calls", "BU calls", "BB calls", "flop Kh 7h 2c", "BB checks", "HJ bets 12", "CO calls"], expect: { action: "continue" } },
    { id: "post-deep-multi-oesd", description: "250 BB deep, open-ended straight draw facing a half-pot bet in a three-way pot: continue", table: nine("CO", "Jd Td", { stack_bb: 250 }),
        script: ["HJ raises 6", "CO calls", "BU calls", "flop 9c 8s 2h", "HJ bets 10"], expect: { action: "continue" } },
    { id: "pre-bu-q9s-deep-4way", description: "BU with Q9s behind a raise and two callers at 250 BB: call (deep multiway implied odds)", table: nine("BU", "Qs 9s", { stack_bb: 250 }),
        script: ["LJ raises 6", "HJ calls", "CO calls"], expect: { action: "call" } },
    { id: "post-value-vs-station-size", description: "Top set on the turn checked to by a station: bet at least half the pot (stations call big bets)", table: nine("BU", "Kh Kd"), nut: true,
        script: ["CO raises 6", "BU calls", "flop Ks 8d 3c", "CO checks", "BU bets 6", "CO calls", "turn 4h", "CO checks"], players: { CO: "station" }, expect: { action: "aggressive", size_bb: [12, 100] } }
];

// ---------------------------------------------------------------------------------------------
// Runner

export interface ScenarioResult {
    scenario: Scenario,
    pass: boolean,
    failures: string[],
    action: string,
    size_bb: number,
    ms: number,
    street: string,
    big_blind: number,
    /** Preflop advice or post-flop analysis, for diagnosing failures. */
    preflop?: PreflopAdvice,
    analysis?: PostflopAnalysis,
    /** Hero's equity (preflop: against the likely hands of the players still in). */
    equity?: number,
    view: HeroView,
    /** The mixed strategy the random number picks from (every option in it is checked too). */
    mix?: MixStrategy
}

/** The longest an analysis may take: the action clock needs the answer quickly. */
export const MAX_ANALYSIS_MS = 800;
const PREFLOP_EQUITY_SEED = 7;

/**
 * The engine's built-in averages, action weights and response table (no stored hands), so results don't
 * depend on a database or on what ran before.
 */
export function useBuiltInDefaults(): void {
    resetPriors();
    resetActionWeights();
    resetResponseTable();
    setPlayConstants(null);
    resetPreflopResponseTable();
    POPULATION_TENDENCIES.vpip = 35;
    POPULATION_TENDENCIES.pfr = 12;
    delete POPULATION_TENDENCIES.three_bet;
    TABLE_RULES.seven_deuce_bounty = true;
}

export function spotOf(sc: Scenario): { s: HandState, v: HeroView } {
    const s = parseHand(buildLog(sc.table, sc.script), { hero_name: sc.table.hero });
    const v = heroView(s);
    if (!v || !s.hero_id) throw new Error(`${sc.id}: hero not found`);
    return { s, v };
}

/**
 * Runs one scenario through the engine (preflop charts or the post-flop model) and checks it: the engine's
 * single pick, and every option the random number could pick under `mix_style` (they must all be legal and
 * respect the scenario's "never" rules, and the expected play must stay at least half of the mix).
 */
export function runScenario(sc: Scenario, time_budget_ms?: number, mix_style: MixStyle = "balanced"): ScenarioResult {
    const { s, v } = spotOf(sc);
    const bb = s.big_blind;
    const type = (ref: PlayerRef) => sc.players?.[ref.name];
    const stats = (ref: PlayerRef) => statsOf(type(ref));
    const players = (ref: PlayerRef) => profileOf(ref, type(ref));
    const failures: string[] = [];
    let action: string, size_bb: number, preflop: PreflopAdvice | undefined, analysis: PostflopAnalysis | undefined, eq: number | undefined;

    const t0 = performance.now();
    if (s.street === "preflop") {
        // like the live bot: equity against the players still in prices calls when hero closes the action
        eq = equity({ hero: s.hero_cards, board: [], opponents: opponentModels(s, stats).map((m) => m.model), iterations: 6000, time_budget_ms: 5000, seed: PREFLOP_EQUITY_SEED }).equity;
        const advice = preflopAdvice(s, v, stats, undefined, { seven_deuce_bounty: (sc.bounty_bb ?? 0) * bb, equity: eq, ev: { profile: preflopProfiles(players), time_budget_ms: 500 } });
        if (!advice) throw new Error(`${sc.id}: no preflop advice for this spot`);
        preflop = advice;
        action = advice.action;
        size_bb = advice.size_bb;
    } else {
        analysis = analyzePostflop(s, v, opponentTendencies(s, stats, players), time_budget_ms);
        const best = analysis.candidates[0];
        action = best.action;
        size_bb = best.to > 0 ? Math.round(best.to / bb * 100) / 100 : 0;
        for (const c of analysis.candidates) {
            if (!Number.isFinite(c.ev)) failures.push(`NaN or infinite EV for ${c.label}`);
        }
        if (!Number.isFinite(analysis.equity)) failures.push("NaN equity");
        // a bet's label matches its equity against the hands that call
        for (const c of analysis.candidates) {
            if (c.purpose === "value" && c.called_equity! < 0.5) failures.push(`${c.label} labeled value with ${Math.round(c.called_equity! * 100)}% when called`);
            if (c.purpose === "semi-bluff" && c.called_equity! < 0.15) failures.push(`${c.label} labeled semi-bluff with ${Math.round(c.called_equity! * 100)}% when called`);
        }
    }
    const ms = performance.now() - t0;

    // invariants
    const legal = checkLegality({ action: action as ActionKind, size_bb }, v, bb);
    if (!legal.legal) failures.push(`illegal: ${legal.reason}`);
    if (legal.dominated) failures.push("folds when checking is free");
    if (sc.nut && action === "fold") failures.push("folds a nut hand");
    if (aggressive(action) && action !== "all-in" && v.min_raise_to !== null) {
        const chips = size_bb * bb;
        if (chips < v.min_raise_to - 1e-6 || chips > v.max_raise_to + 1e-6) failures.push(`size ${size_bb} BB outside ${v.min_raise_to / bb}-${v.max_raise_to / bb} BB`);
    }
    if (ms > MAX_ANALYSIS_MS) failures.push(`took ${Math.round(ms)} ms (limit ${MAX_ANALYSIS_MS})`);

    // expectations
    const e = sc.expect;
    const wanted = e.action === undefined ? [] : Array.isArray(e.action) ? e.action : [e.action];
    if (wanted.length && !wanted.some((w) => matches(action, w))) failures.push(`expected ${wanted.join(" or ")}, got ${action}`);
    for (const x of e.not ?? []) if (matches(action, x)) failures.push(`must not ${x}, got ${action}`);
    if (e.size_bb && aggressive(action) && action !== "all-in" && (size_bb < e.size_bb[0] - 1e-9 || size_bb > e.size_bb[1] + 1e-9)) {
        failures.push(`size ${size_bb} BB outside the expected ${e.size_bb[0]}-${e.size_bb[1]} BB`);
    }

    // the mix: every option the roll could pick
    let mix: MixStrategy | undefined;
    if (mix_style !== "off") {
        const opponent_types = s.seats.filter((p) => p.id !== s.hero_id && !p.folded).map((p) => PLAYER_TYPE[type(p) ?? "pool"]);
        if (preflop) {
            mix = mixPreflop({ advice: preflop, cls: classOf(s.hero_cards), style: mix_style, roll: 50, pot_bb: v.pot / bb, opponent_types });
        } else if (analysis) {
            const hero = s.seats.find((p) => p.id === s.hero_id)!;
            const hero_range = rangeProfile(seatModel(s, hero, stats).model, s.board, s.hero_cards);
            mix = mixPostflop({ analysis, state: s, view: v, style: mix_style, roll: 50, hero_range, opponent_types });
        }
    }
    const share = (x: number) => `${Math.round(x * 100)}%`;
    for (const o of mix?.options ?? []) {
        const size = o.action === "all-in" ? v.max_raise_to / bb : o.size_bb;
        const ok = checkLegality({ action: o.action as ActionKind, size_bb: size }, v, bb);
        if (!ok.legal) failures.push(`mix: ${o.label} is illegal (${ok.reason})`);
        if (ok.dominated) failures.push(`mix: ${o.label} folds when checking is free`);
        if (sc.nut && o.action === "fold") failures.push(`mix: folds a nut hand ${share(o.freq)} of the time`);
        if (aggressive(o.action) && o.action !== "all-in" && v.min_raise_to !== null) {
            const chips = size * bb;
            if (chips < v.min_raise_to - 1e-6 || chips > v.max_raise_to + 1e-6) failures.push(`mix: size ${size} BB outside ${v.min_raise_to / bb}-${v.max_raise_to / bb} BB`);
        }
        for (const x of e.not ?? []) if (matches(o.action, x)) failures.push(`mix: must not ${x}, but ${o.label} ${share(o.freq)} of the time`);
    }
    if (mix && wanted.length) {
        const other = mix.options.filter((o) => !wanted.some((w) => matches(o.action, w))).reduce((sum, o) => sum + o.freq, 0);
        if (other > 0.5) failures.push(`mix: expected ${wanted.join(" or ")} at least half the time, but other plays ${share(other)} (${describeMix(mix)})`);
    }
    return { scenario: sc, pass: failures.length === 0, failures, action, size_bb, ms, street: s.street, big_blind: bb, preflop, analysis, equity: eq ?? analysis?.equity, view: v, mix };
}

/** One line per result, plus every option's EV when it failed (or `verbose`). */
export function describeResult(r: ScenarioResult, verbose = false): string {
    const bb = r.big_blind;
    const size = r.size_bb > 0 ? ` ${r.size_bb} BB` : "";
    const head = `${r.pass ? "PASS" : "FAIL"} ${r.scenario.id.padEnd(34)} ${`${r.action}${size}`.padEnd(16)} ${Math.round(r.ms).toString().padStart(4)} ms  ${r.scenario.description}`;
    const lines = [head];
    if (r.mix && !r.mix.pure) lines.push(`     mix: ${describeMix(r.mix)}`);
    if (!r.pass) lines.push(`     ${r.failures.join("; ")}`);
    if (!r.pass || verbose) {
        if (r.preflop) {
            lines.push(`     ${r.preflop.scenario}: ${r.preflop.reason}${r.equity !== undefined ? ` (equity ${Math.round(r.equity * 100)}%)` : ""}`);
        }
        const a = r.analysis;
        if (a) {
            const pct = (x: number | undefined) => x === undefined ? "-" : `${Math.round(x * 100)}%`;
            lines.push(`     equity ${pct(a.equity)}, when called ${pct(a.equity_when_called)}, need ${pct(a.required_equity)}, R ${a.realization.toFixed(2)}${a.call_plan ? ` (call ${a.call_plan.realization.toFixed(2)}: next bet ${pct(a.call_plan.barrel)}, keeps calling ${pct(a.call_plan.continue_vs_barrel)})` : ""}, ${a.in_position ? "IP" : "OOP"}${a.bet_role ? `, role ${a.bet_role}` : ""}${a.note ? `; ${a.note}` : ""}`);
            for (const c of a.candidates) {
                const extra = c.fold_chance !== undefined ? ` folds ${pct(c.fold_chance)} raised ${pct(c.raise_chance)} called-eq ${pct(c.called_equity)} ${c.purpose}` : "";
                lines.push(`       ${c.label.padEnd(18)} ${(c.ev / bb >= 0 ? "+" : "") + (c.ev / bb).toFixed(2)} BB${extra}`);
            }
        }
    }
    return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Command line

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const verbose = args.includes("--verbose");
    const only_at = args.indexOf("--only");
    const only = only_at >= 0 ? args[only_at + 1] : undefined;
    const db_file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--only");
    if (db_file) {
        // your games' measured averages, action weights and response table, as the live bot uses them
        const { DBService } = await import("../app/services/db-service.ts");
        const { HandRecorder } = await import("../app/services/hand-recorder.ts");
        const { ProfileService } = await import("../app/services/profile-service.ts");
        const db = new DBService(db_file);
        await db.init();
        await db.createTables();
        const profiles = new ProfileService(new HandRecorder(db));
        const hands = await profiles.load();
        setActionWeights(profiles.actionWeights().weights);
        setResponseTable(profiles.responseTable().table);
        setPlayConstants(profiles.playConstants().values);
        setPreflopResponseTable(profiles.preflopResponses().table);
        await db.close();
        console.log(`Calibrated from ${hands} stored hands: pool VPIP ${Math.round(POPULATION_TENDENCIES.vpip)}%, PFR ${Math.round(POPULATION_TENDENCIES.pfr)}%, river fold ${Math.round(PRIORS.fold_to_bet_river.mean * 100)}%.`);
    } else {
        useBuiltInDefaults();
        console.log("Built-in defaults (pass a database file to use your games' measured tables).");
    }
    const list = SCENARIOS.filter((sc) => !only || sc.id.startsWith(only));
    let failed = 0;
    for (const sc of list) {
        const r = runScenario(sc);
        if (!r.pass) failed++;
        console.log(describeResult(r, verbose));
    }
    console.log(`\n${list.length - failed}/${list.length} scenarios pass.`);
    process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await main();
}
