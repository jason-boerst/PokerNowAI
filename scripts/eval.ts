// Replays recorded decision prompts through one or more models and scores them.
//   npm run eval                                  (current model, up to 50 most recent decisions)
//   npm run eval -- --models a/model,b/model --limit 100 --labeled-only
// Scores: legal (action allowed in that spot), agreement with your labels (npm run label), latency.
// Each decision is sent as a single prompt without the earlier turns of that hand, so results can
// differ slightly from live play. Every request costs money on your API account.
import dotenv from "dotenv";

import ai_config_json from "../app/configs/ai-config.json" with { type: "json" };
import { AIServiceFactory, resolveAIConfig } from "../app/helpers/ai-service-factory.ts";
import { readLastModel } from "../app/helpers/model-picker.ts";
import { ask } from "../app/helpers/terminal.ts";
import { DBService } from "../app/services/db-service.ts";
import { DecisionRow, HandRecorder } from "../app/services/hand-recorder.ts";
import { actionsAgree, checkLegality, parseSuggestedAction, SuggestedAction } from "../app/engine/legality.ts";
import { spotFromRecord } from "../app/engine/spot-format.ts";

dotenv.config();
const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
};
const config = resolveAIConfig(ai_config_json);
const models = (arg("--models") ?? (config.model_name || readLastModel() || "")).split(",").map((m) => m.trim()).filter(Boolean);
const limit = Number(arg("--limit") ?? 50);
const labeled_only = process.argv.includes("--labeled-only");
if (models.length === 0) {
    console.log("No model to evaluate. Pass --models provider/model[,other/model].");
    process.exit(1);
}

const db = new DBService("./app/pokernow-gpt.db");
await db.init();
await db.createTables();
const rows: DecisionRow[] = (await new HandRecorder(db).decisions())
    .filter((d) => d.prompt && (!labeled_only || d.label))
    .slice(-limit);
if (rows.length === 0) {
    console.log(labeled_only ? "No labeled decisions yet (run `npm run label`)." : "No recorded decisions yet.");
    process.exit(0);
}

const calls = rows.length * models.length;
if (!process.argv.includes("--yes")) {
    const answer = await ask(`This sends ${calls} request(s) (${rows.length} decisions x ${models.length} model(s)) and costs money. Continue? (y/N) `);
    if (answer.toLowerCase() !== "y") process.exit(0);
}

interface Score { n: number, legal: number, parsed: number, labeled: number, agree: number, latencies: number[], errors: number }

async function evaluate(model: string): Promise<Score> {
    const service = new AIServiceFactory().createAIService({ ...config, model_name: model });
    service.init();
    const score: Score = { n: 0, legal: 0, parsed: 0, labeled: 0, agree: 0, latencies: [], errors: 0 };
    let next = 0;
    const worker = async () => {
        while (next < rows.length) {
            const row = rows[next++];
            const { state, view } = spotFromRecord(JSON.parse(row.messages_json), row.hero_name, row.hero_cards, row.big_blind);
            if (!view) continue;
            score.n++;
            try {
                const started = Date.now();
                const res = await service.query(row.prompt, []);
                score.latencies.push(Date.now() - started);
                const b = res.bot_action;
                const suggested: SuggestedAction | null = b.action_str ? parseSuggestedAction(`${b.action_str} ${b.bet_size_in_BBs || ""}`) : null;
                if (!suggested) continue;
                score.parsed++;
                if (checkLegality(suggested, view, state.big_blind).legal) score.legal++;
                const label = row.label ? parseSuggestedAction(row.label) : null;
                if (label) {
                    score.labeled++;
                    if (actionsAgree(suggested, label)) score.agree++;
                }
            } catch (err) {
                score.errors++;
            }
        }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return score;
}

const pct = (a: number, b: number) => b ? `${Math.round(a / b * 100)}%` : "-";
const pctl = (xs: number[], p: number) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] / 1000 : NaN;
console.log(`\n${"model".padEnd(40)} ${"spots".padStart(5)} ${"parsed".padStart(7)} ${"legal".padStart(6)} ${"agrees w/ label".padStart(16)} ${"median s".padStart(9)} ${"p90 s".padStart(6)} ${"errors".padStart(6)}`);
for (const model of models) {
    const s = await evaluate(model);
    console.log(`${model.padEnd(40)} ${String(s.n).padStart(5)} ${pct(s.parsed, s.n).padStart(7)} ${pct(s.legal, s.n).padStart(6)} ` +
        `${`${pct(s.agree, s.labeled)} of ${s.labeled}`.padStart(16)} ${pctl(s.latencies, 0.5).toFixed(1).padStart(9)} ${pctl(s.latencies, 0.9).toFixed(1).padStart(6)} ${String(s.errors).padStart(6)}`);
}
console.log("\nLabels are your judgment, not a solver's. Agreement is only meaningful with a few dozen labeled spots.");
await db.close();
