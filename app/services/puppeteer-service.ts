import puppeteer, { type Browser, type Page } from 'puppeteer';

import { computeTimeout, sleep } from '../helpers/bot-helper.ts';

import type { Response } from '../utils/error-handling-utils.ts';

import { GameInfo, parseGameInfo } from '../utils/game-info-utils.ts';
import type { OverlayContent } from '../helpers/overlay-builder.ts';


export class PuppeteerService {
    private default_timeout: number;
    private headless_flag: boolean;
    private use_existing_browser: boolean;
    private debugging_port: number;

    private browser!: Browser;
    private page!: Page;
    /** Why the game can no longer be followed (tab closed, browser gone, navigated away), or null. */
    private stop_reason: string | null = null;

    constructor(default_timeout: number, headless_flag: boolean, use_existing_browser: boolean = false, debugging_port: number = 9222) {
        this.default_timeout = default_timeout;
        this.headless_flag = headless_flag;
        this.use_existing_browser = use_existing_browser;
        this.debugging_port = debugging_port;
    }

    async init(): Promise<void> {
        if (this.use_existing_browser) {
            this.browser = await puppeteer.connect({
                browserURL: `http://localhost:${this.debugging_port}`,
                defaultViewport: null,
            });
            this.browser.on("disconnected", () => {
                this.stop_reason ??= "Chrome was closed or the connection to it was lost.";
            });
            // Use the first available page as a placeholder; navigateToGame will find the right tab.
            const pages = await this.browser.pages();
            this.page = pages[0] ?? await this.browser.newPage();
        } else {
            this.browser = await puppeteer.launch({
                defaultViewport: null,
                headless: this.headless_flag
            });
            this.browser.on("disconnected", () => {
                this.stop_reason ??= "The browser was closed.";
            });
            this.page = await this.browser.newPage();
        }
    }

    /** Non-null once the game tab or browser is gone, with a reason to show the user. */
    stopReason(): string | null {
        if (!this.stop_reason && this.page?.isClosed()) {
            this.stop_reason = "The game tab was closed.";
        }
        return this.stop_reason;
    }

    /** Watches the game tab: closing it, or navigating away from the game, stops the bot. */
    private watchGamePage(game_id: string): void {
        this.page.once("close", () => {
            this.stop_reason ??= "The game tab was closed.";
        });
        this.page.on("framenavigated", (frame) => {
            if (frame === this.page.mainFrame() && !frame.url().includes(game_id)) {
                this.stop_reason ??= `The game tab left the game (now at ${frame.url()}).`;
            }
        });
    }

    /** True while the page shows the user waiting for the next hand to start. */
    async isWaitingForNextHand(): Promise<boolean> {
        try {
            return (await this.page.$(".you-player > .waiting, .you-player > .waiting-next-hand")) !== null;
        } catch {
            return false;
        }
    }

    /** Players seated and not sitting out, without waiting; null if the page can't be read. */
    async countPlayers(): Promise<number | null> {
        try {
            const seated = await this.page.$$eval(".table-player", (divs) => divs.length);
            const away = await this.page.$$eval(".table-player-status-icon", (divs) => divs.length);
            return seated - away;
        } catch {
            return null;
        }
    }

    /** True if the page shows the user seated at the table. */
    async isSeated(): Promise<boolean> {
        try {
            return (await this.page.$(".you-player")) !== null;
        } catch {
            return false;
        }
    }

    /** Which action buttons are currently shown and enabled (used to cross-check the hand log). */
    async actionButtons(): Promise<{ check: boolean, call: boolean, fold: boolean, raise: boolean }> {
        try {
            // no helper functions inside page code: the page runs without the build tool's helpers
            const state = await this.page.evaluate(() => {
                const out: Record<string, boolean> = {};
                for (const cls of ["check", "call", "fold", "raise"]) {
                    const b = document.querySelector(`.game-decisions-ctn .action-buttons .${cls}`) as HTMLButtonElement | null;
                    out[cls] = !!b && !b.disabled;
                }
                return out;
            });
            return { check: state.check, call: state.call, fold: state.fold, raise: state.raise };
        } catch {
            return { check: false, call: false, fold: false, raise: false };
        }
    }

