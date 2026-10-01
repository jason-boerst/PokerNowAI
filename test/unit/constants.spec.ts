import { expect } from "chai";

import { seededRandom } from "../../app/engine/cards.ts";
import { checkConstantEvents, ConstantEvent, constantEvents, DEFAULT_CONSTANTS, fitConstants } from "../../app/engine/constant-calibration.ts";
import { parseHand } from "../../app/engine/hand-parser.ts";
import { playConstants, setPlayConstants } from "../../app/engine/postflop.ts";

const p = (name: string, id: string) => `"${name} @ ${id}"`;
const A = p("A", "a"), B = p("B", "b"), C = p("C", "c");
const hand = (lines: string[]) => parseHand([
    `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: ${C}) --`,
    `Player stacks: #1 ${A} (200) | #2 ${B} (200) | #3 ${C} (200)`,
    `${A} posts a small blind of 1`, `${B} posts a big blind of 2`, ...lines, `-- ending hand #1 --`]);

/** Checked-to spots where each of `behind` players bets at `one * f^(behind - 1)`, over several games. */
function checkedTo(f: number, games: number, per_game: number, seed: number): { game: string, events: ConstantEvent[] }[] {
    const rand = seededRandom(seed);
    return Array.from({ length: games }, (_, g) => ({
        game: `g${g}`,
        events: Array.from({ length: per_game }, (_, i): ConstantEvent => {
            const behind = 1 + (i % 3);
            const each = 0.6 * Math.pow(f, behind - 1);
            let hit = false;
            for (let k = 0; k < behind; k++) if (rand() < each) hit = true;
            return { kind: "checked_to", behind, hit };
        })
    }));
}

describe("re-measuring the play constants", () => {
    it("reads the events of a hand: a called bettor betting again, checks with players behind, answers to a bet", () => {
        const s = hand([
            `${C} raises to 6`, `${A} folds`, `${B} calls 6`,
            `Flop:  [K♠, 8♠, 4♣]`, `${B} checks`, `${C} bets 6`, `${B} calls 6`,
            `Turn: K♠, 8♠, 4♣ [9♥]`, `${B} checks`, `${C} bets 12`, `${B} folds`]);
        const ev = constantEvents(s);
        expect(ev).to.deep.include({ kind: "checked_to", behind: 1, hit: true });
        expect(ev).to.deep.include({ kind: "facing_bet", extra: 0, cont: true, raise: false });
        expect(ev).to.deep.include({ kind: "bet_next", street: "flop", hit: true });
        // only the seats asked for
        expect(constantEvents(s, (seat) => seat.id !== "c").some((e) => e.kind === "bet_next")).to.equal(false);
    });

    it("counts each player facing a multiway bet, with the others facing it", () => {
        const s = hand([`${C} calls 2`, `${A} calls 2`, `${B} checks`, `Flop:  [K♠, 8♠, 4♣]`, `${A} bets 3`, `${B} folds`, `${C} calls 3`, `Turn: K♠, 8♠, 4♣ [9♥]`, `${A} checks`, `${C} checks`]);
        const facing = constantEvents(s).filter((e) => e.kind === "facing_bet");
        expect(facing).to.deep.equal([{ kind: "facing_bet", extra: 1, cont: false, raise: false }, { kind: "facing_bet", extra: 1, cont: true, raise: false }]);
    });

    it("fits a constant from its events, pulled toward the built-in value", () => {
        const big = fitConstants(checkedTo(0.35, 10, 600, 1).flatMap((g) => g.events));
        expect(big.values.multiway_bet).to.be.closeTo(0.35, 0.06);
        const small = fitConstants(checkedTo(0.35, 1, 30, 2).flatMap((g) => g.events));
        // 30 events: most of the weight stays on the built-in value
        expect(Math.abs(small.values.multiway_bet - DEFAULT_CONSTANTS.multiway_bet)).to.be.lessThan(Math.abs(big.values.multiway_bet - DEFAULT_CONSTANTS.multiway_bet));
        expect(small.cases.multiway_bet).to.equal(20);
    });

    it("uses a measured value only when it predicts left-out games clearly better", () => {
        const shifted = checkConstantEvents(checkedTo(0.3, 8, 400, 3)).checks.find((c) => c.name === "multiway_bet")!;
        expect(shifted.active).to.equal(true);
        const same = checkConstantEvents(checkedTo(DEFAULT_CONSTANTS.multiway_bet, 8, 400, 4)).checks.find((c) => c.name === "multiway_bet")!;
        expect(same.active).to.equal(false);
        // nothing measured for the others: they stay built in
        expect(checkConstantEvents(checkedTo(0.3, 8, 400, 3)).values.bet_next_flop).to.equal(DEFAULT_CONSTANTS.bet_next_flop);
    });

    it("sets the engine's values and resets them", () => {
        try {
            setPlayConstants({ multiway_bet: 0.7 });
            expect(playConstants()).to.deep.equal({ ...DEFAULT_CONSTANTS, multiway_bet: 0.7 });
        } finally {
            setPlayConstants(null);
        }
        expect(playConstants()).to.deep.equal(DEFAULT_CONSTANTS);
    });
});
