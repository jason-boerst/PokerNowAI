// Win rate from recorded hands, overall and by the model that made most of the hand's decisions.
//   npm run stats
import { DBService } from "../app/services/db-service.ts";
import { HandRecorder } from "../app/services/hand-recorder.ts";
import { summarizeWinrate, WinrateSummary } from "../app/engine/winrate.ts";
import { parseHand } from "../app/engine/hand-parser.ts";
import { allInAdjustedNet } from "../app/engine/allin-ev.ts";

const db = new DBService("./app/pokernow-gpt.db");
await db.init();
await db.createTables();
const recorder = new HandRecorder(db);
const hands = (await recorder.hands()).filter((h) => h.hero_net !== null && h.big_blind);
const decisions = await recorder.decisions();

const fmt = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1);
const line = (label: string, w: WinrateSummary) =>
    `${label.padEnd(40)} ${String(w.hands).padStart(6)} hands  ${fmt(w.bb_per_100).padStart(8)} bb/100  ` +
    `95% CI [${fmt(w.ci_low)}, ${fmt(w.ci_high)}]  total ${fmt(w.total_bb)} BB` +
    (w.inconclusive ? "  (can't tell yet)" : "");

if (hands.length === 0) {
    console.log("No recorded hands yet. Hands are recorded automatically while the bot runs.");
} else {
    console.log(line("All hands", summarizeWinrate(hands.map((h) => h.hero_net! / h.big_blind!))));

    // luck-adjusted: all-ins before the river with both hands shown count at hero's equity share
    let adjusted_count = 0;
    const adjusted = hands.map((h) => {
        const state = parseHand(JSON.parse(h.messages_json), { hero_name: h.hero_name ?? undefined, big_blind: h.big_blind! });
        const adj = state.hero_id ? allInAdjustedNet(state, state.hero_id) : null;
        if (adj !== null) adjusted_count++;
        return (adj ?? h.hero_net!) / h.big_blind!;
    });
    console.log(line(`All-in adjusted (${adjusted_count} all-in hand(s))`, summarizeWinrate(adjusted)));

    // attribute each hand to the model that made most of its decisions
    const model_of = new Map<string, string>();
    const counts = new Map<string, Map<string, number>>();
    for (const d of decisions) {
        const key = `${d.game_id}#${d.hand_number}`;
        const c = counts.get(key) ?? new Map<string, number>();
        c.set(d.model, (c.get(d.model) ?? 0) + 1);
        counts.set(key, c);
    }
    for (const [key, c] of counts) {
        model_of.set(key, [...c.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    }
    const by_model = new Map<string, number[]>();
    for (const h of hands) {
        const model = model_of.get(`${h.game_id}#${h.hand_number}`) ?? "(no decision this hand)";
        by_model.set(model, [...(by_model.get(model) ?? []), h.hero_net! / h.big_blind!]);
    }
    for (const [model, results] of [...by_model.entries()].sort()) {
        console.log(line(`  ${model}`, summarizeWinrate(results)));
    }
    console.log("\nPoker results are noisy: a real edge usually needs tens of thousands of hands to show up reliably.");
    console.log("Treat any interval that crosses zero as \"no conclusion yet\". Use `npm run eval` to compare decision quality instead.");
}
await db.close();
