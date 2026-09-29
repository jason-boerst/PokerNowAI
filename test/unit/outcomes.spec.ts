import { expect } from "chai";
import { readFileSync } from "node:fs";

import { followedSuggestion, mapSource, OUTCOME_SOURCES, OutcomeRow, summarizeOutcomes } from "../../app/engine/decision-outcomes.ts";
import { importLog } from "../../app/import/importer.ts";
import { readLogRows, splitHands } from "../../app/import/pokernow-csv.ts";
import { DBService } from "../../app/services/db-service.ts";
import { DecisionRow, HandRecorder, ME } from "../../app/services/hand-recorder.ts";

// Anonymized PokerNow export; "Hero @ HeroId0001" is you. In hand #2 Hero (QQ in the big blind)
// calls a 3-bet, then checks and calls on the flop, turn and river, and loses 137.42 BB.
const FIXTURE_NAME = "poker_now_log_fixtureGame01.csv";
const FIXTURE = readFileSync(new URL(`../fixtures/${FIXTURE_NAME}`, import.meta.url), "utf8");
const hand = (n: number) => splitHands(readLogRows(FIXTURE)).hands.find((h) => h.hand_number === n)!.messages;
/** The hand's log just before the line that contains `text` (what the bot saw when it was asked). */
const before = (messages: string[], text: string, nth = 0) => messages.slice(0, messages.map((m, i) => [m, i] as const).filter(([m]) => m.includes(text))[nth][1]);

// synthetic hand: Hero calls a raise with AKs (suggested: raise), bets the flop, then shoves over
// a raise and is called by a set; all in on the flop with both hands shown.
const SHOVE_HAND = [
    '-- starting hand #5 (id: synth5)  No Limit Texas Hold\'em (dealer: "Villain2 @ VillainId02") --',
    'Player stacks: #1 "Villain1 @ VillainId01" (100.00) | #2 "Hero @ HeroId0001" (100.00) | #3 "Villain2 @ VillainId02" (100.00)',
    "Your hand is A♠, K♠",
    '"Villain1 @ VillainId01" posts a small blind of 0.50',
    '"Hero @ HeroId0001" posts a big blind of 1.00',
    '"Villain2 @ VillainId02" raises to 3.00',
    '"Villain1 @ VillainId01" folds',
    '"Hero @ HeroId0001" calls 3.00',
    "Flop:  [A♥, 7♦, 2♣]",
    '"Hero @ HeroId0001" bets 4.00',
    '"Villain2 @ VillainId02" raises to 12.00',
    '"Hero @ HeroId0001" raises to 97.00 and go all in',
    '"Villain2 @ VillainId02" calls 97.00 and go all in',
    "Turn: A♥, 7♦, 2♣ [9♠]",
    "River: A♥, 7♦, 2♣, 9♠ [3♥]",
    '"Villain2 @ VillainId02" shows a 7♠, 7♥.',
    '"Hero @ HeroId0001" shows a A♠, K♠.',
    '"Villain2 @ VillainId02" collected 200.50 from pot with Three of a Kind, 7\'s',
    "-- ending hand #5 --"
];

const AI_PROMPT = "You are advising in a live No-Limit Hold'em cash game (full ring) against loose, mostly passive recreational players.";
const BASIC_PROMPT = "Help me decide my action in No Limit Hold'em poker. I'm in the BB position with a stack size of 100 BB.";

