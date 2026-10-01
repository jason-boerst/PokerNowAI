import { expect } from "chai";
import { readFileSync } from "node:fs";

import { netResult, parseHand } from "../../app/engine/hand-parser.ts";
import { blendSession, calibratePriors, classify, isHoldem, PlayerProfile, POOL_PRIOR_WEIGHT, PRIORS, RATE_KEYS, resetPriors, sessionDeviations } from "../../app/engine/player-profile.ts";
import { POPULATION_TENDENCIES } from "../../app/engine/opponent-range.ts";
import { importLog } from "../../app/import/importer.ts";
import { detectHero, gameIdFromFileName, handsDealtToYou, ImportedHand, parseCsv, potBalances, readLogRows, splitHands } from "../../app/import/pokernow-csv.ts";
import { DBService } from "../../app/services/db-service.ts";
import { HandRecorder } from "../../app/services/hand-recorder.ts";
import { LogService } from "../../app/services/log-service.ts";
import { ME, ProfileService } from "../../app/services/profile-service.ts";

// Real hands from PokerNow exports with every name and id replaced (Hero = the exporting player).
// Hand #1 is cut off by the export limit; #2-#14 cover: your showdowns (#2, #3), antes (#4), an
// Omaha double-board bomb pot (#5), run it twice (#6), 7-2 bounties (#7, #9), cards shown after
// the hand (#8), a straddle (#9), 10-handed (#10, #12), a dead button (#11), missed blinds (#12),
// an uncalled bet (#13) and an all-in (#14). An ID change links PlayerId03 and PlayerId07.
const FIXTURE_NAME = "poker_now_log_fixtureGame01.csv";
const FIXTURE = readFileSync(new URL(`../fixtures/${FIXTURE_NAME}`, import.meta.url), "utf8");
const fixtureHands = () => splitHands(readLogRows(FIXTURE));
const hand = (n: number) => fixtureHands().hands.find((h) => h.hand_number === n)!;
const state = (n: number) => { const h = hand(n); return parseHand(h.messages, { big_blind: h.big_blind }); };