    /**
     * Fetches a same-origin path (e.g. "/games/<id>/log?...") from inside the game tab, so the
     * request uses the page's domain (pokernow.com or .club) and the user's login cookies.
     */
    async fetchInPage(path: string): Promise<{ status: number, text: string }> {
        return await this.page.evaluate(async (p) => {
            const res = await fetch(p, { credentials: "include", headers: { "Accept": "application/json" } });
            return { status: res.status, text: await res.text() };
        }, path);
    }

    async closeBrowser(): Promise<void> {
        if (this.use_existing_browser) {
            // Don't close the user's browser – just disconnect.
            this.browser.disconnect();
        } else {
            await this.browser.close();
        }
    }
    
    async navigateToGame<D, E=Error>(game_id: string): Response<D, E> {
        if (!game_id) {
            return {
                code: "error",
                error: new Error("Game id cannot be empty.") as E
            }
        }

        const targetUrl = `https://www.pokernow.club/games/${game_id}`;

        if (this.use_existing_browser) {
            // Use the tab already showing this game; otherwise reuse a PokerNow tab
            // (e.g. the home page opened by `npm start`) or open a new one.
            const pages = await this.browser.pages();
            const match = pages.find(p => p.url().includes(game_id));
            if (match) {
                console.log(`Found the game already open in a tab: ${match.url()}`);
                this.page = match;
            } else {
                this.page = pages.find(p => p.url().includes("pokernow")) ?? await this.browser.newPage();
                console.log(`Opening ${targetUrl}`);
                await this.page.goto(targetUrl);
            }
            await this.page.bringToFront();
            this.watchGamePage(game_id);
        } else {
            await this.page.goto(targetUrl);
            await this.page.setViewport({width: 1024, height: 768});
        }

        return {
            code: "success",
            data: null as D,
            msg: `Successfully opened PokerNow game with id ${game_id}.`
        }
    }
    
    async waitForGameInfo<D, E=Error>(): Response<D, E> {
        try {
            await this.page.waitForSelector('.game-infos > .blind-value-ctn > .blind-value', {timeout: this.default_timeout * 12});
        } catch (err) {
            return {
                code: "error",
                error: new Error(
                    `The table did not load within ${this.default_timeout * 12 / 1000}s (the blinds display was not found on ${this.page.url()}). ` +
                    "Check that the game link is correct and the table is visible in Chrome. " +
                    "If it is, PokerNow may have changed its page layout: run `npm run diagnose` while the game is open and send the output."
                ) as E
            }
        }
        return {
            code: "success",
            data: null as D,
            msg: "Successfully waited for game information."
        }
    }
    
    async getGameInfo<D, E=Error>(): Response<D, E> {
        var game_info;
        try {
            game_info = await this.page.$eval(".game-infos > .blind-value-ctn > .blind-value", (div: any) => div.textContent);
        } catch (err) {
            return {
                code: "error",
                error: new Error("Could not get game info.") as E
            }
        }
        return {
            code: "success",
            data: game_info as D,
            msg: "Successfully grabbed the game info."
        }
    }
    
    /** Returns null if the blinds text could not be parsed. */
    convertGameInfo(game_info: string): GameInfo | null {
        return parseGameInfo(game_info);
    }
    
    // send enter table request as non-host player
    async sendEnterTableRequest<D, E=Error>(name: string, stack_size: number): Response<D, E> {
        if (name.length < 2 || name.length > 14) {
            return {
                code: "error",
                error: new Error("Player name must be betwen 2 and 14 characters long.") as E
            }
        }
        try {
            await this.page.waitForSelector(".table-player-seat-button", {timeout: this.default_timeout * 4});
            await this.page.$eval(".table-player-seat-button", (button: any) => button.click());
        } catch (err) {
            return {
                code: "error",
                error: new Error("Could not find open seat.") as E
            }
        }
        await this.page.waitForSelector('.selected .popover-1.request-ingress-popover', {timeout: this.default_timeout * 4});
        await this.page.focus('.selected input[placeholder="Your Name"]');
        await this.page.keyboard.type(name);
        await this.page.focus('.selected input[placeholder="Intended Stack"]');
        await this.page.keyboard.type(stack_size.toString())
        await this.page.$eval('.selected .form-1 button[type="submit"]', (button: any) => button.click());
        try {
            await this.page.waitForSelector(".alert-1-buttons > button", {timeout: this.default_timeout});
            await this.page.$eval(".alert-1-buttons > button", (button: any) => button.click());
        } catch (err) {
            var message = "Table ingress unsuccessful."
            if (await this.page.$('.selected .form-2-input-control:nth-child(1) > .error-message')) {
                message = "Player name must be unique to game.";
            }
            await this.page.$eval(".selected > .table-player-seat-button", (button: any) => button.click());
            return {
                code: "error",
                error: new Error(message) as E
            }
        }
        return {
            code: "success",
            data: null as D,
            msg: "Table ingress request successfully sent."
        }
    }
    
