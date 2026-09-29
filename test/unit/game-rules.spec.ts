import { expect } from "chai";

import { bountyFromHands, describeRules, GameRules, hasKeyRules, mergeRules, parseGameRules, RULES_CHANGE } from "../../app/engine/game-rules.ts";
import { LogService } from "../../app/services/log-service.ts";

// Synthetic log lines in PokerNow's format (oldest first).
const config = (...settings: string[]) => ["Game Config Changes", ...settings.map((s) => `* ${s}`)].join("\n");
const hand = (n: number, lines: string[], after: string[] = []) => [
    `-- starting hand #${n} (id: h${n})  No Limit Texas Hold'em (dealer: "Host @ hostid") --`,
    `Player stacks: #1 "Host @ hostid" (100.00) | #2 "Guest @ guestid" (100.00) | #3 "Other @ otherid" (100.00)`,
    ...lines,
    `-- ending hand #${n} --`,
    ...after
];
const SETUP = [
    config("Allow Straddle: off » on", "Cents Mode: off » on", "Blind Schedule: L1: 10/20 » L1: 50/100",
        "Decision Limit Time: 20s » 15s", "Allow Run it Twice: no » ask players", "7-2 bounty: off » 300"),
    "The game's small blind was changed from 0.10 to 0.50.",
    "The game's big blind was changed from 0.20 to 1.00.",
    "The game's ante was changed from 0.00 to 0.00."
];
const BOUNTY_PAID = [
    `"Host @ hostid" shows a 7♠, 2♦.`,
    `"Guest @ guestid" paid 3.00 for the 7-2 bounty to "Host @ hostid"`,
    `"Other @ otherid" paid 3.00 for the 7-2 bounty to "Host @ hostid"`,
    `"Host @ hostid" collected 6.00 from the 7-2 bounty`
];