describe("suggestion tracking", () => {
    let db: DBService;
    let recorder: HandRecorder;

    beforeEach(async () => {
        db = new DBService(":memory:");
        await db.init();
        await db.createTables();
        recorder = new HandRecorder(db);
    });
    afterEach(async () => { await db.close(); });

    const decide = (game_id: string, hand_number: number | null, street: string, messages: string[], action_str: string, size = 0,
        source = "engine", model = street === "preflop" ? "preflop-engine" : "postflop-engine", prompt = "") =>
        recorder.recordDecision({
            game_id, hand_number, street, messages, hero_name: "Hero", hero_cards: [], big_blind: 1, prompt, response: "",
            action: { action_str, bet_size_in_BBs: size, reason: "test" }, model, source, latency_ms: 5
        });
    const rows = async (): Promise<DecisionRow[]> => recorder.decisions();

    it("records what you did after each suggestion and what the hand earned", async () => {
        const h2 = hand(2);
        await decide("live", 2, "preflop", before(h2, '"Hero @ HeroId0001" calls 15.50'), "call");
        await decide("live", 2, "flop", before(h2, '"Hero @ HeroId0001" checks'), "check");
        await decide("live", 2, "flop", before(h2, '"Hero @ HeroId0001" calls 15.00'), "fold");
        await decide("live", 2, "turn", before(h2, '"Hero @ HeroId0001" checks', 1), "bet", 20, "llm", "some/model", AI_PROMPT);
        await decide("live", 2, "river", before(h2, '"Hero @ HeroId0001" calls 81.92'), "call");
        await recorder.recordHand("live", h2, "Hero", 1);

        const got = (await rows()).map((d) => [d.street, d.actual_action, d.followed]);
        expect(got).to.deep.equal([
            ["preflop", "call", 1],
            ["flop", "check", 1],
            ["flop", "call", 0],
            ["turn", "check", 0],
            ["river", "call", 1]
        ]);
        for (const d of await rows()) {
            expect(d.hand_net_bb).to.be.closeTo(-137.42, 1e-9);
            expect(d.adjusted_net_bb).to.be.closeTo(-137.42, 1e-9);   // all in on the river: nothing to adjust
        }
    });

    it("matches several suggestions on one street in order, and counts only the last of repeated ones", async () => {
        const h2 = hand(2);
        // the hand's full log (no decision-time log to go by): next unmatched action on the street
        await decide("live", 2, "turn", h2, "check");
        await decide("live", 2, "turn", h2, "raise", 50);
        // shown twice for the same river spot: both are about the check, the second is what you saw
        await decide("live", 2, "river", before(h2, '"Hero @ HeroId0001" checks', 2), "check");
        await decide("live", 2, "river", before(h2, '"Hero @ HeroId0001" checks', 2), "bet", 30);
        await decide("live", 2, "river", before(h2, '"Hero @ HeroId0001" calls 81.92'), "fold");
        await recorder.recordHand("live", h2, "Hero", 1);

        expect((await rows()).map((d) => [d.street, d.actual_action, d.followed])).to.deep.equal([
            ["turn", "check", 1],
            ["turn", "call", 0],
            ["river", "check", null],
            ["river", "check", 0],
            ["river", "call", 0]
        ]);
    });

    it("skips a spot the bot missed without shifting the next suggestion", async () => {
        const h2 = hand(2);
        // no suggestion for the flop check; the next one was made facing the bet
        await decide("live", 2, "flop", before(h2, '"Hero @ HeroId0001" calls 15.00'), "call");
        await recorder.recordHand("live", h2, "Hero", 1);
        expect((await rows()).map((d) => [d.actual_action, d.followed])).to.deep.equal([["call", 1]]);
    });

    it("compares raise sizes and all-ins, and luck-adjusts an all-in called by a set", async () => {
        await decide("live", 5, "preflop", before(SHOVE_HAND, '"Hero @ HeroId0001" calls 3.00'), "raise", 10);
        await decide("live", 5, "flop", before(SHOVE_HAND, '"Hero @ HeroId0001" bets 4.00'), "bet", 4.5);
        await decide("live", 5, "flop", before(SHOVE_HAND, '"Hero @ HeroId0001" raises to 97.00'), "all-in", 97, "llm", "some/model", AI_PROMPT);
        await recorder.recordHand("live", SHOVE_HAND, "Hero", 1);

        const got = await rows();
        expect(got.map((d) => [d.actual_action, d.followed])).to.deep.equal([
            ["call", 0],                  // suggested raise, you called
            ["bet 4", 1],                 // 4 vs 4.5 BB: within 25%
            ["raise 97 (all in)", 1]
        ]);
        expect(got[0].hand_net_bb).to.be.closeTo(-100, 1e-9);
        // AK needs runner-runner against a set: a few percent of the 200.5 BB pot
        expect(got[0].adjusted_net_bb!).to.be.greaterThan(-100).and.lessThan(-80);
    });

    it("decides followed for sizes and short stacks", () => {
        const act = (type: "call" | "bet" | "raise", size_bb = 0, all_in = false) => ({ street: "flop" as const, type, size_bb, all_in });
        expect(followedSuggestion({ action: "raise", size_bb: 9 }, act("raise", 7))).to.equal(true);
        expect(followedSuggestion({ action: "raise", size_bb: 12 }, act("raise", 7))).to.equal(false);
        expect(followedSuggestion({ action: "raise", size_bb: 12 }, act("raise", 7, true))).to.equal(true);   // all you had
        expect(followedSuggestion({ action: "raise", size_bb: 12 }, act("call", 0, true))).to.equal(true);    // calling was all in
        expect(followedSuggestion({ action: "all-in", size_bb: 40 }, act("call", 0, true))).to.equal(true);
        expect(followedSuggestion({ action: "all-in", size_bb: 40 }, act("raise", 20))).to.equal(false);
        expect(followedSuggestion({ action: "call", size_bb: 0 }, act("raise", 20, true))).to.equal(false);
    });

    it("still records hands with no suggestions, and leaves other hands' suggestions for later", async () => {
        await decide("live", 3, "preflop", before(hand(3), '"Hero @ HeroId0001" calls 3.00'), "fold");
        await recorder.recordHand("live", hand(2), "Hero", 1);
        expect(await recorder.hands()).to.have.length(1);
        expect((await rows())[0]).to.include({ followed: null, actual_action: null });

        const empty = await recorder.results();
        expect(empty.sources).to.deep.equal([]);
        expect(empty.note).to.match(/^No suggestions matched to your actions yet\./).and.match(/1 suggestion wasn't counted/);

        await recorder.recordHand("live", hand(3), "Hero", 1);
        expect((await rows())[0]).to.include({ followed: 0, actual_action: "call", hand_net_bb: 16.5 });
    });

    it("retries when you can't be found in a hand, e.g. once your id is linked", async () => {
        // the bot's name isn't the one in the log (e.g. a changed display name)
        await recorder.recordDecision({
            game_id: "live", hand_number: 3, street: "river", messages: before(hand(3), '"Hero @ HeroId0001" calls 6.50'), hero_name: "Renamed",
            hero_cards: [], big_blind: 1, prompt: "", response: "", action: { action_str: "call", bet_size_in_BBs: 0 }, model: "postflop-engine",
            source: "engine", latency_ms: 5
        });
        await recorder.recordHand("live", hand(3), "Renamed", 1);
        expect((await rows())[0]).to.include({ followed: null, actual_action: null });
        await recorder.link("HeroId0001", ME, "detected from your hole cards");
        await recorder.results();
        expect((await rows())[0]).to.include({ followed: 1, actual_action: "call", hand_net_bb: 16.5 });
    });

    it("matches suggestions when their hands arrive by import", async () => {
        await decide("fixtureGame01", 3, "river", before(hand(3), '"Hero @ HeroId0001" calls 6.50'), "call", 0, "llm", "some/model", AI_PROMPT);
        await importLog(recorder, FIXTURE_NAME, FIXTURE);
        expect((await rows())[0]).to.include({ followed: 1, actual_action: "call", hand_net_bb: 16.5 });
    });

    it("adds the new columns to an older database and fills them in", async () => {
        const old = new DBService(":memory:");
        await old.init();
        await old.run(`CREATE TABLE Decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, hand_number INT, street TEXT,
            messages_json TEXT NOT NULL, hero_name TEXT, hero_cards TEXT, big_blind REAL, prompt TEXT, response TEXT, action_json TEXT,
            model TEXT, source TEXT, latency_ms INT, label TEXT, recorded_at TEXT NOT NULL)`);
        await old.run(`INSERT INTO Decisions (game_id, hand_number, street, messages_json, hero_name, action_json, model, source, prompt, recorded_at)
            VALUES ('old', 2, 'preflop', '[]', 'Hero', '{"action_str":"call","bet_size_in_BBs":0}', 'gpt-4o', 'llm', ?, 'x')`, [BASIC_PROMPT]);
        await old.createTables();
        const r = new HandRecorder(old);
        await old.run(`INSERT INTO Hands (game_id, hand_number, hero_name, big_blind, messages_json, recorded_at) VALUES ('old', 2, 'Hero', 1, ?, 'x')`,
            [JSON.stringify(hand(2))]);
        const summary = await r.results();
        expect(summary.sources.map((s) => [s.source, s.decisions, s.follow_rate])).to.deep.equal([["Basic AI prompt", 1, 1]]);
        expect((await r.decisions())[0]).to.include({ followed: 1, actual_action: "call" });
        await old.close();
    });
});

describe("results by suggestion source", () => {
    it("names the five sources", () => {
        expect(mapSource("preflop-engine", "engine")).to.equal("Preflop chart");
        expect(mapSource("postflop-engine", "engine")).to.equal("Post-flop engine");
        expect(mapSource("anthropic/claude-x", "llm", AI_PROMPT)).to.equal("AI");
        expect(mapSource("anthropic/claude-x", "llm")).to.equal("AI");
        expect(mapSource("engine (fallback from anthropic/claude-x)", "engine-fallback")).to.equal("AI fallback");
        expect(mapSource("gpt-4o", "llm", BASIC_PROMPT)).to.equal("Basic AI prompt");
        expect(OUTCOME_SOURCES).to.have.length(5);
    });

    const row = (hand_number: number | null, followed: number | null, net: number | null, model = "preflop-engine", source = "engine", prompt = ""): OutcomeRow =>
        ({ game_id: "g", hand_number, model, source, prompt, followed, hand_net_bb: net === null ? null : net - 1, adjusted_net_bb: net });

    it("counts follow rate per suggestion and results per hand", () => {
        const summary = summarizeOutcomes([
            row(1, 1, 10), row(2, 1, -2), row(3, 0, -5),
            row(4, 1, 4), row(4, 0, 4),                               // one of two not followed: hand not followed
            row(5, 1, 3, "some/model", "llm", AI_PROMPT),
            row(6, 0, -1, "gpt-4o", "llm", BASIC_PROMPT),
            row(7, 1, 2, "engine (fallback from x)", "engine-fallback"),
            row(8, 1, 1, "postflop-engine"),
            row(9, null, null)                                        // not matched: left out
        ]);
        expect(Object.keys(summary).sort()).to.deep.equal(["note", "sources"]);
        expect(summary.sources.map((s) => s.source)).to.deep.equal([...OUTCOME_SOURCES]);
        const pre = summary.sources[0];
        expect(Object.keys(pre).sort()).to.deep.equal(["decisions", "follow_rate", "followed", "not_followed", "source"]);
        expect(Object.keys(pre.followed).sort()).to.deep.equal(["bb_per_100", "ci_high", "ci_low", "hands"]);
        expect(pre).to.include({ decisions: 5, follow_rate: 0.6 });
        expect(pre.followed.hands).to.equal(2);
        expect(pre.followed.bb_per_100).to.be.closeTo(400, 1e-9);
        // sd of [10, -2] is 8.49 BB a hand: 1.96 * 8.49 / sqrt(2) * 100
        expect(pre.followed.ci_high - pre.followed.bb_per_100).to.be.closeTo(1.96 * Math.sqrt(72) / Math.sqrt(2) * 100, 1e-6);
        expect(pre.not_followed).to.include({ hands: 2, bb_per_100: -50 });
        // a single hand: the range comes from the minimum spread instead of being endless
        const ai = summary.sources[2];
        expect(ai).to.include({ decisions: 1, follow_rate: 1 });
        expect(ai.followed.ci_low).to.be.closeTo(300 - 980, 1e-9);
        expect(ai.not_followed).to.deep.equal({ hands: 0, bb_per_100: 0, ci_low: 0, ci_high: 0 });
        expect(summary.note).to.match(/^Too few hands to tell yet: /).and.match(/You followed 67% of 9 suggestions\./)
            .and.match(/1 suggestion wasn't counted/);
        expect(summary.note).to.not.match(/[\u2013\u2014]/);
    });

    it("gives a verdict only when the ranges clearly separate", () => {
        const rows: OutcomeRow[] = [];
        for (let i = 0; i < 40; i++) {
            rows.push(row(i, 1, i % 2 ? 4 : 6));                       // followed: about +5 BB a hand
            rows.push(row(100 + i, 0, i % 2 ? -4 : -6));               // ignored: about -5 BB a hand
        }
        const summary = summarizeOutcomes(rows);
        expect(summary.note).to.match(/^Following the preflop chart has paid off: \+500\.0 bb\/100 when you followed it vs -500\.0 when you didn't\./);
        expect(summary.note).to.match(/Hands where you followed the preflop chart are winning/)
            .and.match(/Hands where you went against the preflop chart are losing/);
        expect(summary.note).to.not.match(/Too few hands/);

        // the same gap over a few hands: no verdict
        expect(summarizeOutcomes(rows.slice(0, 20)).note).to.match(/^Too few hands to tell yet/);
    });
});