    async waitForTableEntry<D, E=Error>(timeout: number = this.default_timeout * 120): Response<D, E> {
        try {
            await this.page.waitForSelector(".you-player", {timeout: timeout});
        } catch (err) {
            return {
                code: "error",
                error: new Error("Table ingress request not accepted by host.") as E
            }
        }
        return {
            code: "success",
            data: null as D,
            msg: "Successfully entered table."
        }
    }

    /** Get the display name of the "you" player (current user in this browser). */
    async getYouPlayerName<D, E=Error>(): Response<D, E> {
        try {
            const name = await this.page.$eval(
                ".you-player .table-player-name",
                (el: any) => el?.textContent?.trim() || ""
            );
            return {
                code: "success",
                data: name as D,
                msg: "Got current player name."
            };
        } catch (err) {
            return {
                code: "error",
                error: new Error("Could not get current player name.") as E
            };
        }
    }

    /**
     * Inject AI suggestion overlay in the top-right corner of the game page.
     * Shows bright with a pulse animation when fresh. Hover reveals the reason.
     * Call dimSuggestion() after the turn ends.
     */
    /**
     * Shows the suggestion overlay in the top-right corner of the game page. All text is inserted
     * with textContent (never as HTML), since it includes AI output and player names.
     */
    async injectSuggestion(content: OverlayContent): Promise<void> {
        const verb: Record<string, string> = { raise: "RAISE TO", bet: "BET", call: "CALL", check: "CHECK", fold: "FOLD", "all-in": "ALL-IN" };
        const label = verb[content.action.toLowerCase()] ?? content.action.toUpperCase();
        const main = `${label}${content.size_bb > 0 ? ` ${content.size_bb} BB` : ""}`;
        const chips = content.size_bb > 0 && content.big_blind > 0 ? `= ${Math.round(content.size_bb * content.big_blind * 100) / 100} chips` : "";
        const tag = { text: content.tag ?? "", color: content.tag_color ?? "#e5e7eb", lines: content.tag_lines ?? [] };
        await this.renderOverlay(content.status, content.header, content.context, main, chips, content.warnings, content.sections, content.reason, tag);
    }

    /** Minimal overlay, e.g. "Your turn: analyzing..." before the analysis is ready. */
    async showOverlayStatus(header: string, main: string): Promise<void> {
        await this.renderOverlay("thinking", header, "", main, "", [], [], "", { text: "", color: "", lines: [] });
    }

