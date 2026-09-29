// Checks whether the PokerNow page elements the bot relies on are present.
// Run it while your game is open in the Chrome window started by `npm start` / `npm run chrome`:
//   npm run diagnose
// It only prints element counts, the blinds text, and tab URLs (no names or cards).
import puppeteer from "puppeteer";

import webdriver_config from "../app/configs/webdriver-config.json" with { type: "json" };

const port = Number(process.env.CHROME_DEBUG_PORT ?? webdriver_config.debugging_port ?? 9222);

// [selector, what it is used for, when you should expect to see it]
const checks: Array<[string, string, string]> = [
    [".game-infos > .blind-value-ctn > .blind-value", "blinds / game type", "always"],
    [".table-player", "players at the table", "always"],
    [".table > .table-pot-size > .main-value", "pot size", "during a hand"],
    [".table-player-seat-button", "empty seat buttons", "when seats are free"],
    [".you-player", "you (seated)", "after the host approves you"],
    [".you-player .table-player-name", "your name", "when seated"],
    [".you-player > .table-player-infos-ctn > div > .table-player-stack", "your stack", "when seated"],
    [".you-player > .table-player-cards > div", "your hole cards", "when you are dealt in"],
    [".you-player > .table-player-cards > div .value", "card values", "when you are dealt in"],
    [".you-player > .table-player-cards > div .sub-suit", "card suits", "when you are dealt in"],
    [".you-player > .waiting, .you-player > .waiting-next-hand", "waiting for next hand", "between hands"],
    [".action-signal", "your turn signal", "on your turn"],
    [".game-decisions-ctn > .action-buttons > .fold", "fold button", "on your turn"],
    [".game-decisions-ctn > .action-buttons > .check, .game-decisions-ctn > .action-buttons > .call", "check/call button", "on your turn"],
    [".game-decisions-ctn > .action-buttons > .raise", "raise button", "on your turn"],
    [".table-player.winner", "hand winner", "at the end of a hand"]
];

let browser;
try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
} catch {
    console.error(`Could not connect to Chrome on debug port ${port}. Start it with \`npm start\` or \`npm run chrome\` first.`);
    process.exit(1);
}

const pages = await browser.pages();
console.log(`Chrome tabs (${pages.length}):`);
for (const p of pages) {
    console.log(`  ${p.url()}`);
}

const game_page = pages.find((p) => /\/games\//.test(p.url()));
if (!game_page) {
    console.log("\nNo tab with a PokerNow game (URL containing /games/) is open. Open your game in that Chrome window and run this again.");
    await browser.disconnect();
    process.exit(1);
}

console.log(`\nChecking ${game_page.url()}\n`);
for (const [selector, label, expected] of checks) {
    const count = await game_page.$$eval(selector, (els) => els.length).catch(() => -1);
    const status = count > 0 ? "found" : count === 0 ? "missing" : "error";
    console.log(`  ${status.padEnd(7)} ${String(Math.max(count, 0)).padStart(3)}  ${label}  (expected ${expected})`);
}

const blinds = await game_page.$eval(".game-infos > .blind-value-ctn > .blind-value", (el) => el.textContent).catch(() => null);
console.log(`\nBlinds text: ${blinds === null ? "(not found)" : JSON.stringify(blinds)}`);
console.log("\nIf items marked \"expected always\" are missing while the table is visible, PokerNow's page layout has changed.");

await browser.disconnect();
