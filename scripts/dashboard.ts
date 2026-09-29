// Local web dashboard for importing PokerNow logs and viewing player metrics.
//   npm run dashboard            -> http://localhost:4545
//   DASHBOARD_PORT=5000 npm run dashboard   (or DASHBOARD_PORT in .env)
// `npm start` also runs this in the background (launchDashboard in app/dashboard/server.ts): it then
// reports over the IPC channel instead of printing, and exits when the bot does.
import dotenv from "dotenv";

import { dashboardPort, DEFAULT_DASHBOARD_PORT, EXIT_PORT_IN_USE, isDashboardAt, startDashboard } from "../app/dashboard/server.ts";

// the same port as the bot uses (a value already set, e.g. by the bot, wins)
dotenv.config();
let port = dashboardPort(process.env.DASHBOARD_PORT);
if (port === null) {
    console.error(`DASHBOARD_PORT must be a port number, like 4545 (it is "${process.env.DASHBOARD_PORT}").`);
    process.exit(1);
}
// 0 only turns off the bot's automatic start; started by hand, use the usual port
if (port === 0) port = DEFAULT_DASHBOARD_PORT;
const db_file = process.env.DB_FILE ?? "./app/pokernow-gpt.db";

try {
    const listening = await startDashboard(port, db_file);
    if (process.env.DASHBOARD_BACKGROUND === "1" && process.send) {
        // started by the bot: stop when it goes, even if it was killed without a chance to stop us
        if (!process.connected) process.exit(0);
        process.on("disconnect", () => process.exit(0));
        process.send({ ready: listening });
    } else {
        console.log(`Dashboard running at http://localhost:${listening}  (Ctrl+C to stop)`);
    }
} catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        console.error(await isDashboardAt(port, db_file)
            ? `The stats page is already running at http://localhost:${port} (open it in your browser).`
            : `Port ${port} is already in use by another program, so the stats page could not start. Pick another port, for example: DASHBOARD_PORT=${port === 65535 ? 4546 : port + 1} npm run dashboard`);
        process.exit(EXIT_PORT_IN_USE);
    }
    console.error(`The stats page could not start: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
}
