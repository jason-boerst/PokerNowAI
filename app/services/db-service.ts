import { Database, open } from 'sqlite'
import sqlite3 from 'sqlite3';

export class DBService {
    private file_name: string;
    private db!: Database<sqlite3.Database, sqlite3.Statement>;

    constructor(file_name: string) {
        this.file_name = file_name;
    }

    async init(): Promise<void> {
        this.db = await open<sqlite3.Database, sqlite3.Statement>({
            filename: this.file_name,
            driver: sqlite3.Database
        })
    }
    
    async createTables(): Promise<void> {
        await this.createPlayerTable();
        await this.createHistoryTables();
    }

    /** Hand histories and the bot's decisions, used by export-hands, eval and stats. */
    async createHistoryTables(): Promise<void> {
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS Hands (
                game_id TEXT NOT NULL,
                hand_number INT NOT NULL,
                hand_id TEXT,
                hero_name TEXT,
                big_blind REAL,
                messages_json TEXT NOT NULL,
                hero_net REAL,
                recorded_at TEXT NOT NULL,
                PRIMARY KEY (game_id, hand_number)
            );
            CREATE TABLE IF NOT EXISTS Games (
                game_id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                file_name TEXT,
                hero_id TEXT,
                hands INT,
                first_at TEXT,
                last_at TEXT,
                imported_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS PlayerLinks (
                player_id TEXT PRIMARY KEY,
                person_id TEXT NOT NULL,
                reason TEXT
            );
            CREATE TABLE IF NOT EXISTS Decisions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id TEXT NOT NULL,
                hand_number INT,
                street TEXT,
                messages_json TEXT NOT NULL,
                hero_name TEXT,
                hero_cards TEXT,
                big_blind REAL,
                prompt TEXT,
                response TEXT,
                action_json TEXT,
                model TEXT,
                source TEXT,
                latency_ms INT,
                label TEXT,
                recorded_at TEXT NOT NULL
            );
        `);
        await this.addMissingColumns("Hands", { started_at: "TEXT", game_type: "TEXT", source: "TEXT", hero_id: "TEXT" });
        // what you actually did after each suggestion and what the hand earned (filled in once the hand is stored)
        await this.addMissingColumns("Decisions", { followed: "INT", actual_action: "TEXT", hand_net_bb: "REAL", adjusted_net_bb: "REAL" });
        await this.db.exec(`CREATE INDEX IF NOT EXISTS Decisions_hand ON Decisions (game_id, hand_number)`);
        // hands recorded live by versions before the Games table existed
        await this.db.exec(`
            INSERT OR IGNORE INTO Games (game_id, source, hands, first_at, last_at, imported_at)
            SELECT game_id, 'live', COUNT(*), MIN(COALESCE(started_at, recorded_at)), MAX(COALESCE(started_at, recorded_at)), MIN(recorded_at)
            FROM Hands GROUP BY game_id
        `);
    }

    /** Runs several statements atomically (much faster for bulk imports). */
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
        await this.db.exec("BEGIN");
        try {
            const result = await fn();
            await this.db.exec("COMMIT");
            return result;
        } catch (err) {
            await this.db.exec("ROLLBACK");
            throw err;
        }
    }

    /** Adds columns introduced after a table was first created (older databases). */
    private async addMissingColumns(table: string, columns: Record<string, string>): Promise<void> {
        const existing = new Set((await this.db.all<{ name: string }[]>(`PRAGMA table_info(${table})`)).map((c) => c.name));
        for (const [name, type] of Object.entries(columns)) {
            if (!existing.has(name)) await this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
        }
    }

    async run(sql: string, params: Array<any> = []): Promise<void> {
        await this.db.run(sql, params);
    }

    async all<T = any>(sql: string, params: Array<any> = []): Promise<T[]> {
        return await this.db.all<T[]>(sql, params);
    }
    
    async createPlayerTable(): Promise<void> {
        try {
            await this.db.exec(`
                CREATE TABLE IF NOT EXISTS PlayerStats (
                    name TEXT PRIMARY KEY NOT NULL,
                    total_hands INT NOT NULL,
                    walks INT NOT NULL,
                    vpip_hands INT NOT NULL,
                    vpip_stat REAL AS (vpip_hands / CAST((total_hands - walks) AS REAL)),
                    pfr_hands INT NOT NULL,
                    pfr_stat REAL AS (pfr_hands / CAST((total_hands - walks) AS REAL))
                );
            `);
        } catch (err) {
            console.log("Failed to create player table", err.message);
        }
    }
    
    async close(): Promise<void> {
        await this.db.close();
    }
    

    async query(sql: string, params: Array<any>): Promise<Array<string>> {
        var rows : string[] = [];
        await this.db.each(sql, params, (err: any, row: string) => {
            if (err) {
                throw new Error(err.message);
            }
            rows.push(row);
        });
        return rows;
    }
}

const db_service = new DBService("./app/pokernow-gpt.db");

export default db_service;