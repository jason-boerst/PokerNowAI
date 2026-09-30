// How good is the engine on your hands? Three measures, each with what it can and can't show:
//   1. real counterfactuals where the opponent's cards became known,
//   2. your results in hands where the engine agreed with every decision vs the rest,
//   3. a simulated cash game against the engine's own model of your pool.
//   npx tsx scripts/evaluate.ts <db file> [--sim-hands N] [--out report.json] [--seed S] [--workers K]
//        [--budget MS] [--in-sample] [--no-sim] [--show-spots N]
// Reads the database only (work on a copy to be safe). Never prints player names.
import { writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { DBService } from "../app/services/db-service.ts";
import { HandRecorder } from "../app/services/hand-recorder.ts";
import { ProfileService } from "../app/services/profile-service.ts";
import { replayAll } from "../app/eval/replay.ts";
import { comparePolicies, counterfactualSpots, CounterfactualSpot, PolicyComparison } from "../app/eval/counterfactual.ts";
import { agreementReport, AgreementReport } from "../app/eval/agreement.ts";
import { capturePool, PoolModel, simulateParallel, SimSummary, summarizeSim } from "../app/eval/simulate.ts";
import { mixingReport, MixingReport } from "../app/eval/mixing-report.ts";
import type { MixStyle } from "../app/engine/mixing.ts";
import { WinrateSummary } from "../app/engine/winrate.ts";
import { SumInterval } from "../app/eval/stats.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string, fallback: number) => {
    const i = args.indexOf(name);
    const x = i >= 0 ? Number(args[i + 1]) : NaN;
    return Number.isFinite(x) ? x : fallback;
};
const text_option = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const VALUE_OPTIONS = ["--sim-hands", "--out", "--seed", "--workers", "--budget", "--show-spots"];
const db_file = args.find((a, i) => !a.startsWith("--") && (i === 0 || !VALUE_OPTIONS.includes(args[i - 1])));
if (!db_file) {
    console.log("usage: npx tsx scripts/evaluate.ts <db file> [--sim-hands N] [--out report.json] [--seed S] [--workers K] [--budget MS] [--in-sample] [--no-sim] [--show-spots N]");
    process.exit(1);
}
const sim_hands = Math.max(0, Math.floor(option("--sim-hands", 10000)));
const seed = Math.floor(option("--seed", 1));
const workers = Math.max(1, Math.floor(option("--workers", Math.min(8, availableParallelism()))));
const budget = option("--budget", 15);
const in_sample = flag("--in-sample");
const show_spots = Math.floor(option("--show-spots", 0));
const out_file = text_option("--out");

const db = new DBService(db_file);
await db.init();
const recorder = new HandRecorder(db);
const rows = await recorder.hands();
const links = await recorder.links();
await db.close();

const log = (line = "") => console.log(line);
const sign = (x: number, digits = 1) => (x >= 0 ? "+" : "") + x.toFixed(digits);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const wr = (w: WinrateSummary) => w.hands === 0 ? "no hands"
    : `${String(w.hands).padStart(5)} hands  ${sign(w.bb_per_100).padStart(8)} bb/100  95% CI [${sign(w.ci_low)}, ${sign(w.ci_high)}]${w.inconclusive ? "  (can't tell)" : ""}`;
const interval = (s: SumInterval) => `${sign(s.total)} BB (95% CI bootstrap [${sign(s.boot_low)}, ${sign(s.boot_high)}], normal [${sign(s.normal_low)}, ${sign(s.normal_high)}])`;

const t0 = Date.now();
log("PokerNow GPT evaluation on your hands");
log("=====================================");
const MIX_STYLES: MixStyle[] = ["exploit", "balanced", "gto"];
const hands = await replayAll(rows, links, {
    in_sample, time_budget_ms: 120, mix_styles: MIX_STYLES,
    progress: (done, total) => process.stderr.write(`\rreplaying your hands: game ${done} of ${total}`)
});
process.stderr.write("\n");
const games = new Set(hands.map((h) => h.game_id)).size;
const decisions = hands.reduce((n, h) => n + h.decisions.length, 0);
log(`Database: ${rows.length} hands stored; ${hands.length} of them are your Hold'em hands with known cards, in ${games} games; ${decisions} of your decisions replayed.`);
log(in_sample
    ? "Opponent profiles: built from every hand, including the game being evaluated (in-sample: flatters the engine)."
    : "Opponent profiles: for each game, built only from the OTHER games (leave one game out), so the engine never sees the hands it is judged on.");
