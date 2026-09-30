import { expect } from "chai";

import { heroView, parseHand } from "../../app/engine/hand-parser.ts";
import { rangeClassShares } from "../../app/engine/equity.ts";
import { analyzePostflop, OpponentTendency } from "../../app/engine/postflop.ts";
import { ALL_IN_FOUR_BET_WIDTH, fourBetFactor } from "../../app/engine/opponent-range.ts";
import { preflopRange, rangePercent, topRange } from "../../app/engine/ranges.ts";
import { buildLog, describeResult, runScenario, Scenario, SCENARIOS, useBuiltInDefaults } from "../../scripts/scenarios.ts";

// Every scenario runs with the engine's built-in tables (no database), and with enough time for the full
// number of simulations, so results are the same on every machine.
const BUDGET_MS = 2000;

describe("strategy scenarios", () => {
    before(() => useBuiltInDefaults());

    it("cover preflop and post-flop spots across table sizes, stack depths and player types", () => {
        const ids = SCENARIOS.map((sc) => sc.id);
        expect(new Set(ids).size).to.equal(ids.length);
        expect(SCENARIOS.length).to.be.at.least(60);
        const pre = SCENARIOS.filter((sc) => sc.id.startsWith("pre-")), post = SCENARIOS.filter((sc) => sc.id.startsWith("post-"));
        expect(pre.length + post.length).to.equal(SCENARIOS.length);
        expect(pre.length).to.be.at.least(30);
        expect(post.length).to.be.at.least(30);
        // heads-up, 9 and 10 handed; straddles, antes, deep and short stacks; the bounty; every player type
        expect(new Set(SCENARIOS.map((sc) => sc.table.n))).to.include.members([2, 9, 10]);
        expect(SCENARIOS.some((sc) => sc.table.straddle)).to.equal(true);
        expect(SCENARIOS.some((sc) => sc.table.ante_bb)).to.equal(true);
        expect(SCENARIOS.some((sc) => (sc.table.stack_bb ?? 0) >= 300)).to.equal(true);
        expect(SCENARIOS.some((sc) => (sc.table.stack_bb ?? Infinity) <= 20)).to.equal(true);
        expect(SCENARIOS.some((sc) => (sc.bounty_bb ?? 0) > 0)).to.equal(true);
        const types = new Set(SCENARIOS.flatMap((sc) => Object.values(sc.players ?? {})));
        expect([...types]).to.include.members(["station", "nit", "maniac"]);
    });

    for (const sc of SCENARIOS) {
        it(`${sc.id}: ${sc.description}`, () => {
            const r = runScenario(sc, BUDGET_MS);
            expect(r.failures, describeResult(r)).to.deep.equal([]);
        });
    }
});

describe("scenario runner", () => {
    before(() => useBuiltInDefaults());

    it("writes PokerNow logs: seats named by position, skipped players fold, boards dealt street by street", () => {
        const lines = buildLog({ n: 9, hero: "BU", cards: "As Kd", ante_bb: 0.5 },
            ["UTG raises 6", "CO calls", "BU calls", "BB calls", "flop Ks 7d 2c", "BB checks", "UTG bets 10 allin"]);
        const s = parseHand(lines, { hero_name: "BU" });
        expect(s.seats.map((p) => p.position)).to.deep.equal(["SB", "BB", "UTG", "UTG+1", "MP", "LJ", "HJ", "CO", "BU"]);
        expect(s.seats.filter((p) => p.folded).map((p) => p.name)).to.deep.equal(["SB", "UTG+1", "MP", "LJ", "HJ"]);
        expect(s.hero_cards).to.deep.equal(["As", "Kd"]);
        expect(s.board).to.deep.equal(["Ks", "7d", "2c"]);
        expect(s.actions.filter((a) => a.type === "post_ante")).to.have.length(9);
        expect(s.seats.find((p) => p.name === "UTG")!.all_in).to.equal(true);
        expect(s.unparsed).to.deep.equal([]);
        // CO still has to act after the bet: hero isn't skipped past anyone who hasn't acted
        expect(heroView(s)!.to_call).to.equal(10);
    });

    it("puts the straddler last preflop and refuses a script that skips hero", () => {
        const lines = buildLog({ n: 9, hero: "CO", cards: "9h 9d", straddle: true }, ["UTG+1 calls"]);
        const s = parseHand(lines, { hero_name: "CO" });
        expect(s.actions.find((a) => a.type === "post_straddle")!.street_total).to.equal(4);
        expect(s.seats.filter((p) => !p.folded).map((p) => p.name)).to.deep.equal(["SB", "BB", "UTG", "UTG+1", "CO", "BU"]);
        expect(() => buildLog({ n: 9, hero: "HJ", cards: "9h 9d" }, ["CO raises 6"])).to.throw(/skips hero/);
    });

    it("fails a scenario whose expectation the engine doesn't meet, and checks the invariants", () => {
        const wrong: Scenario = { id: "t", description: "aces fold", table: { n: 9, hero: "UTG", cards: "As Ad" }, script: [], expect: { action: "fold" } };
        const r = runScenario(wrong, BUDGET_MS);
        expect(r.pass).to.equal(false);
        expect(r.failures.join()).to.match(/expected fold, got raise/);
        const nut: Scenario = { id: "t2", description: "nut", table: { n: 9, hero: "BB", cards: "7c 2d" }, script: ["UTG raises 6"], nut: true, expect: {} };
        expect(runScenario(nut, BUDGET_MS, "off").failures).to.deep.equal(["folds a nut hand"]);
        // every option the random number could pick is checked too
        expect(runScenario(nut, BUDGET_MS).failures).to.deep.equal(["folds a nut hand", "mix: folds a nut hand 100% of the time"]);
    });
});

