// One benchmark for every engine change: the numbers that say whether a change helped, in one JSON, and a
// comparison with an earlier run. Each number is labeled with what it can show.
//   npm run benchmark -- <db file> [--out reports/x.json] [--compare reports/old.json] [--sim-hands N] [--no-sim]
//        [--workers K] [--seed S]
// Reads the database only (work on a copy). Never prints player names. Fixed seeds, so two runs on the same code
// and data give the same numbers (except timing).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname } from "node:path";
import { DBService } from "../app/services/db-service.ts";
import { HandRecorder, HandRow } from "../app/services/hand-recorder.ts";
import { ProfileService } from "../app/services/profile-service.ts";
import { replayAll } from "../app/eval/replay.ts";
import { comparePolicies, counterfactualSpots } from "../app/eval/counterfactual.ts";
import { agreementReport } from "../app/eval/agreement.ts";
import { capturePool, simulateParallel, summarizeSim } from "../app/eval/simulate.ts";
import { parseHand, HandState } from "../app/engine/hand-parser.ts";
import { isHoldem } from "../app/engine/player-profile.ts";
import { calibrateResponses, responseFor, roleOf } from "../app/engine/response-calibration.ts";
import { PostflopStreet, setActionWeights } from "../app/engine/equity.ts";
import { analyzePostflop, setResponseTable } from "../app/engine/postflop.ts";
import { opponentTendencies } from "../app/helpers/decision-maker.ts";
import { TELL_KINDS } from "../app/engine/seven-deuce-tells.ts";
import { SCENARIOS, runScenario, useBuiltInDefaults } from "./scenarios.ts";
import { ME } from "../app/services/hand-recorder.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const VALUE_OPTIONS = ["--out", "--compare", "--sim-hands", "--workers", "--seed"];
const db_file = args.find((a, i) => !a.startsWith("--") && (i === 0 || !VALUE_OPTIONS.includes(args[i - 1])));
if (!db_file) {
    console.log("usage: npm run benchmark -- <db file> [--out reports/x.json] [--compare reports/old.json] [--sim-hands N] [--no-sim] [--workers K] [--seed S]");
    process.exit(1);
}
const sim_hands = Math.max(0, Number(option("--sim-hands") ?? 10000));
const workers = Math.max(1, Number(option("--workers") ?? Math.min(8, availableParallelism())));
const seed = Number(option("--seed") ?? 11);

/** A number with the half-width of its 95% interval (0 when exact), so comparisons can tell change from noise. */
export interface Metric { value: number, half: number, better: "higher" | "lower" | "none", note: string }
const metric = (value: number, half: number, better: Metric["better"], note: string): Metric =>
    ({ value: Math.round(value * 1000) / 1000, half: Math.round(half * 1000) / 1000, better, note });

const t0 = Date.now();
const db = new DBService(db_file);
await db.init();
const recorder = new HandRecorder(db);
const rows = await recorder.hands();
const links = await recorder.links();
await db.close();
const metrics: Record<string, Metric> = {};
const log = (line = "") => console.log(line);

// --- real-card counterfactuals (leave one game out) ---
process.stderr.write("replaying your hands...\n");
const hands = await replayAll(rows, links, { time_budget_ms: 120 });
const spots = counterfactualSpots(hands);
const half = (i: { normal_low: number, normal_high: number }) => (i.normal_high - i.normal_low) / 2;
const board = comparePolicies(spots, "board"), eq = comparePolicies(spots, "equity");
metrics.cf_engine_minus_you_bb = metric(board.difference.total, half(board.difference), "higher", `real-card spots (${spots.length}), actual boards; selection bias toward calls`);
metrics.cf_engine_minus_you_equity_bb = metric(eq.difference.total, half(eq.difference), "higher", "same spots valued by equity (less luck)");
for (const st of ["preflop", "flop", "turn", "river"] as const) {
    const c = comparePolicies(spots.filter((s) => s.street === st), "equity");
    metrics[`cf_${st}_equity_bb`] = metric(c.difference.total, half(c.difference), "higher", `${c.spots} ${st} spots by equity`);
}
metrics.cf_engine_folds_you_continued = metric(board.engine_fold_you_continue.n, 0, "none", "spots where the engine folds and you continued");
const agree = agreementReport(hands);
metrics.agreement_pct = metric(agree.decision_agreement * 100, 0, "none", `${agree.decisions} decisions: share where the engine's kind of action matches yours`);
for (const st of ["preflop", "flop", "turn", "river"] as const) {
    const a = agree.street_agreement[st];
    metrics[`agreement_${st}_pct`] = metric(a.matched / Math.max(1, a.compared) * 100, 0, "none", `${a.compared} ${st} decisions`);
}

