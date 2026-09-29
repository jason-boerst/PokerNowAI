import { expect } from "chai";

import { heroView, parseHand } from "../../app/engine/hand-parser.ts";
import { preflopAdvice, PreflopContext } from "../../app/engine/preflop.ts";
import { parseRange } from "../../app/engine/range-notation.ts";
import { ObservedStats } from "../../app/engine/opponent-range.ts";

const p = (name: string, id: string) => `"${name} @ ${id}"`;

/** Builds a preflop spot: n players (seat i = name Si), dealer = last seat, then `lines` of action. */
function spot(n: number, hero: string, cards: string, lines: string[], stack = 100, stats: Record<string, ObservedStats> = {}, context?: PreflopContext) {
    const seats = Array.from({ length: n }, (_, i) => i + 1);
    const messages = [
        `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${p(`S${n}`, `i${n}`)}) --`,
        `Player stacks: ${seats.map((i) => `#${i} ${p(`S${i}`, `i${i}`)} (${stack})`).join(" | ")}`,
        `Your hand is ${cards}`,
        `${p("S1", "i1")} posts a small blind of 1`,
        `${p("S2", "i2")} posts a big blind of 2`,
        ...lines.map((l) => l.replace(/^(S\d+) /, (_m, name) => `${p(name, "i" + name.slice(1))} `))
    ];
    const s = parseHand(messages, { hero_name: hero });
    const lookup = (player: { name: string }) => stats[player.name];
    // no context: the call existing callers make (no bounty)
    return context ? preflopAdvice(s, heroView(s)!, lookup, undefined, context) : preflopAdvice(s, heroView(s)!, lookup);
}

// 9-handed seats: S1 SB, S2 BB, S3 UTG, S4 UTG+1, S5 MP, S6 LJ, S7 HJ, S8 CO, S9 BU

describe("range notation", () => {
    it("expands plus, dash and bare items", () => {
        expect([...parseRange("TT+")]).to.deep.equal(["TT", "JJ", "QQ", "KK", "AA"]);
        expect([...parseRange("ATs+")]).to.deep.equal(["ATs", "AJs", "AQs", "AKs"]);
        expect([...parseRange("A5s-A3s")].sort()).to.deep.equal(["A3s", "A4s", "A5s"]);
        expect([...parseRange("KQ")].sort()).to.deep.equal(["KQo", "KQs"]);
    });
});

