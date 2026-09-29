import { DBService } from "./db-service.ts";
import { netResult, parseHand } from "../engine/hand-parser.ts";

export interface DecisionRecord {
    game_id: string,
    hand_number: number | null,
    street: string,
    /** The current hand's log lines (chronological) at decision time. */
    messages: string[],
    hero_name: string,
    hero_cards: string[],
    big_blind: number,
    prompt: string,
    response: string,
    action: unknown,
    model: string,
    /** "llm" or "engine". */
    source: string,
    latency_ms: number
}

export interface HandRow {
    game_id: string,
    hand_number: number,
    hand_id: string | null,
    hero_name: string | null,
    big_blind: number | null,
    messages_json: string,
    hero_net: number | null,
    recorded_at: string
}

export interface DecisionRow {
    id: number,
    game_id: string,
    hand_number: number | null,
    street: string,
    messages_json: string,
    hero_name: string,
    hero_cards: string,
    big_blind: number,
    prompt: string,
    response: string,
    action_json: string,
    model: string,
    source: string,
    latency_ms: number,
    label: string | null,
    recorded_at: string
}

/** Stores completed hands and the bot's decisions in SQLite. Failures are logged, never thrown. */
export class HandRecorder {
    constructor(private db: DBService) {}

    async recordHand(game_id: string, messages: string[], hero_name: string, big_blind: number): Promise<void> {
        try {
            const state = parseHand(messages, { hero_name, big_blind });
            if (state.hand_number === null) return;
            const hero_net = state.hero_id ? netResult(state, state.hero_id) : null;
            await this.db.run(
                `INSERT OR REPLACE INTO Hands (game_id, hand_number, hand_id, hero_name, big_blind, messages_json, hero_net, recorded_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [game_id, state.hand_number, state.hand_id, hero_name, state.big_blind || big_blind, JSON.stringify(messages), hero_net, new Date().toISOString()]
            );
        } catch (err) {
            console.log("Could not record hand:", err instanceof Error ? err.message : err);
        }
    }

    async recordDecision(d: DecisionRecord): Promise<void> {
        try {
            await this.db.run(
                `INSERT INTO Decisions (game_id, hand_number, street, messages_json, hero_name, hero_cards, big_blind, prompt, response,
                                        action_json, model, source, latency_ms, recorded_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [d.game_id, d.hand_number, d.street, JSON.stringify(d.messages), d.hero_name, d.hero_cards.join(" "), d.big_blind,
                 d.prompt, d.response, JSON.stringify(d.action), d.model, d.source, d.latency_ms, new Date().toISOString()]
            );
        } catch (err) {
            console.log("Could not record decision:", err instanceof Error ? err.message : err);
        }
    }

    async hands(): Promise<HandRow[]> {
        return this.db.all<HandRow>(`SELECT * FROM Hands ORDER BY recorded_at`);
    }

    async decisions(): Promise<DecisionRow[]> {
        return this.db.all<DecisionRow>(`SELECT * FROM Decisions ORDER BY id`);
    }

    async setLabel(decision_id: number, label: string | null): Promise<void> {
        await this.db.run(`UPDATE Decisions SET label = ? WHERE id = ?`, [label, decision_id]);
    }
}