// --- how bets are read: fair-sample fit and 7-2 tells (all games) ---
const profiles = new ProfileService({ hands: async () => rows, links: async () => links } as unknown as HandRecorder);
await profiles.load();
const bluff = profiles.actionWeights().bluff;
if (bluff && bluff.samples > 0) {
    metrics.bluff_fit_loglik_per_bet = metric(bluff.log_likelihood_fitted / bluff.samples, 0, "higher", `log-likelihood per called river bettor (${bluff.samples}); the engine's reading of bettors`);
    metrics.bluff_scale = metric(bluff.scale, 0, "none", "fitted flop/turn bluff scale");
}
const tells = profiles.sevenDeuceTells();
metrics.tells_active = metric(TELL_KINDS.filter((k) => tells.stats[k].active).length, 0, "none", "7-2 tells that pass the significance test");

// --- response table calibration (leave one game out): log loss of fold predictions for first bets heads-up ---
{
    const states = rows.map((r) => ({ game: r.game_id, s: safeParse(r) })).filter((x): x is { game: string, s: HandState } => !!x.s);
    const games = [...new Set(states.map((x) => x.game))];
    let loss = 0, n = 0, predicted = 0, actual = 0;
    const losses: number[] = [];
    for (const g of games) {
        const keyOf = (seat: { id: string }) => links.get(seat.id) ?? seat.id;
        const table = calibrateResponses(states.filter((x) => x.game !== g).map((x) => x.s), (seat) => keyOf(seat) !== ME).table;
        for (const { s } of states.filter((x) => x.game === g)) {
            for (const c of firstBetsHeadsUp(s)) {
                const p = Math.min(0.97, Math.max(0.03, responseFor(table, c.street, c.role, c.share).fold));
                const l = -(c.fold ? Math.log(p) : Math.log(1 - p));
                loss += l; losses.push(l); n++; predicted += p; actual += c.fold ? 1 : 0;
            }
        }
    }
    const mean = loss / Math.max(1, n);
    const sd = Math.sqrt(losses.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n - 1));
    metrics.response_logloss = metric(mean, 1.96 * sd / Math.sqrt(Math.max(1, n)), "lower", `fold predictions for ${n} first bets heads-up, games held out`);
    metrics.response_fold_bias_pct = metric((predicted - actual) / Math.max(1, n) * 100, 0, "none", "predicted minus actual fold rate (percentage points)");
}

// --- post-flop timing ---
{
    const ms: number[] = [];
    setActionWeights(profiles.actionWeights().weights);
    setResponseTable(profiles.responseTable().table);
    const post = hands.flatMap((h) => h.decisions).filter((d) => d.street !== "preflop" && d.state.hero_cards.length === 2).slice(0, 150);
    for (const d of post) {
        const start = performance.now();
        analyzePostflop(d.state, d.view, opponentTendencies(d.state, (p) => profiles.stats(p), (p) => profiles.info(p)));
        ms.push(performance.now() - start);
    }
    ms.sort((a, b) => a - b);
    metrics.postflop_ms_p50 = metric(ms[Math.floor(ms.length / 2)] ?? 0, 0, "lower", `${ms.length} post-flop analyses (live budget 120 ms)`);
    metrics.postflop_ms_p95 = metric(ms[Math.floor(ms.length * 0.95)] ?? 0, 0, "lower", "keep well under the action clock");
}