log("Engine: the preflop engine (with its price check) and the post-flop engine's top option, AI off, as the live bot runs them.");
log("Caveat for everything below: the engine's built-in constants (response table defaults, calling ranges, size effects) were tuned on these same games, so no replay here is fully out of sample.");
log("What none of this can prove: that the tool wins in the long run. A few thousand hands are far too few; win rates need tens of thousands of hands to separate from luck.");

// --- 1. counterfactuals ---
log();
log("1. Real counterfactuals: spots where the opponent's cards became known");
log("-----------------------------------------------------------------------");
log("Every decision of yours facing a bet or raise, heads-up at that moment, where that opponent showed their cards later in the hand.");
log("Against their actual cards, calling is worth: your pot share x (pot + call) - call, relative to folding (0). The share is on the actual");
log("final board when all five cards were dealt, else your exact equity over the remaining cards. Later betting is ignored (valued as a");
log("check-down after the call; exact on the river and for all-in calls). A raise is valued like a call. Only fold vs continue is judged.");
const spots = counterfactualSpots(hands);
const by_street = (["preflop", "flop", "turn", "river"] as const).map((st) => ({ street: st, spots: spots.filter((s) => s.street === st) }));
const board_cmp = comparePolicies(spots, "board");
const equity_cmp = comparePolicies(spots, "equity");
const river = spots.filter((s) => s.street === "river");
const river_cmp = comparePolicies(river, "board");
const printComparison = (c: PolicyComparison, indent = "  ") => {
    log(`${indent}Spots: ${c.spots}. Same fold/continue choice: ${c.agree}. Spots where either side raised (valued as a call): ${c.raises}.`);
    log(`${indent}Engine continues where you folded: ${c.engine_continue_you_fold.n} spots, engine's choice ${sign(c.engine_continue_you_fold.gain_bb)} BB vs yours.`);
    log(`${indent}Engine folds where you continued: ${c.engine_fold_you_continue.n} spots, engine's choice ${sign(c.engine_fold_you_continue.gain_bb)} BB vs yours.`);
    log(`${indent}Engine's choices in total: ${interval(c.engine)}`);
    log(`${indent}Your choices in total:     ${interval(c.you)}`);
    log(`${indent}Engine minus you:          ${interval(c.difference)}`);
};
log(`Spots found: ${spots.length} (${by_street.map((b) => `${b.street} ${b.spots.length}`).join(", ")}).`);
log("All spots, valued on the actual board where known:");
printComparison(board_cmp);
log("All spots, valued by equity against their cards (less luck, same choices):");
log(`  Engine minus you: ${interval(equity_cmp.difference)}`);
log("By street (actual board where known), engine minus you:");
for (const b of by_street) {
    const c = comparePolicies(b.spots, "board");
    log(`  ${b.street.padEnd(8)} ${String(c.spots).padStart(4)} spots, ${String(c.spots - c.agree).padStart(3)} disagreements: ${interval(c.difference)}`);
}
log("River decisions only (exact: no cards to come, no later betting):");
printComparison(river_cmp);
log("Selection bias: an opponent's cards are known mostly when the hand went to showdown, which usually means you called. Spots where");
log("you folded rarely appear, and the hands opponents show are not a random draw of the hands they bet with. These totals say how the");
log("engine's fold/call choices would have done on the spots we can check, not what it would win overall.");
if (show_spots > 0) {
    log(`Sample spots (${Math.min(show_spots, spots.length)}; disagreements first):`);
    const shown = [...spots].sort((a, b) => Number((b.engine !== "fold") !== (b.actual !== "fold")) - Number((a.engine !== "fold") !== (a.actual !== "fold"))).slice(0, show_spots);
    for (const s of shown) log("  " + describeSpot(s));
}

