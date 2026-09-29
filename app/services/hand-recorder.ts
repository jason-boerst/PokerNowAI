import { DBService } from "./db-service.ts";
import { netResult, parseHand } from "../engine/hand-parser.ts";
import { DecisionOutcome, DecisionToMatch, matchHandDecisions, OutcomeRow, OutcomeSummary, summarizeOutcomes } from "../engine/decision-outcomes.ts";
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
    recorded_at: string,
    /** Filled in once the hand is stored: 1 you followed the suggestion, 0 you didn't, null unknown or not counted. */
    followed: number | null,
    /** What you actually did, e.g. "raise 7.5"; "" when no action matched; null before matching (or while you can't be found in the hand). */
    actual_action: string | null,
    /** The hand's result for you in BB, and the same all-in adjusted. */
    hand_net_bb: number | null,
    adjusted_net_bb: number | null
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
            await this.matchDecisions(game_id, state.hand_number);
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
        // suggestions made while playing this game whose hands weren't recorded live
        await this.matchPendingDecisions(game_id);
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

    /**
     * Fills in, for each suggestion made in a stored hand, what you actually did (followed or not)
     * and what the hand earned. Safe to repeat. Failures are logged, never thrown.
     */
    async matchDecisions(game_id: string, hand_number: number): Promise<void> {
        await this.matchHands(`d.game_id = ? AND d.hand_number = ?`, [game_id, hand_number]);
    }

    /**
     * Matches suggestions whose hands are stored but that haven't been matched yet (older databases,
     * hands added by an import), optionally for one game. Returns the number of hands matched. Never throws.
     */
    async matchPendingDecisions(game_id?: string): Promise<number> {
        return this.matchHands(`d.actual_action IS NULL${game_id ? " AND d.game_id = ?" : ""}`, game_id ? [game_id] : []);
    }

    /**
     * Matches every suggestion of each stored hand that has a suggestion meeting `where` (on Decisions d).
     * Reads a batch of hands at a time and writes each batch's results in one statement, without
     * holding a transaction open (the bot may be writing to the same database).
     */
    private async matchHands(where: string, params: Array<any>): Promise<number> {
        const BATCH = 200;
        let matched = 0;
        try {
            const keys = await this.db.all<{ game_id: string, hand_number: number }>(
                `SELECT DISTINCT d.game_id, d.hand_number FROM Decisions d JOIN Hands h ON h.game_id = d.game_id AND h.hand_number = d.hand_number WHERE ${where}`,
                params
            );
            if (keys.length === 0) return 0;
            // your ids, in case the bot's name isn't in a hand's log (a changed display name)
            const my_ids = new Set((await this.db.all<{ player_id: string }>(`SELECT player_id FROM PlayerLinks WHERE person_id = ?`, [ME])).map((r) => r.player_id));
            for (let i = 0; i < keys.length; i += BATCH) {
                const batch = keys.slice(i, i + BATCH);
                const in_batch = `(VALUES ${batch.map(() => "(?, ?)").join(", ")}) AS k`;
                const key_params = batch.flatMap((k) => [k.game_id, k.hand_number]);
                const hands = await this.db.all<Pick<HandRow, "game_id" | "hand_number" | "messages_json" | "hero_name" | "hero_id" | "big_blind">>(
                    `SELECT h.game_id, h.hand_number, h.messages_json, h.hero_name, h.hero_id, h.big_blind
                     FROM Hands h JOIN ${in_batch} ON h.game_id = k.column1 AND h.hand_number = k.column2`, key_params
                );
                const decisions = await this.db.all<DecisionToMatch & { game_id: string, hand_number: number, hero_name: string | null }>(
                    `SELECT d.id, d.game_id, d.hand_number, d.street, d.action_json, d.messages_json, d.hero_cards, d.hero_name
                     FROM Decisions d JOIN ${in_batch} ON d.game_id = k.column1 AND d.hand_number = k.column2 ORDER BY d.id`, key_params
                );
                const by_hand = new Map<string, typeof decisions>();
                for (const d of decisions) {
                    const key = `${d.game_id}#${d.hand_number}`;
                    by_hand.set(key, [...(by_hand.get(key) ?? []), d]);
                }
                const outcomes: DecisionOutcome[] = [];
                for (const h of hands) {
                    const ds = by_hand.get(`${h.game_id}#${h.hand_number}`) ?? [];
                    try {
                        const hero = { id: h.hero_id, ids: my_ids, name: ds[0]?.hero_name ?? h.hero_name };
                        outcomes.push(...matchHandDecisions(JSON.parse(h.messages_json), ds, hero, h.big_blind));
                        matched++;
                    } catch (err) {
                        console.log(`Could not match the suggestions of hand #${h.hand_number}:`, err instanceof Error ? err.message : err);
                    }
                }
                await this.saveOutcomes(outcomes);
            }
        } catch (err) {
            console.log("Could not match suggestions to hands:", err instanceof Error ? err.message : err);
        }
        return matched;
    }

    private async saveOutcomes(outcomes: DecisionOutcome[]): Promise<void> {
        const BATCH = 150;
        for (let i = 0; i < outcomes.length; i += BATCH) {
            const batch = outcomes.slice(i, i + BATCH);
            await this.db.run(
                `UPDATE Decisions SET followed = v.column2, actual_action = v.column3, hand_net_bb = v.column4, adjusted_net_bb = v.column5
                 FROM (VALUES ${batch.map(() => "(?, ?, ?, ?, ?)").join(", ")}) AS v WHERE Decisions.id = v.column1`,
                batch.flatMap((o) => [o.id, o.followed, o.actual_action, o.hand_net_bb, o.adjusted_net_bb])
            );
        }
    }

    /** Every suggestion with its outcome, light enough to summarize often (see summarizeOutcomes). */
    async outcomeRows(): Promise<OutcomeRow[]> {
        return this.db.all<OutcomeRow>(
            `SELECT game_id, hand_number, model, source, substr(prompt, 1, 40) AS prompt, followed, hand_net_bb, adjusted_net_bb FROM Decisions ORDER BY id`
        );
    }

    /** Follow rate and results by suggestion source, after matching any suggestions not matched yet. */
    async results(): Promise<OutcomeSummary> {
        await this.matchPendingDecisions();
        return summarizeOutcomes(await this.outcomeRows());
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