describe("preflopAdvice", () => {
    it("opens strong hands and folds weak ones by position", () => {
        expect(spot(9, "S3", "A♠, K♦", [])).to.include({ action: "raise", size_bb: 3 });
        expect(spot(9, "S3", "7♠, 6♠", [])!.action).to.equal("fold");
        expect(spot(9, "S9", "7♠, 6♠", [])!.action).to.equal("raise");
    });

    it("uses the range for the number of players left to act at short tables", () => {
        // 6-handed: UTG has 3 non-blind players behind, like a 9-max LJ; A7s is in LJ but not UTG
        const n6 = (lines: string[]) => spot(6, "S3", "A♦, 7♦", lines);
        expect(n6([])!.action).to.equal("raise");
        expect(spot(9, "S3", "A♦, 7♦", [])!.action).to.equal("fold");
    });

    it("opens bigger when the players behind call too much", () => {
        const loose = { vpip: 55, pfr: 10, hands: 50 };
        const stats = Object.fromEntries(["S4", "S5", "S6", "S7", "S8", "S9", "S1", "S2"].map((n) => [n, loose]));
        expect(spot(9, "S3", "A♠, K♦", [], 100, stats)).to.include({ action: "raise", size_bb: 4 });
    });

    it("isolates limpers with strong hands, limps behind with speculative ones", () => {
        const limped = ["S3 calls 2", "S5 calls 2"];
        expect(spot(9, "S9", "Q♠, Q♦", limped)).to.include({ action: "raise", size_bb: 6 });
        expect(spot(9, "S9", "6♠, 5♠", limped)!.action).to.equal("call");
        expect(spot(9, "S9", "K♠, 7♦", limped)!.action).to.equal("fold");
        expect(spot(9, "S2", "7♣, 2♦", [...limped, "S9 calls 2", "S1 calls 2"])!.action).to.equal("check");
    });

    it("3-bets value, calls playable hands, folds the rest against a raise", () => {
        const raised = ["S3 raises to 6"];
        expect(spot(9, "S9", "A♠, A♦", raised)).to.include({ action: "raise", size_bb: 9 });
        expect(spot(9, "S9", "J♠, J♦", raised)!.action).to.equal("call");
        expect(spot(9, "S9", "K♠, 9♦", raised)!.action).to.equal("fold");
    });

    it("3-bets wider against a loose raiser and tighter against a nit", () => {
        const raised = ["S3 raises to 6"];
        expect(spot(9, "S9", "J♠, J♦", raised, 100, { S3: { vpip: 45, pfr: 30, hands: 60 } })!.action).to.equal("raise");
        expect(spot(9, "S9", "Q♠, Q♦", raised, 100, { S3: { vpip: 12, pfr: 4, hands: 60 } })!.action).to.equal("call");
    });

    it("folds small pairs when stacks are too short to set-mine", () => {
        // 30 chip stacks (15 BB) facing a 3 BB raise: 12 BB behind vs a 2 BB call is under 15x
        expect(spot(9, "S9", "2♠, 2♦", ["S3 raises to 6"], 30)!.action).to.equal("fold");
        expect(spot(9, "S9", "2♠, 2♦", ["S3 raises to 6"], 200)!.action).to.equal("call");
    });

    it("handles 3-bets: 4-bet the top, call strong hands, fold the rest", () => {
        const three_bet = ["S3 folds", "S4 folds", "S5 folds", "S6 folds", "S7 raises to 6", "S8 raises to 18"];
        // 100 BB deep: a 4-bet to ~21 BB is under 40% of the stack, so it stays a raise
        expect(spot(9, "S7", "K♠, K♦", three_bet, 200)!.action).to.equal("raise");
        expect(spot(9, "S7", "Q♠, Q♦", three_bet)!.action).to.equal("call");
        expect(spot(9, "S7", "9♠, 8♠", three_bet)!.action).to.equal("fold");
    });

    it("goes all-in when the raise would commit a big share of the stack", () => {
        const three_bet = ["S7 raises to 6", "S8 raises to 18"];
        expect(spot(9, "S7", "A♠, A♦", three_bet, 60)!.action).to.equal("all-in");
    });

    it("never suggests a raise below the legal minimum", async () => {
        const { ALL_CLASSES } = await import("../../app/engine/hand-classes.ts");
        const suitsFor = (cls: string) => cls.length === 2 || cls[2] === "o" ? [`${cls[0]}♠`, `${cls[1]}♦`] : [`${cls[0]}♠`, `${cls[1]}♠`];
        const lines_options = [[], ["S3 calls 2"], ["S3 raises to 7"], ["S3 raises to 30"], ["S3 raises to 6", "S5 raises to 20"]];
        let raises = 0;
        for (const cls of ALL_CLASSES) {
            for (const lines of lines_options) {
                for (const stack of [40, 200, 1000]) {
                    const messages_spot = spot(9, "S9", suitsFor(cls).join(", "), lines, stack)!;
                    if (messages_spot.action !== "raise") continue;
                    raises++;
                    const s = parseHand([
                        `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${p("S9", "i9")}) --`,
                        `Player stacks: ${Array.from({ length: 9 }, (_, i) => `#${i + 1} ${p(`S${i + 1}`, `i${i + 1}`)} (${stack})`).join(" | ")}`,
                        `${p("S1", "i1")} posts a small blind of 1`, `${p("S2", "i2")} posts a big blind of 2`,
                        ...lines.map((l) => l.replace(/^(S\d+) /, (_m, n) => `${p(n, "i" + n.slice(1))} `))
                    ], { hero_name: "S9" });
                    const v = heroView(s)!;
                    expect(messages_spot.size_bb * 2, `${cls} ${lines} ${stack}`).to.be.at.least(v.min_raise_to! - 1e-9);
                    expect(messages_spot.size_bb * 2).to.be.at.most(v.max_raise_to + 1e-9);
                }
            }
        }
        expect(raises).to.be.greaterThan(100);
    });
});

