
import { sleep } from './helpers/bot-helper.ts';
import { ask } from './helpers/terminal.ts';
import { BotStopped } from './helpers/stop.ts';
import { OverlayContent, postflopOverlay, preflopOverlay } from './helpers/overlay-builder.ts';
import { PanelModel, toneFor } from './ui/panel-model.ts';
import { HandState, HeroView, heroView, parseCards, parseHand } from './engine/hand-parser.ts';
import { HandRecorder } from './services/hand-recorder.ts';
import { formatSpot } from './engine/spot-format.ts';
import { equity } from './engine/equity.ts';
import { requiredEquity } from './engine/odds.ts';
import { ObservedStats, opponentModels, TABLE_RULES } from './engine/opponent-range.ts';
import { bountyFromHands, describeRules, GameRules, mergeRules } from './engine/game-rules.ts';
import { preflopAdvice } from './engine/preflop.ts';
import { describeProfile, isHoldem, PlayerRef } from './engine/player-profile.ts';
import { decidePostflop, Decision, opponentTendencies } from './helpers/decision-maker.ts';
import { PlayerLookup, ProfileService } from './services/profile-service.ts';
import { rangePercent } from './engine/ranges.ts';
import { GameInfo, parseGameInfo } from './utils/game-info-utils.ts';

import { AIMessage, AIService, BotAction, defaultCheckAction, defaultFoldAction } from './interfaces/ai-client-interfaces.ts';
import { ProcessedLogs } from './interfaces/log-processing-interfaces.ts';

import { Game } from './models/game.ts';
import { Table } from './models/table.ts';

import { LogService } from './services/log-service.ts';
import { PlayerService } from './services/player-service.ts';
import { PuppeteerService } from './services/puppeteer-service.ts';

import { constructQuery } from './helpers/construct-query-helper.ts';

import { DebugMode, logResponse } from './utils/error-handling-utils.ts';
import { postProcessLogs, postProcessLogsAfterHand, preProcessLogs } from './utils/log-processing-utils.ts';
import { getIdToInitialStackFromMsg, getIdToNameFromMsg, getIdToTableSeatFromMsg, getNameToIdFromMsg, getPlayerStacksMsg, getTableSeatToIdFromMsg, validateAllMsg } from './utils/message-processing-utils.ts';
import { convertToBBs, convertToValue } from './utils/value-conversion-utils.ts'

export interface BotOptions {
    /** Use the rule-based preflop engine instead of the AI for preflop decisions. */
    preflop_engine: boolean,
    /** Post-flop: give up on the AI after this long and use the engine's pick. */
    llm_timeout_ms: number,
    /** Post-flop: ask the AI even when the engine's best option is clearly ahead (legacy; see ai_mode). */
    always_ask_llm: boolean,
    /** "close_spots" (default), "off" or "always". */
    ai_mode?: string,
    /** The game's action clock in seconds when the log doesn't say (the AI must answer well inside it). */
    decision_seconds: number,
    /** Opponent profiles from recorded hand histories. */
    profiles?: ProfileService,
    /** Stop after this long with no hand activity (turns, hands finishing). */
    stop_after_idle_ms: number,
    /** Stop after being unseated this long. */
    stop_after_unseated_ms: number,
    /** Stop after fewer than 2 players have been at the table this long. */
    stop_after_short_table_ms: number
}

export class Bot {
    private log_service: LogService;
    private ai_service: AIService;
    private player_service: PlayerService;
    private puppeteer_service: PuppeteerService;

    private game_id: string;
    private debug_mode: DebugMode;
    private query_retries: number;
    private assistant_mode: boolean;

    private first_created: string;
    private recorder?: HandRecorder;
    private options: BotOptions;
    /** Current hand's log lines at the latest decision point (for recording and the hand state). */
    private current_hand_messages: string[] = [];
    /** True when the blinds were typed in because the page text could not be parsed. */
    private manual_blinds: boolean = false;
    private hand_history: AIMessage[];
    /** House rules read from the game log and stored hands (clock, 7-2 bounty, antes...). */
    private rules: GameRules = {};
    private rules_described = "";
    /** When the current turn started (the AI's time budget counts from here). */
    private turn_started_at = 0;
    private hands_since_rules_check = 0;

    private table!: Table;
    private game!: Game;
    private bot_name!: string;

    constructor(log_service: LogService, 
                ai_service: AIService,
                player_service: PlayerService,
                puppeteer_service: PuppeteerService,
                game_id: string,
                debug_mode: DebugMode,
                query_retries: number,
                assistant_mode: boolean = false,
                recorder?: HandRecorder,
                options: Partial<BotOptions> = {}) 
    {
        this.recorder = recorder;
        this.options = {
            preflop_engine: true, llm_timeout_ms: 6000, always_ask_llm: false, decision_seconds: 15,
            stop_after_idle_ms: 10 * 60_000, stop_after_unseated_ms: 60_000, stop_after_short_table_ms: 2 * 60_000,
            ...options
        };
        this.log_service = log_service;
        this.ai_service = ai_service;
        this.player_service = player_service;
        this.puppeteer_service = puppeteer_service;

        this.game_id = game_id;
        this.debug_mode = debug_mode;
        this.query_retries = query_retries;
        this.assistant_mode = assistant_mode;

        this.first_created = "";
        this.hand_history = [];
    }