// --- 2. agreement ---
log();
log("2. Your results when the engine agreed with you vs when it didn't");
log("------------------------------------------------------------------");
log("Each of your hands is marked \"matched\" when every engine suggestion had the same kind as what you did (fold, check, call, or");
log("bet/raise; sizes not compared). Results are all-in adjusted (all-ins before the river count at your equity).");
log("Correlational only: agreement is tied to the cards (both of you fold trash and play monsters). The gap is not the value of following the engine.");
const agree = agreementReport(hands);
log(`All your hands: ${wr(agree.overall)}`);
log(`Decisions compared: ${agree.decisions}, same kind: ${pct(agree.decision_agreement)}. By street: ` +
    (["preflop", "flop", "turn", "river"] as const).map((s) => `${s} ${pct(agree.street_agreement[s].matched / Math.max(1, agree.street_agreement[s].compared))} of ${agree.street_agreement[s].compared}`).join(", ") + ".");
for (const g of agree.splits) {
    log(`  ${g.label}`);
    log(`    matched:     ${wr(g.matched)}`);
    log(`    not matched: ${wr(g.unmatched)}`);
}
log("What you did (rows) vs what the engine suggested (columns), decision counts:");
const kinds = ["fold", "check", "call", "raise"] as const;
log("            " + kinds.map((k) => k.padStart(7)).join(""));
for (const a of kinds) log(`  you ${a.padEnd(6)} ` + kinds.map((b) => String(agree.confusion[a][b]).padStart(7)).join(""));

// --- mixing ---
log();
log("Mixing with the random number (RNG), by style");
log("---------------------------------------------");
log("At every replayed decision: which options the mix plays and how often (engine/mixing.ts). The cost is the post-flop EV given up");
log("by mixing instead of always taking the best option, by the engine's own estimates (preflop charts have no EVs, so no cost there).");
log("This shows what mixing changes, not that it wins: its benefit, being harder to read, can't be measured from these hands.");
const mixing: MixingReport[] = MIX_STYLES.map((style) => mixingReport(hands, style));
for (const r of mixing) {
    const mixed = (["preflop", "flop", "turn", "river"] as const).map((st) => `${st} ${pct(r.by_street[st].mixed / Math.max(1, r.by_street[st].decisions))}`).join(", ");
    log(`  ${r.style}: mixed spots ${mixed}; cost ${sign(-r.cost_per_100, 1)} BB per 100 hands (${sign(-r.cost_bb, 1)} BB over ${r.hands} hands)`);
    log(`    post-flop bluffs: engine ${pct(r.bluffs.engine)} of decisions, mix ${pct(r.bluffs.mix)}`);
    log(`    facing a bet (${r.defense.spots}): continues engine ${pct(r.defense.engine)}, mix ${pct(r.defense.mix)}, balanced defense (MDF) ${pct(r.defense.balanced)}`);
    log(`    not facing a bet (${r.betting.spots}): bets engine ${pct(r.betting.engine)}, mix ${pct(r.betting.mix)}, balanced range ${pct(r.betting.balanced)}`);
    log(`    all decisions: ` + kinds.map((k) => `${k} ${pct(r.kinds.engine[k])} -> ${pct(r.kinds.mix[k])}`).join(", "));
}

