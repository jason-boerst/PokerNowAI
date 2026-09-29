// Walk through recorded decisions and enter the correct action for spots you care about.
// Labels are used by `npm run eval` to score models.
//   npm run label            (unlabeled decisions, newest first)
//   npm run label -- --all   (include already-labeled ones)
import { DBService } from "../app/services/db-service.ts";
import { HandRecorder } from "../app/services/hand-recorder.ts";
import { checkLegality, parseSuggestedAction } from "../app/engine/legality.ts";
import { formatActions, formatSpot, spotFromRecord } from "../app/engine/spot-format.ts";
import { ask } from "../app/helpers/terminal.ts";

const db = new DBService("./app/pokernow-gpt.db");
await db.init();
await db.createTables();
const recorder = new HandRecorder(db);
const include_labeled = process.argv.includes("--all");
const rows = (await recorder.decisions()).filter((d) => include_labeled || !d.label).reverse();

if (rows.length === 0) {
    console.log("No decisions to label.");
}
let saved = 0;
for (const row of rows) {
    const { state, view } = spotFromRecord(JSON.parse(row.messages_json), row.hero_name, row.hero_cards, row.big_blind);
    if (!view) continue;
    const bot = JSON.parse(row.action_json ?? "null");
    console.log(`\n#${row.id}  hand ${row.hand_number}  your cards: ${row.hero_cards || "?"}`);
    for (const l of formatActions(state)) console.log(`  ${l}`);
    console.log(`  ${formatSpot(state, view)}`);
    console.log(`  bot suggested (${row.model}): ${bot ? `${bot.action_str} ${bot.bet_size_in_BBs || ""}`.trim() : "?"}${row.label ? `   current label: ${row.label}` : ""}`);

    while (true) {
        const answer = await ask(`Correct action (e.g. fold, check, call, raise 3.5 [BB, raise-to]), Enter = skip, q = quit: `);
        if (answer.toLowerCase() === "q") {
            console.log(`Saved ${saved} label(s).`);
            await db.close();
            process.exit(0);
        }
        if (!answer) break;
        const action = parseSuggestedAction(answer);
        if (!action) {
            console.log("Didn't understand that. Examples: fold, check, call, bet 2, raise 7.5, all in");
            continue;
        }
        const legality = checkLegality(action, view, state.big_blind);
        if (!legality.legal) {
            console.log(`That isn't legal here: ${legality.reason}`);
            continue;
        }
        await recorder.setLabel(row.id, `${action.action}${action.size_bb ? ` ${action.size_bb}` : ""}`);
        saved++;
        break;
    }
}
console.log(`Saved ${saved} label(s).`);
await db.close();