    public async run() {
        await this.openGame();
        // in the background: the log can be long and the clock setting is near its start
        void this.loadGameRules();
        if (this.assistant_mode) {
            await this.waitForUserToSit();
        } else {
            await this.enterTableInProgress();
        }
        // retrieve initial num players
        await this.updateNumPlayers();
        this.markActivity();
        // runs until a stop condition throws BotStopped (tab closed, unseated, table broken, idle)
        while (true) {
            await this.checkStop();
            await this.waitForNextHand();
            await this.updateNumPlayers();
            await this.updateGameInfo();
            console.log("Number of players in game:", this.table.getNumPlayers());
            this.table.setPlayersInPot(this.table.getNumPlayers());
            await this.playOneHand();
            this.hand_history = [];
            this.table.nextHand();
        }
    }

    private async openGame() {
        console.log(`The PokerNow game with id: ${this.game_id} will now open.`);
        
        logResponse(await this.puppeteer_service.navigateToGame(this.game_id), this.debug_mode);
        console.log("Waiting for the table to load...");
        const wait_res = await this.puppeteer_service.waitForGameInfo();
        if (wait_res.code === "error") {
            throw wait_res.error;
        }

        console.log("Getting game info.");
        const res = await this.puppeteer_service.getGameInfo();
        logResponse(res, this.debug_mode);
        const blinds_text = res.code === "success" ? res.data as string : null;
        let game_info = this.puppeteer_service.convertGameInfo(blinds_text ?? "");
        if (game_info) {
            console.log(`Game: ${game_info.game_type}, blinds ${game_info.small_blind} / ${game_info.big_blind}`);
        } else {
            game_info = await this.askForBlinds(blinds_text);
        }
        this.table = new Table(this.player_service);
        this.game = new Game(this.game_id, this.table, game_info.big_blind, game_info.small_blind, game_info.game_type, 30);
    }

    /** Fallback when the blinds shown on the page can't be parsed (e.g. PokerNow changed the format). */
    private async askForBlinds(blinds_text: string | null): Promise<GameInfo> {
        console.log(`\nCould not read the blinds from the page (text found: ${JSON.stringify(blinds_text)}).`);
        console.log("Please send that text to whoever maintains this bot so the parser can be fixed.");
        while (true) {
            const answer = await ask("Enter the small and big blind, e.g. 10/20: ");
            const parsed = parseGameInfo(answer);
            if (parsed) {
                this.manual_blinds = true;
                return parsed;
            }
            console.log("Please enter two numbers separated by a slash, e.g. 10/20.");
        }
    }

    private async enterTableInProgress() {
        while (true) {
            const name = await ask("What is your desired player name? ");
            console.log(`Your player name will be ${name}.` )
            this.bot_name = name;
    
            const stack_size = await ask("What is your desired stack size? ");
            console.log(`Your initial stack size will be ${stack_size}.`)
    
            console.log(`Attempting to enter table with name: ${name} and stack size: ${stack_size}.`);
            const code = logResponse(await this.puppeteer_service.sendEnterTableRequest(name, Number(stack_size)), this.debug_mode);
    
            if (code === "success") {
                break;
            }
            console.log("Please try again.");
        }
        console.log("Waiting for table host to accept ingress request.");
        logResponse(await this.puppeteer_service.waitForTableEntry(), this.debug_mode);
    }

    /**
     * Assistant mode: wait for the user to manually sit down in the browser,
     * then read the player name from the page.
     */
    private async waitForUserToSit() {
        // Wait until .you-player appears (host accepted, user is seated), reminding every 30s
        let res = await this.puppeteer_service.waitForTableEntry(1000);
        if (res.code === "success") {
            console.log("\n[Assistant Mode] You are already seated.");
        } else {
            console.log("\n[Assistant Mode] Table loaded. In the Chrome window: click an empty seat, enter your name and stack size, and submit.");
            console.log("[Assistant Mode] Waiting for the host to approve you. The AI starts once you are seated...\n");
            while ((res = await this.puppeteer_service.waitForTableEntry(30000)).code !== "success") {
                const closed = this.puppeteer_service.stopReason();
                if (closed) throw new BotStopped(closed);
                console.log("[Assistant Mode] Still waiting for you to be seated at the table (take a seat and wait for the host to approve).");
            }
            console.log("[Assistant Mode] You are seated.");
        }

        // Read the player name that the user typed
        const nameRes = await this.puppeteer_service.getYouPlayerName();
        if (nameRes.code === "success" && nameRes.data) {
            this.bot_name = (nameRes.data as string).trim();
            console.log(`[Assistant Mode] Detected player name: ${this.bot_name}`);
        } else {
            // Fallback: ask in terminal
            this.bot_name = await ask("Could not detect your player name, please enter it manually: ");
        }
    }

    private async updateNumPlayers() {
        const res = await this.puppeteer_service.getNumPlayers();
        if (res.code === "success") {
            this.table.setNumPlayers(Number(res.data));
        }
    }

    private async waitForNextHand() {
        console.log("Waiting for the next hand to start. Suggestions appear in the top-right of the table on your turn.")
        while (await this.puppeteer_service.isWaitingForNextHand()) {
            await this.checkStop();
            await sleep(2000);
        }
        this.markActivity();
    }

    // ---- stop conditions -------------------------------------------------------------------

    private last_activity = Date.now();
    private unseated_since: number | null = null;
    private short_table_since: number | null = null;