describe("heads-up and position-aware preflop", () => {
    // 2 players: S1 posts SB (and is the button), S2 posts BB
    it("raises most hands from the heads-up small blind, including K6o", () => {
        expect(spot(2, "S1", "K♠, 6♦", [])).to.include({ action: "raise", size_bb: 2.5 });
        expect(spot(2, "S1", "T♠, 6♦", [])!.action).to.equal("raise");
        expect(spot(2, "S1", "7♠, 2♦", [])!.action).to.equal("fold");
    });

    it("defends the heads-up big blind wide against a raise", () => {
        expect(spot(2, "S2", "K♠, 6♦", ["S1 raises to 5"])!.action).to.equal("call");
        expect(spot(2, "S2", "A♠, K♦", ["S1 raises to 5"])!.action).to.equal("raise");
        expect(spot(2, "S2", "7♠, 2♦", ["S1 raises to 5"])!.action).to.equal("fold");
    });

    it("raises strong hands and checks the rest when the heads-up small blind limps", () => {
        expect(spot(2, "S2", "A♠, 9♦", ["S1 calls 2"])!.action).to.equal("raise");
        expect(spot(2, "S2", "K♠, 6♦", ["S1 calls 2"])!.action).to.equal("check");
    });

    it("defends the big blind wider against a button raise than against an early raise", () => {
        const folds = ["S3 folds", "S4 folds", "S5 folds", "S6 folds", "S7 folds", "S8 folds"];
        expect(spot(9, "S2", "K♠, 9♦", [...folds, "S9 raises to 6", "S1 folds"])!.action).to.equal("call");
        expect(spot(9, "S2", "K♠, 9♦", ["S3 raises to 6", "S4 folds", "S5 folds", "S6 folds", "S7 folds", "S8 folds", "S9 folds", "S1 folds"])!.action).to.equal("fold");
    });

    it("completes the small blind with playable hands when folded to it at a full table", () => {
        const folds = ["S3 folds", "S4 folds", "S5 folds", "S6 folds", "S7 folds", "S8 folds", "S9 folds"];
        expect(spot(9, "S1", "K♠, 6♦", folds)!.action).to.equal("call");
        expect(spot(9, "S1", "7♠, 2♦", folds)!.action).to.equal("fold");
    });
});

describe("heads-up position and ranges", () => {
    it("treats the heads-up small blind (button) as in position after the flop", async () => {
        const { heroInPosition } = await import("../../app/engine/postflop.ts");
        const flop = (hero: string) => parseHand([
            `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${p("S1", "i1")}) --`,
            `Player stacks: #1 ${p("S1", "i1")} (100) | #2 ${p("S2", "i2")} (100)`,
            `${p("S1", "i1")} posts a small blind of 1`, `${p("S2", "i2")} posts a big blind of 2`,
            `${p("S1", "i1")} raises to 5`, `${p("S2", "i2")} calls 5`, `Flop:  [K♥, 7♦, 2♣]`
        ], { hero_name: hero });
        expect(heroInPosition(flop("S1"))).to.equal(true);
        expect(heroInPosition(flop("S2"))).to.equal(false);
    });

    it("estimates wider opening ranges from late position and heads-up", async () => {
        const { positionWidth, preflopRange, rangePercent } = await import("../../app/engine/ranges.ts");
        const t = { vpip: 35, pfr: 12 };
        const utg = rangePercent(preflopRange("raise", t, positionWidth("UTG", 9)));
        const bu = rangePercent(preflopRange("raise", t, positionWidth("BU", 9)));
        const hu = rangePercent(preflopRange("raise", t, positionWidth("SB", 2)));
        expect(utg).to.be.lessThan(bu);
        expect(bu).to.be.lessThan(hu);
    });
});

const folds = (...names: string[]) => names.map((n) => `${n} folds`);

