
import { sleep } from './helpers/bot-helper.ts';
import { ask } from './helpers/terminal.ts';
import { HandState, HeroView, heroView, parseCards, parseHand } from './engine/hand-parser.ts';
import { HandRecorder } from './services/hand-recorder.ts';
import { formatSpot } from './engine/spot-format.ts';
import { equity } from './engine/equity.ts';
import { requiredEquity } from './engine/odds.ts';
import { opponentModels } from './engine/opponent-range.ts';
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
    /** Current hand's log lines at the latest decision point (for recording and the hand state). */
    private current_hand_messages: string[] = [];
    /** True when the blinds were typed in because the page text could not be parsed. */
    private manual_blinds: boolean = false;
    private hand_history: AIMessage[];

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
                recorder?: HandRecorder) 
    {
        this.recorder = recorder;
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
        if (this.assistant_mode) {
            await this.waitForUserToSit();
        } else {
            await this.enterTableInProgress();
        }
        // retrieve initial num players
        await this.updateNumPlayers();
        //TODO: implement loop until STOP SIGNAL (perhaps from UI?)
        while (true) {
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
        await this.puppeteer_service.waitForNextHand(this.table.getNumPlayers(), this.game.getMaxTurnLength());
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
            console.log("Checking for bot's turn or winner of hand.");

            res = await this.puppeteer_service.waitForBotTurnOrWinner(this.table.getNumPlayers(), this.game.getMaxTurnLength());
            if (res.code == "success") {
                const data = res.data as string;
                if (data.includes("action-signal")) {
                    console.log("Performing bot's turn.");

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
                    const hand_state = hand_messages.length > 0 ? this.buildHandState(hand_messages, hand) : null;

                    this.table.setPot(convertToBBs(pot_size, this.game.getBigBlind()));

                    // If logs never succeeded (first_fetch still true), the name→id map is
                    // not yet populated so updateHero and constructQuery would both crash.
                    // Skip everything AI-related and wait for the next turn.
                    if (processed_logs.first_fetch) {
                        console.log("Skipping AI query: logs not yet available, waiting for next turn.");
                    } else {
                        await this.updateHero(hand, convertToBBs(stack_size, this.game.getBigBlind()));
                        // post process logs and construct query
                        await postProcessLogs(this.table.getLogsQueue(), this.game);
                        const query = constructQuery(this.game);
                        // query chatGPT and make action
                        try {
                            const started = Date.now();
                            const bot_action = await this.queryBotAction(query, this.query_retries);
                            await this.recordDecision(hand_state, hand, query, bot_action, Date.now() - started);
                            this.table.resetPlayerActions();
                            if (this.assistant_mode) {
                                await this.puppeteer_service.injectSuggestion(bot_action.action_str, bot_action.bet_size_in_BBs, bot_action.reason ?? "", this.game.getBigBlind());
                                console.log("AI suggestion shown in top-right. Please act in the browser.");
                            } else {
                                await this.performBotAction(bot_action);
                            }
                        } catch (err) {
                            console.log("Failed to query and perform bot action.")
                        }
                    }

                    console.log("Waiting for bot's turn to end");
                    logResponse(await this.puppeteer_service.waitForBotTurnEnd(), this.debug_mode);
                    if (this.assistant_mode) {
                        await this.puppeteer_service.dimSuggestion();
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

    /** Parses the current hand's log into a full state and prints a one-line summary of hero's spot. */
    private buildHandState(messages: string[], dom_hand: string[]): HandState | null {
        try {
            const bb = this.game.getBigBlind();
            const state = parseHand(messages, { hero_name: this.bot_name, hero_cards: parseCards(dom_hand.join(" ")), big_blind: bb });
            const view = heroView(state);
            if (!view) {
                console.log(`[State] Could not find "${this.bot_name}" among the players in the hand log.`);
                return state;
            }
            console.log(`[State] ${formatSpot(state, view)}`);
            this.printEquity(state, view);
            if (state.unparsed.length > 0) {
                console.log(`[State] ${state.unparsed.length} log line(s) not understood, e.g. ${JSON.stringify(state.unparsed[0])}`);
            }
            return state;
        } catch (err) {
            console.log("[State] Could not build the hand state:", err instanceof Error ? err.message : err);
            return null;
        }
    }

    /** Estimates hero's equity against each remaining opponent's likely range and prints it. */
    private printEquity(state: HandState, view: HeroView): void {
        if (state.hero_cards.length !== 2 || view.active_opponents.length === 0) return;
        try {
            const models = opponentModels(state, (name) => {
                try {
                    const st = this.table.getPlayerStatsFromName(name);
                    return { vpip: st.computeVPIPStat(), pfr: st.computePFRStat(), hands: st.getTotalHands() };
                } catch {
                    return undefined;
                }
            });
            const result = equity({ hero: state.hero_cards, board: state.board, opponents: models.map((m) => m.model), time_budget_ms: 150 });
            const need = view.to_call > 0 ? ` (need ${Math.round(requiredEquity(view.to_call, view.pot) * 100)}% to call)` : "";
            const ranges = models.map((m) => `${m.seat.position} ~${Math.round(rangePercent(m.model.range))}%`).join(", ");
            console.log(`[Engine] equity ${Math.round(result.equity * 100)}%${need} vs estimated ranges: ${ranges}`);
        } catch (err) {
            console.log("[Engine] Could not estimate equity:", err instanceof Error ? err.message : err);
        }
    }

    private async recordDecision(state: HandState | null, dom_hand: string[], prompt: string, action: BotAction, latency_ms: number): Promise<void> {
        if (!this.recorder || this.current_hand_messages.length === 0) return;
        const last = this.hand_history[this.hand_history.length - 1];
        await this.recorder.recordDecision({
            game_id: this.game_id,
            hand_number: state?.hand_number ?? null,
            street: state?.street ?? "",
            messages: this.current_hand_messages,
            hero_name: this.bot_name,
            hero_cards: state?.hero_cards.length ? state.hero_cards : parseCards(dom_hand.join(" ")),
            big_blind: this.game.getBigBlind(),
            prompt,
            response: last && last.metadata.role !== "user" ? last.text_content : "",
            action,
            model: this.ai_service.getModelName(),
            source: "llm",
            latency_ms
        });
    }

    private async recordCompletedHand(): Promise<void> {
        if (!this.recorder) return;
        try {
            const messages = await this.log_service.fetchLastCompletedHand();
            if (messages) {
                await this.recorder.recordHand(this.game_id, messages, this.bot_name, this.game.getBigBlind());
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
            pot_size = res.data as number;
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
            stack_size = res.data as number;
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