    private markActivity(): void {
        this.last_activity = Date.now();
    }

    /** Throws BotStopped when the game can't or shouldn't be followed any more. */
    private async checkStop(): Promise<void> {
        const closed = this.puppeteer_service.stopReason();
        if (closed) throw new BotStopped(closed);
        const now = Date.now();

        if (await this.puppeteer_service.isSeated()) {
            this.unseated_since = null;
        } else {
            this.unseated_since ??= now;
            if (now - this.unseated_since >= this.options.stop_after_unseated_ms) {
                throw new BotStopped(`You haven't been seated at the table for ${Math.round((now - this.unseated_since) / 1000)} seconds.`);
            }
        }
        const players = await this.puppeteer_service.countPlayers();
        if (players !== null && players < 2) {
            this.short_table_since ??= now;
            if (now - this.short_table_since >= this.options.stop_after_short_table_ms) {
                throw new BotStopped(`Fewer than 2 players have been at the table for ${Math.round((now - this.short_table_since) / 60000)} minute(s); the table looks broken.`);
            }
        } else {
            this.short_table_since = null;
        }
        if (now - this.last_activity >= this.options.stop_after_idle_ms) {
            throw new BotStopped(`No hand activity for ${Math.round((now - this.last_activity) / 60000)} minutes; the game looks finished or paused.`);
        }
        // re-check the tab after the page reads above (they fail fast once it's gone)
        const closed_now = this.puppeteer_service.stopReason();
        if (closed_now) throw new BotStopped(closed_now);
    }

    /** Waits for hero's turn or the end of the hand, in short chunks so stop conditions are noticed. */
    private async waitForTurnOrWinner(): Promise<string> {
        console.log("Checking for bot's turn or winner of hand.");
        while (true) {
            await this.checkStop();
            const res = await this.puppeteer_service.waitForBotTurnOrWinner(this.table.getNumPlayers(), this.game.getMaxTurnLength(), 10_000);
            if (res.code === "success") {
                this.markActivity();
                return res.data as string;
            }
        }
    }

    /** Waits until hero has acted (the turn signal disappears), however long that takes. */
    private async waitForTurnEnd(): Promise<void> {
        console.log("Waiting for bot's turn to end");
        while ((await this.puppeteer_service.waitForBotTurnEnd(10_000)).code !== "success") {
            await this.checkStop();
        }
        this.markActivity();
    }

