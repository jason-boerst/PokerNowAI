// Local dashboard: import PokerNow logs and browse player metrics.
//   npm run dashboard   ->   http://localhost:4545
import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DBService } from "../services/db-service.ts";
import { HandRecorder } from "../services/hand-recorder.ts";
import { ME, ProfileService } from "../services/profile-service.ts";
import { importLog } from "../import/importer.ts";
import { PlayerProfile, RATE_KEYS, sessionDeviations } from "../engine/player-profile.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function summarize(p: PlayerProfile) {
    const rates: Record<string, { value: number, k: number, n: number }> = {};
    for (const key of RATE_KEYS) rates[key] = p[key];
    return {
        name: p.name, names: p.names, hands: p.hands, type: p.type, exploit: p.exploit,
        net_bb: p.net_bb, bb_per_100: p.bb_per_100, avg_bet_to_pot: p.avg_bet_to_pot, bets_seen: p.bets_seen,
        last_seen: p.last_seen, rates, vpip_by_position: p.vpip_by_position
    };
}

export async function startDashboard(port: number, db_file = "./app/pokernow-gpt.db"): Promise<void> {
    const db = new DBService(db_file);
    await db.init();
    await db.createTables();
    const recorder = new HandRecorder(db);
    const service = new ProfileService(recorder);
    let loaded_at = 0;
    let loading: Promise<void> | null = null;
    const fresh = async () => {
        // the bot may be adding live hands to the same database; reload at most every few seconds,
        // and let simultaneous requests share one reload
        if (Date.now() - loaded_at > 5000) {
            loading ??= service.load().then(() => { loaded_at = Date.now(); }).finally(() => { loading = null; });
        }
        if (loading) await loading;
    };
    // after a write: make sure the next read reloads (a reload already running may have missed it)
    const invalidate = async () => {
        if (loading) await loading.catch(() => {});
        loaded_at = 0;
    };

    const app = express();
    app.use(express.json({ limit: "100mb" }));

    app.get("/", (_req, res) => {
        res.type("html").send(readFileSync(path.join(here, "index.html"), "utf8"));
    });

    app.get("/favicon.ico", (_req, res) => { res.status(204).end(); });

    app.get("/api/summary", async (_req, res) => {
        await fresh();
        const games = await recorder.games();
        res.json({ games, hands: games.reduce((n, g) => n + (g.hands ?? 0), 0), players: service.everyone().length });
    });

    app.get("/api/players", async (_req, res) => {
        await fresh();
        const games = service.gameCounts();
        res.json(service.everyone().filter((e) => e.info.long).map((e) => ({
            key: e.key, is_me: e.key === ME, games: games.get(e.key) ?? 0, ...summarize(e.info.long!)
        })));
    });

    app.get("/api/games", async (_req, res) => {
        await fresh();
        res.json(await recorder.games());
    });

    // one game (e.g. the one being played live): each player's play in it vs every other game
    app.get("/api/games/:id", async (req, res) => {
        await fresh();
        const game = (await recorder.games()).find((g) => g.game_id === req.params.id);
        if (!game) {
            res.status(404).json({ error: "No such game." });
            return;
        }
        const players = service.gameView(game.game_id).map(({ key, info }) => ({
            key, is_me: key === ME,
            session: summarize(info.session!),
            usual: info.long ? summarize(info.long) : null,
            current: info.current ? summarize(info.current) : null,
            deviations: info.deviations.map((d) => d.text)
        })).sort((a, b) => b.session.hands - a.session.hands);
        res.json({ game, players });
    });

    app.get("/api/players/:key", async (req, res) => {
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
    });

    app.post("/api/import", async (req, res) => {
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
    });

    app.post("/api/link", async (req, res) => {
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
    });

    app.post("/api/unlink", async (req, res) => {
        await recorder.unlink(req.body?.id);
        await invalidate();
        res.json({ ok: true });
    });

    await new Promise<void>((resolve) => app.listen(port, "127.0.0.1", () => resolve()));
    console.log(`Dashboard running at http://localhost:${port}  (Ctrl+C to stop)`);
}