    private async renderOverlay(status: string, header: string, context: string, main: string, chips: string,
                                warnings: string[], sections: { title: string, lines: string[] }[], reason: string,
                                tag: { text: string, color: string, lines: string[] }): Promise<void> {
        await this.page.evaluate((status: string, header: string, context: string, main: string, chips: string,
                                  warnings: string[], sections: { title: string, lines: string[] }[], reason: string,
                                  tag: { text: string, color: string, lines: string[] }) => {
            const id = "pokernow-gpt-suggestion";
            if (!document.getElementById("pokernow-gpt-style")) {
                const style = document.createElement("style");
                style.id = "pokernow-gpt-style";
                style.textContent = `
                    @keyframes pgpt-pulse {
                        0%   { box-shadow: 0 0 0 0 rgba(74,222,128,0.7); }
                        70%  { box-shadow: 0 0 0 10px rgba(74,222,128,0); }
                        100% { box-shadow: 0 0 0 0 rgba(74,222,128,0); }
                    }
                    #pokernow-gpt-suggestion .pgpt-reason {
                        max-height: 0; overflow: hidden; opacity: 0; margin-top: 0;
                        transition: max-height 0.3s ease, opacity 0.3s ease, margin-top 0.3s ease;
                    }
                    #pokernow-gpt-suggestion:hover .pgpt-reason { max-height: 200px; opacity: 1; margin-top: 8px; }
                `;
                document.head.appendChild(style);
            }
            let el = document.getElementById(id) as HTMLElement | null;
            if (!el) {
                el = document.createElement("div");
                el.id = id;
                el.style.cssText = [
                    "position: fixed", "top: 16px", "right: 16px", "z-index: 999999", "padding: 10px 14px",
                    "border-radius: 10px", "font-family: system-ui, sans-serif", "width: 330px", "cursor: default",
                    "max-height: calc(100vh - 32px)", "overflow-y: auto", "box-sizing: border-box",
                    "transition: opacity 0.6s ease, background 0.6s ease, border-color 0.6s ease"
                ].join(";");
                document.body.appendChild(el);
            }
            // remember whether the user collapsed the details (kept on the element across redraws,
            // including the brief "analyzing" state that has no details section)
            const previous = el.querySelector("details") as HTMLDetailsElement | null;
            if (previous) el.dataset.detailsOpen = previous.open ? "1" : "0";
            const details_open = el.dataset.detailsOpen !== "0";
            const thinking = status === "thinking";
            const accent = thinking ? "#fbbf24" : "#4ade80";
            el.style.background = "rgba(10,20,15,0.95)";
            el.style.border = `2px solid ${accent}`;
            el.style.opacity = "1";
            el.style.animation = thinking ? "none" : "pgpt-pulse 1s ease 0s 2";
            el.replaceChildren();

            // no helper functions in here: the page runs this code without the build tool's helpers
            const rows: [string, string, string][] = [];
            rows.push([`${thinking ? "◌" : "●"} ${header}${reason ? " · hover for reason" : ""}`, `font-size:11px;font-weight:600;color:${accent};letter-spacing:0.03em;`, "header"]);
            if (context) rows.push([context, "font-size:11px;color:#9ca3af;margin-bottom:2px;", ""]);
            rows.push([main, `font-size:20px;font-weight:700;color:${thinking ? "#fde68a" : "#ffffff"};letter-spacing:0.02em;`, ""]);
            if (chips) rows.push([chips, "font-size:12px;color:#86efac;", ""]);
            // what kind of bet this is (value, semi-bluff, bluff; lead or c-bet) and why, always visible
            if (tag.text) rows.push([tag.text, `font-size:13px;font-weight:700;color:${tag.color};margin-top:3px;`, ""]);
            for (const line of tag.lines) rows.push([line, "font-size:11px;color:#e5e7eb;line-height:1.35;", ""]);
            for (const w of warnings) rows.push([`⚠ ${w}`, "font-size:11px;color:#fbbf24;margin-top:3px;", ""]);
            for (const [text, css, cls] of rows) {
                const d = document.createElement("div");
                d.textContent = text;
                d.style.cssText = css;
                if (cls) d.className = cls;
                el.appendChild(d);
            }
            // the detail sections sit in a native collapsible element (click "Details" to hide/show)
            if (sections.length > 0) {
                const box = document.createElement("details");
                box.open = details_open;
                const summary = document.createElement("summary");
                summary.textContent = "Details";
                summary.style.cssText = "font-size:10px;color:#9ca3af;cursor:pointer;margin-top:6px;";
                box.appendChild(summary);
                for (const section of sections) {
                    const title = document.createElement("div");
                    title.textContent = section.title.toUpperCase();
                    title.style.cssText = "font-size:9.5px;font-weight:600;color:#6ee7b7;letter-spacing:0.08em;margin-top:7px;";
                    box.appendChild(title);
                    for (const line of section.lines) {
                        const d = document.createElement("div");
                        d.textContent = line;
                        d.style.cssText = "font-size:11.5px;color:#e5e7eb;line-height:1.35;white-space:pre-wrap;";
                        box.appendChild(d);
                    }
                }
                el.appendChild(box);
            }
            if (reason) {
                const d = document.createElement("div");
                d.textContent = reason;
                d.className = "pgpt-reason";
                d.style.cssText = "font-size:12px;color:#a3e4b0;line-height:1.5;border-top:1px solid rgba(74,222,128,0.3);padding-top:8px;";
                el.appendChild(d);
            }
        }, status, header, context, main, chips, warnings, sections, reason, tag);
    }

