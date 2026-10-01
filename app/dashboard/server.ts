// Local dashboard: import PokerNow logs and browse player metrics.
//   npm run dashboard   ->   http://localhost:4545
//   npm start runs it too, in the background (see launchDashboard)
import express, { Request, Response } from "express";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DBService } from "../services/db-service.ts";
import { HandRecorder } from "../services/hand-recorder.ts";
import { ME, ProfileService } from "../services/profile-service.ts";
import { importLog } from "../import/importer.ts";
import { parseHand } from "../engine/hand-parser.ts";
import { leakReport } from "../eval/leaks.ts";
import { sameProfileCandidates, SameProfileCandidate } from "../engine/identity.ts";
import { learningStatus, LearningStatus, readHistory } from "../eval/learning-status.ts";
import { PlayerProfile, PRIORS, RATE_KEYS, sessionDeviations } from "../engine/player-profile.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DASHBOARD_PORT = 4545;
/** Exit code of scripts/dashboard.ts when its port is already taken. */
export const EXIT_PORT_IN_USE = 3;
/** Answered on /api/health, so a second start can tell the dashboard is already running. */
const APP_ID = "pokernow-gpt-dashboard";
/** A live game counts as in progress while its last hand is at most this old. */
const LIVE_WINDOW_MS = 30 * 60_000;

/** DASHBOARD_PORT as a port number (unset: 4545, 0: off), or null when it isn't a valid port. */
export function dashboardPort(value: string | undefined): number | null {
    if (value === undefined || value.trim() === "") return DEFAULT_DASHBOARD_PORT;
    const port = Number(value);
    return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}

/** Whether this dashboard is answering on the port (e.g. started from another terminal), for `db_file` if given. */
export async function isDashboardAt(port: number, db_file?: string): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
        const health = res.ok ? await res.json() : null;
        return health?.app === APP_ID && (db_file === undefined || health.db === path.resolve(db_file));
    } catch {
        return false;
    }
}

function summarize(p: PlayerProfile) {
    const rates: Record<string, { value: number, k: number, n: number }> = {};
    for (const key of RATE_KEYS) rates[key] = p[key];
    return {
        name: p.name, names: p.names, hands: p.hands, type: p.type, exploit: p.exploit,
        net_bb: p.net_bb, bb_per_100: p.bb_per_100, avg_bet_to_pot: p.avg_bet_to_pot, bets_seen: p.bets_seen,
        last_seen: p.last_seen, rates, vpip_by_position: p.vpip_by_position
    };
}

/** Express 4 does not catch errors in async handlers: answer with the error instead of crashing. */
function handle(fn: (req: Request, res: Response) => Promise<void>) {
    return (req: Request, res: Response) => {
        fn(req, res).catch((err) => {
            if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        });
    };
}