describe("10-handed tables, straddles and antes", () => {
    // 10-handed seats: S1 SB, S2 BB, S3 UTG, S4 UTG+1, S5 UTG+2, S6 MP, S7 LJ, S8 HJ, S9 CO, S10 BU
    it("puts UTG+2 between UTG+1 and MP at 10-handed tables", () => {
        // UTG+2 has 5 non-blind players behind (UTG+1 range); UTG+1 has 6 (UTG range). JTs is in UTG+1 but not UTG.
        expect(spot(10, "S5", "J♠, T♠", folds("S3", "S4"))).to.include({ action: "raise", scenario: "unopened (UTG+1 range)" });
        expect(spot(10, "S4", "J♠, T♠", folds("S3"))).to.include({ action: "fold", scenario: "unopened (UTG range)" });
    });

    it("treats UTG+2 as an early seat when isolating limpers", () => {
        // early seats isolate with 99+ (a late seat would raise 88)
        expect(spot(10, "S5", "8♠, 8♦", ["S3 calls 2", "S4 folds"])!.action).to.equal("fold");
        expect(spot(10, "S5", "9♠, 9♦", ["S3 calls 2", "S4 folds"])!.action).to.equal("raise");
    });

    // 9-handed with S3 (UTG) straddling to 4 (2 BB); stacks 400 (200 BB)
    const straddle = ["S3 posts a straddle of 4"];

    it("sizes raises from the straddle and doesn't treat it as a raise", () => {
        // UTG+1 has 5 non-blind players behind plus the straddler (who acts last): UTG range, open to 3 straddles
        expect(spot(9, "S4", "A♠, K♦", straddle, 400)).to.include({ action: "raise", size_bb: 6, scenario: "unopened (UTG range)" });
        expect(spot(9, "S4", "J♠, T♠", straddle, 400)!.action).to.equal("fold");
        // isolating one limper: (4 + 1) x 2 BB
        expect(spot(9, "S9", "Q♠, Q♦", [...straddle, "S4 calls 4", ...folds("S5", "S6", "S7", "S8")], 400)).to.include({ action: "raise", size_bb: 10 });
    });

    it("counts the straddler as a player left to act", () => {
        // the button still has the straddler behind, so it uses the CO range: K2s folds
        expect(spot(9, "S9", "K♠, 2♠", [...straddle, ...folds("S4", "S5", "S6", "S7", "S8")], 400)).to.include({ action: "fold", scenario: "unopened (CO range)" });
        expect(spot(9, "S9", "K♠, 2♠", folds("S3", "S4", "S5", "S6", "S7", "S8"), 400)!.action).to.equal("raise");
    });

    it("lets the straddler check its option and the big blind complete (not check) in a straddled pot", () => {
        const limped = [...straddle, "S4 calls 4", ...folds("S5", "S6", "S7", "S8", "S9", "S1")];
        expect(spot(9, "S2", "7♠, 2♦", limped, 400)!.action).to.equal("fold");
        expect(spot(9, "S2", "9♠, 8♠", limped, 400)!.action).to.equal("call");
        expect(spot(9, "S3", "7♠, 2♦", [...limped, "S2 folds"], 400)!.action).to.equal("check");
    });

    it("defends the straddle like a big blind and 3-bets bigger out of position", () => {
        const button_raise = [...straddle, ...folds("S4", "S5", "S6", "S7", "S8"), "S9 raises to 12", ...folds("S1", "S2")];
        expect(spot(9, "S3", "K♠, 9♦", button_raise, 400)!.action).to.equal("call");
        expect(spot(9, "S3", "A♠, A♦", button_raise, 400)).to.include({ action: "raise", size_bb: 24 });
    });

    it("opens wider and bigger, and defends the big blind wider, when antes are in the pot", () => {
        const antes = (chips: number) => Array.from({ length: 9 }, (_, i) => `S${i + 1} posts an ante of ${chips}`);
        // 0.25 BB antes: 3.75 BB of dead money, one step wider. MP uses the LJ range (A7s+ instead of A9s+).
        expect(spot(9, "S5", "A♠, 7♠", folds("S3", "S4"))!.action).to.equal("fold");
        const wide = spot(9, "S5", "A♠, 7♠", [...antes(0.5), ...folds("S3", "S4")])!;
        expect(wide).to.include({ action: "raise", size_bb: 4, scenario: "unopened (LJ range, wider for the antes)" });
        expect(wide.reason).to.include("3.8 BB pot");
        // 0.5 BB antes: 6 BB of dead money, two steps wider. UTG uses the MP range (A9s).
        expect(spot(9, "S3", "A♠, 9♠", [])!.action).to.equal("fold");
        expect(spot(9, "S3", "A♠, 9♠", antes(1))!.action).to.equal("raise");
        // the big blind defends K9s against an early raise only with antes in
        const raise = ["S3 raises to 6", ...folds("S4", "S5", "S6", "S7", "S8", "S9", "S1")];
        expect(spot(9, "S2", "K♠, 9♠", raise)!.action).to.equal("fold");
        expect(spot(9, "S2", "K♠, 9♠", [...antes(0.5), ...raise])!.action).to.equal("call");
    });
});

