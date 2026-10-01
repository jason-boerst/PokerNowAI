// Where you lose money: your results by preflop line and seat, your stats against your games' average player,
// exact river checks, and (unless --fast) the spots where you went against the engine.
//   npm run leaks -- <db file> [--fast] [--all] [--budget MS] [--out report.json]
// Reads the database only. Never prints player names.
import { writeFileSync } from "node:fs";
import { DBService } from "../app/services/db-service.ts";
import { HandRecorder } from "../app/services/hand-recorder.ts";
import { ProfileService } from "../app/services/profile-service.ts";
import { leakReport, LeakLine } from "../app/eval/leaks.ts";
import { replayAll } from "../app/eval/replay.ts";

const args = process.argv.slice(2);
const value = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const VALUE_OPTIONS = ["--budget", "--out"];
const db_file = args.find((a, i) => !a.startsWith("--") && (i === 0 || !VALUE_OPTIONS.includes(args[i - 1])));
if (!db_file) {
    console.log("usage: npm run leaks -- <db file> [--fast] [--all] [--budget MS] [--out report.json]");
    process.exit(1);
}
const fast = args.includes("--fast");
const show_all = args.includes("--all");
const budget = Number(value("--budget") ?? 60);
const out_file = value("--out");

const db = new DBService(db_file);
await db.init();
const recorder = new HandRecorder(db);
const rows = await recorder.hands();
const profiles = new ProfileService(recorder);
await profiles.load();
const links = await recorder.links();
await db.close();

const hands = fast ? undefined : await replayAll(rows, links, {
    time_budget_ms: budget,
    progress: (done, total) => process.stderr.write(`\rasking the engine about your decisions: game ${done} of ${total}`)
});
if (!fast) process.stderr.write("\n");
const report = leakReport(rows, profiles, hands);

const sign = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const describe = (l: LeakLine) => {
    if (l.result) {
        const w = l.result;
        return `${String(l.n).padStart(5)} hands  ${sign(w.bb_per_100).padStart(8)} bb/100  ${Number.isFinite(w.ci_low) ? `95% CI [${sign(w.ci_low)}, ${sign(w.ci_high)}]` : "(too few to tell)"}`;
    }
    return `${String(l.n).padStart(5)} chances  you ${pct(l.rate ?? 0).padStart(6)}  vs ${pct(l.benchmark ?? 0).padStart(6)}  (z ${sign(l.z ?? 0)})`;
};

console.log("Your leaks");
console.log("==========");
console.log(`${report.hands} of your Hold'em hands with known cards${fast ? " (engine comparison skipped: --fast)" : ""}.`);
console.log(`${report.tested} lines had enough data to test (20+ hands or chances). A line is flagged only when |z| >= ${report.z_bar.toFixed(2)},`);
console.log("the bar that keeps the chance of any false flag across all of them near 5%. Results by line are correlational:");
console.log("the cards you were dealt decide most of them. River checks compare what happened with what the price needed.");
console.log();
const flagged = report.lines.filter((l) => l.flagged);
console.log(flagged.length ? "Findings" : "Findings: none clear yet (nothing passed the bar; more hands needed, or no large leak in these lines).");
for (const l of flagged) {
    console.log(`  * ${l.label}`);
    console.log(`      ${describe(l)}`);
    console.log(`      ${l.note}`);
}
const AREAS: [LeakLine["area"], string][] = [["preflop", "Results by preflop line and seat"], ["postflop", "Results by what you did after the flop"], ["frequency", "Your stats against your games' average player"],
    ["river", "River checks"], ["engine", "Where you went against the engine"]];
for (const [area, title] of AREAS) {
    const lines = report.lines.filter((l) => l.area === area && (show_all || l.n >= 20 || area === "river"));
    if (!lines.length) continue;
    console.log();
    console.log(title + (show_all || area === "river" ? "" : " (20+ hands; --all for every line)"));
    for (const l of lines) console.log(`  ${l.flagged ? "*" : " "} ${l.label.padEnd(56)} ${describe(l)}`);
    if (area === "river") for (const l of lines) console.log(`      ${l.note}`);
}
if (out_file) {
    writeFileSync(out_file, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${out_file}`);
}