    // pull logs
    // wait for any player action to start
    // check if it is the player's turn -> perform actions
    // check if there is a winner -> perform end of hand actions
    private async playOneHand() {
        let processed_logs = {
            valid_msgs: new Array<Array<string>>,
            last_created: this.first_created,
            first_fetch: true
        }
        while (true) {
            var res;
            // wait for the bot's turn -> perform actions
            // OR winner is detected -> pull all the logs
            const data = await this.waitForTurnOrWinner();
            {
                if (data.includes("action-signal")) {
                    this.turn_started_at = Date.now();
                    console.log("Performing bot's turn.");
                    if (this.assistant_mode) {
                        await this.puppeteer_service.showOverlayStatus("Your turn · analyzing…", "…").catch(() => undefined);
                    }

                    // fetch logs, hand, pot and stack concurrently to minimise latency
                    const [logsResult, pot_size, hand, stack_size, hand_messages] = await Promise.all([
                        (async () => {
                            try {
                                await sleep(500);
                                return await this.pullAndProcessLogs(processed_logs.last_created, processed_logs.first_fetch);
                            } catch (err) {
                                console.log("Failed to pull logs:", err instanceof Error ? err.message : err);
                                return processed_logs;
                            }
                        })(),
                        this.getPotSize(),
                        this.getHand(),
                        this.getStackSize(),
                        this.log_service.fetchCurrentHand().catch((err) => {
                            console.log("Could not read the full hand history:", err instanceof Error ? err.message : err);
                            return [] as string[];
                        }),
                    ]);
                    processed_logs = logsResult;
                    this.current_hand_messages = hand_messages;
                    const hand_state = hand_messages.length > 0 ? await this.buildValidatedState(hand_messages, hand) : null;

                    this.table.setPot(convertToBBs(pot_size, this.game.getBigBlind()));

                    // If logs never succeeded (first_fetch still true), the name→id map is
                    // not yet populated so updateHero and constructQuery would both crash.
                    // Skip everything AI-related and wait for the next turn.
                    // preflop: deterministic engine, no AI call (null if disabled or the spot isn't covered)
                    const engine_action = this.preflopEngineAction(hand_state);
                    const postflop_view = hand_state && hand_state.street !== "preflop" && hand_state.hero_cards.length === 2 ? heroView(hand_state) : null;
                    if (processed_logs.first_fetch && !engine_action && !postflop_view) {
                        console.log("Skipping AI query: logs not yet available, waiting for next turn.");
                    } else {
                        if (!processed_logs.first_fetch) {
                            // keep the legacy table state (used by the AI prompt) in sync every turn
                            await this.updateHero(hand, convertToBBs(stack_size, this.game.getBigBlind()));
                            await postProcessLogs(this.table.getLogsQueue(), this.game);
                        }
                        try {
                            const started = Date.now();
                            let bot_action: BotAction;
                            let query = "";
                            let response: string | undefined;
                            let source: string = "llm";
                            if (engine_action) {
                                bot_action = engine_action;
                                source = "engine";
                            } else if (hand_state && postflop_view) {
                                const d = await this.postflopDecision(hand_state, postflop_view);
                                bot_action = { action_str: d.action, bet_size_in_BBs: d.size_bb, reason: d.reason };
                                query = d.prompt;
                                response = d.response;
                                source = d.source;
                            } else {
                                // fallback when the full hand state isn't available: the original prompt
                                query = constructQuery(this.game);
                                bot_action = await this.queryBotAction(query, this.query_retries);
                            }
                            const latency_ms = Date.now() - started;
                            this.table.resetPlayerActions();
                            if (this.assistant_mode) {
                                // the engine only models Hold'em; other games (e.g. Omaha in a mixed game) get the AI alone
                                const other_game = hand_state && !isHoldem(hand_state) ? hand_state.game_type : null;
                                const overlay: OverlayContent = this.overlay_content ?? {
                                    status: "final",
                                    header: `AI (${this.ai_service.getModelName()}) · basic prompt (${other_game ? `${other_game}: no engine` : "full hand state unavailable"})`,
                                    context: "", action: bot_action.action_str, size_bb: bot_action.bet_size_in_BBs,
                                    big_blind: this.game.getBigBlind(), sections: [],
                                    warnings: [other_game
                                        ? `This hand is ${other_game}. The equity engine, preflop charts and opponent stats are Hold'em only, so this is the AI's opinion without any math. Treat it with caution.`
                                        : "The full hand history couldn't be read, so this used the basic prompt without the engine."],
                                    reason: bot_action.reason ?? ""
                                };
                                this.overlay_content = null;
                                if (this.state_warning) overlay.warnings.unshift(this.state_warning);
                                await this.puppeteer_service.injectSuggestion(panelFromOverlay({
                                    ...overlay,
                                    action: bot_action.action_str,
                                    size_bb: bot_action.bet_size_in_BBs,
                                    reason: bot_action.reason ?? overlay.reason
                                }));
                                console.log("Suggestion shown in top-right. Please act in the browser.");
                            } else {
                                await this.performBotAction(bot_action);
                            }
                            await this.recordDecision(hand_state, hand, query, bot_action, latency_ms, source, response);
                        } catch (err) {
                            console.log("Failed to query and perform bot action:", err instanceof Error ? err.message : err);
                        }
                    }

                    await this.waitForTurnEnd();
                    if (this.assistant_mode) {
                        await this.puppeteer_service.dimSuggestion().catch(() => undefined);
                    }
                } else if (data.includes("winner")) {
                    console.log("Detected winner in hand.")
                    break;
                }
            }
        }

        res = await this.puppeteer_service.getStackSize();
        logResponse(res, this.debug_mode);
        if (res.code === "success") {
            console.log("Ending stack size:", res.data);
        }

        try {
            //TODO: when running multiple bots, ensure that only one bot is trying to process players at end of hand
            //only one bot should have the magic hat at any given time
            //pulling logs fails when multiple bots try to pull the logs at the same time
            processed_logs = await this.pullAndProcessLogs(this.first_created, processed_logs.first_fetch);
            await postProcessLogsAfterHand(processed_logs.valid_msgs, this.game);
            await this.table.processPlayers();
        } catch (err) {
            console.log("Failed to process players:", err instanceof Error ? err.message : err);
        }
        
        logResponse(await this.puppeteer_service.waitForHandEnd(), this.debug_mode);
        await this.recordCompletedHand();
        console.log("Completed a hand.\n");
    }

    /** Set when the hand log still disagrees with the table after re-reading; shown in the overlay. */
    private state_warning: string | null = null;

    private parseState(messages: string[], dom_hand: string[]): HandState {
        return parseHand(messages, { hero_name: this.bot_name, hero_cards: parseCards(dom_hand.join(" ")), big_blind: this.game.getBigBlind() });
    }

    /**
     * The turn signal can appear before the opponent's last bet reaches the game log. Cross-check
     * the parsed state against the action buttons on the table (a Call button means there's a bet
     * to call) and re-read the log a few times if they disagree.
     */
    private async buildValidatedState(messages: string[], dom_hand: string[]): Promise<HandState | null> {
        this.state_warning = null;
        try {
            let state = this.parseState(messages, dom_hand);
            for (let attempt = 0; attempt < 4; attempt++) {
                const view = heroView(state);
                const buttons = await this.puppeteer_service.actionButtons();
                const facing_bet_on_table = buttons.call && !buttons.check;
                const nothing_to_call_on_table = buttons.check && !buttons.call;
                const mismatch = view !== null && ((facing_bet_on_table && view.to_call <= 0) || (nothing_to_call_on_table && view.to_call > 0));
                if (!mismatch) break;
                if (attempt === 3) {
                    this.state_warning = "The game log may be behind the table: check the pot and amount to call yourself.";
                    console.log(`[State] ${this.state_warning}`);
                    break;
                }
                await sleep(400);
                const fresh = await this.log_service.fetchCurrentHand();
                this.current_hand_messages = fresh;
                state = this.parseState(fresh, dom_hand);
            }
            return this.announceState(state);
        } catch (err) {
            console.log("[State] Could not build the hand state:", err instanceof Error ? err.message : err);
            return null;
        }
    }

