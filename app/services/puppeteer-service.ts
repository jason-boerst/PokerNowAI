import puppeteer, { type Browser, type Page } from 'puppeteer';

import { computeTimeout, sleep } from '../helpers/bot-helper.ts';

import type { Response } from '../utils/error-handling-utils.ts';

import { GameInfo, parseGameInfo } from '../utils/game-info-utils.ts';
import type { PanelModel } from '../ui/panel-model.ts';
import { escapeHtml, renderPanel } from '../ui/panel-render.ts';


export class PuppeteerService {
    private default_timeout: number;
    private headless_flag: boolean;
    private use_existing_browser: boolean;
    private debugging_port: number;

    private browser!: Browser;
    private page!: Page;
    /** Why the game can no longer be followed (tab closed, browser gone, navigated away), or null. */
    private stop_reason: string | null = null;
    /** The panel shown for the current decision (redrawn as "previous turn" when it ends). */
    private last_panel: PanelModel | null = null;

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
     * Shows the suggestion panel (top-right by default) for this decision. The panel is drawn by
     * renderPanel (every piece of text in its html is already escaped); this only hosts it in the page:
     * drag to move, collapsible sections, compact mode, the AI countdown and the stale state.
     * Call dimSuggestion() after the turn ends.
     */
    async injectSuggestion(model: PanelModel): Promise<void> {
        this.last_panel = model;
        const { html, css } = renderPanel(model);
        await this.renderOverlay(html, css, model.status, model.tone, handKey(model.context),
            `${model.context}|${model.action.verb}|${model.action.size_bb ?? ""}`);
    }

    /** Minimal panel, e.g. "Your turn · analyzing…" before the analysis is ready. */
    async showOverlayStatus(header: string, main: string): Promise<void> {
        this.last_panel = null;
        const html = `<div class="pgpt-panel pgpt-status-panel" data-status="thinking">` +
            `<div class="pgpt-header"><span class="pgpt-status-dot"></span><span>${escapeHtml(header)}</span></div>` +
            `<div class="pgpt-status-main">${escapeHtml(main)}</div>` +
            `<div class="pgpt-status-track"><div class="pgpt-status-bar"></div></div></div>`;
        await this.renderOverlay(html, "", "thinking", "", "", "");
    }

