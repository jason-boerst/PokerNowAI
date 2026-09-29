// Local web dashboard for importing PokerNow logs and viewing player metrics.
//   npm run dashboard            -> http://localhost:4545
//   DASHBOARD_PORT=5000 npm run dashboard
import { startDashboard } from "../app/dashboard/server.ts";

await startDashboard(Number(process.env.DASHBOARD_PORT ?? 4545), process.env.DB_FILE ?? "./app/pokernow-gpt.db");