    /** Prints a one-line summary of hero's spot (plus opponents and preflop equity). */
    private announceState(state: HandState): HandState | null {
        try {
            const view = heroView(state);
            if (!view) {
                console.log(`[State] Could not find "${this.bot_name}" among the players in the hand log.`);
                return state;
            }
            console.log(`[State] ${formatSpot(state, view)}`);
            this.printOpponents(state);
            if (state.street === "preflop") this.printEquity(state, view);
            if (state.unparsed.length > 0) {
                console.log(`[State] ${state.unparsed.length} log line(s) not understood, e.g. ${JSON.stringify(state.unparsed[0])}`);
            }
            return state;
        } catch (err) {
            console.log("[State] Could not build the hand state:", err instanceof Error ? err.message : err);
            return null;
        }
    }

    private described_hand: number | null = null;
    /** Overlay content for the current decision, set by whichever path made it. */
    private overlay_content: OverlayContent | null = null;
    /** Latest preflop equity estimate, for the overlay. */
    private last_equity: { equity: number, need: number } | null = null;

    /** Prints each opponent's profile once per hand. */
    private printOpponents(state: HandState): void {
        if (!this.options.profiles || state.hand_number === this.described_hand) return;
        this.described_hand = state.hand_number;
        for (const seat of state.seats) {
            if (seat.id === state.hero_id) continue;
            const info = this.options.profiles.info(seat);
            const p = info.current;
            console.log(`[Opponent] ${seat.position} ${p ? `${describeProfile(p)}. ${p.exploit}` : `${seat.name}: no history yet`}`);
            for (const d of info.deviations) console.log(`[Opponent]    ${seat.name} today: ${d.text}`);
        }
    }

    /** Estimates hero's equity against each remaining opponent's likely range and prints it. */
    private printEquity(state: HandState, view: HeroView): void {
        this.last_equity = null;
        if (state.hero_cards.length !== 2 || view.active_opponents.length === 0) return;
        try {
            const models = opponentModels(state, (player) => this.statsLookup(player));
            const result = equity({ hero: state.hero_cards, board: state.board, opponents: models.map((m) => m.model), time_budget_ms: 150 });
            // Preflop, pot odds only matter when facing a raise; completing a blind or opening is a
            // range decision (position, playability, later streets), so "need X%" would mislead there.
            const facing_raise = state.street !== "preflop" || state.actions.some((a) => a.street === "preflop" && (a.type === "raise" || a.type === "bet"));
            const need_value = facing_raise && view.to_call > 0 ? requiredEquity(view.to_call, view.pot) : 0;
            const need = need_value > 0 ? ` (need ${Math.round(need_value * 100)}% to call)` : "";
            const ranges = models.map((m) => `${m.seat.position} ~${Math.round(rangePercent(m.model.range))}% of hands`).join(", ");
            console.log(`[Engine] equity ${Math.round(result.equity * 100)}%${need} vs their likely hands: ${ranges}`);
            this.last_equity = { equity: result.equity, need: need_value };
        } catch (err) {
            console.log("[Engine] Could not estimate equity:", err instanceof Error ? err.message : err);
        }
    }

    /** Post-flop decision: engine analysis, the AI for close spots, validated with an engine fallback. */
    private async postflopDecision(state: HandState, view: HeroView): Promise<Decision> {
        const players = this.playerLookup();
        const opponents = opponentTendencies(state, (player) => this.statsLookup(player), players);
        const notes = this.tableNotes();
        const inputs = { state, view, players, stats: (player: PlayerRef) => this.statsLookup(player), notes };
        const d = await decidePostflop(state, view, this.ai_service, opponents, players, {
            llm_timeout_ms: this.options.llm_timeout_ms,
            always_ask_llm: this.options.always_ask_llm,
            ai_mode: this.options.ai_mode,
            decision_seconds: this.rules.decision_seconds ?? this.options.decision_seconds,
            turn_started_at: this.turn_started_at || undefined,
            notes,
            // close spot: show the engine's pick right away while the AI thinks
            on_asking_llm: async (analysis, budget_ms) => {
                if (!this.assistant_mode) return;
                const provisional = postflopOverlay(inputs, analysis, null, this.ai_service.getModelName(), budget_ms);
                if (this.state_warning) provisional.warnings.unshift(this.state_warning);
                await this.puppeteer_service.injectSuggestion(panelFromOverlay(provisional)).catch(() => undefined);
            }
        });
        const a = d.analysis;
        const bb = state.big_blind;
        console.log(`[Engine] equity ${Math.round(a.equity * 100)}% (${Math.round(a.equity_when_called * 100)}% when called)` +
            `${a.required_equity > 0 ? `, need ${Math.round(a.required_equity * 100)}%` : ""} | ` +
            a.candidates.map((c) => `${c.label} ${(c.ev / bb >= 0 ? "+" : "")}${(c.ev / bb).toFixed(1)}`).join(", "));
        const who = d.source === "llm" ? `AI (${this.ai_service.getModelName()}, confidence ${Math.round(d.confidence * 100)}%)`
            : d.source === "engine-fallback" ? "engine (AI fallback)"
            : d.ai_skipped === "off" ? "engine (close spot, AI off)"
            : d.ai_skipped === "time" ? "engine (close spot, no time for the AI)"
            : "engine (clear spot)";
        const size = d.size_bb > 0 ? ` ${d.size_bb} BB` : "";
        console.log(`[Decision] ${who}: ${d.action.toUpperCase()}${size}. ${d.reason}`);

        this.overlay_content = postflopOverlay(inputs, a, d, this.ai_service.getModelName(), d.ai_budget_ms);
        return d;
    }