/** Starts the dashboard on 127.0.0.1 and returns the port it listens on. Rejects with code EADDRINUSE if the port is taken. */
export async function startDashboard(port: number, db_file = "./app/pokernow-gpt.db"): Promise<number> {
    const db = new DBService(db_file);
    await db.init();
    // the bot writes to the same file: wait for its writes instead of failing
    await db.run("PRAGMA busy_timeout = 10000");
    await db.createTables();
    const recorder = new HandRecorder(db);
    const service = new ProfileService(recorder);
    // re-read every hand only when the hands or player links changed (the bot adds hands during a
    // game; its many decision records don't matter here). A replaced hand gets a new rowid.
    const changeMarker = async () => {
        const [row] = await db.all<{ marker: string }>(
            `SELECT (SELECT COUNT(*) FROM Hands) || '/' || (SELECT IFNULL(MAX(rowid), 0) FROM Hands) || '/' ||
                    (SELECT IFNULL(group_concat(player_id || '>' || person_id), '') FROM (SELECT * FROM PlayerLinks ORDER BY player_id)) AS marker`);
        return row.marker;
    };
    let loaded_marker: string | null = null;
    // bumped on every reload, so per-game results can be cached until the data changes
    let generation = 0;
    let loading: Promise<void> | null = null;
    const fresh = async () => {
        if (!loading) {
            const marker = await changeMarker();
            // simultaneous requests share one reload
            if (marker !== loaded_marker) {
                loading ??= service.load().then(() => { loaded_marker = marker; generation++; }).finally(() => { loading = null; });
            }
        }
        if (loading) await loading;
    };
    // after a write from the page (import, link): make sure the next read reloads
    const invalidate = async () => {
        if (loading) await loading.catch(() => {});
        loaded_marker = null;
    };
    let game_views = { generation: -1, views: new Map<string, unknown[]>() };
    let leaks: { generation: number, report: ReturnType<typeof leakReport> } | null = null;
    let same_player: { generation: number, candidates: SameProfileCandidate[] } | null = null;
    let learning: { generation: number, status: LearningStatus } | null = null;

    const app = express();
    // only answer pages opened from this computer's own address (a web page can't point another name at it)
    app.use((req, res, next) => {
        if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host ?? "")) return next();
        res.status(403).json({ error: "Open this page at http://localhost." });
    });
    app.use(express.json({ limit: "100mb" }));

    app.get("/", (_req, res) => {
        res.type("html").send(readFileSync(path.join(here, "index.html"), "utf8"));
    });

    app.get("/favicon.ico", (_req, res) => { res.status(204).end(); });

    app.get("/api/health", (_req, res) => { res.json({ app: APP_ID, db: path.resolve(db_file) }); });

    app.get("/api/summary", handle(async (_req, res) => {
        await fresh();
        const games = await recorder.games();
        res.json({
            games, hands: games.reduce((n, g) => n + (g.hands ?? 0), 0), players: service.everyone().length,
            // what players with little history are assumed to do: your games' average (built-in guesses when empty)
            pool: { hands: service.pool_hands, rates: Object.fromEntries(RATE_KEYS.map((key) => [key, PRIORS[key].mean])) }
        });
    }));

    // the game being played right now, if any (cheap: no hands are read)
    app.get("/api/live", handle(async (_req, res) => {
        const cutoff = Date.now() - LIVE_WINDOW_MS;
        const live = (await recorder.games()).find((g) => g.source === "live" && g.last_at && Date.parse(g.last_at) >= cutoff);
        res.json(live ?? null);
    }));

    app.get("/api/players", handle(async (_req, res) => {
        await fresh();
        const games = service.gameCounts();
        res.json(service.everyone().filter((e) => e.info.long).map((e) => ({
            key: e.key, is_me: e.key === ME, games: games.get(e.key) ?? 0, ...summarize(e.info.long!)
        })));
    }));

    app.get("/api/games", handle(async (_req, res) => {
        await fresh();
        res.json(await recorder.games());
    }));

    // one game (e.g. the one being played live): each player's play in it vs every other game
    app.get("/api/games/:id", handle(async (req, res) => {
        await fresh();
        const game = (await recorder.games()).find((g) => g.game_id === req.params.id);
        if (!game) {
            res.status(404).json({ error: "No such game." });
            return;
        }
        if (game_views.generation !== generation) game_views = { generation, views: new Map() };
        // kept across the await below, so a reload meanwhile can't receive this (older) result
        const views = game_views.views;
        let players = views.get(game.game_id);
        if (!players) {
            // who was dealt into the game's last hand (still at the table, for a game in progress)
            const [last] = await db.all<{ messages_json: string, big_blind: number | null }>(
                `SELECT messages_json, big_blind FROM Hands WHERE game_id = ? ORDER BY hand_number DESC LIMIT 1`, [game.game_id]);
            const seated = new Set(last ? parseHand(JSON.parse(last.messages_json), { big_blind: last.big_blind ?? undefined }).seats.map(service.keyOf) : []);
            players = service.gameView(game.game_id).map(({ key, info }) => ({
                key, is_me: key === ME, seated: seated.has(key),
                session: summarize(info.session!),
                usual: info.long ? summarize(info.long) : null,
                current: info.current ? summarize(info.current) : null,
                deviations: info.deviations.map((d) => d.text)
            })).sort((a, b) => b.session.hands - a.session.hands);
            views.set(game.game_id, players);
        }
        res.json({ game, players });
    }));

    app.get("/api/players/:key", handle(async (req, res) => {
        await fresh();
        const e = service.everyone().find((x) => x.key === req.params.key);
        if (!e?.info.long) {
            res.status(404).json({ error: "No such player." });
            return;
        }
        const games = service.gamesOf(e.key);
        // how the most recent game compares with everything before it
        const latest = games[0];
        const before = latest && games.length > 1 ? service.profileExcludingGame(e.key, latest.game_id) : undefined;
        const links = await recorder.links();
        res.json({
            key: e.key, is_me: e.key === ME, ...summarize(e.info.long),
            ids: [...links.entries()].filter(([, person]) => person === e.key).map(([id]) => id),
            showdowns: e.info.long.showdowns,
            games: games.map((g) => ({ game_id: g.game_id, first_at: g.first_at, ...summarize(g.profile) })),
            latest_vs_usual: latest && before ? sessionDeviations(before, latest.profile).map((d) => d.text) : []
        });
    }));

    // how the bot's suggestions worked out, by where they came from (filled in by the results tracker)
    // how each suggestion source did, when you followed it vs when you didn't
    app.get("/api/results", handle(async (_req, res) => {
        res.json(await recorder.results());
    }));

    // where you lose money (no engine replay: fast enough for a page; `npm run leaks` adds the engine comparison)
    app.get("/api/leaks", handle(async (_req, res) => {
        await fresh();
        if (leaks?.generation !== generation) {
            const at = generation;
            const report = leakReport(await recorder.hands(), service);
            leaks = { generation: at, report };
        }
        res.json(leaks.report);
    }));

    // what has been learned from your hands, and the history `npm run learning` keeps (counts only)
    app.get("/api/learning", handle(async (_req, res) => {
        await fresh();
        if (learning?.generation !== generation) {
            const at = generation;
            learning = { generation: at, status: learningStatus(service, await recorder.decisions()) };
        }
        res.json({ ...learning.status, history: readHistory("reports/learning-history.jsonl") });
    }));

    // ids that are likely the same person (never at the same hand, same or similar name), for you to confirm
    app.get("/api/same-player", handle(async (_req, res) => {
        await fresh();
        if (same_player?.generation !== generation) {
            const at = generation;
            const hands = (await recorder.hands()).map((r) => ({ game_id: r.game_id, state: parseHand(JSON.parse(r.messages_json), { big_blind: r.big_blind ?? undefined }) }));
            same_player = { generation: at, candidates: sameProfileCandidates(hands, service.keyOf, (key) => service.info({ id: key, name: "" }).long) };
        }
        res.json(same_player.candidates);
    }));

    app.post("/api/import", handle(async (req, res) => {
        const files: { name: string, text: string }[] = req.body?.files ?? [];
        const results = [];
        for (const f of files) {
            try {
                results.push({ ok: true, ...(await importLog(recorder, f.name, f.text)) });
            } catch (err) {
                results.push({ ok: false, file_name: f.name, error: err instanceof Error ? err.message : String(err) });
            }
        }
        await invalidate();
        res.json(results);
    }));

    app.post("/api/link", handle(async (req, res) => {
        let { a, b } = req.body ?? {};
        // your own ids always stay under "me"
        if (b === ME) [a, b] = [b, a];
        if (!a || !b || a === b) {
            res.status(400).json({ error: "Pick two different players." });
            return;
        }
        // every id of person b joins person a
        const links = await recorder.links();
        const ids = [b, ...[...links.entries()].filter(([, person]) => person === b).map(([id]) => id)];
        for (const id of ids) await recorder.link(id, a, "linked in dashboard");
        if (!links.has(a) && a !== ME) await recorder.link(a, a, "linked in dashboard");
        await invalidate();
        res.json({ ok: true });
    }));

    app.post("/api/unlink", handle(async (req, res) => {
        await recorder.unlink(req.body?.id);
        await invalidate();
        res.json({ ok: true });
    }));

    const server = app.listen(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        server.once("listening", () => {
            server.off("error", reject);
            resolve();
        });
        server.once("error", reject);
    });
    server.on("error", (err) => console.error(`Dashboard server error: ${err.message}`));
    // read every stored hand now, so the first page opens quickly
    fresh().catch(() => undefined);
    return (server.address() as AddressInfo).port;
}