    /**
     * Dim the suggestion overlay after the player's turn ends,
     * so the user knows it's from the previous round.
     */
    async dimSuggestion(): Promise<void> {
        await this.page.evaluate(() => {
            const el = document.getElementById("pokernow-gpt-suggestion") as HTMLElement | null;
            if (!el) return;
            el.style.animation = "none";
            el.style.opacity = "0.35";
            el.style.border = "2px solid rgba(255,255,255,0.15)";
            el.style.background = "rgba(0,0,0,0.7)";
            const label = el.querySelector(".header") as HTMLElement | null;
            if (label) {
                label.style.color = "#888";
                label.textContent = "○ Previous turn (not current)";
            }
        });
    }
    
    // game has not started yet -> "waiting state"
    // joined when hand is currently in progress -> "in next hand"
    // if player is in waiting state, wait for next hand
    // otherwise, return
    async waitForNextHand<D, E=Error>(num_players: number, max_turn_length: number): Response<D, E> {
        // check if the player is in a waiting state
        // if not, return
        try {
            await this.page.waitForSelector([".you-player > .waiting", ".you-player > .waiting-next-hand"].join(','), {timeout: this.default_timeout});
        } catch (err) {
            return {
                code: "error",
                error: new Error("Player is not in waiting state.") as E
            }
        }
        // if player is in waiting state, wait for the waiting state to disappear
        try {
            await this.page.waitForSelector([".you-player > .waiting", ".you-player > .waiting-next-hand"].join(','), 
            {hidden: true, timeout: computeTimeout(num_players, max_turn_length, 4) * 5 + this.default_timeout});
        } catch (err) {
            return {
                code: "error",
                error: new Error("Player is not in waiting state.") as E
            }
        }
        return {
            code: "success",
            data: null as D,
            msg: "Waited for next hand to start."
        }
    }
    
    async getNumPlayers<D, E=Error>(): Response<D, E> {
        try {
            await this.page.waitForSelector(".table-player", {timeout: this.default_timeout});
            const table_players_count = await this.page.$$eval(".table-player", (divs: any) => divs.length) as number;
            const table_player_status_count = await this.page.$$eval(".table-player-status-icon", (divs: any) => divs.length) as number;
            const num_players = table_players_count - table_player_status_count;
            return {
                code: "success",
                data: num_players as D,
                msg: `Successfully got number of players in table: ${num_players}`
            }
        } catch (err) {
            return {
                code: "error",
                error: new Error("Failed to compute number of players in table.") as E
            }
        }
    
    }
    
    // wait for bot's turn or winner of hand has been determined
    async waitForBotTurnOrWinner<D, E=Error>(num_players: number, max_turn_length: number, timeout?: number): Response<D, E> {
        try {
            const el = await this.page.waitForSelector([".action-signal", ".table-player.winner"].join(','), {timeout: timeout ?? computeTimeout(num_players, max_turn_length, 4) * 5 + this.default_timeout});
            const class_name = await this.page.evaluate(el => el!.className, el);
            return {
                code: "success",
                data: class_name as D,
                msg: `Waited for ${class_name}`
            }
        } catch (err) {
            return {
                code: "error",
                error: new Error("It is not the player's turn.") as E
            }
        }
    }
    
    async waitForBotTurnEnd<D, E=Error>(timeout?: number): Response<D, E> {
        try {
            await this.page.waitForSelector(".action-signal", {hidden: true, timeout: timeout ?? this.default_timeout * 15});
        } catch (err) {
            return {
                code: "error",
                error: new Error("Failed to wait for bot's turn to end.") as E
            }
        }
        return {
            code: "success",
            data: null as D,
            msg: "Successfully waited for bot's turn to end."
        }
    }
    
    async getPotSize<D, E=Error>(): Response<D, E> {
        try {
            await this.page.waitForSelector(".table > .table-pot-size > .main-value", { timeout: 2000 });
            const pot_size_str = await this.page.$eval(".table > .table-pot-size > .main-value", (p: any) => p.textContent);
            return {
                code: "success",
                data: pot_size_str as D,
                msg: "Successfully retrieved table pot size."
            }
        } catch (err) {
            return {
                code: "error",
                error: new Error("Failed to retrieve table pot size.") as E
            }
        }
    }
    