describe("game rules from the log", () => {
    it("reads the clock, bounty, straddles and run it twice from the game's setup", () => {
        expect(parseGameRules(SETUP)).to.deep.equal({
            decision_seconds: 15, seven_deuce_bounty: 3, ante: 0, straddle_allowed: true, run_it_twice: true
        });
    });

    it("returns only the rules the log shows", () => {
        expect(parseGameRules([])).to.deep.equal({});
        expect(parseGameRules(hand(1, [`"Host @ hostid" posts a small blind of 1`, `"Guest @ guestid" posts a big blind of 2`]))).to.deep.equal({});
        expect(parseGameRules([config("Decision Limit Time: 20s » 15s")])).to.deep.equal({ decision_seconds: 15 });
    });

    it("uses the latest setting", () => {
        const rules = parseGameRules([
            ...SETUP,
            config("Decision Limit Time: 15s » 10s"),
            config("Blind Schedule: L1: 50/100 » L1: 100/200", "7-2 bounty: 300 » 400"),
            config("Allow Straddle: on » off", "Allow Run it Twice: ask players » no")
        ]);
        expect(rules).to.include({ decision_seconds: 10, seven_deuce_bounty: 4, straddle_allowed: false, run_it_twice: false });
        expect(parseGameRules([...SETUP, config("7-2 bounty: 300 » off")]).seven_deuce_bounty).to.equal(0);
        // a clock turned off is no clock
        expect(parseGameRules([...SETUP, config("Decision Limit Time: 15s » off")])).to.not.have.property("decision_seconds");
        const clock = (value: string) => parseGameRules([config(`Decision Limit Time: 20s » ${value}`)]).decision_seconds;
        expect([clock("30s"), clock("1m"), clock("1m 30s"), clock("1:30"), clock("45")]).to.deep.equal([30, 60, 90, 90, 45]);
    });

    it("reads the bounty setting in chips, with or without Cents Mode", () => {
        // no Cents Mode: the setting is in chips
        expect(parseGameRules([config("Decision Limit Time: 20s » 15s", "7-2 bounty: off » 6"), "The game's big blind was changed from 20 to 2."]))
            .to.include({ seven_deuce_bounty: 6 });
        // Cents Mode set before the log starts: amounts with cents show it
        expect(parseGameRules([config("7-2 bounty: 200 » 300"), ...hand(1, [`"Host @ hostid" posts a big blind of 1.00`])]))
            .to.include({ seven_deuce_bounty: 3 });
        // numbers with commas
        expect(parseGameRules([config("7-2 bounty: off » 1,500")])).to.include({ seven_deuce_bounty: 1500 });
    });

    it("falls back to the bounty players paid, and never lets a payment override a setting", () => {
        const paid = hand(1, [`"Host @ hostid" posts a big blind of 1.00`], BOUNTY_PAID);
        expect(parseGameRules(paid)).to.deep.equal({ seven_deuce_bounty: 3 });
        // a short stack pays less: the full bounty is the largest payment
        const short = hand(2, [], [`"Other @ otherid" paid 1.25 for the 7-2 bounty to "Host @ hostid"`]);
        expect(parseGameRules([...paid, ...short]).seven_deuce_bounty).to.equal(3);
        expect(parseGameRules([...SETUP, ...short]).seven_deuce_bounty).to.equal(3);
        // a later setting replaces older payments
        expect(parseGameRules([...paid, config("7-2 bounty: 300 » off")]).seven_deuce_bounty).to.equal(0);
        // turned off during a hand that still pays out under the old rule
        const mid_hand = hand(3, [`"Host @ hostid" posts a big blind of 1.00`, config("7-2 bounty: 300 » off")], BOUNTY_PAID);
        expect(parseGameRules([...SETUP, ...mid_hand]).seven_deuce_bounty).to.equal(0);
    });

    it("tracks the ante from changes and from the hands", () => {
        expect(parseGameRules([...SETUP, "The game's ante was changed from 0.00 to 0.20."]).ante).to.equal(0.2);
        expect(parseGameRules([...SETUP, "The game's ante was changed from 0.20 to 0.00."]).ante).to.equal(0);
        const antes = (n: number, a: string, b: string) => hand(n, [`"Host @ hostid" posts an ante of ${a}`, `"Guest @ guestid" posts an ante of ${b} and go all in`]);
        // the largest ante in the latest hand (a short stack posts less)
        expect(parseGameRules([...antes(1, "0.10", "0.10"), ...antes(2, "0.25", "0.05")]).ante).to.equal(0.25);
        expect(parseGameRules([...antes(1, "0.25", "0.25"), "The game's ante was changed from 0.25 to 0.00."]).ante).to.equal(0);
        expect(parseGameRules(["The game's ante was changed from 0.00 to 0.10.", ...antes(1, "1,000", "1,000")]).ante).to.equal(1000);
    });

    it("spots straddles, bomb pots and run it twice in the hands", () => {
        expect(parseGameRules(hand(1, [`"Host @ hostid" posts a straddle of 2.00`]))).to.deep.equal({ straddle_allowed: true });
        expect(parseGameRules(hand(1, [`"Host @ hostid" posts a bet of 3.00 (bomb pot bet)`, `"Guest @ guestid" calls 3.00 (bomb pot bet)`])))
            .to.deep.equal({ bomb_pots: true });
        expect(parseGameRules(hand(1, ["Remaining players decide whether to run it twice.", `"Host @ hostid" chooses to not run it twice.`])))
            .to.deep.equal({ run_it_twice: true });
        // the settings switch them off again
        expect(parseGameRules([config("Bomb Pot: off » on", "Bomb Pot BB Quantity: off » 3")])).to.deep.equal({ bomb_pots: true });
        const bomb = hand(1, [`"Host @ hostid" posts a bet of 3.00 (bomb pot bet)`]);
        expect(parseGameRules([...bomb, config("Bomb Pot: on » off", "Bomb Pot BB Quantity: 3 » off")])).to.deep.equal({ bomb_pots: false });
        // a player name with "»" in it is not a setting
        expect(parseGameRules(hand(1, [`"A»B @ abid" posts a straddle of 2`]))).to.deep.equal({ straddle_allowed: true });
    });

    it("lets a setting stand against the rest of the hand it was changed in", () => {
        const offered = ["Remaining players decide whether to run it twice.", `"Host @ hostid" chooses to  run it twice.`];
        // switched off during a hand: that hand still ran under the old rule
        expect(parseGameRules(hand(1, [config("Allow Run it Twice: ask players » no"), ...offered])).run_it_twice).to.equal(false);
        // a later hand shows it's in use again (turned back on by a setting before this log starts)
        expect(parseGameRules([...hand(1, [config("Allow Run it Twice: ask players » no")]), ...hand(2, offered)]).run_it_twice).to.equal(true);
        expect(parseGameRules([...hand(1, [`"Host @ hostid" posts an ante of 0.20`]), "The game's ante was changed from 0.20 to 0.00.", ...hand(2, [])]).ante).to.equal(0);
    });

    it("reads settings and ante changes wherever they appear in an entry", () => {
        expect(parseGameRules([`${config("Decision Limit Time: 20s » 15s")}\nThe game's ante was changed from 0.00 to 0.20.`]))
            .to.deep.equal({ decision_seconds: 15, ante: 0.2 });
        expect(parseGameRules([` "Host @ hostid" posts a straddle of 2.00`, ` The game's ante was changed from 0.00 to 0.20. `]))
            .to.deep.equal({ straddle_allowed: true, ante: 0.2 });
    });

    it("finds the bounty in stored hands, newest hand first", () => {
        const older = hand(1, [], [`"Guest @ guestid" paid 2.00 for the 7-2 bounty to "Host @ hostid"`]);
        const newer = hand(2, [], [`"Guest @ guestid" paid 3.00 for the 7-2 bounty to "Host @ hostid"`, `"Other @ otherid" paid 1.50 for the 7-2 bounty to "Host @ hostid"`]);
        expect(bountyFromHands([older, newer, hand(3, [])])).to.equal(3);
        expect(bountyFromHands([older])).to.equal(2);
        expect(bountyFromHands([hand(1, [])])).to.equal(undefined);
        expect(bountyFromHands([])).to.equal(undefined);
    });

    it("merges rules, later sources winning", () => {
        const merged = mergeRules({ decision_seconds: 15, ante: 0.2 }, { seven_deuce_bounty: 3, ante: undefined }, { ante: 0 });
        expect(merged).to.deep.equal({ decision_seconds: 15, ante: 0, seven_deuce_bounty: 3 });
        expect(mergeRules()).to.deep.equal({});
    });

    it("describes the rules in short plain notes", () => {
        const rules: GameRules = { decision_seconds: 15, seven_deuce_bounty: 3, ante: 0.5, straddle_allowed: true, bomb_pots: true, run_it_twice: true };
        const notes = describeRules(rules, 1);
        expect(notes).to.deep.equal([
            "7-2 bounty on: 3 BB from each player", "Antes 0.5 BB", "Straddles allowed", "Bomb pots on", "Run it twice allowed", "Clock 15 s"
        ]);
        expect(notes.join(" ")).to.not.match(/[\u2013\u2014]/);
        expect(describeRules({ seven_deuce_bounty: 1.5, ante: 0.25 }, 0.5)).to.deep.equal(["7-2 bounty on: 3 BB from each player", "Antes 0.5 BB"]);
        expect(describeRules({ seven_deuce_bounty: 6 }, 0)).to.deep.equal(["7-2 bounty on: 6 chips from each player"]);
        // rules that are off or unknown aren't mentioned
        expect(describeRules({ seven_deuce_bounty: 0, ante: 0, straddle_allowed: false }, 1)).to.deep.equal([]);
    });

    it("recognizes the log entries that change rules", () => {
        expect(RULES_CHANGE.test(SETUP[0])).to.equal(true);
        expect(RULES_CHANGE.test("The game's ante was changed from 0.00 to 0.20.")).to.equal(true);
        expect(RULES_CHANGE.test("The game's big blind was changed from 0.50 to 1.00.")).to.equal(false);
        expect(RULES_CHANGE.test(`"Host @ hostid" posts an ante of 0.20`)).to.equal(false);
    });

    it("knows when the clock and the bounty are settled", () => {
        expect(hasKeyRules(SETUP)).to.equal(true);                                    // Cents Mode and amounts in cents
        expect(hasKeyRules([config("Decision Limit Time: 20s » 15s", "7-2 bounty: off » 300")])).to.equal(false);    // cents or chips?
        expect(hasKeyRules([config("Decision Limit Time: 20s » 15s", "7-2 bounty: off » 6"), `"Host @ hostid" posts a big blind of 2`])).to.equal(true);
        expect(hasKeyRules([config("Decision Limit Time: 20s » 15s"), ...BOUNTY_PAID])).to.equal(false);  // keep looking for the setting
        expect(hasKeyRules([...BOUNTY_PAID, `"Host @ hostid" posts a big blind of 1.00`])).to.equal(false);  // no clock
    });
});