/** The dashboard running in the background for `npm start`. */
export interface BackgroundDashboard {
    /** The line to show in the terminal: the page's address, or why it is not running. Later failures are printed as they happen. */
    status(): string,
    /** True once the page is being served, false if it failed to start. */
    ready: Promise<boolean>,
    /** Stops the background process (also done automatically when this program exits). */
    stop(): void
}

/**
 * Runs the dashboard in a separate process, so re-reading every stored hand never holds up the bot
 * during a hand. Its normal output is hidden; only a failure is reported. If a dashboard is already
 * answering on the port (started from another terminal), that one is used.
 */
export async function launchDashboard(port: number, db_file: string): Promise<BackgroundDashboard> {
    const address = `http://localhost:${port}`;
    const already_running = `Player stats: already running at ${address} (open in your browser)`;
    if (await isDashboardAt(port, db_file)) return { status: () => already_running, ready: Promise.resolve(true), stop: () => undefined };

    let loader = "tsx";
    try {
        loader = import.meta.resolve("tsx");
    } catch {
        // resolved from the working folder instead
    }
    const child = spawn(process.execPath, ["--import", loader, path.join(here, "..", "..", "scripts", "dashboard.ts")], {
        env: { ...process.env, DB_FILE: path.resolve(db_file), DASHBOARD_PORT: String(port), DASHBOARD_BACKGROUND: "1" },
        stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    let problem: string | null = null;
    let shown = false;
    let stopped = false;
    let stderr = "";
    // the first problem wins; once the status line was shown, a problem is printed when it happens
    const report = (text: string) => {
        if (problem || stopped) return;
        problem = text;
        if (shown) console.log(text);
    };
    const ready = new Promise<boolean>((resolve) => {
        child.on("message", (msg) => { if ((msg as { ready?: number })?.ready) resolve(true); });
        child.on("error", (err) => {
            report(`Player stats page could not start: ${err.message}`);
            resolve(false);
        });
        child.on("exit", async (code) => {
            if (stopped) return resolve(false);
            if (code === EXIT_PORT_IN_USE) {
                // another dashboard may have started first; otherwise something else has the port
                report(await isDashboardAt(port, db_file) ? already_running
                    : `Player stats page did not start: port ${port} is already in use by another program. To use another port, add DASHBOARD_PORT=${port === 65535 ? 4546 : port + 1} to your .env file.`);
            } else {
                const reason = stderr.trim().split("\n").filter((line) => line.trim()).pop();
                report(`Player stats page stopped${reason ? ` (${reason.trim()})` : ""}. To open it again, run npm run dashboard in another Terminal window.`);
            }
            resolve(false);
        });
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    // never keep this program running just for the dashboard
    child.unref();
    child.channel?.unref();
    (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();

    const stop = () => {
        if (stopped) return;
        stopped = true;
        process.off("exit", stop);
        if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    // however this program ends (normal stop, Ctrl+C, an error), the dashboard goes with it;
    // if this program is killed outright, the dashboard notices the lost connection and exits itself
    process.once("exit", stop);
    return {
        status: () => {
            shown = true;
            return problem ?? `Player stats: ${address} (open in your browser)`;
        },
        ready,
        stop
    };
}
