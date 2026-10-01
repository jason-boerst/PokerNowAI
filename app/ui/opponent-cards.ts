// Opponent cards for the in-game panel: who they are, how they play, and the stats that matter for this decision.
import { ActionType, HandState, HeroView, POST_TYPES, SeatState } from "../engine/hand-parser.ts";
import { ObservedStats, opponentModels, playerBluff, sevenDeuceTell } from "../engine/opponent-range.ts";
import { MIN_HANDS_FOR_TYPE, PlayerProfile, PlayerRef, PlayerType, PRIORS, RateKey } from "../engine/player-profile.ts";
import { rangePercent } from "../engine/ranges.ts";
import { bb } from "../engine/spot-format.ts";
import type { PlayerInfo, PlayerLookup } from "../services/profile-service.ts";
import { OpponentCard, OpponentStat, StatLevel, TypeTone } from "./panel-model.ts";

export interface OpponentCardInputs {
    state: HandState,
    view: HeroView,
    players: PlayerLookup,
    stats: (player: PlayerRef) => ObservedStats | undefined
}

/** Most stats on one card: the ones for this decision, then VPIP, PFR and 3-bet. */
const MAX_STATS = 6;
/** Chances before a stat is colored at all, and before it can be called high or low. */
const MIN_CHANCES_SHOWN = 5;
const MIN_CHANCES_JUDGED = 10;
/** Gap from the pool that counts as high or low: 7 points, or a quarter of the average for rare actions. */
const LEVEL_GAP = 0.07;
const SMALL_RATE = 0.20;
const SMALL_RATE_GAP = 0.25;

const TYPE_TONE: Record<PlayerType, TypeTone> = {
    "calling station": "loose", "loose-passive": "loose",
    "maniac": "aggressive", "LAG": "aggressive",
    "nit": "tight",
    "TAG": "balanced", "regular": "balanced",
    "unknown": "unknown"
};

export function typeTone(type: string): TypeTone {
    return TYPE_TONE[type as PlayerType] ?? "unknown";
}

/**
 * How a stat compares with your pool: unknown under 5 chances; high or low from 10 chances when the
 * estimate is at least 7 points from the average (a quarter of it for rare actions like a 3-bet); else normal.
 */
export function statLevel(value: number, n: number, pool: number): StatLevel {
    if (n < MIN_CHANCES_SHOWN) return "unknown";
    if (n < MIN_CHANCES_JUDGED) return "normal";
    const gap = pool < SMALL_RATE ? SMALL_RATE_GAP * pool : LEVEL_GAP;
    if (value - pool >= gap - 1e-9) return "high";
    if (pool - value >= gap - 1e-9) return "low";
    return "normal";
}

/** Preflop: UTG first, blinds last. After the flop: small blind first, button last (heads-up: big blind first). */
const PREFLOP_ORDER = ["UTG", "UTG+1", "UTG+2", "MP", "LJ", "HJ", "CO", "BU", "SB", "BB"];
const POSTFLOP_ORDER = ["SB", "BB", "UTG", "UTG+1", "UTG+2", "MP", "LJ", "HJ", "CO", "BU"];

function actingOrder(s: HandState, position: string): number {
    const heads_up = s.seats.filter((p) => p.position !== "?").length === 2;
    if (heads_up && s.street !== "preflop") return position === "BB" ? 0 : position === "SB" ? 1 : 99;
    const order = s.street === "preflop" ? PREFLOP_ORDER : POSTFLOP_ORDER;
    const i = order.indexOf(position);
    if (i >= 0) return i;
    // more early seats than the list has: after UTG+2, before MP; unknown seats last
    const extra = position.match(/^UTG\+(\d+)$/);
    return extra ? order.indexOf("UTG+2") + Number(extra[1]) / 100 : 99;
}

/** What is going on in the hand, as the stat choice needs it. */
interface Spot {
    preflop: boolean,
    /** Hero has a bet or raise to call. */
    facing_bet: boolean,
    /** The most recent bet or raise in the hand (any street), and the current street's. */
    last_aggressor?: string,
    street_aggressor?: string,
    /** Preflop: the first raise (the open) and whether it was a steal from CO, BU or SB. */
    opener?: string,
    steal_open: boolean,
    /** Nobody has put chips in voluntarily before the flop yet. */
    unopened: boolean,
    limpers: Set<string>,
    /** Hero made the last preflop raise (a bet on the flop is a c-bet). */
    hero_pf_raiser: boolean,
    /** Opponents who bet this street after someone checked (it was checked to them). */
    bet_after_check: Set<string>,
    /** Opponents who act after hero if hero checks or calls. */
    to_act: Set<string>
}

