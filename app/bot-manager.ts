import dotenv from 'dotenv';

import { Bot } from './bot.ts'

import ai_config_json from './configs/ai-config.json' with { type: "json" };
import bot_config_json from './configs/bot-config.json' with { type: "json" };
import webdriver_config_json from './configs/webdriver-config.json' with { type: "json" };

import { DBService } from './services/db-service.ts';
import { LogService } from './services/log-service.ts';
import { PlayerService } from './services/player-service.ts';
import { PuppeteerService } from './services/puppeteer-service.ts';
import { HandRecorder } from './services/hand-recorder.ts';
import { ProfileService } from './services/profile-service.ts';
import { importFiles } from './import/importer.ts';
import { existsSync } from 'node:fs';
import { PRIORS } from './engine/player-profile.ts';
import { setActionWeights } from './engine/equity.ts';
import { setResponseTable } from './engine/postflop.ts';

const LOGS_FOLDER = 'logs';

import { BotConfig, WebDriverConfig } from './interfaces/config-interfaces.ts';
import { AIServiceFactory, resolveAIConfig } from './helpers/ai-service-factory.ts';
import { chooseModelIfNeeded } from './helpers/model-picker.ts';
import { ask } from './helpers/terminal.ts';
import { startLiveCommands } from './helpers/live-commands.ts';
import { BackgroundDashboard, dashboardPort, launchDashboard } from './dashboard/server.ts';

const bot_config: BotConfig = bot_config_json;
const webdriver_config: WebDriverConfig = webdriver_config_json;

const DB_FILE = "./app/pokernow-gpt.db";

/** Starts the player stats page next to the bot (in its own process), unless DASHBOARD_PORT=0. */
async function startStatsPage(): Promise<BackgroundDashboard | null> {
    const port = dashboardPort(process.env.DASHBOARD_PORT);
    if (port === 0) return null;
    if (port === null) {
        console.log(`Player stats page not started: DASHBOARD_PORT in .env should be a port number like 4545 (or 0 to turn it off).`);
        return null;
    }
    try {
        return await launchDashboard(port, DB_FILE);
    } catch (err) {
        console.log(`Player stats page could not start: ${err instanceof Error ? err.message : err}`);
        return null;
    }
}

