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