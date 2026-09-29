import { expect } from "chai";

import { parseHand } from "../../app/engine/hand-parser.ts";
import { PRIORS, resetPriors } from "../../app/engine/player-profile.ts";
import { POPULATION_TENDENCIES } from "../../app/engine/opponent-range.ts";
import { calibrateActionWeights, DEFAULT_ACTION_WEIGHTS } from "../../app/engine/showdown-calibration.ts";
import { DBService } from "../../app/services/db-service.ts";
import { HandRecorder } from "../../app/services/hand-recorder.ts";
import { ME, ProfileService } from "../../app/services/profile-service.ts";

const p = (name: string, id: string) => `"${name} @ ${id}"`;
const header = (n: number, game = "No Limit Texas Hold'em") => [
    `-- starting hand #${n} (id: h${n})  ${game} (dealer: ${p("C", "c")}) --`,
    `Player stacks: #1 ${p("A", "a")} (200) | #2 ${p("B", "b")} (200) | #3 ${p("C", "c")} (200)`,
    `${p("A", "a")} posts a small blind of 1`,
    `${p("B", "b")} posts a big blind of 2`
];

// B bets every street with a set of kings, C calls every street with nothing, and both show
const valueBet = (n: number, c_cards = "Q♥, J♥", river = "3♣", c_last = "calls 20", game?: string) => [...header(n, game),
    `${p("C", "c")} calls 2`, `${p("A", "a")} folds`, `${p("B", "b")} checks`,
    `Flop:  [K♠, 7♠, 2♣]`, `${p("B", "b")} bets 4`, `${p("C", "c")} calls 4`,
    `Turn: K♠, 7♠, 2♣ [9♥]`, `${p("B", "b")} bets 8`, `${p("C", "c")} calls 8`,
    `River: K♠, 7♠, 2♣, 9♥ [${river}]`, `${p("B", "b")} bets 20`, `${p("C", "c")} ${c_last}`,
    `${p("B", "b")} shows a K♦, K♣.`, `${p("C", "c")} shows a ${c_cards}.`, `-- ending hand #${n} --`];