async function init(): Promise<string> {
    if (bot_config.assistant_mode) {
        console.log("=================================================");
        console.log(" AI Assistant Mode");
        console.log(" The browser will open. Please:");
        console.log("   1. Click an empty seat [SIT]");
        console.log("   2. Enter your name and stack size, then submit");
        console.log("   3. Wait for the host to approve");
        console.log(" Once seated, AI monitors the game and shows a");
        console.log(" suggestion in the top-right on your turn.");
        console.log("=================================================\n");
    }
    // game ID can also be passed as `npm start -- <id or url>` or POKERNOW_GAME_ID in .env
    const input = process.argv[2] ?? process.env.POKERNOW_GAME_ID
        ?? await ask("Paste the PokerNow game link (or just the game ID) and press Enter: ");
    // accept a pasted full URL as well as the bare ID
    return input.trim().replace(/^.*\/games\//, "").split(/[?#/]/)[0];
}

const bot_manager = async function() {
    dotenv.config();

    // started first so it is ready by the time the game link is entered; the line saying where it is
    // comes after the questions below, so it never lands in the middle of one
    const stats_page = await startStatsPage();

    // choose the model and create the AI service first, so a missing key or bad provider
    // fails before the browser opens
    const ai_service_factory = new AIServiceFactory();
    const ai_config = await chooseModelIfNeeded(resolveAIConfig(ai_config_json));
    const ai_service = ai_service_factory.createAIService(ai_config);
    console.log(`Created AI service: ${ai_config.provider} ${ai_config.model_name} (effort: ${ai_config.effort ?? "model default"}) with playstyle: ${ai_config.playstyle}`);
    ai_service.init();

    const game_id = await init();
    if (stats_page) console.log(stats_page.status());

    const use_existing = webdriver_config.use_existing_browser ?? false;
    const debugging_port = webdriver_config.debugging_port ?? 9222;

    if (use_existing) {
        console.log(`\n[Connecting to existing Chrome on port ${debugging_port}]`);
        console.log(`  If Chrome is not running yet, start it first with:`);
        console.log(`  npm run chrome\n`);
    } else {
        if (bot_config.assistant_mode) {
            console.log("\nOpening browser. Please sit down manually in the browser window.\n");
        }
    }

    const headless = webdriver_config.headless_flag && !bot_config.assistant_mode;
    const puppeteer_service = new PuppeteerService(
        webdriver_config.default_timeout,
        headless,
        use_existing,
        debugging_port
    );
    await puppeteer_service.init();

    const db_service = new DBService(DB_FILE);
    await db_service.init();

    const player_service = new PlayerService(db_service);

    const log_service = new LogService(game_id, (path) => puppeteer_service.fetchInPage(path));
    await log_service.init();

    const recorder = new HandRecorder(db_service);
    const profiles = new ProfileService(recorder);
    // new PokerNow log exports dropped in the logs/ folder are imported automatically
    if (existsSync(LOGS_FOLDER)) {
        const summaries = await importFiles(recorder, [LOGS_FOLDER], () => undefined);
        const added = summaries.reduce((n, s) => n + s.added, 0);
        if (added > 0) console.log(`Imported ${added} new hand(s) from ${summaries.length} log file(s) in ${LOGS_FOLDER}/.`);
    }
    const loaded = await profiles.load(game_id);
    if (loaded > 0) {
        // read bets and raises the way players in your games actually showed them down
        setActionWeights(profiles.actionWeights().weights);
        // how players in your games answer leads, c-bets and barrels of each size
        setResponseTable(profiles.responseTable().table);
        const pct = (x: number) => `${Math.round(x * 100)}%`;
        console.log(`Loaded ${loaded} stored hand(s); hands from this game count as today's session.`);
        if (profiles.pool_hands > 0) {
            console.log(`Typical opponent in your games (used for players with little history): VPIP ${pct(PRIORS.vpip.mean)}, PFR ${pct(PRIORS.pfr.mean)}, ` +
                `3-bet ${pct(PRIORS.three_bet.mean)}, folds to a bet on the flop/turn/river ${pct(PRIORS.fold_to_bet_flop.mean)}/${pct(PRIORS.fold_to_bet_turn.mean)}/${pct(PRIORS.fold_to_bet_river.mean)}.`);
        }
    }
    const bot = new Bot(log_service, ai_service, player_service, puppeteer_service, game_id, bot_config.debug_mode, bot_config.query_retries, bot_config.assistant_mode, recorder, {
        preflop_engine: bot_config.preflop_engine ?? true,
        llm_timeout_ms: bot_config.llm_timeout_ms ?? 6000,
        always_ask_llm: (bot_config as { always_ask_llm?: boolean }).always_ask_llm ?? false,
        ai_mode: bot_config.ai_mode,
        decision_seconds: bot_config.decision_seconds ?? 15,
        stop_after_idle_ms: (bot_config.stop_after_idle_minutes ?? 10) * 60_000,
        stop_after_unseated_ms: (bot_config.stop_after_unseated_seconds ?? 60) * 1000,
        stop_after_short_table_ms: (bot_config.stop_after_short_table_minutes ?? 2) * 60_000,
        profiles
    });
    startLiveCommands(ai_service, ai_config);
    try {
        await bot.run();
    } finally {
        // stop the stats page, leave the user's Chrome open (only disconnect) and close the database
        stats_page?.stop();
        await puppeteer_service.closeBrowser().catch(() => undefined);
        await db_service.close().catch(() => undefined);
    }
}

export default bot_manager;