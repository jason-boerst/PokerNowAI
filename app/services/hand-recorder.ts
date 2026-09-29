import { DBService } from "./db-service.ts";
import { netResult, parseHand } from "../engine/hand-parser.ts";
import type { ImportedHand } from "../import/pokernow-csv.ts";

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
    recorded_at: string,
    /** When the hand started (log timestamp for imported hands, recording time for live ones). */
    started_at: string | null,
    game_type: string | null,
    /** "live" or "import" (null for hands recorded by older versions, which were live). */
    source: string | null,
    hero_id: string | null
}

export interface GameRow {
    game_id: string,
    source: string,
    file_name: string | null,
    hero_id: string | null,
    hands: number,
    first_at: string | null,
    last_at: string | null,
    imported_at: string
}

export interface ImportResult {
    game_id: string,
    hands_in_file: number,
    added: number,
    already_had: number
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

/** Person id for the ids that are the user's own. */
export const ME = "me";

/** Stores completed hands and the bot's decisions in SQLite. Failures are logged, never thrown. */
export class HandRecorder {
    constructor(private db: DBService) {}

    async recordHand(game_id: string, messages: string[], hero_name: string, big_blind: number): Promise<void> {
        try {
            const state = parseHand(messages, { hero_name, big_blind });
            if (state.hand_number === null) return;
            const hero_net = state.hero_id ? netResult(state, state.hero_id) : null;
            const now = new Date().toISOString();
            await this.db.run(
                `INSERT OR REPLACE INTO Hands (game_id, hand_number, hand_id, hero_name, big_blind, messages_json, hero_net, recorded_at, started_at, game_type, source, hero_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?)`,
                [game_id, state.hand_number, state.hand_id, hero_name, state.big_blind || big_blind, JSON.stringify(messages), hero_net, now, now, state.game_type, state.hero_id]
            );
            await this.db.run(
                `INSERT INTO Games (game_id, source, hands, first_at, last_at, imported_at) VALUES (?, 'live', 1, ?, ?, ?)
                 ON CONFLICT(game_id) DO UPDATE SET hands = (SELECT COUNT(*) FROM Hands WHERE game_id = excluded.game_id), last_at = excluded.last_at`,
                [game_id, now, now, now]
            );
            // the seat the bot plays is you
            if (state.hero_id) {
                await this.db.run(`INSERT OR IGNORE INTO PlayerLinks (player_id, person_id, reason) VALUES (?, ?, 'you, playing live')`, [state.hero_id, ME]);
            }
        } catch (err) {
            console.log("Could not record hand:", err instanceof Error ? err.message : err);
        }
    }

    /** Stores the complete hands of an imported PokerNow log. Hands already stored are skipped. */
    async importHands(game_id: string, file_name: string, hands: ImportedHand[], hero_id: string | null): Promise<ImportResult> {
        const now = new Date().toISOString();
        let added = 0;
        await this.db.transaction(async () => {
            for (const h of hands) {
                const existing = await this.db.all(`SELECT 1 FROM Hands WHERE game_id = ? AND hand_number = ?`, [game_id, h.hand_number]);
                if (existing.length > 0) continue;
                const state = parseHand(h.messages, { big_blind: h.big_blind });
                const hero = hero_id ? state.seats.find((p) => p.id === hero_id) : undefined;
                await this.db.run(
                    `INSERT INTO Hands (game_id, hand_number, hand_id, hero_name, big_blind, messages_json, hero_net, recorded_at, started_at, game_type, source, hero_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?)`,
                    [game_id, h.hand_number, state.hand_id, hero?.name ?? null, h.big_blind, JSON.stringify(h.messages),
                     hero ? netResult(state, hero.id) : null, now, h.started_at, h.game_type, hero ? hero.id : null]
                );
                added++;
            }
            const first = hands[0]?.started_at ?? null;
            const last = hands[hands.length - 1]?.started_at ?? null;
            await this.db.run(
                `INSERT INTO Games (game_id, source, file_name, hero_id, hands, first_at, last_at, imported_at) VALUES (?, 'import', ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(game_id) DO UPDATE SET file_name = excluded.file_name, hero_id = COALESCE(excluded.hero_id, hero_id),
                    hands = (SELECT COUNT(*) FROM Hands WHERE game_id = excluded.game_id), first_at = MIN(COALESCE(first_at, excluded.first_at), excluded.first_at),
                    last_at = MAX(COALESCE(last_at, excluded.last_at), excluded.last_at), imported_at = excluded.imported_at`,
                [game_id, file_name, hero_id, hands.length, first, last, now]
            );
        });
        return { game_id, hands_in_file: hands.length, added, already_had: hands.length - added };
    }

    async games(): Promise<GameRow[]> {
        return this.db.all<GameRow>(`SELECT * FROM Games ORDER BY COALESCE(last_at, imported_at) DESC`);
    }

    /** Player id -> person id links (several PokerNow ids used by the same person). */
    async links(): Promise<Map<string, string>> {
        const rows = await this.db.all<{ player_id: string, person_id: string }>(`SELECT player_id, person_id FROM PlayerLinks`);
        return new Map(rows.map((r) => [r.player_id, r.person_id]));
    }

    async link(player_id: string, person_id: string, reason: string): Promise<void> {
        await this.db.run(`INSERT OR REPLACE INTO PlayerLinks (player_id, person_id, reason) VALUES (?, ?, ?)`, [player_id, person_id, reason]);
    }

    async unlink(player_id: string): Promise<void> {
        await this.db.run(`DELETE FROM PlayerLinks WHERE player_id = ?`, [player_id]);
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
        return this.db.all<HandRow>(`SELECT * FROM Hands ORDER BY COALESCE(started_at, recorded_at), hand_number`);
    }

    async decisions(): Promise<DecisionRow[]> {
        return this.db.all<DecisionRow>(`SELECT * FROM Decisions ORDER BY id`);
    }

    async setLabel(decision_id: number, label: string | null): Promise<void> {
        await this.db.run(`UPDATE Decisions SET label = ? WHERE id = ?`, [label, decision_id]);
    }
}