describe("showdown calibration of action weights", () => {
    it("keeps the built-in weights when nothing was shown", () => {
        const result = calibrateActionWeights([], DEFAULT_ACTION_WEIGHTS);
        expect(result.samples).to.deep.equal({ flop: 0, turn: 0, river: 0 });
        for (const street of ["flop", "turn", "river"] as const) expect(result.weights[street]).to.deep.equal(DEFAULT_ACTION_WEIGHTS);
    });

    it("learns that bets are mostly strong hands when bettors keep showing strong hands", () => {
        const states = Array.from({ length: 200 }, (_, i) => parseHand(valueBet(i + 1)));
        const { weights, samples } = calibrateActionWeights(states, DEFAULT_ACTION_WEIGHTS);
        expect(samples).to.deep.equal({ flop: 400, turn: 400, river: 400 });
        const share = 200 / 240;
        for (const street of ["flop", "turn", "river"] as const) {
            // a typical range often has air and pairs on these boards, but bettors never did
            expect(weights[street].bet.strong).to.be.closeTo(1, 1e-9);
            expect(weights[street].bet.air).to.be.closeTo(share * 0.03 + (1 - share) * DEFAULT_ACTION_WEIGHTS.bet.air, 1e-9);
            expect(weights[street].bet.air).to.be.below(0.1);
            expect(weights[street].bet.pair).to.be.below(0.2);
            // callers showed air, so a call now points to air more than to a strong hand
            expect(weights[street].call.air).to.be.above(weights[street].call.strong);
            // calls are compared with all shown hands, and no pairs were shown: the built-in weight stays
            expect(weights[street].call.pair).to.equal(DEFAULT_ACTION_WEIGHTS.call.pair);
        }
    });

    it("stays near the built-in weights with only a few showdowns", () => {
        const states = [1, 2, 3].map((n) => parseHand(valueBet(n)));
        const { weights } = calibrateActionWeights(states, DEFAULT_ACTION_WEIGHTS);
        // 3 bets and 3 calls per street against a prior weight of 40; no raises or checks
        const share: Record<string, number> = { bet: 3 / 43, call: 3 / 43, raise: 0, check: 0 };
        for (const street of ["flop", "turn", "river"] as const) {
            for (const action of ["bet", "raise", "call", "check"] as const) {
                for (const cls of ["strong", "pair", "draw", "air"] as const) {
                    expect(Math.abs(weights[street][action][cls] - DEFAULT_ACTION_WEIGHTS[action][cls])).to.be.at.most(share[action] + 1e-9);
                }
            }
            // but they do move: bets were all strong
            expect(weights[street].bet.air).to.be.below(DEFAULT_ACTION_WEIGHTS.bet.air);
        }
    });

    it("classes a hand on the board at the time of each action", () => {
        // C calls the flop with a flush draw and makes the flush on the river
        const state = parseHand(valueBet(1, "A♠, 5♠", "3♠"));
        const { weights } = calibrateActionWeights([state], DEFAULT_ACTION_WEIGHTS, 0);
        expect(weights.flop.call.draw).to.equal(1);
        expect(weights.flop.call.strong).to.equal(0.03);
        expect(weights.river.call.strong).to.equal(1);
    });

    it("skips folded hands, other games, bomb pots and players left out", () => {
        // C folds the river and shows anyway: none of C's actions count, only B's bets
        const folded = parseHand(valueBet(1, "Q♥, J♥", "3♣", "folds"));
        expect(calibrateActionWeights([folded], DEFAULT_ACTION_WEIGHTS).samples).to.deep.equal({ flop: 1, turn: 1, river: 1 });
        const omaha = parseHand(valueBet(2, "Q♥, J♥", "3♣", "calls 20", "Pot Limit Omaha Hi"));
        const bomb = parseHand(valueBet(3));
        bomb.bomb_pot = true;
        expect(calibrateActionWeights([omaha, bomb], DEFAULT_ACTION_WEIGHTS).samples).to.deep.equal({ flop: 0, turn: 0, river: 0 });
        const no_b = calibrateActionWeights([parseHand(valueBet(4))], DEFAULT_ACTION_WEIGHTS, 40, (seat) => seat.id !== "b");
        expect(no_b.samples).to.deep.equal({ flop: 1, turn: 1, river: 1 });
        // your own shown hand (the log's hole cards) never counts, even before your id is linked
        const yours = parseHand(valueBet(5), { hero_cards: ["Kd", "Kc"] });
        expect(calibrateActionWeights([yours], DEFAULT_ACTION_WEIGHTS).samples).to.deep.equal({ flop: 1, turn: 1, river: 1 });
    });
});

describe("ProfileService action weights", () => {
    let db: DBService;
    let recorder: HandRecorder;

    beforeEach(async () => {
        db = new DBService(":memory:");
        await db.init();
        await db.createTables();
        recorder = new HandRecorder(db);
    });

    afterEach(async () => {
        await db.close();
        resetPriors();
        POPULATION_TENDENCIES.vpip = PRIORS.vpip.mean * 100;
        POPULATION_TENDENCIES.pfr = PRIORS.pfr.mean * 100;
    });

    it("learns from opponents' shown hands at load and as live hands finish, leaving yours out", async () => {
        const service = new ProfileService(recorder);
        expect(service.actionWeights().weights.river).to.deep.equal(DEFAULT_ACTION_WEIGHTS);
        // you are B: only C's calls count
        for (let n = 1; n <= 5; n++) await recorder.recordHand("g1", valueBet(n), "B", 2);
        await service.load("g1");
        expect(service.actionWeights().samples).to.deep.equal({ flop: 5, turn: 5, river: 5 });
        service.addHand(valueBet(6), 2, "g1");
        expect(service.actionWeights().samples.river).to.equal(6);
        // a copy: changing it doesn't change the service
        service.actionWeights().weights.river.bet.air = 99;
        expect(service.actionWeights().weights.river.bet.air).to.be.below(1);
    });

    it("counts the seat you play as you from the first live hand", async () => {
        for (let n = 1; n <= 2; n++) await recorder.recordHand("g1", valueBet(n), "Nobody", 2);
        const service = new ProfileService(recorder);
        await service.load("g1");
        expect(service.actionWeights().samples.river).to.equal(4);
        // B turns out to be your seat: B's river bet no longer counts, C's call does
        service.addHand(valueBet(3), 2, "g1", "B");
        expect(service.actionWeights().samples.river).to.equal(5);
        expect(service.info({ id: "b", name: "B" }).session?.key).to.equal(ME);
    });
});