    /** Long-term, session and current-form profiles for a player (empty when there's no history). */
    private playerLookup(): PlayerLookup {
        return (player) => this.options.profiles?.info(player) ?? { deviations: [] };
    }

    /** Player stats for the engine (undefined if the player isn't known yet). */
    private statsLookup(player: PlayerRef): ObservedStats | undefined {
        const profiled = this.options.profiles?.stats(player);
        if (profiled) return profiled;
        try {
            const st = this.table.getPlayerStatsFromName(player.name);
            return { vpip: st.computeVPIPStat(), pfr: st.computePFRStat(), hands: st.getTotalHands() };
        } catch {
            return undefined;
        }
    }

    /** Preflop advice from the rule-based engine, as a bot action (null when not applicable). */
    private preflopEngineAction(state: HandState | null): BotAction | null {
        if (!this.options.preflop_engine || !state || state.street !== "preflop") return null;
        const view = heroView(state);
        if (!view) return null;
        // the equity estimate printed just before (against the players still in) lets calls be priced
        const advice = preflopAdvice(state, view, (player) => this.statsLookup(player), undefined, {
            seven_deuce_bounty: this.rules.seven_deuce_bounty ?? 0,
            equity: this.last_equity?.equity
        });
        if (!advice) return null;
        const size = advice.action === "raise" || advice.action === "all-in" ? ` to ${advice.size_bb} BB` : "";
        console.log(`[Preflop] ${advice.action.toUpperCase()}${size} (${advice.scenario}): ${advice.reason}`);
        this.overlay_content = preflopOverlay(
            { state, view, players: this.playerLookup(), stats: (player) => this.statsLookup(player), notes: this.tableNotes() },
            advice, this.last_equity
        );
        return { action_str: advice.action, bet_size_in_BBs: advice.size_bb, reason: advice.reason };
    }

    private async recordDecision(state: HandState | null, dom_hand: string[], prompt: string, action: BotAction, latency_ms: number, source: string, response?: string): Promise<void> {
        if (!this.recorder || this.current_hand_messages.length === 0) return;
        const last = response === undefined && source === "llm" ? this.hand_history[this.hand_history.length - 1] : undefined;
        await this.recorder.recordDecision({
            game_id: this.game_id,
            hand_number: state?.hand_number ?? null,
            street: state?.street ?? "",
            messages: this.current_hand_messages,
            hero_name: this.bot_name,
            hero_cards: state?.hero_cards.length ? state.hero_cards : parseCards(dom_hand.join(" ")),
            big_blind: this.game.getBigBlind(),
            prompt,
            response: response ?? (source === "engine" ? action.reason ?? "" : last && last.metadata.role !== "user" ? last.text_content : ""),
            action,
            model: source === "llm" ? this.ai_service.getModelName() : source === "engine" && state?.street === "preflop" ? "preflop-engine" : source === "engine" ? "postflop-engine" : `engine (fallback from ${this.ai_service.getModelName()})`,
            source,
            latency_ms
        });
    }

    /** Reads the game's rules from bounties in stored hands of this game and the game log. Never throws. */
    private async loadGameRules(): Promise<void> {
        try {
            const stored = this.recorder ? (await this.recorder.hands()).filter((h) => h.game_id === this.game_id).map((h) => JSON.parse(h.messages_json) as string[]) : [];
            const from_hands: GameRules = { seven_deuce_bounty: bountyFromHands(stored) };
            this.applyRules(mergeRules(from_hands, await this.log_service.fetchGameRules(10)));
            // the clock is only logged when the game is set up, which can be far back
            if (this.rules.decision_seconds === undefined) {
                this.applyRules(mergeRules(this.rules, await this.log_service.fetchGameRules(300)));
            }
        } catch (err) {
            console.log("[Rules] Could not read the game's rules:", err instanceof Error ? err.message : err);
        }
    }

    private applyRules(rules: GameRules): void {
        this.rules = rules;
        // opponents' ranges include 7-2 bluffs when the bounty is on
        if (rules.seven_deuce_bounty !== undefined) TABLE_RULES.seven_deuce_bounty = rules.seven_deuce_bounty > 0;
        const text = describeRules(rules, this.game?.getBigBlind() ?? 0).join(", ");
        if (text && text !== this.rules_described) {
            this.rules_described = text;
            console.log(`[Rules] ${text}${rules.decision_seconds === undefined ? ` (clock not found in the log; assuming ${this.options.decision_seconds} s)` : ""}`);
        }
    }

    /** Short table notes for the panel and the AI: only rules that change decisions. */
    private tableNotes(): string[] {
        return describeRules(this.rules, this.game.getBigBlind()).filter((n) => /^(7-2|Antes)/.test(n));
    }

