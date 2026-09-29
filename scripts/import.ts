// Imports PokerNow log exports (the CSV from "Log" -> "Download full log") into the hand database.
//   npm run import -- ~/Downloads/poker_now_log_pglAbC.csv   (one or more files)
//   npm run import -- ~/Downloads                            (every CSV in a folder)
//   npm run import                                           (the logs/ folder in this project)
// Re-importing is safe: hands already stored are skipped.
import { existsSync } from "node:fs";

import { DBService } from "../app/services/db-service.ts";
import { HandRecorder } from "../app/services/hand-recorder.ts";
import { importFiles } from "../app/import/importer.ts";

const targets = process.argv.slice(2);
if (targets.length === 0) {
    if (!existsSync("logs")) {
        console.log("Usage: npm run import -- <log.csv or folder> [...]\n(or put PokerNow log CSVs in a logs/ folder in this project and run npm run import)");
        process.exit(1);
    }
    targets.push("logs");
}
const db = new DBService("./app/pokernow-gpt.db");
await db.init();
await db.createTables();
const recorder = new HandRecorder(db);
const summaries = await importFiles(recorder, targets);
const added = summaries.reduce((n, s) => n + s.added, 0);
console.log(`\nDone: ${added} new hand(s) from ${summaries.length} file(s). See players with \`npm run players\` or \`npm run dashboard\`.`);
await db.close();