    /**
     * Hosts rendered panel html in the page (or, with html null, only updates the status of the panel
     * already there). No named helpers in the page code: tsx wraps them with __name, which the page lacks.
     */
    private async renderOverlay(html: string | null, css: string, status: string, tone: string, hand: string, fresh_key: string): Promise<void> {
        await this.page.evaluate((html: string | null, css: string, host_css: string, status: string, tone: string, hand: string, fresh_key: string) => {
            const id = "pokernow-gpt-suggestion";
            let el = document.getElementById(id) as HTMLElement | null;
            if (html === null && !el) return;
            if (html !== null) {
                let style = document.getElementById("pokernow-gpt-style") as HTMLStyleElement | null;
                if (!style) {
                    style = document.createElement("style");
                    style.id = "pokernow-gpt-style";
                    (document.head ?? document.documentElement).appendChild(style);
                }
                const full_css = host_css + "\n" + css;
                if (style.textContent !== full_css) style.textContent = full_css;
            }
            if (!el) {
                el = document.createElement("div");
                el.id = id;
                // saved preferences (the dataset holds them for this page, so blocked storage still works)
                el.dataset.pgptCollapsed = "[]";
                try {
                    const pos = JSON.parse(localStorage.getItem("pgpt-pos") ?? "null");
                    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
                        el.dataset.pgptLeft = String(pos.left);
                        el.dataset.pgptTop = String(pos.top);
                    }
                    const collapsed = JSON.parse(localStorage.getItem("pgpt-collapsed") ?? "[]");
                    if (Array.isArray(collapsed)) el.dataset.pgptCollapsed = JSON.stringify(collapsed.filter((x: unknown) => typeof x === "string"));
                    if (localStorage.getItem("pgpt-compact") === "1") el.classList.add("pgpt-compact");
                } catch { /* storage blocked or corrupt: defaults */ }

                // keep clicks on the panel away from the table underneath
                for (const type of ["click", "dblclick", "mousedown", "pointerdown", "touchstart"]) {
                    el.addEventListener(type, (e) => e.stopPropagation());
                }
                el.addEventListener("click", (e) => {
                    const panel = document.getElementById(id);
                    const target = e.target as HTMLElement | null;
                    if (!panel || !target || !target.closest) return;
                    if (target.closest('[data-pgpt-action="compact"]')) {
                        e.preventDefault();
                        const compact = panel.classList.toggle("pgpt-compact");
                        try { localStorage.setItem("pgpt-compact", compact ? "1" : "0"); } catch { /* not saved */ }
                        return;
                    }
                    const title = target.closest(".pgpt-section-title") as HTMLElement | null;
                    const section = title?.closest(".pgpt-section[data-section]") as HTMLElement | null;
                    if (!title || !section || !section.classList.contains("pgpt-collapsible") || !panel.contains(section)) return;
                    const name = section.dataset.section ?? "";
                    const collapsed = section.classList.toggle("pgpt-collapsed");
                    title.setAttribute("aria-expanded", collapsed ? "false" : "true");
                    let names: string[] = [];
                    try { names = JSON.parse(panel.dataset.pgptCollapsed ?? "[]"); } catch { names = []; }
                    names = names.filter((n) => n !== name);
                    if (collapsed) names.push(name);
                    panel.dataset.pgptCollapsed = JSON.stringify(names);
                    try { localStorage.setItem("pgpt-collapsed", panel.dataset.pgptCollapsed); } catch { /* not saved */ }
                });
                el.addEventListener("keydown", (e) => {
                    // keyboard: Enter or Space on a focused section title or button acts like a click
                    const target = e.target as HTMLElement | null;
                    if ((e.key === "Enter" || e.key === " ") && target && target.matches && target.matches(".pgpt-collapsible > .pgpt-section-title")) {
                        e.preventDefault();
                        e.stopPropagation();
                        target.click();
                    }
                });
                // drag by the header; the move and release listeners are on the window (capture phase, so
                // they run even when the release lands on the panel)
                el.addEventListener("mousedown", (e) => {
                    const panel = document.getElementById(id);
                    const target = e.target as HTMLElement | null;
                    if (!panel || !target || !target.closest || e.button !== 0) return;
                    if (!target.closest(".pgpt-header") || target.closest("[data-pgpt-action], button, a, input, select, textarea")) return;
                    const rect = panel.getBoundingClientRect();
                    panel.dataset.pgptDrag = `${e.clientX - rect.left},${e.clientY - rect.top}`;
                    panel.classList.add("pgpt-dragging");
                    e.preventDefault();
                });
                if (!(window as any).__pgpt_drag_bound) {
                    (window as any).__pgpt_drag_bound = true;
                    window.addEventListener("mousemove", (e) => {
                        const panel = document.getElementById(id);
                        if (!panel || !panel.dataset.pgptDrag) return;
                        const [dx, dy] = panel.dataset.pgptDrag.split(",").map(Number);
                        const left = Math.round(Math.min(Math.max(0, e.clientX - dx), Math.max(0, window.innerWidth - panel.offsetWidth)));
                        const top = Math.round(Math.min(Math.max(0, e.clientY - dy), Math.max(0, window.innerHeight - Math.min(panel.offsetHeight, 96))));
                        panel.dataset.pgptLeft = String(left);
                        panel.dataset.pgptTop = String(top);
                        panel.style.left = `${left}px`;
                        panel.style.top = `${top}px`;
                        panel.style.right = "auto";
                        panel.style.maxHeight = `${Math.max(96, window.innerHeight - top - 12)}px`;
                        panel.dataset.pgptMoved = "1";
                        e.preventDefault();
                    }, true);
                    window.addEventListener("mouseup", () => {
                        const panel = document.getElementById(id);
                        if (!panel || !panel.dataset.pgptDrag) return;
                        delete panel.dataset.pgptDrag;
                        panel.classList.remove("pgpt-dragging");
                        if (panel.dataset.pgptMoved !== "1") return;
                        delete panel.dataset.pgptMoved;
                        // the click that follows a drag released off the panel must not reach the table
                        (window as any).__pgpt_swallow_click = true;
                        setTimeout(() => { (window as any).__pgpt_swallow_click = false; }, 0);
                        try {
                            localStorage.setItem("pgpt-pos", JSON.stringify({ left: Number(panel.dataset.pgptLeft), top: Number(panel.dataset.pgptTop) }));
                        } catch { /* not saved */ }
                    }, true);
                    window.addEventListener("click", (e) => {
                        if (!(window as any).__pgpt_swallow_click) return;
                        (window as any).__pgpt_swallow_click = false;
                        e.stopPropagation();
                        e.preventDefault();
                    }, true);
                    window.addEventListener("resize", () => {
                        const panel = document.getElementById(id);
                        if (!panel || panel.dataset.pgptLeft === undefined) return;
                        const left = Math.min(Math.max(0, Number(panel.dataset.pgptLeft)), Math.max(0, window.innerWidth - panel.offsetWidth));
                        const top = Math.min(Math.max(0, Number(panel.dataset.pgptTop)), Math.max(0, window.innerHeight - Math.min(panel.offsetHeight, 96)));
                        panel.style.left = `${left}px`;
                        panel.style.top = `${top}px`;
                        panel.style.maxHeight = `${Math.max(96, window.innerHeight - top - 12)}px`;
                    });
                }
                document.body.appendChild(el);
            }

            if (html !== null) {
                // keep the scroll position while redrawing the same hand, start at the top for a new one
                const scroll = el.scrollTop;
                const same_hand = hand !== "" && el.dataset.pgptHand === hand;
                el.innerHTML = html;
                el.dataset.pgptHand = hand;
                el.scrollTop = same_hand ? scroll : 0;

                // sections: the action banner and the Why box always stay open
                let collapsed: string[] = [];
                try { collapsed = JSON.parse(el.dataset.pgptCollapsed ?? "[]"); } catch { collapsed = []; }
                for (const section of Array.from(el.querySelectorAll(".pgpt-section[data-section]")) as HTMLElement[]) {
                    const name = section.dataset.section ?? "";
                    const title = section.querySelector(".pgpt-section-title") as HTMLElement | null;
                    if (!title || name === "action" || name === "why" || section.dataset.collapsible === "false") continue;
                    section.classList.add("pgpt-collapsible");
                    title.setAttribute("role", "button");
                    title.setAttribute("tabindex", "0");
                    const is_collapsed = collapsed.includes(name);
                    section.classList.toggle("pgpt-collapsed", is_collapsed);
                    title.setAttribute("aria-expanded", is_collapsed ? "false" : "true");
                }
                const compact_button = el.querySelector('[data-pgpt-action="compact"]');
                if (compact_button) compact_button.setAttribute("aria-pressed", el.classList.contains("pgpt-compact") ? "true" : "false");

                // countdown while the AI thinks: width from its current share of the budget down to 0
                for (const bar of Array.from(el.querySelectorAll(".pgpt-countdown[data-budget-ms][data-started-at]")) as HTMLElement[]) {
                    const budget = Number(bar.dataset.budgetMs);
                    const started = Number(bar.dataset.startedAt);
                    if (!(budget > 0) || !Number.isFinite(started)) continue;
                    const remaining = Math.max(0, Math.min(budget, budget - (Date.now() - started)));
                    bar.style.transition = "none";
                    bar.style.width = `${(remaining / budget) * 100}%`;
                    void bar.offsetWidth;
                    bar.style.transition = `width ${Math.round(remaining)}ms linear`;
                    bar.style.width = "0%";
                }

                // a short glow in the action's color when a new decision arrives
                if (status === "final" && el.dataset.pgptFresh !== fresh_key) {
                    el.classList.remove("pgpt-flash");
                    void el.offsetWidth;
                    el.classList.add("pgpt-flash");
                }
                el.dataset.pgptFresh = status === "final" ? fresh_key : "";
                if (tone) el.dataset.tone = tone;
                else delete el.dataset.tone;
            }

            // status (a stale panel stays readable but greyed, with a "Previous turn" label)
            el.dataset.status = status;
            const panel_root = el.querySelector(".pgpt-panel") as HTMLElement | null;
            if (panel_root) panel_root.dataset.status = status;
            if (status === "stale") {
                el.classList.remove("pgpt-flash");
                for (const bar of Array.from(el.querySelectorAll(".pgpt-countdown")) as HTMLElement[]) {
                    bar.style.transition = "none";
                    bar.style.width = "0%";
                }
                if (!el.querySelector(".pgpt-stale-banner")) {
                    const banner = document.createElement("div");
                    banner.className = "pgpt-stale-banner";
                    banner.textContent = "Previous turn · not your current decision";
                    (panel_root ?? el).prepend(banner);
                }
            }

            // position: saved spot (clamped to the window) or the top-right corner
            if (el.dataset.pgptLeft !== undefined && el.dataset.pgptTop !== undefined) {
                const left = Math.min(Math.max(0, Number(el.dataset.pgptLeft)), Math.max(0, window.innerWidth - el.offsetWidth));
                const top = Math.min(Math.max(0, Number(el.dataset.pgptTop)), Math.max(0, window.innerHeight - Math.min(el.offsetHeight, 96)));
                el.style.left = `${left}px`;
                el.style.top = `${top}px`;
                el.style.right = "auto";
                el.style.maxHeight = `${Math.max(96, window.innerHeight - top - 12)}px`;
            } else {
                el.style.left = "auto";
                el.style.top = "16px";
                el.style.right = "16px";
                // stop above PokerNow's action buttons when they sit under the panel (bottom right)
                let bottom = window.innerHeight - 16;
                const decisions = document.querySelector(".game-decisions-ctn") as HTMLElement | null;
                const zone = decisions ? decisions.getBoundingClientRect() : null;
                if (zone && zone.height > 0 && zone.right > window.innerWidth - 16 - el.offsetWidth && zone.left < window.innerWidth - 16) {
                    bottom = Math.min(bottom, zone.top - 8);
                }
                el.style.maxHeight = `${Math.max(160, bottom - 16)}px`;
            }
        }, html, css, HOST_CSS, status, tone, hand, fresh_key);
    }

    /**
     * Switches the panel to a clear "Previous turn" state after the player's turn ends: greyed but
     * readable, so the user knows it's not for the current decision.
     */
    async dimSuggestion(): Promise<void> {
        const last = this.last_panel;
        if (last) {
            const { html, css } = renderPanel({ ...last, status: "stale", thinking: undefined });
            await this.renderOverlay(html, css, "stale", last.tone, handKey(last.context), "");
        } else {
            await this.renderOverlay(null, "", "stale", "", "", "");
        }
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

/** "Hand #14" from the panel's context line (for keeping the scroll position within a hand). */
function handKey(context: string): string {
    return /Hand #\d+/.exec(context)?.[0] ?? context;
}

/**
 * Styles the in-page host needs whatever the panel design: placement, dragging, collapsed sections,
 * the stale state and the brief "analyzing" panel. The renderer's CSS comes after it, so it can override.
 */
const HOST_CSS = `
#pokernow-gpt-suggestion{position:fixed;z-index:2147483000;width:384px;max-width:calc(100vw - 16px);box-sizing:border-box;
  overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;border-radius:14px;cursor:default;text-align:left;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;
  scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.4) transparent;transition:opacity .3s ease,filter .3s ease;
  --pgpt-host-accent:#94a3b8}
#pokernow-gpt-suggestion[data-tone="fold"]{--pgpt-host-accent:#ef4444}
#pokernow-gpt-suggestion[data-tone="check"]{--pgpt-host-accent:#eab308}
#pokernow-gpt-suggestion[data-tone="go"]{--pgpt-host-accent:#22c55e}
#pokernow-gpt-suggestion::-webkit-scrollbar{width:8px}
#pokernow-gpt-suggestion::-webkit-scrollbar-thumb{background:rgba(148,163,184,.35);border-radius:8px}
#pokernow-gpt-suggestion .pgpt-header{cursor:grab;user-select:none;-webkit-user-select:none}
#pokernow-gpt-suggestion.pgpt-dragging,#pokernow-gpt-suggestion.pgpt-dragging *{cursor:grabbing !important;user-select:none;-webkit-user-select:none}
#pokernow-gpt-suggestion.pgpt-dragging{transition:none;opacity:.92}
#pokernow-gpt-suggestion [data-pgpt-action]{cursor:pointer}
#pokernow-gpt-suggestion .pgpt-collapsible>.pgpt-section-title{cursor:pointer;user-select:none;-webkit-user-select:none}
#pokernow-gpt-suggestion .pgpt-collapsible>.pgpt-section-title::after{content:"\\25BE";margin-left:auto;padding-left:6px;float:right;opacity:.55;display:inline-block;transition:transform .15s ease}
#pokernow-gpt-suggestion .pgpt-collapsible.pgpt-collapsed>.pgpt-section-title::after{transform:rotate(-90deg)}
#pokernow-gpt-suggestion .pgpt-collapsible>.pgpt-section-title:focus-visible{outline:2px solid rgba(148,163,184,.7);outline-offset:2px;border-radius:4px}
#pokernow-gpt-suggestion .pgpt-collapsed>.pgpt-section-body{display:none}
#pokernow-gpt-suggestion .pgpt-countdown{will-change:width}
@keyframes pgpt-host-flash{0%{box-shadow:0 0 0 0 var(--pgpt-host-accent)}100%{box-shadow:0 0 0 16px rgba(0,0,0,0)}}
#pokernow-gpt-suggestion.pgpt-flash{animation:pgpt-host-flash .9s ease-out 2}
#pokernow-gpt-suggestion[data-status="stale"]{filter:grayscale(1) brightness(.8)}
#pokernow-gpt-suggestion[data-status="stale"]:hover{filter:grayscale(.6) brightness(.95)}
#pokernow-gpt-suggestion .pgpt-stale-banner{display:flex;align-items:center;gap:6px;margin:0 0 8px;padding:5px 10px;border-radius:8px;
  background:rgba(148,163,184,.18);border:1px dashed rgba(148,163,184,.55);color:#e2e8f0;font-size:11px;font-weight:700;
  letter-spacing:.06em;text-transform:uppercase}
#pokernow-gpt-suggestion .pgpt-stale-banner::before{content:"";width:7px;height:7px;border-radius:50%;background:#94a3b8;flex:none}
#pokernow-gpt-suggestion .pgpt-status-panel{background:rgba(12,17,28,.96);border:1px solid rgba(148,163,184,.35);border-radius:14px;
  padding:12px 14px 12px;color:#e5e7eb;box-shadow:0 12px 32px rgba(0,0,0,.5)}
#pokernow-gpt-suggestion .pgpt-status-panel .pgpt-header{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;
  letter-spacing:.07em;text-transform:uppercase;color:#cbd5e1}
@keyframes pgpt-host-dot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}
#pokernow-gpt-suggestion .pgpt-status-dot{width:8px;height:8px;border-radius:50%;background:#60a5fa;flex:none;animation:pgpt-host-dot 1.1s ease-in-out infinite}
#pokernow-gpt-suggestion .pgpt-status-main{margin-top:6px;font-size:20px;font-weight:800;color:#f8fafc;letter-spacing:.02em}
#pokernow-gpt-suggestion .pgpt-status-track{position:relative;height:4px;margin-top:10px;border-radius:4px;background:rgba(148,163,184,.2);overflow:hidden}
@keyframes pgpt-host-slide{0%{left:-40%}100%{left:100%}}
#pokernow-gpt-suggestion .pgpt-status-bar{position:absolute;top:0;bottom:0;width:40%;border-radius:4px;
  background:linear-gradient(90deg,rgba(96,165,250,0),#60a5fa,rgba(96,165,250,0));animation:pgpt-host-slide 1.2s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){#pokernow-gpt-suggestion *,#pokernow-gpt-suggestion{animation:none !important}}
`;