// --- simulator: engine and control seat against the engine's model of your pool ---
if (!flag("--no-sim") && sim_hands > 0) {
    const pool = capturePool(profiles.actionWeights().weights, profiles.responseTable().table);
    for (const [players, stack] of [[6, 100], [6, 250], [2, 100]] as const) {
        for (const hero of ["engine", "pool"] as const) {
            process.stderr.write(`simulating ${players}-handed, ${stack} BB, ${hero} seat...\n`);
            const r = summarizeSim(await simulateParallel(pool, { players, hands: sim_hands, seed: seed + players + stack, hero, stack_bb: stack, engine_budget_ms: 15 }, workers));
            const w = r.adjusted;
            metrics[`sim_${players}max_${stack}bb_${hero}`] = metric(w.bb_per_100, (w.ci_high - w.ci_low) / 2, hero === "engine" ? "higher" : "none",
                `${r.hands} simulated hands, all-in adjusted bb/100 against the engine's model of your pool${hero === "pool" ? " (control, should be about 0)" : ""}`);
        }
    }
}

// --- scenario suite (built-in defaults; last: it resets the engine's global averages) ---
{
    useBuiltInDefaults();
    const results = SCENARIOS.map((sc) => runScenario(sc));
    metrics.scenarios_failed = metric(results.filter((r) => !r.pass).length, 0, "lower", `of ${results.length} hand-built spots`);
}

const report = { created: new Date().toISOString(), db_hands: rows.length, seconds: Math.round((Date.now() - t0) / 1000), metrics };
for (const [k, m] of Object.entries(metrics)) log(`${k.padEnd(36)} ${String(m.value).padStart(10)}${m.half ? ` ± ${m.half}` : ""}  ${m.note}`);
const out = option("--out");
if (out) {
    if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2));
    log(`\nWritten to ${out}.`);
}

// --- comparison with an earlier run ---
const old_file = option("--compare");
if (old_file) {
    const old = JSON.parse(readFileSync(old_file, "utf8")) as typeof report;
    log(`\nCompared with ${old_file}:`);
    log("A change counts only when it is bigger than the combined 95% half-widths (an unpaired, cautious band; both runs use the same hands, so real noise is smaller).");
    for (const [k, m] of Object.entries(metrics)) {
        const o = old.metrics[k];
        if (!o) { log(`  ${k.padEnd(36)} new: ${m.value}`); continue; }
        const d = m.value - o.value;
        const band = Math.sqrt(m.half ** 2 + o.half ** 2);
        const verdict = m.better === "none" ? "" : Math.abs(d) <= band ? "  (within noise)"
            : (d > 0) === (m.better === "higher") ? "  BETTER" : "  WORSE";
        log(`  ${k.padEnd(36)} ${String(o.value).padStart(10)} -> ${String(m.value).padStart(10)}  (${d >= 0 ? "+" : ""}${Math.round(d * 1000) / 1000}${band ? `, band ±${Math.round(band * 1000) / 1000}` : ""})${verdict}`);
    }
}

function safeParse(r: HandRow): HandState | null {
    try {
        const s = parseHand(JSON.parse(r.messages_json), { big_blind: r.big_blind ?? undefined });
        return isHoldem(s) && !s.bomb_pot ? s : null;
    } catch {
        return null;
    }
}

/** The first bet of each street when two players are left, and whether the other player folded to it. */
function firstBetsHeadsUp(s: HandState): { street: PostflopStreet, role: ReturnType<typeof roleOf>, share: number, fold: boolean }[] {
    const out: { street: PostflopStreet, role: ReturnType<typeof roleOf>, share: number, fold: boolean }[] = [];
    const folded = new Set<string>();
    const seen = new Set<string>();
    s.actions.forEach((a, i) => {
        if (a.street !== "preflop" && a.type === "bet" && !seen.has(a.street)) {
            seen.add(a.street);
            const active = s.seats.filter((p) => !folded.has(p.id));
            const reply = s.actions.slice(i + 1).find((x) => x.street === a.street && x.player_id !== a.player_id);
            if (active.length === 2 && reply && ["fold", "call", "raise"].includes(reply.type)) {
                const street = a.street as PostflopStreet;
                out.push({ street, role: roleOf(s.actions.slice(0, i), a.player_id, street, folded), share: a.amount / Math.max(a.pot_before, 1e-9), fold: reply.type === "fold" });
            }
        }
        if (a.type === "fold") folded.add(a.player_id);
    });
    return out;
}
