// Cross-platform replacement for start-chrome.sh: opens a dedicated Chrome window with the
// remote debugging port enabled so the bot (assistant mode) can attach to it.
// If a debuggable Chrome is already listening on the port, it is reused.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";

import webdriver_config from "../app/configs/webdriver-config.json" with { type: "json" };

const port = Number(process.env.CHROME_DEBUG_PORT ?? webdriver_config.debugging_port ?? 9222);
const profile_dir = process.env.CHROME_PROFILE_DIR ?? path.join(os.homedir(), ".pokernow-gpt", "chrome-profile");

async function isDebuggerUp(): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        return res.ok;
    } catch {
        return false;
    }
}

function candidatePaths(): string[] {
    const home = os.homedir();
    switch (process.platform) {
        case "darwin":
            return [
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
            ];
        case "win32": {
            const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env["LOCALAPPDATA"]]
                .filter((root): root is string => !!root);
            return roots.flatMap((root) => [
                path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
                path.join(root, "Microsoft", "Edge", "Application", "msedge.exe")
            ]);
        }
        default: {
            const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
            const dirs = (process.env.PATH ?? "").split(path.delimiter).concat(["/snap/bin"]);
            return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
        }
    }
}

async function findChrome(): Promise<string | undefined> {
    if (process.env.CHROME_PATH) {
        return process.env.CHROME_PATH;
    }
    const found = candidatePaths().find((p) => existsSync(p));
    if (found) {
        return found;
    }
    // fall back to the Chrome that puppeteer downloads during `npm install`
    try {
        const bundled = await puppeteer.executablePath();
        return existsSync(bundled) ? bundled : undefined;
    } catch {
        return undefined;
    }
}

async function main() {
    if (!webdriver_config.use_existing_browser) {
        console.log("use_existing_browser is false in webdriver-config.json; the bot will launch its own browser.");
        return;
    }
    if (await isDebuggerUp()) {
        console.log(`Chrome is already listening on debug port ${port}; reusing it.`);
        return;
    }

    const chrome = await findChrome();
    if (!chrome) {
        console.error("Could not find Chrome, Chromium or Edge. Install Chrome, or set CHROME_PATH in .env to the browser executable.");
        process.exit(1);
    }

    mkdirSync(profile_dir, { recursive: true });
    const args = [
        `--remote-debugging-port=${port}`,
        // a separate profile is required: Chrome refuses remote debugging on the default profile
        `--user-data-dir=${profile_dir}`,
        "--no-first-run",
        "--no-default-browser-check",
        ...(process.env.CHROME_EXTRA_ARGS ? process.env.CHROME_EXTRA_ARGS.split(" ").filter(Boolean) : []),
        "https://www.pokernow.club"
    ];
    console.log(`Starting a dedicated Chrome window on debug port ${port}:\n  ${chrome}`);
    const child = spawn(chrome, args, { detached: true, stdio: "ignore" });
    child.unref();

    for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (await isDebuggerUp()) {
            console.log("Chrome is ready. In that window: open your PokerNow game, take a seat, and wait for the host to approve.");
            return;
        }
    }
    console.error(`Chrome did not open debug port ${port} within 10 seconds. If another Chrome is using the profile at ${profile_dir}, close it and retry.`);
    process.exit(1);
}

await main();