describe("stack depth and 3-bet/4-bet decisions", () => {
    it("only gets it all in with AA against a 4-bet when stacks are very deep", () => {
        // hero (S8, CO) 3-bet the HJ open and faces a 4-bet to 25 BB
        const four_bet = [...folds("S3", "S4", "S5", "S6"), "S7 raises to 6", "S8 raises to 20", ...folds("S9", "S1", "S2"), "S7 raises to 50"];
        // 100 BB: KK gets it in as before
        expect(spot(9, "S8", "K♠, K♦", four_bet, 200)!.action).to.equal("all-in");
        // 150 BB and 300 BB: KK calls, AA gets it in, QQ folds
        expect(spot(9, "S8", "K♠, K♦", four_bet, 300)!.action).to.equal("call");
        const kk = spot(9, "S8", "K♠, K♦", four_bet, 600)!;
        expect(kk.action).to.equal("call");
        expect(kk.reason).to.include("300 BB deep");
        expect(spot(9, "S8", "A♠, A♦", four_bet, 600)!.action).to.equal("all-in");
        expect(spot(9, "S8", "Q♠, Q♦", four_bet, 600)!.action).to.equal("fold");
        // against a loose 4-bettor QQ calls instead of folding
        const loose = { S7: { vpip: 45, pfr: 25, hands: 100, three_bet: 14 } };
        expect(spot(9, "S8", "Q♠, Q♦", four_bet, 600, loose)!.action).to.equal("call");
    });

    it("gets it in with the call hands when the 4-bet already commits a big share of the stack", () => {
        // 150 BB stacks, 4-bet to 70 BB (47% of the stack)
        const big = [...folds("S3", "S4", "S5", "S6"), "S7 raises to 6", "S8 raises to 20", ...folds("S9", "S1", "S2"), "S7 raises to 140"];
        expect(spot(9, "S8", "K♠, K♦", big, 300)!.action).to.equal("all-in");
    });

    it("calls raises wider in position and drops dominated offsuit hands when deep", () => {
        const utg_raise = ["S3 raises to 6", ...folds("S4", "S5", "S6", "S7", "S8")];
        // 76s on the button: fold at 100 BB, call at 200 BB
        expect(spot(9, "S9", "7♠, 6♠", utg_raise, 200)!.action).to.equal("fold");
        expect(spot(9, "S9", "7♠, 6♠", utg_raise, 400)!.action).to.equal("call");
        // KQo in the big blind: call at 100 BB, fold at 300 BB
        const to_bb = [...utg_raise, ...folds("S9", "S1")];
        expect(spot(9, "S2", "K♠, Q♦", to_bb, 200)!.action).to.equal("call");
        expect(spot(9, "S2", "K♠, Q♦", to_bb, 600)!.action).to.equal("fold");
        // against a nit the vs_nit range is kept as it is, even deep
        expect(spot(9, "S9", "A♠, 2♠", utg_raise, 800)!.action).to.equal("call");
        expect(spot(9, "S9", "A♠, 2♠", utg_raise, 800, { S3: { vpip: 10, pfr: 5, hands: 200 } })!.action).to.equal("fold");
    });

    // hero opens from HJ (S7) and the big blind 3-bets to 9 BB, so hero has position after the flop
    const three_bet = [...folds("S3", "S4", "S5", "S6"), "S7 raises to 6", ...folds("S8", "S9", "S1"), "S2 raises to 18"];
    const tight = { S2: { vpip: 18, pfr: 10, hands: 200, three_bet: 3 } };
    const loose = { S2: { vpip: 40, pfr: 25, hands: 200, three_bet: 15 } };

    it("calls or folds a 3-bet depending on how often the 3-bettor 3-bets", () => {
        // unknown 3-bettor: typical range, 99 calls in position
        const unknown = spot(9, "S7", "9♠, 9♦", three_bet, 200)!;
        expect(unknown.action).to.equal("call");
        expect(unknown.reason).to.include("No 3-bet history");
        expect(spot(9, "S7", "9♠, 9♦", three_bet, 200, tight)!.action).to.equal("fold");
        expect(spot(9, "S7", "Q♠, Q♦", three_bet, 200, tight)!.action).to.equal("call");
        const qq = spot(9, "S7", "Q♠, Q♦", three_bet, 200, loose)!;
        expect(qq.action).to.equal("raise");
        expect(qq.reason).to.include("BB 3-bets 15% of the time");
        expect(spot(9, "S7", "A♠, T♠", three_bet, 200, loose)!.action).to.equal("call");
        expect(spot(9, "S7", "A♠, T♠", three_bet, 200)!.action).to.equal("fold");
    });

    it("cold-calls a 3-bet only with strong hands, tighter against a tight 3-bettor", () => {
        const cold = ["S3 raises to 6", "S4 raises to 18", ...folds("S5", "S6", "S7", "S8")];
        expect(spot(9, "S9", "J♠, J♦", cold)!.action).to.equal("call");
        expect(spot(9, "S9", "J♠, J♦", cold, 100, { S4: { vpip: 15, pfr: 8, hands: 200, three_bet: 3 } })!.action).to.equal("fold");
        expect(spot(9, "S9", "A♠, Q♦", cold)!.action).to.equal("fold");
    });

    it("ignores a 3-bet % measured over too few hands", () => {
        const few = { S2: { vpip: 40, pfr: 25, hands: 10, three_bet: 30 } };
        expect(spot(9, "S7", "A♠, T♠", three_bet, 200, few)!.action).to.equal("fold");
    });
});