    async getHand<D, E=Error>(): Response<D, E> {
        try {
            const cards_div = await this.page.$$(".you-player > .table-player-cards > div");
            let cards: string[] = [];
            for (const card_div of cards_div) {
                const card_value = await card_div.$eval(".value", (span: any) => span.textContent);
                const sub_suit_letter = await card_div.$eval(".sub-suit", (span: any) => span.textContent);
                if (card_value && sub_suit_letter) {
                    cards.push(card_value + sub_suit_letter);
                } else {
                    throw "Invalid card.";
                }
            }
            return {
                code: "success",
                data: cards as D,
                msg: "Successfully retrieved player's hand."
            }
        } catch (err) {
            return {
                code: "error",
                error: new Error("Failed to retrieve player's hand.") as E
            }
        }
    }
    
    async getStackSize<D, E=Error>(): Response<D, E> {
        try {
            await this.page.waitForSelector(".you-player > .table-player-infos-ctn > div > .table-player-stack", { timeout: 2000 });
            const stack_size_str = await this.page.$eval(".you-player > .table-player-infos-ctn > div > .table-player-stack", (p: any) => p.textContent);
            return {
                code: "success",
                data: stack_size_str as D,
                msg: "Successfully retrieved bot's stack size."
            }
        } catch (err) {
            return {
                code: "error",
                error: new Error("Failed to retrieve bot's stack size.") as E
            }
        }
    }

    async waitForCallOption<D, E=Error>(): Response<D, E> {
        try {
            await this.page.waitForSelector(".game-decisions-ctn > .action-buttons > .call", {timeout: this.default_timeout});
            const is_disabled = await this.page.$eval(".game-decisions-ctn > .action-buttons > .call", (button: any) => button.disabled);
            if (is_disabled) {
                throw new Error("Call option is disabled.")
            }
        } catch (err) {
            return {
                code: "error",
                error: new Error("No option to call available.") as E
            }
        }
        return {
            code: "success",
            data: null as D,
            msg: "Successfully waited for call option."
        }
    }
    
    async call<D, E=Error>(): Response<D, E> {
        try {
            await this.page.$eval(".game-decisions-ctn > .action-buttons > .call", (button: any) => button.click());
        } catch (err) {
            return {
                code: "error",
                error: new Error("Failed to execute call action.") as E
            }
        }
        return {
            code: "success",
            data: null as D,
            msg: "Successfully executed call action."
        }
    }
    
    async waitForFoldOption<D, E=Error>(): Response<D, E> {
        try {
            await this.page.waitForSelector(".game-decisions-ctn > .action-buttons > .fold", {timeout: this.default_timeout});
            const is_disabled = await this.page.$eval(".game-decisions-ctn > .action-buttons > .fold", (button: any) => button.disabled);
            if (is_disabled) {
                throw new Error("Fold option is disabled.")
            }
        } catch (err) {
            return {
                code: "error",
                error: new Error("No option to fold available.") as E
            }
        }
        return {
            code: "success",
            data: null as D,
            msg: "Successfully waited for fold option."
        }
    }

    async fold<D, E=Error>(): Response<D, E> {
        try {
            await this.page.waitForSelector(".game-decisions-ctn > .action-buttons > .fold", {timeout: this.default_timeout});
            await this.page.$eval(".game-decisions-ctn > .action-buttons > .fold", (button: any) => button.click());
        } catch (err) {
            return {
                code: "error",
                error: new Error("No option to fold available.") as E
            }
        }
        return {
            code: "success",
            data: null as D,
            msg: "Successfully executed fold action."
        }
    }
    
    async cancelUnnecessaryFold<D, E=Error>(): Response<D, E> {
        const fold_alert_text = "Are you sure that you want do an unnecessary fold?Do not show this again in this session? "
        try {
            await this.page.waitForSelector(".alert-1", {timeout: this.default_timeout});
            const text = await this.page.$eval(".alert-1 > .content", (div: any) => div.textContent);
            if (text === fold_alert_text) {
                await this.page.$eval(".alert-1 > .alert-1-buttons > .button-1.red", (button: any) => button.click());
            }
        } catch (err) {
            return {
                code: "error",
                error: new Error("No option to cancel unnecessary fold available.") as E
            }
        }
        return {
            code: "success",
            data: null as D,
            msg: "Successfully cancelled unnecessary fold."
        }
    }
    