function readSpot(s: HandState, v: HeroView): Spot {
    const hero = s.seats.find((p) => p.id === s.hero_id);
    const voluntary = (t: ActionType) => !POST_TYPES.has(t) && t !== "fold" && t !== "check";
    const aggressive = (t: ActionType) => t === "bet" || t === "raise";
    const pre = s.actions.filter((a) => a.street === "preflop");
    const pre_raises = pre.filter((a) => aggressive(a.type));
    const first_voluntary = pre.find((a) => voluntary(a.type));
    const opener = pre_raises[0];
    const position = (id: string) => s.seats.find((p) => p.id === id)?.position ?? "";
    const limpers = new Set<string>();
    for (const a of pre) {
        if (aggressive(a.type)) break;
        if (a.type === "call") limpers.add(a.player_id);
    }
    const street_acts = s.actions.filter((a) => a.street === s.street && !POST_TYPES.has(a.type));
    const bet_after_check = new Set<string>();
    let checked = false, bet_seen = false;
    for (const a of street_acts) {
        if (a.type === "check") checked = true;
        if (aggressive(a.type)) {
            if (!bet_seen && checked) bet_after_check.add(a.player_id);
            bet_seen = true;
        }
    }
    const all_aggression = s.actions.filter((a) => aggressive(a.type));
    const acted = new Set(street_acts.map((a) => a.player_id));
    const hero_order = hero ? actingOrder(s, hero.position) : 99;
    // preflop the big blind and a straddler keep their option to raise, wherever they sit
    const option = new Set(pre.filter((a) => a.type === "post_bb" || a.type === "post_straddle").map((a) => a.player_id));
    const actsAfterHero = (p: SeatState) => {
        if (p.all_in) return false;
        if (p.street_contribution < s.current_bet - 1e-9) return true;
        if (acted.has(p.id)) return false;
        return actingOrder(s, p.position) > hero_order || (s.street === "preflop" && option.has(p.id));
    };
    const to_act = new Set(v.active_opponents.filter(actsAfterHero).map((p) => p.id));
    return {
        preflop: s.street === "preflop",
        facing_bet: v.to_call > 0,
        last_aggressor: all_aggression[all_aggression.length - 1]?.player_id,
        street_aggressor: street_acts.filter((a) => aggressive(a.type)).pop()?.player_id,
        opener: opener?.player_id,
        steal_open: !!opener && opener === first_voluntary && ["CO", "BU", "SB"].includes(position(opener.player_id)),
        unopened: !first_voluntary,
        limpers,
        hero_pf_raiser: !!s.hero_id && pre_raises[pre_raises.length - 1]?.player_id === s.hero_id,
        bet_after_check,
        to_act
    };
}

/** A stat to show: which rate, its label and why it matters now. */
type Pick = [RateKey, string, string];

/** The stats that matter for this decision against one opponent, most relevant first. */
function pickStats(seat: SeatState, spot: Spot, s: HandState, hero_position: string): Pick[] {
    const picks: Pick[] = [];
    const behind = spot.to_act.has(seat.id);
    if (spot.preflop) {
        const raiser = spot.last_aggressor === seat.id && spot.last_aggressor !== s.hero_id;
        if (raiser && spot.opener === seat.id) {
            if (spot.steal_open) picks.push(["steal", "Steal", "opened late: how often they raise there"]);
            picks.push(["fold_to_three_bet", "Fold to 3-bet", "if you 3-bet: how often they fold"]);
        }
        if (spot.unopened && ["CO", "BU", "SB"].includes(hero_position) && ["SB", "BB"].includes(seat.position) && behind) {
            picks.push(["fold_to_steal", "Fold to steal", "you open: how often they fold their blind"]);
        }
        if (spot.limpers.has(seat.id)) picks.push(["limp", "Limp", "limped in: how often they limp"]);
    } else if (!spot.facing_bet) {
        if (s.street === "flop" && spot.hero_pf_raiser) picks.push(["fold_to_cbet", "Fold to c-bet", "you c-bet: how often they fold"]);
        const street = s.street as "flop" | "turn" | "river";
        picks.push([`fold_to_bet_${street}`, `Fold to ${street} bet`, "you bet: how often they fold heads-up"]);
        picks.push(["raise_vs_bet", "Raises vs bet", "you bet: how often they raise"]);
    } else if (spot.street_aggressor === seat.id) {
        picks.push(["aggression", "Aggression", "they bet: higher means more bluffs"]);
        if (spot.bet_after_check.has(seat.id)) picks.push(["bet_when_checked_to", "Bets when checked to", "bet after a check: how often they stab"]);
        picks.push(["won_at_showdown", "Wins at showdown", "how often they show the best hand"]);
        picks.push(["went_to_showdown", "Showdown", "how often they see a showdown"]);
    } else {
        if (behind) picks.push(["raise_vs_bet", "Raises vs bet", "acts after you: how often they raise"]);
        picks.push(["went_to_showdown", "Showdown", "how often they call down to a showdown"]);
        picks.push(["aggression", "Aggression", "how often they bet or raise after the flop"]);
    }
    const three_bet_hint = spot.preflop && behind ? "acts after you: how often they re-raise" : "how often they re-raise before the flop";
    const always: Pick[] = [
        ["vpip", "VPIP", "share of hands they play"],
        ["pfr", "PFR", "share of hands they raise preflop"],
        ["three_bet", "3-bet", three_bet_hint]
    ];
    return [...picks.slice(0, MAX_STATS - always.length), ...always];
}