describe("7-2 bounty", () => {
    const bounty = { seven_deuce_bounty: 6 }; // 3 BB from each opponent

    it("raises 72 first in or over limpers when the bounty is on", () => {
        const open = spot(9, "S3", "7♠, 2♦", [], 200, {}, bounty)!;
        expect(open).to.include({ action: "raise", size_bb: 3 });
        expect(open.reason).to.include("7-2 bounty is on: winning this hand with 72 is worth about 24 BB extra.");
        expect(spot(9, "S9", "7♠, 2♠", ["S3 calls 2"], 200, {}, bounty)).to.include({ action: "raise", size_bb: 5 });
        // heads-up the bounty is one payment, still enough to raise from the button
        expect(spot(2, "S1", "7♠, 2♦", [], 200, {}, bounty)).to.include({ action: "raise", size_bb: 2.5 });
    });

    it("3-bets 72 against one raise when the bounty covers the cost, and folds to a 3-bet", () => {
        expect(spot(9, "S9", "7♠, 2♦", ["S3 raises to 6"], 200, {}, bounty)).to.include({ action: "raise", size_bb: 9 });
        // a small bounty doesn't pay for a 3-bet
        expect(spot(9, "S9", "7♠, 2♦", ["S3 raises to 6"], 200, {}, { seven_deuce_bounty: 1 })!.action).to.equal("fold");
        expect(spot(9, "S7", "7♠, 2♦", ["S7 raises to 6", "S8 raises to 18"], 200, {}, bounty)!.action).to.equal("fold");
    });

    it("plays 72 as usual with no bounty", () => {
        expect(spot(9, "S3", "7♠, 2♦", [])!.action).to.equal("fold");
        expect(spot(9, "S3", "7♠, 2♦", [], 200, {}, {})!.action).to.equal("fold");
        expect(spot(9, "S9", "7♠, 2♦", ["S3 raises to 6"], 200, {}, { seven_deuce_bounty: 0 })!.action).to.equal("fold");
        expect(spot(2, "S1", "7♠, 2♦", [])!.action).to.equal("fold");
    });
});

