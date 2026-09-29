import type { Response } from '../utils/error-handling-utils.ts';
import { Data, Log } from '../interfaces/log-processing-interfaces.ts';

/** Fetches a same-origin path and returns the HTTP status and body text. */
export type PageFetcher = (path: string) => Promise<{ status: number, text: string }>;

export class LogService {
    private game_id: string;
    private page_fetch?: PageFetcher;

    /**
     * @param page_fetch fetches from inside the game tab (preferred: right domain, logged-in cookies).
     *                   Without it, logs are fetched directly from https://www.pokernow.com.
     */
    constructor(game_id: string, page_fetch?: PageFetcher) {
        this.game_id = game_id;
        this.page_fetch = page_fetch;
    }

    async init(): Promise<void> {
    }

    async closeBrowser(): Promise<void> {
        // Nothing to close.
    }

    async fetchData<D, E=Error>(before: string = "", after: string = ""): Response<D, E> {
        const path = `/games/${this.game_id}/log?before_at=${before}&after_at=${after}&mm=false&v=2`;
        try {
            let status: number;
            let text: string;
            if (this.page_fetch) {
                ({ status, text } = await this.page_fetch(path));
            } else {
                const res = await fetch(`https://www.pokernow.com${path}`, { headers: { "Accept": "application/json" } });
                status = res.status;
                text = await res.text();
            }
            if (status !== 200) {
                return {
                    code: "error",
                    error: new Error(`Log API returned status ${status}.`) as E
                }
            }
            let data: any;
            try {
                data = JSON.parse(text);
            } catch {
                return {
                    code: "error",
                    error: new Error(`Log API did not return JSON (starts with: ${JSON.stringify(text.slice(0, 80))}).`) as E
                }
            }
            if (!data || !Array.isArray(data.logs)) {
                return {
                    code: "error",
                    error: new Error(`Log API returned an unexpected format (keys: ${Object.keys(data ?? {}).join(", ") || "none"}).`) as E
                }
            }
            return {
                code: "success",
                data: data as D,
                msg: `Successfully got logs (${data.logs.length} entries).`
            }
        } catch (err) {
            return {
                code: "error",
                error: new Error(`Failed to fetch logs: ${err}`) as E
            }
        }
    }
    
    getData(log: any): Data {
        const data = log.data as Data;
        // ignore malformed entries rather than crashing on them
        return { logs: (data.logs ?? []).filter((entry) => entry && typeof entry.msg === "string") };
    }
    
    getMsg(data: Data): Array<string> {
        return data.logs.map((element) => element.msg);
    }
    
    getCreatedAt(data: Data): Array<string> {
        return data.logs.map((element) => element.created_at);
    }
    
    getLast(arr: Array<string>): string {
        return arr[arr.length - 1];
    }
    
    getFirst(arr: Array<string>): string {
        return arr[0];
    }
    
    pruneLogsBeforeCurrentHand(data: Data): Data {
        //starts from the top of logs (newest first) and keeps everything up to the start of the current hand
        const start = data.logs.findIndex((entry) => entry.msg.includes("starting hand #"));
        if (start === -1) {
            throw new Error(`Could not find the start of the current hand in the game log (no "starting hand #" among ${data.logs.length} entries). Run \`npm run diagnose\` and send the output.`);
        }
        const log_arr: Log[] = data.logs.slice(0, start + 1);
        return {
            logs: log_arr
        }
    }
}