describe("all-in re-raises (preflop fix found by the scenarios)", () => {
    before(() => useBuiltInDefaults());

    it("widens an all-in 4-bet or 5-bet range, and only the player who made it all-in", () => {
        const s = parseHand(buildLog({ n: 9, hero: "BU", cards: "Qh Qd", stacks_bb: { CO: 25 } }, ["CO raises 6", "BU raises 18", "CO raises 50 allin"]), { hero_name: "BU" });
        expect(fourBetFactor(s, "id-CO")).to.equal(ALL_IN_FOUR_BET_WIDTH);
        expect(fourBetFactor(s, "id-BU")).to.equal(1);
        const not_all_in = parseHand(buildLog({ n: 9, hero: "BU", cards: "Qh Qd" }, ["CO raises 6", "BU raises 18", "CO raises 50"]), { hero_name: "BU" });
        expect(fourBetFactor(not_all_in, "id-CO")).to.equal(1);
        const t = { vpip: 30, pfr: 15, three_bet: 9 };
        expect(rangePercent(preflopRange("4bet", t, undefined, { reraise: ALL_IN_FOUR_BET_WIDTH }))).to.be.closeTo(2 * rangePercent(preflopRange("4bet", t)), 0.01);
    });
});

describe("river raises (post-flop fix found by the scenarios)", () => {
    before(() => useBuiltInDefaults());

    it("expects a river bettor's hands without a pair to fold to a raise", () => {
        // hero's second pair against a bet from any two cards (the scenarios check the decisions this changes)
        const p = (name: string) => `"${name} @ id-${name}"`;
        const s = parseHand([
            `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${p("H")}) --`,
            `Player stacks: #1 ${p("V")} (200) | #2 ${p("H")} (200)`,
            `Your hand is 8h, 7h`,
            `${p("V")} posts a small blind of 1`, `${p("H")} posts a big blind of 2`, `${p("V")} calls 2`, `${p("H")} checks`,
            `Flop:  [Kc, 8d, 3s]`, `${p("H")} checks`, `${p("V")} checks`,
            `Turn: Kc, 8d, 3s [2c]`, `${p("H")} checks`, `${p("V")} checks`,
            `River: Kc, 8d, 3s, 2c [4d]`, `${p("H")} checks`, `${p("V")} bets 4`
        ], { hero_name: "H" });
        const v = heroView(s)!;
        const wide: OpponentTendency = { model: { range: topRange(100), aggression: 0.6 }, fold_to_bet: 0.3, fold_to_raise: 0.2 };
        const a = analyzePostflop(s, v, [wide], BUDGET_MS);
        const air = rangeClassShares(wide.model, s.board, s.hero_cards).air;
        expect(air).to.be.greaterThan(0.3);
        const raises = a.candidates.filter((c) => c.action === "raise" || c.action === "all-in");
        expect(raises.length).to.be.greaterThan(0);
        // every hand without a pair gives up (the player's own fold-to-raise rate, 20%, is far below that)
        for (const c of raises) expect(c.fold_chance!).to.be.at.least(air - 1e-9);
    });
});