    async waitForCheckOption<D, E=Error>(): Response<D, E> {
        try {
            await this.page.waitForSelector(".game-decisions-ctn > .action-buttons > .check", {timeout: this.default_timeout});
            const is_disabled = await this.page.$eval(".game-decisions-ctn > .action-buttons > .check", (button: any) => button.disabled);
            if (is_disabled) {
                throw new Error("Check option is disabled.")
            }
        } catch (err) {
            return {
                code: "error",
                error: new Error("No option to check available.") as E
            }
        }
        return {
            code: "success",
            data: null as D,
            msg: "Successfully waited for check option."
        }
    }
    
    async check<D, E=Error>(): Response<D, E> {
        try {
            await this.page.waitForSelector(".game-decisions-ctn > .action-buttons > .check", {timeout: this.default_timeout});
            await this.page.$eval(".game-decisions-ctn > .action-buttons > .check", (button: any) => button.click());
        } catch (err) {
            return {
                code: "error",
                error: new Error("No option to check available.") as E
            }
        }
        return {
            code: "success",
            data: null as D,
            msg: "Successfully executed check action."
        }
    }
    
    async waitForBetOption<D, E=Error>(): Response<D ,E> {
        try {
            await this.page.waitForSelector(".game-decisions-ctn > .action-buttons > .raise", {timeout: this.default_timeout});
            const is_disabled = await this.page.$eval(".game-decisions-ctn > .action-buttons > .raise", (button: any) => button.disabled);
            if (is_disabled) {
                throw new Error("Bet or raise option is disabled.")
            }
        } catch (err) {
            return {
                code: "error",
                error: new Error("No option to bet or raise available.") as E
            }
        }
        return {
            code: "success",
            data: null as D,
            msg: "Successfully waited for bet or raise option."
        }
    }
    
    async betOrRaise<D, E=Error>(bet_amount: number): Response<D, E> {
        try {
            const bet_action = await this.page.$eval(".game-decisions-ctn > .action-buttons > .raise", (button: any) => button.textContent);
            await this.page.$eval(".game-decisions-ctn > .action-buttons > .raise", (button: any) => button.click());
    
            if (bet_action === "Raise") {
                const res = await this.getCurrentBet();
                if (res.code === "success") {
                    const current_bet = res.data as number;
                    bet_amount += current_bet;
                }
            }
            await this.page.waitForSelector(".game-decisions-ctn > form > .raise-bet-value > div > input", {timeout: this.default_timeout});
            await this.page.focus(".game-decisions-ctn > form > .raise-bet-value > div > input");
            await sleep(this.default_timeout);
            await this.page.keyboard.type(bet_amount.toString(), {delay: 200});
            await this.page.waitForSelector(".game-decisions-ctn > form > .action-buttons > .bet", {timeout: this.default_timeout});
            await this.page.$eval(".game-decisions-ctn > form > .action-buttons > .bet", (input: any) => input.click());
        } catch (err) {
            return {
                code: "error",
                error: new Error(`Failed to bet with amount ${bet_amount}.`) as E
            }
        }
        return {
            code: "success",
            data: null as D,
            msg: `Successfully executed bet action with amount ${bet_amount}.`
        }
    }

    async getCurrentBet<D, E=Error>(): Response<D, E> {
        try {
            const el = await this.page.waitForSelector(".you-player > .table-player-bet-value", {timeout: this.default_timeout});
            const current_bet = await this.page.evaluate((el: any) => isNaN(el.textContent) ? '0' : el.textContent, el);
            return {
                code: "success",
                data: parseFloat(current_bet) as D,
                msg: `Successfully retrieved current bet amount: ${current_bet}`
            }
        } catch (err) {
            return {
                code: "error",
                error: new Error("No existing bet amount found.") as E
            }
        }
    }

    async waitForHandEnd<D, E=Error>(): Response<D, E> {
        try {
            await this.page.waitForSelector(".table-player.winner", {hidden: true, timeout: this.default_timeout * 10});
        } catch (err) {
            return {
                code: "error",
                error: new Error("Failed to wait for hand to finish.") as E
            }
        }
        return {
            code: "success",
            data: null as D,
            msg: "Waited for hand to finish."
        }
    }
}