    private async recordCompletedHand(): Promise<void> {
        if (!this.recorder) return;
        try {
            const messages = await this.log_service.fetchLastCompletedHand();
            if (messages) {
                await this.recorder.recordHand(this.game_id, messages, this.bot_name, this.game.getBigBlind());
                this.options.profiles?.addHand(messages, this.game.getBigBlind(), this.game_id, this.bot_name);
                const bounty = bountyFromHands([messages]);
                if (bounty) this.applyRules(mergeRules(this.rules, { seven_deuce_bounty: bounty }));
                // rules can change mid-game; re-read the newest log pages now and then, in the background
                if (++this.hands_since_rules_check >= 25) {
                    this.hands_since_rules_check = 0;
                    void this.log_service.fetchGameRules(3).then((r) => this.applyRules(mergeRules(this.rules, r))).catch(() => undefined);
                }
            }
        } catch (err) {
            console.log("Could not record the finished hand:", err instanceof Error ? err.message : err);
        }
    }

    private async updateGameInfo() {
        logResponse(await this.puppeteer_service.waitForGameInfo(), this.debug_mode);
    
        console.log("Getting game info.");
        const res = await this.puppeteer_service.getGameInfo();
        logResponse(res, this.debug_mode);
        const game_info = res.code === "success" ? this.puppeteer_service.convertGameInfo(res.data as string) : null;
        if (game_info) {
            this.game.updateGameTypeAndBlinds(game_info.small_blind, game_info.big_blind, game_info.game_type);
        } else if (!this.manual_blinds) {
            console.log("Could not read the blinds this hand; keeping the previous values.");
        }
    }

    private async pullAndProcessLogs(last_created: string, first_fetch: boolean): Promise<ProcessedLogs> {
        const log = await this.log_service.fetchData("", last_created);
        if (log.code === "success") {
            let data = this.log_service.getData(log);
            let msg = this.log_service.getMsg(data);
            if (first_fetch) {
                data = this.log_service.pruneLogsBeforeCurrentHand(data);
                msg = this.log_service.getMsg(data);
                this.table.setPlayerInitialStacksFromMsg(msg, this.game.getBigBlind());

                first_fetch = false;
                this.first_created = this.log_service.getLast(this.log_service.getCreatedAt(data));

                let stack_msg = getPlayerStacksMsg(msg);

                let id_to_stack_map = getIdToInitialStackFromMsg(stack_msg, this.game.getBigBlind());
                this.table.setIdToStack(id_to_stack_map);

                let seat_to_id_map = getTableSeatToIdFromMsg(stack_msg);
                this.table.setTableSeatToId(seat_to_id_map);

                let id_to_seat_map = getIdToTableSeatFromMsg(stack_msg);
                this.table.setIdToTableSeat(id_to_seat_map);
                
                let id_to_name_map = getIdToNameFromMsg(stack_msg);
                this.table.setIdToName(id_to_name_map);

                let name_to_id_map = getNameToIdFromMsg(stack_msg);
                this.table.setNameToId(name_to_id_map);

                await this.table.updateCache();
            }

            let only_valid = validateAllMsg(msg);
    
            preProcessLogs(only_valid, this.game);
            let first_seat_number = this.table.getSeatNumberFromId(this.table.getFirstSeatOrderId());
            this.table.setIdToPosition(first_seat_number);
            this.table.convertAllOrdersToPosition();

            last_created = this.log_service.getFirst(this.log_service.getCreatedAt(data));
            return {
                valid_msgs: only_valid,
                last_created: last_created,
                first_fetch: first_fetch
            }
        } else {
            throw log.error;
        }
    }

    private async getPotSize(): Promise<number> {
        let pot_size: number = 0;
        const res = await this.puppeteer_service.getPotSize();
        logResponse(res, this.debug_mode);
        if (res.code === "success") {
            pot_size = Number(String(res.data).replace(/[^\d.]/g, "")) || 0;
        }
        return pot_size;
    }

    private async getHand(): Promise<string[]> {
        let hand: string[] = [];
        const res = await this.puppeteer_service.getHand();
        logResponse(res, this.debug_mode);
        if (res.code === "success") {
            hand = res.data as string[];
        }
        return hand;
    }

    private async getStackSize(): Promise<number> {
        let stack_size: number = 0;
        const res = await this.puppeteer_service.getStackSize();
        logResponse(res, this.debug_mode);
        if (res.code === "success") {
            stack_size = Number(String(res.data).replace(/[^\d.]/g, "")) || 0;
        }
        return stack_size;
    }

    private async updateHero(hand: string[], stack_size: number): Promise<void> {
        const hero = this.game.getHero();
        if (!hero) {
            this.game.createAndSetHero(this.table.getIdFromName(this.bot_name), hand, stack_size);
        } else {
            hero.setHand(hand);
            hero.setStackSize(stack_size);
        }
    }

    private async queryBotAction(query: string, retries: number, retry_counter: number = 0): Promise<BotAction> {
        if (retry_counter > retries) {
            if (await this.isValidBotAction(defaultCheckAction)) {
                console.log(`Failed to query bot action, exceeded the retry limit after ${retries} attempts. Defaulting to checking.`);
                return defaultCheckAction;
            } else {
                console.log(`Failed to query bot action, exceeded the retry limit after ${retries} attempts. Defaulting to folding.`);
                return defaultFoldAction;
            }
        }
        try {
            const ai_response = await this.ai_service.query(query, this.hand_history);
            this.hand_history = ai_response.prev_messages;

            if (await this.isValidBotAction(ai_response.bot_action)) {
                // only push to hand history if the choice made is valid
                if (ai_response.curr_message) {
                    this.hand_history.push(ai_response.curr_message);
                }
                return ai_response.bot_action;
            }
            console.log("Invalid bot action, retrying query.");
            return await this.queryBotAction(query, retries, retry_counter + 1);
        } catch (err) {
            console.log("Error while querying the AI model:", err, "retrying query.");
            return await this.queryBotAction(query, retries, retry_counter + 1);
        }
    }

