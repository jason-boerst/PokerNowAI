import { parseHand } from "../engine/hand-parser.ts";
import { ObservedStats } from "../engine/opponent-range.ts";
import { PlayerProfile, ProfileBuilder } from "../engine/player-profile.ts";
import { HandRecorder } from "./hand-recorder.ts";

/** Opponent profiles built from every recorded hand, updated as new hands finish. */
export class ProfileService {
    private builder = new ProfileBuilder();

    constructor(private recorder: HandRecorder) {}

    /** Loads all recorded hands. Returns how many were loaded. */
    async load(): Promise<number> {
        const hands = await this.recorder.hands();
        for (const h of hands) {
            this.builder.addHand(parseHand(JSON.parse(h.messages_json), { big_blind: h.big_blind ?? undefined }));
        }
        return hands.length;
    }

    addHand(messages: string[], big_blind: number): void {
        this.builder.addHand(parseHand(messages, { big_blind }));
    }

    profile(name: string): PlayerProfile | undefined {
        return this.builder.profile(name);
    }

    /** Stats in the form the range and preflop engines use. */
    stats(name: string): ObservedStats | undefined {
        const p = this.builder.profile(name);
        if (!p) return undefined;
        return { vpip: p.vpip.value * 100, pfr: p.pfr.value * 100, hands: p.hands, aggression: p.aggression.value, shrunk: true };
    }
}