describe("LogService.fetchGameRules", () => {
    const LOG = [
        ...SETUP,
        ...hand(1, [`"Host @ hostid" posts a big blind of 1.00`], BOUNTY_PAID),
        config("Decision Limit Time: 15s » 10s"),
        "The game's ante was changed from 0.00 to 0.20.",
        ...hand(2, [`"Host @ hostid" posts an ante of 0.20`, `"Guest @ guestid" posts a straddle of 2.00`])
    ];
    // serves `chronological` newest first, `size` entries per page, like PokerNow's log API
    const fakeGame = (chronological: string[], size: number, fail_after = Infinity) => {
        const logs = chronological.map((msg, i) => ({ msg, at: "", created_at: String(1000 + i) })).reverse();
        const service_calls = { pages: 0 };
        const service = new LogService("g", async (path) => {
            if (service_calls.pages >= fail_after) return { status: 500, text: "" };
            service_calls.pages++;
            const before = Number(path.match(/before_at=(\d*)/)![1] || Infinity);
            return { status: 200, text: JSON.stringify({ logs: logs.filter((l) => Number(l.created_at) < before).slice(0, size) }) };
        });
        return { service, calls: service_calls };
    };

    it("pages back through the log and reads the rules in order", async () => {
        const { service } = fakeGame(LOG, 5);
        expect(await service.fetchGameRules()).to.deep.equal(parseGameRules(LOG));
        expect(parseGameRules(LOG)).to.deep.equal({
            decision_seconds: 10, seven_deuce_bounty: 3, ante: 0.2, straddle_allowed: true, run_it_twice: true
        });
    });

    it("stops once it has seen the clock and the bounty settings, or after max_pages", async () => {
        const filler = Array.from({ length: 50 }, (_, i) => `The player "P${i} @ p${i}" joined the game with a stack of 100.`);
        const game = fakeGame([...filler, ...LOG], 5);
        await game.service.fetchGameRules();
        expect(game.calls.pages).to.equal(Math.ceil(LOG.length / 5));    // never reaches the filler
        const capped = fakeGame([...filler, ...hand(1, [`"Host @ hostid" posts a straddle of 2`]), config("Decision Limit Time: 20s » 15s")], 5);
        expect(await capped.service.fetchGameRules(3)).to.deep.equal({ decision_seconds: 15, straddle_allowed: true });
        expect(capped.calls.pages).to.equal(3);
    });

    it("never throws: keeps the pages it could read, or returns {}", async () => {
        const broken = new LogService("g", async () => { throw new Error("tab closed"); });
        expect(await broken.fetchGameRules()).to.deep.equal({});
        const not_json = new LogService("g", async () => ({ status: 200, text: "<html>" }));
        expect(await not_json.fetchGameRules()).to.deep.equal({});
        const { service } = fakeGame(LOG, 5, 1);
        expect(await service.fetchGameRules()).to.deep.equal({ ante: 0.2, straddle_allowed: true });
    });
});