    private async isValidBotAction(bot_action: BotAction): Promise<boolean> {
        console.log("Attempted Bot Action:", bot_action);
        const valid_actions: string[] = ["bet", "raise", "call", "check", "fold", "all-in"];
        const curr_stack_size_in_BBs = this.game.getHero()!.getStackSize();
        console.log("Bot Stack in BBs:", curr_stack_size_in_BBs);
        let is_valid = false;
        if (bot_action.action_str && valid_actions.includes(bot_action.action_str)) {
            let res;
            switch (bot_action.action_str) {
                case "bet":
                    res = await this.puppeteer_service.waitForBetOption();
                    if (res.code === "success" && bot_action.bet_size_in_BBs > 0 && bot_action.bet_size_in_BBs <= curr_stack_size_in_BBs) {
                        is_valid = true;
                    }
                    break;
                case "raise":
                    //TODO: should also check that the raise >= min raise
                    res = await this.puppeteer_service.waitForBetOption();
                    if (res.code === "success" && bot_action.bet_size_in_BBs > 0 && bot_action.bet_size_in_BBs <= curr_stack_size_in_BBs) {
                        is_valid = true;
                    }
                    break;
                case "all-in":
                    res = await this.puppeteer_service.waitForBetOption();
                    if (res.code === "success") {
                        is_valid = true;
                    }
                    break;
                case "call":
                    res = await this.puppeteer_service.waitForCallOption();
                    if (res.code === "success" && bot_action.bet_size_in_BBs > 0 && bot_action.bet_size_in_BBs <= curr_stack_size_in_BBs) {
                        is_valid = true;
                    }
                    break;
                case "check":
                    res = await this.puppeteer_service.waitForCheckOption();
                    if (res.code === "success" && bot_action.bet_size_in_BBs == 0) {
                        is_valid = true;
                    }
                    break;
                case "fold":
                    res = await this.puppeteer_service.waitForFoldOption();
                    if (res.code === "success" && bot_action.bet_size_in_BBs == 0) {
                        is_valid = true;
                    }
                    break;
            }
        }
        return is_valid;
    }

    private async performBotAction(bot_action: BotAction): Promise<void> {
        console.log("Bot Action:", bot_action.action_str);
        let bet_size = convertToValue(bot_action.bet_size_in_BBs, this.game.getBigBlind());
        switch (bot_action.action_str) {
            case "bet":
                console.log("Bet Size:", convertToBBs(bet_size, this.game.getBigBlind()));
                logResponse(await this.puppeteer_service.betOrRaise(bet_size), this.debug_mode);
                break;
            case "raise":
                console.log("Bet Size:", convertToBBs(bet_size, this.game.getBigBlind()));
                logResponse(await this.puppeteer_service.betOrRaise(bet_size), this.debug_mode);
                break;
            case "all-in":
                bet_size = convertToValue(this.game.getHero()!.getStackSize(), this.game.getBigBlind());
                console.log("Bet Size:", convertToBBs(bet_size, this.game.getBigBlind()));
                logResponse(await this.puppeteer_service.betOrRaise(bet_size), this.debug_mode);
                break;
            case "call":
                logResponse(await this.puppeteer_service.call(), this.debug_mode);
                break;
            case "check":
                logResponse(await this.puppeteer_service.check(), this.debug_mode);
                break;
            case "fold":
                logResponse(await this.puppeteer_service.fold(), this.debug_mode);
                const res = await this.puppeteer_service.cancelUnnecessaryFold();
                if (res.code === "success") {
                    logResponse(await this.puppeteer_service.check(), this.debug_mode);
                }
                break;
        }
    }
}

/** Temporary adapter from the overlay builders' content to the panel model (until they build PanelModel directly). */
function panelFromOverlay(o: OverlayContent): PanelModel {
    const verbs: Record<string, string> = { raise: "RAISE TO", bet: "BET", call: "CALL", check: "CHECK", fold: "FOLD", "all-in": "ALL-IN" };
    const sized = o.size_bb > 0;
    return {
        status: o.status, tone: toneFor(o.action), source: { label: o.header }, context: o.context,
        action: {
            verb: verbs[o.action.toLowerCase()] ?? o.action.toUpperCase(),
            size_bb: sized ? o.size_bb : undefined,
            chips: sized && o.big_blind > 0 ? Math.round(o.size_bb * o.big_blind * 100) / 100 : undefined
        },
        tag: o.tag ? { text: o.tag, kind: /^semi-bluff/i.test(o.tag) ? "semi-bluff" : /^bluff/i.test(o.tag) ? "bluff" : /^value/i.test(o.tag) ? "value" : "neutral" } : undefined,
        reasoning: [...(o.reason ? [o.reason] : []), ...(o.tag_lines ?? [])],
        warnings: o.warnings,
        spot: { pot_bb: 0, to_call_bb: 0, pot_odds: 0, stack_bb: 0, effective_bb: 0, spr: 0, spr_label: "SPR", notes: [] },
        hand: { cards: [], board: [], made: "" },
        odds: {}, options: [], opponents: [], more_opponents: 0
    };
}