function statOf([key, label, hint]: Pick, p: PlayerProfile | undefined): OpponentStat {
    const pool = PRIORS[key].mean;
    // no history: the pool average, which is what the engine assumes for them
    if (!p) return { label, value: pool, n: 0, pool, level: "unknown", hint };
    const r = p[key];
    return { label, value: r.value, n: r.n, pool, level: statLevel(r.value, r.n, pool), hint };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const raw = (r: { k: number, n: number }) => r.n ? pct(r.k / r.n) : "-";

/** Today's raw VPIP / PFR against their usual numbers. */
function todayLine(info: PlayerInfo): string | undefined {
    const today = info.session;
    if (!today || today.hands === 0) return undefined;
    const now = `Today VPIP ${raw(today.vpip)} / PFR ${raw(today.pfr)} over ${today.hands} hand${today.hands === 1 ? "" : "s"}`;
    // raw rates on both sides, so a short history doesn't look like a change
    return info.long?.vpip.n ? `${now} (usually ${raw(info.long.vpip)} / ${raw(info.long.pfr)})` : `${now} (no earlier games)`;
}

/** Their last shown hand and how they played it, e.g. "9c Kd after call, check/call, bet". */
function showdownLine(p: PlayerProfile | undefined): string | undefined {
    const sd = p?.showdowns[0];
    if (!sd) return undefined;
    return `${sd.cards.join(" ")} after ${sd.line.replace(/\w+: /g, "").replace(/ \| /g, ", ")}`;
}

/**
 * One card per opponent still in the hand, the most relevant first: whoever bet or raised last, then
 * the rest in acting order. Shows up to `limit` cards; `more` counts the rest.
 */
export function opponentCards(inputs: OpponentCardInputs, limit = 4): { cards: OpponentCard[], more: number, warnings: string[] } {
    const { state: s, view: v } = inputs;
    const spot = readSpot(s, v);
    const hero_position = s.seats.find((p) => p.id === s.hero_id)?.position ?? "";
    const ordered = [...v.active_opponents].sort((a, b) =>
        Number(b.id === spot.last_aggressor) - Number(a.id === spot.last_aggressor) || actingOrder(s, a.position) - actingOrder(s, b.position));
    const shown = ordered.slice(0, Math.max(0, limit));
    const ranges = new Map(opponentModels(s, inputs.stats).map((m) => [m.seat.id, m.model.range]));
    const cards: OpponentCard[] = shown.map((seat) => {
        const info = inputs.players(seat);
        const p = info.current;
        const range = ranges.get(seat.id);
        const type = p?.type ?? "unknown";
        return {
            seat: seat.position, name: seat.name, stack_bb: s.big_blind > 0 ? bb(seat.stack, s.big_blind) : 0,
            type, type_tone: typeTone(type),
            hands: { before: info.long?.hands ?? 0, today: info.session?.hands ?? 0 },
            range_pct: range ? Math.round(rangePercent(range) * 10) / 10 : undefined,
            stats: pickStats(seat, spot, s, hero_position).map((pick) => statOf(pick, p)),
            today: todayLine(info),
            flags: [...(sevenDeuceTell(s, seat)?.notes ?? []), ...(playerBluff(seat) ? [playerBluff(seat)!.note] : []), ...info.deviations.map((d) => d.text)],
            last_showdown: showdownLine(p),
            exploit: p ? p.exploit : "No history yet: assume a typical player from your games.",
            low_sample: !p || p.hands < MIN_HANDS_FOR_TYPE,
            to_act: spot.to_act.has(seat.id)
        };
    });
    const unknown = cards.filter((c) => c.low_sample).length;
    const warnings = unknown ? [`${unknown} opponent(s) have under ${MIN_HANDS_FOR_TYPE} hands: their stats are mostly population defaults.`] : [];
    return { cards, more: Math.max(0, v.active_opponents.length - shown.length), warnings };
}
