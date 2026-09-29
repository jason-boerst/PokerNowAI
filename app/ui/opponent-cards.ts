// Opponent cards for the in-game panel: who they are, how they play, and the stats that matter for this decision.
import { HandState, HeroView } from "../engine/hand-parser.ts";
import { ObservedStats } from "../engine/opponent-range.ts";
import { MIN_HANDS_FOR_TYPE, PlayerRef } from "../engine/player-profile.ts";
import type { PlayerLookup } from "../services/profile-service.ts";
import { OpponentCard } from "./panel-model.ts";

export interface OpponentCardInputs {
    state: HandState,
    view: HeroView,
    players: PlayerLookup,
    stats: (player: PlayerRef) => ObservedStats | undefined
}

/** Minimal version (replaced by the full implementation): one card per opponent still in the hand. */
export function opponentCards(inputs: OpponentCardInputs, limit = 4): { cards: OpponentCard[], more: number, warnings: string[] } {
    const { state: s, view: v } = inputs;
    const shown = v.active_opponents.slice(0, limit);
    const cards: OpponentCard[] = shown.map((seat) => {
        const info = inputs.players(seat);
        const p = info.current;
        return {
            seat: seat.position, name: seat.name, stack_bb: s.big_blind > 0 ? seat.stack / s.big_blind : 0,
            type: p?.type ?? "unknown", type_tone: "unknown",
            hands: { before: info.long?.hands ?? 0, today: info.session?.hands ?? 0 },
            stats: p ? [
                { label: "VPIP", value: p.vpip.value, n: p.vpip.n, level: "unknown" },
                { label: "PFR", value: p.pfr.value, n: p.pfr.n, level: "unknown" }
            ] : [],
            flags: info.deviations.map((d) => d.text),
            low_sample: !p || p.hands < MIN_HANDS_FOR_TYPE
        };
    });
    const unknown = cards.filter((c) => c.low_sample).length;
    const warnings = unknown ? [`${unknown} opponent(s) have under ${MIN_HANDS_FOR_TYPE} hands: their stats are mostly population defaults.`] : [];
    return { cards, more: Math.max(0, v.active_opponents.length - shown.length), warnings };
}