// --- 3. simulation ---
let sim: { pool: PoolModel, pool_hands: number, runs: { label: string, summary: SimSummary, seconds: number }[] } | null = null;
if (!flag("--no-sim") && sim_hands > 0) {
    log();
    log("3. Simulated cash game against the engine's model of your pool");
    log("---------------------------------------------------------------");
    log("CONSISTENCY CHECK AGAINST THE ENGINE'S OWN MODEL OF YOUR POOL, NOT PROOF OF REAL RESULTS.");
    log("The engine (AI off) plays against opponents who act the way the engine believes your pool plays: preflop from the ranges it");
    log("assigns to an average pool player (pool VPIP, PFR, 3-bet), after the flop from the measured response table (fold, call, raise");
    log("by street, bettor and size), the pool's bet-when-checked-to and c-bet rates, and hands chosen by the calibrated action weights.");
    log("Everyone starts every hand with 100 BB (no side pots), blinds of half a BB and one BB, no rake, no 7-2 bounty. If the model of the pool");
    log(`is wrong, so is this number. Post-flop engine time budget ${budget} ms per decision (the live bot uses 120).`);
    const profiles = new ProfileService({ hands: async () => rows, links: async () => links } as unknown as HandRecorder);
    await profiles.load();
    const pool = capturePool(profiles.actionWeights().weights, profiles.responseTable().table);
    const pool_hands = profiles.poolSummary().pool_hands;
    log(`Pool model (from ${pool_hands} opponent hands): VPIP ${pct(pool.priors.vpip)}, PFR ${pct(pool.priors.pfr)}, 3-bet ${pct(pool.priors.three_bet)}, ` +
        `c-bet ${pct(pool.priors.cbet)}, bet when checked to ${pct(pool.priors.bet_when_checked_to)}, raise vs bet ${pct(pool.priors.raise_vs_bet)}.`);
    const runs: { label: string, summary: SimSummary, seconds: number }[] = [];
    for (const players of [2, 6]) {
        for (const hero of ["engine", "pool"] as const) {
            const start = Date.now();
            const r = await simulateParallel(pool, { players, hands: sim_hands, seed: seed + players, hero, engine_budget_ms: budget }, workers);
            const summary = summarizeSim(r);
            const label = `${players === 2 ? "Heads-up" : "6-handed"}, ${hero === "engine" ? "engine in your seat" : "control: a pool player in your seat (should be about 0)"}`;
            runs.push({ label, summary, seconds: (Date.now() - start) / 1000 });
            log(`  ${label}`);
            log(`    result:         ${wr(summary.winrate)}`);
            log(`    all-in adjusted: ${wr(summary.adjusted)}`);
            log(`    your seat's VPIP ${pct(summary.vpip)}, PFR ${pct(summary.pfr)}${summary.errors ? `, ${summary.errors} hands abandoned on errors` : ""} (${((Date.now() - start) / 1000).toFixed(0)} s)`);
            if (r.error_samples.length) log(`    first error: ${r.error_samples[0]}`);
        }
    }
    log("Read the engine's number against its control: the control seat plays exactly like its opponents, so any distance from 0 there");
    log("is noise or a seat effect of the simulator.");
    sim = { pool, pool_hands, runs };
}

log();
log(`Done in ${((Date.now() - t0) / 1000).toFixed(0)} s.`);

if (out_file) {
    const report = {
        generated_at: new Date().toISOString(),
        settings: { in_sample, sim_hands, seed, workers, engine_budget_ms: budget },
        data: { hands_stored: rows.length, your_hands: hands.length, games, decisions },
        counterfactual: {
            spots: spots.length, by_board: board_cmp, by_equity: equity_cmp, river: river_cmp,
            by_street: Object.fromEntries(by_street.map((b) => [b.street, comparePolicies(b.spots, "board")])),
            // spot details carry cards only, no names or ids
            details: spots.map(({ game_id: _g, ...rest }) => rest)
        },
        agreement: agree as AgreementReport,
        mixing,
        simulation: sim
    };
    writeFileSync(out_file, JSON.stringify(report, null, 2));
    log(`JSON written to ${out_file}`);
}

function describeSpot(s: CounterfactualSpot): string {
    return `${s.street} hand #${s.hand_number}: you ${s.hero_cards.join(" ")} vs ${s.villain_cards.join(" ")}, board [${s.board.join(" ")}]` +
        (s.final_board.length > s.board.length ? ` -> [${s.final_board.join(" ")}]` : "") +
        `, pot ${s.pot_bb.toFixed(1)} BB, call ${s.to_call_bb.toFixed(1)} BB, equity ${pct(s.equity)}, share ${pct(s.share)}: ` +
        `call ${sign(s.call_bb, 2)} BB (by equity ${sign(s.call_equity_bb, 2)}); you ${s.actual}, engine ${s.engine} (${s.engine_label})`;
}