describe("PokerNow CSV export", () => {
    it("parses quoted fields, doubled quotes, commas and newlines inside quotes", () => {
        const rows = parseCsv('entry,at,order\r\n"""A @ x"" bets 5, then ""folds""",2025-01-01,2\n"Game Config Changes\n* Bomb Pot: off » on",2025-01-01,1\n');
        expect(rows).to.deep.equal([
            ["entry", "at", "order"],
            ['"A @ x" bets 5, then "folds"', "2025-01-01", "2"],
            ["Game Config Changes\n* Bomb Pot: off » on", "2025-01-01", "1"]
        ]);
    });

    it("rejects files that aren't PokerNow logs and sorts rows oldest first", () => {
        expect(() => readLogRows("name,score\nx,1\n")).to.throw(/Not a PokerNow log/);
        const rows = readLogRows("entry,at,order\nnewer,t2,20\nolder,t1,3\n");
        expect(rows.map((r) => r.entry)).to.deep.equal(["older", "newer"]);
    });

    it("reads the game id from the export's file name", () => {
        expect(gameIdFromFileName("poker_now_log_pglAb-C_12.csv")).to.equal("pglAb-C_12");
        expect(gameIdFromFileName("e8735387-poker_now_log_pglXyz.csv")).to.equal("pglXyz");
        expect(gameIdFromFileName("hands.csv")).to.equal(null);
    });

    it("splits complete hands, counts the cut-off one, and keeps lines logged after a hand ends", () => {
        const { hands, incomplete } = fixtureHands();
        expect(hands.map((h) => h.hand_number)).to.deep.equal([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
        expect(incomplete).to.equal(1);
        // bounty payments and after-hand shows come after "-- ending hand" in the log
        const bounty = hand(7).messages;
        const end = bounty.findIndex((m) => m.startsWith("-- ending hand"));
        expect(bounty.slice(end + 1).some((m) => /paid [\d.]+ for the 7-2 bounty/.test(m))).to.equal(true);
        expect(bounty.some((m) => /joined the game/.test(m))).to.equal(false);
    });

    it("balances every real hand: the pot is paid out exactly and results sum to zero", () => {
        for (const h of fixtureHands().hands) {
            const s = parseHand(h.messages, { big_blind: h.big_blind });
            expect(potBalances(h.messages), `hand #${h.hand_number} pot`).to.equal(true);
            const total = s.seats.reduce((sum, seat) => sum + netResult(s, seat.id), 0);
            expect(Math.abs(total), `hand #${h.hand_number} zero-sum`).to.be.below(0.011);
        }
    });

    it("handles antes, bomb pots, bounties, straddles, run it twice, missed blinds and 10-handed tables", () => {
        const antes = state(4);
        expect(antes.actions.some((a) => a.type === "post_ante")).to.equal(true);
        expect(antes.big_blind).to.equal(0.5);                           // an ante isn't mistaken for the big blind

        const bomb = state(5);
        expect(bomb.bomb_pot).to.equal(true);
        expect(bomb.game_type).to.equal("Pot Limit Omaha Hi");
        expect(isHoldem(bomb)).to.equal(false);
        expect(bomb.board).to.have.length(5);                             // first board only

        const twice = state(6);
        expect(twice.board).to.have.length(5);                            // first run only

        const bounty = state(7);
        const winner = bounty.seats.find((seat) => seat.bounty_net > 0)!;
        expect(winner.bounty_net).to.equal(16);
        expect(bounty.seats.reduce((sum, seat) => sum + seat.bounty_net, 0)).to.equal(0);

        expect(state(8).seats.filter((seat) => seat.shown_cards).length).to.be.greaterThan(0);
        expect(state(9).actions.some((a) => a.type === "post_straddle")).to.equal(true);
        expect(state(12).actions.some((a) => a.type === "post_dead")).to.equal(true);

        const ten = state(10);
        const positions = ten.seats.map((seat) => seat.position);
        expect(ten.seats).to.have.length(10);
        expect(new Set(positions).size).to.equal(10);
        expect(positions).to.include.members(["UTG", "UTG+1", "UTG+2", "MP", "LJ", "HJ", "CO", "BU", "SB", "BB"]);
        expect(state(11).seats.every((seat) => seat.position)).to.equal(true);   // dead button
    });
});

describe("finding your seat in a log", () => {
    const p = (name: string, id: string) => `"${name} @ ${id}"`;
    const synthetic = (n: number, ids: string[], dealt: boolean): ImportedHand => ({
        hand_number: n, started_at: "", game_type: "No Limit Texas Hold'em", big_blind: 2,
        messages: [
            `-- starting hand #${n} (id: s${n})  No Limit Texas Hold'em (dealer: ${p(ids[0], ids[0])}) --`,
            `Player stacks: ${ids.map((id, i) => `#${i + 1} ${p(id, id)} (200)`).join(" | ")}`,
            ...(dealt ? ["Your hand is 9♠, 4♦"] : []),
            `-- ending hand #${n} --`
        ]
    });

    it("matches your hole cards to your showdowns", () => {
        expect(detectHero(fixtureHands().hands)).to.equal("HeroId0001");
    });

    it("without showdowns, picks the only player seated exactly when you were dealt in", () => {
        const hands = [
            synthetic(1, ["me", "a", "b"], true), synthetic(2, ["me", "a", "c"], true), synthetic(3, ["me", "b", "c"], true),
            synthetic(4, ["me", "a", "b"], true), synthetic(5, ["me", "c", "d"], true), synthetic(6, ["a", "b", "c"], false)
        ];
        expect(detectHero(hands)).to.equal("me");
        expect(handsDealtToYou(hands)).to.equal(5);
        // two players in every dealt hand: ambiguous
        const ambiguous = [1, 2, 3, 4, 5].map((n) => synthetic(n, ["me", "a", `x${n}`], true));
        expect(detectHero(ambiguous)).to.equal(null);
        // a spectator's export has no hole cards at all
        expect(detectHero([synthetic(1, ["a", "b"], false)])).to.equal(null);
    });
});

describe("importing logs", () => {
    let recorder: HandRecorder;

    // loading profiles sets the population averages; don't leak them into other tests
    afterEach(() => {
        resetPriors();
        POPULATION_TENDENCIES.vpip = PRIORS.vpip.mean * 100;
        POPULATION_TENDENCIES.pfr = PRIORS.pfr.mean * 100;
    });

    beforeEach(async () => {
        const db = new DBService(":memory:");
        await db.init();
        await db.createTables();
        recorder = new HandRecorder(db);
    });

    it("stores complete hands once, finds you and links changed ids", async () => {
        const first = await importLog(recorder, FIXTURE_NAME, FIXTURE);
        expect(first).to.include({ game_id: "fixtureGame01", hands: 13, added: 13, already_had: 0, incomplete: 1, you: "HeroId0001", first_hand: 2 });
        const again = await importLog(recorder, `/some/folder/${FIXTURE_NAME}`, FIXTURE);
        expect(again).to.include({ added: 0, already_had: 13 });

        const links = await recorder.links();
        expect(links.get("HeroId0001")).to.equal(ME);
        expect(links.get("PlayerId03")).to.equal(links.get("PlayerId07"));
        const games = await recorder.games();
        expect(games).to.have.length(1);
        expect(games[0]).to.include({ game_id: "fixtureGame01", source: "import", hands: 13, hero_id: "HeroId0001" });
    });

    it("records live hands once per hand and links the bot's seat to you", async () => {
        const messages = hand(2).messages;
        await recorder.recordHand("liveGame", messages, "Hero", 1);
        await recorder.recordHand("liveGame", messages, "Hero", 1);        // the same hand again
        expect((await recorder.links()).get("HeroId0001")).to.equal(ME);
        const [game] = await recorder.games();
        expect(game).to.include({ game_id: "liveGame", source: "live", hands: 1 });
    });

    it("builds long-term and live-session profiles keyed by person", async () => {
        await importLog(recorder, FIXTURE_NAME, FIXTURE);
        const service = new ProfileService(recorder);

        await service.load(null);
        const me = service.info({ id: "HeroId0001", name: "whatever" });
        expect(me.long?.key).to.equal(ME);
        expect(me.long?.hands).to.be.greaterThan(0);
        expect(me.session).to.equal(undefined);
        expect(service.everyone().some((e) => e.is_me)).to.equal(true);

        // treating the imported game as the live one: its hands become the session
        await service.load("fixtureGame01");
        const live = service.info({ id: "HeroId0001", name: "Hero" });
        expect(live.long).to.equal(undefined);
        expect(live.session?.hands).to.equal(me.long!.hands);
        expect(service.gameView("fixtureGame01").map((e) => e.key)).to.include(ME);
        expect(service.gamesOf(ME)).to.have.length(1);
    });
});

describe("population averages from your games", () => {
    afterEach(resetPriors);

    it("moves the assumed averages toward your pool as hands accumulate", () => {
        const built_in = PRIORS.vpip.mean;
        const pool = Object.fromEntries(RATE_KEYS.map((k) => [k, { k: 0, n: 0 }])) as Record<typeof RATE_KEYS[number], { k: number, n: number }>;
        pool.vpip = { k: 50, n: 200 };                      // 25% over a small sample: halfway
        calibratePriors(pool);
        expect(PRIORS.vpip.mean).to.be.closeTo((50 + built_in * POOL_PRIOR_WEIGHT) / (200 + POOL_PRIOR_WEIGHT), 1e-9);
        expect(PRIORS.pfr.mean).to.not.equal(undefined);
        pool.vpip = { k: 5000, n: 20000 };                  // big sample: nearly all pool
        calibratePriors(pool);
        expect(PRIORS.vpip.mean).to.be.closeTo(0.25, 0.01);
        resetPriors();
        expect(PRIORS.vpip.mean).to.equal(built_in);
    });
});

describe("session vs long-term", () => {
    const rate = (k: number, n: number, value = k / n) => ({ k, n, value });
    const profile = (vpip: [number, number], hands: number): PlayerProfile => {
        const flat = rate(0, 0, 0.3);
        return {
            key: "x", name: "X", names: ["X"], hands, net_bb: 0, bb_per_100: 0, avg_bet_to_pot: 0, bets_seen: 0,
            vpip: rate(vpip[0], vpip[1]), pfr: rate(0, 0, 0.1), limp: flat, three_bet: flat, fold_to_three_bet: flat, steal: flat,
            fold_to_steal: flat, cbet: flat, fold_to_cbet: flat, aggression: flat, went_to_showdown: flat, won_at_showdown: flat,
            fold_to_bet_flop: flat, fold_to_bet_turn: flat, fold_to_bet_river: flat, raise_vs_bet: flat, bet_when_checked_to: flat, fold_to_small_bet: flat, fold_to_big_bet: flat,
            vpip_by_position: { early: flat, middle: flat, late: flat, blinds: flat }, showdowns: [], last_seen: "", type: "unknown", exploit: ""
        };
    };

    it("pulls a session toward the player's own history, and flags clear changes only", () => {
        const long = profile([100, 500], 500);                 // usually 20% VPIP
        const today = profile([25, 50], 50);                   // 50% today
        const blended = blendSession(long, today)!;
        expect(blended.vpip.value).to.be.closeTo((25 + 0.2 * 30) / (50 + 30), 1e-9);
        expect(blended.hands).to.equal(550);
        expect(sessionDeviations(long, today).map((d) => d.stat)).to.deep.equal(["vpip"]);
        expect(sessionDeviations(long, today)[0].text).to.match(/^playing more hands: VPIP 50% this game vs 20% usually/);
        // too few hands today to say anything
        expect(sessionDeviations(long, profile([6, 10], 10))).to.deep.equal([]);
        // no history: the session stands alone
        expect(blendSession(undefined, today)).to.equal(today);
    });

    it("doesn't call a loose player with a modest raise rate tight", () => {
        const p = profile([41, 100], 100);
        p.vpip.value = 0.41;
        p.pfr = rate(15, 100);
        expect(classify(p)[0]).to.equal("loose-passive");
        p.vpip = rate(22, 100);
        p.pfr = rate(16, 100);
        expect(classify(p)[0]).to.equal("TAG");
    });
});

describe("LogService.fetchLastCompletedHand", () => {
    it("includes the shows and bounty payments logged after the hand ended", async () => {
        const chronological = [
            `-- starting hand #7 (id: z)  No Limit Texas Hold'em (dealer: "A @ a") --`,
            `Player stacks: #1 "A @ a" (100) | #2 "B @ b" (100)`,
            `"A @ a" posts a small blind of 1`, `"B @ b" posts a big blind of 2`,
            `"A @ a" raises to 6`, `"B @ b" folds`,
            `Uncalled bet of 4 returned to "A @ a"`, `"A @ a" collected 4 from pot`,
            `-- ending hand #7 --`,
            `"A @ a" shows a 7♠, 2♦.`,
            `"B @ b" paid 2 for the 7-2 bounty to "A @ a"`,
            `"A @ a" collected 2 from the 7-2 bounty`,
            `The player "C @ c" joined the game with a stack of 100.`
        ];
        const logs = [...chronological].reverse().map((msg, i) => ({ msg, at: "", created_at: String(1000 - i) }));
        const service = new LogService("g", async (path) => ({
            status: 200, text: JSON.stringify({ logs: path.includes("before_at=&") ? logs : [] })
        }));
        const messages = (await service.fetchLastCompletedHand())!;
        expect(messages).to.deep.equal(chronological.slice(0, 12));
        const s = parseHand(messages);
        expect(s.seats.find((seat) => seat.id === "a")!.bounty_net).to.equal(2);
        expect(netResult(s, "a") + netResult(s, "b")).to.equal(0);
    });
});
