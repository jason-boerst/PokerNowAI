// What the tool has learned from your stored hands so far, and what still runs on built-in guesses.
//   npm run learning -- [db file] [--no-history]
// Prints the report and adds one row (counts only, no names) to reports/learning-history.jsonl, so later runs show
// how the numbers move as you import more logs. Reads the database only.
import { DBService } from "../app/services/db-service.ts";
import { HandRecorder } from "../app/services/hand-recorder.ts";
import { ProfileService } from "../app/services/profile-service.ts";
import { appendHistory, formatStatus, learningStatus, readHistory } from "../app/eval/learning-status.ts";

export const HISTORY_FILE = "reports/learning-history.jsonl";

const args = process.argv.slice(2);
const db_file = args.find((a) => !a.startsWith("--")) ?? "./app/pokernow-gpt.db";
const db = new DBService(db_file);
await db.init();
const recorder = new HandRecorder(db);
const profiles = new ProfileService(recorder);
await profiles.load();
const decisions = await recorder.decisions().catch(() => []);
await db.close();

const status = learningStatus(profiles, decisions);
if (!args.includes("--no-history")) appendHistory(HISTORY_FILE, status);
console.log("What the tool has learned from your hands");
console.log("=========================================");
for (const line of formatStatus(status, readHistory(HISTORY_FILE))) console.log(line);