describe("pricing calls when you close the action", () => {
    // heads-up: S1 posts the small blind (the button), S2 the big blind; 100-chip stacks are 50 BB
    it("folds Q7o in the big blind to a 3x open when its realized equity falls short, and calls it against 2x", () => {
        const three_x = spot(2, "S2", "Q♣, 7♠", ["S1 raises to 6"], 100, {}, { equity: 0.464 })!;
        expect(three_x.action).to.equal("fold");
        expect(three_x.scenario).to.include("priced");
        expect(three_x.reason).to.match(/46% equity/).and.to.match(/33% this call needs/).and.to.match(/Close spot/);
        const two_x = spot(2, "S2", "Q♣, 7♠", ["S1 raises to 4"], 100, {}, { equity: 0.464 })!;
        expect(two_x.action).to.equal("call");
        expect(two_x.reason).to.match(/25% this call needs/);
    });

    it("uses the fixed ranges when there is no equity estimate, and still 3-bets value from the chart", () => {
        expect(spot(2, "S2", "Q♣, 7♠", ["S1 raises to 6"])!.action).to.equal("fold");
        expect(spot(2, "S2", "K♠, 6♦", ["S1 raises to 6"])!.action).to.equal("call");
        expect(spot(2, "S2", "A♠, K♦", ["S1 raises to 6"], 100, {}, { equity: 0.65 })!.action).to.equal("raise");
    });

    it("prices big blind calls at a full table, including multiway pots", () => {
        const folds = ["S3 folds", "S4 folds", "S5 folds", "S6 folds", "S7 folds", "S8 folds"];
        expect(spot(9, "S2", "5♠, 4♠", [...folds, "S9 raises to 6", "S1 folds"], 100, {}, { equity: 0.40 })!.action).to.equal("call");
        expect(spot(9, "S2", "7♣, 2♦", [...folds, "S9 raises to 6", "S1 folds"], 100, {}, { equity: 0.30 })!.action).to.equal("fold");
        // a raise and a call: a better price, but a multiway pot keeps less of the equity
        const multi = spot(9, "S2", "9♠, 8♠", [...folds.slice(0, 5), "S8 raises to 6", "S9 calls 6", "S1 folds"], 100, {}, { equity: 0.30 })!;
        expect(multi.action).to.equal("call");
    });

    it("doesn't price a call while players behind can still act", () => {
        const folds = ["S3 folds", "S4 folds", "S5 folds", "S6 folds", "S7 folds", "S8 folds"];
        const sb = spot(9, "S1", "7♣, 2♦", [...folds, "S9 raises to 6"], 100, {}, { equity: 0.9 })!;
        expect(sb.action).to.equal("fold");
        expect(sb.scenario).to.not.include("priced");
    });

    it("gives suited and connected hands more realization than offsuit unconnected ones", async () => {
        const { realizationOf } = await import("../../app/engine/preflop.ts");
        const config = (await import("../../app/configs/preflop-ranges.json", { with: { type: "json" } })).default;
        const r = (cls: string, multiway = false, spr = 10) => realizationOf(config, cls, multiway, spr);
        expect(r("54s")).to.be.greaterThan(r("K9s"));
        expect(r("K9s")).to.be.greaterThan(r("KJo"));
        expect(r("KJo")).to.be.greaterThan(r("Q7o"));
        expect(r("Q7o", true)).to.be.lessThan(r("Q7o"));
        expect(r("Q7o", false, 2)).to.be.greaterThan(r("Q7o"));      // short stacks: played to showdown sooner
        expect(r("Q7o", false, 40)).to.be.lessThan(r("Q7o"));       // very deep: offsuit hands lose big pots
    });
});
