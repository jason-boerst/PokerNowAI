import { expect } from "chai";

import { heroView, parseHand } from "../../app/engine/hand-parser.ts";
import { PlayerProfile, PlayerType, PRIORS, RATE_KEYS, RateKey, Rate, resetPriors } from "../../app/engine/player-profile.ts";
import type { PlayerInfo } from "../../app/services/profile-service.ts";
import { opponentCards, statLevel, typeTone } from "../../app/ui/opponent-cards.ts";

const p = (name: string, id: string) => `"${name} @ ${id}"`;
const NAMES = ["H", "A", "B", "C", "D", "E", "F"];
/** A hand log up to now: hero H on the button, then A (SB), B (BB), C, D, E, F, dealt `n` players. */
const hand = (n: number, lines: string[]) => {
    const names = NAMES.slice(0, n);
    const s = parseHand([
        `-- starting hand #7 (id: t)  No Limit Texas Hold'em (dealer: ${p("H", "h")}) --`,
        `Player stacks: ${names.map((x, i) => `#${i + 1} ${p(x, x.toLowerCase())} (${x === "F" ? 50 : 200})`).join(" | ")}`,
        `Your hand is A♥, 5♥`,
        `${p("A", "a")} posts a small blind of 1`, `${p(n === 2 ? "H" : "B", n === 2 ? "h" : "b")} posts a big blind of 2`,
        ...lines.map((l) => l.replace(/^([A-Z]) /, (_, x: string) => `${p(x, x.toLowerCase())} `))
    ], { hero_name: "H" });
    return { state: s, view: heroView(s)! };
};

const rate = (k: number, n: number, value = n ? k / n : 0.3): Rate => ({ k, n, value });
const profile = (hands: number, rates: Partial<Record<RateKey, Rate>> = {}, extra: Partial<PlayerProfile> = {}): PlayerProfile => {
    const all = {} as Record<RateKey, Rate>;
    for (const key of RATE_KEYS) all[key] = rates[key] ?? { k: 0, n: 0, value: PRIORS[key].mean };
    const flat = rate(0, 0, 0.3);
    return {
        key: "x", name: "X", names: ["X"], hands, net_bb: 0, bb_per_100: 0, avg_bet_to_pot: 0, bets_seen: 0, ...all,
        vpip_by_position: { early: flat, middle: flat, late: flat, blinds: flat }, showdowns: [], last_seen: "",
        type: hands >= 20 ? "regular" : "unknown", exploit: "Plays close to standard.", ...extra
    };
};
/** Player lookup from name to info (no entry: no history). */
const lookup = (infos: Record<string, PlayerInfo>) => (ref: { name: string }): PlayerInfo => infos[ref.name] ?? { deviations: [] };
const noStats = () => undefined;
const cardsFor = (h: ReturnType<typeof hand>, infos: Record<string, PlayerInfo> = {}, limit?: number) =>
    opponentCards({ ...h, players: lookup(infos), stats: noStats }, limit);
const labels = (c: { stats: { label: string }[] }) => c.stats.map((x) => x.label);

describe("opponent cards", () => {
    beforeEach(() => resetPriors());

    it("puts the last raiser first, then the rest in acting order, and counts the ones not shown", () => {
        // 7 players: C and D limp, E raises, F calls, hero on the button faces the raise
        const h = hand(7, ["C calls 2", "D calls 2", "E raises to 8", "F calls 8"]);
        const { cards, more } = cardsFor(h);
        expect(cards.map((c) => c.name)).to.deep.equal(["E", "C", "D", "F"]);
        expect(cards.map((c) => c.seat)).to.deep.equal(["HJ", "UTG", "LJ", "CO"]);
        expect(more).to.equal(2);
        // the limpers act again after hero; the caller doesn't
        expect(cards.map((c) => c.to_act)).to.deep.equal([false, true, true, false]);
        expect(cardsFor(h, {}, 6).cards.map((c) => `${c.name}${c.to_act ? "*" : ""}`)).to.deep.equal(["E", "C*", "D*", "F", "A*", "B*"]);
        expect(cards[3].stack_bb).to.equal(21);
    });

    it("counts a straddler with the option as still to act", () => {
        const { cards } = cardsFor(hand(4, ["C posts a straddle of 4"]));
        expect(cards.map((c) => `${c.seat}${c.to_act ? "*" : ""}`)).to.deep.equal(["UTG*", "SB*", "BB*"]);
    });

    it("preflop facing a raise: the raiser's fold to 3-bet, a late opener's steal rate, limpers' limp rate", () => {
        const limped = cardsFor(hand(7, ["C calls 2", "D calls 2", "E raises to 8", "F calls 8"])).cards;
        expect(labels(limped[0])).to.deep.equal(["Fold to 3-bet", "VPIP", "PFR", "3-bet"]);
        expect(labels(limped[1])).to.deep.equal(["Limp", "VPIP", "PFR", "3-bet"]);
        expect(labels(limped[3])).to.deep.equal(["VPIP", "PFR", "3-bet"]);

        const stolen = cardsFor(hand(7, ["C folds", "D folds", "E folds", "F raises to 6"]), {}, 6).cards;
        expect(stolen.map((c) => c.name)).to.deep.equal(["F", "A", "B"]);
        expect(labels(stolen[0])).to.deep.equal(["Steal", "Fold to 3-bet", "VPIP", "PFR", "3-bet"]);
        expect(stolen[0].stats[1].hint).to.equal("if you 3-bet: how often they fold");
        // the blinds act after hero: how often they re-raise
        expect(stolen[1].stats.find((x) => x.label === "3-bet")!.hint).to.equal("acts after you: how often they re-raise");
    });

    it("preflop with a chance to steal: how often the blinds fold", () => {
        const { cards } = cardsFor(hand(4, ["C folds"]));
        expect(cards.map((c) => c.seat)).to.deep.equal(["SB", "BB"]);
        for (const c of cards) expect(labels(c)).to.deep.equal(["Fold to steal", "VPIP", "PFR", "3-bet"]);
    });

    it("after the flop with a chance to bet: how often they fold and raise, and fold to c-bet as the preflop raiser", () => {
        // hero raised preflop; the big blind called and checks the flop
        const cbet = cardsFor(hand(3, ["H raises to 6", "A folds", "B calls 6", "Flop:  [K♥, 9♥, 2♣]", "B checks"])).cards;
        expect(labels(cbet[0])).to.deep.equal(["Fold to c-bet", "Fold to flop bet", "Raises vs bet", "VPIP", "PFR", "3-bet"]);
        expect(cbet[0].stats[1].hint).to.equal("you bet: how often they fold heads-up");
        expect(cbet[0].to_act).to.equal(false);

        // not the preflop raiser, on the turn: no c-bet
        const turn = cardsFor(hand(4, ["C calls 2", "H calls 2", "A calls 2", "B checks", "Flop:  [K♥, 9♥, 2♣]", "A checks", "B checks",
            "C checks", "H checks", "Turn:  K♥, 9♥, 2♣ [7♠]", "A checks", "B checks", "C checks"])).cards;
        expect(turn.map((c) => c.seat)).to.deep.equal(["SB", "BB", "UTG"]);
        expect(labels(turn[0])).to.deep.equal(["Fold to turn bet", "Raises vs bet", "VPIP", "PFR", "3-bet"]);
        expect(turn.map((c) => c.to_act)).to.deep.equal([false, false, false]);
        // heads-up hero is the big blind and acts first after the flop: the button acts after hero
        const first = cardsFor(hand(2, ["A calls 2", "H checks", "Flop:  [K♥, 9♥, 2♣]"])).cards;
        expect(first[0]).to.include({ seat: "SB", to_act: true });
    });

    it("after the flop facing a bet: the bettor's aggression and showdown stats, the others' raises and calls", () => {
        const { cards } = cardsFor(hand(4, ["C calls 2", "H calls 2", "A calls 2", "B checks", "Flop:  [K♥, 9♥, 2♣]", "A checks", "B bets 4", "C calls 4"]));
        expect(cards.map((c) => c.seat)).to.deep.equal(["BB", "SB", "UTG"]);
        expect(labels(cards[0])).to.deep.equal(["Aggression", "Bets when checked to", "Wins at showdown", "VPIP", "PFR", "3-bet"]);
        expect(cards[0].stats[0].hint).to.equal("they bet: higher means more bluffs");
        expect(labels(cards[1])).to.deep.equal(["Raises vs bet", "Showdown", "Aggression", "VPIP", "PFR", "3-bet"]);
        expect(labels(cards[2])).to.deep.equal(["Showdown", "Aggression", "VPIP", "PFR", "3-bet"]);
        expect(cards.map((c) => c.to_act)).to.deep.equal([false, true, false]);

        // a lead (nobody checked first): no "bets when checked to"
        const lead = cardsFor(hand(3, ["H calls 2", "A calls 2", "B checks", "Flop:  [K♥, 9♥, 2♣]", "A bets 3", "B calls 3"])).cards;
        expect(lead[0].name).to.equal("A");
        expect(labels(lead[0])).to.deep.equal(["Aggression", "Wins at showdown", "Showdown", "VPIP", "PFR", "3-bet"]);
    });

    it("colors each stat against your pool's average", () => {
        const player = profile(200, {
            vpip: rate(100, 200, 0.5),          // 15 points over 35%: high
            pfr: rate(10, 200, 0.05),           // 7 points under 12%: low
            three_bet: rate(3, 60, 0.055),      // half a point over 5%: normal
            fold_to_bet_flop: rate(1, 3, 0.2)   // 3 chances: unknown
        });
        const { cards } = cardsFor(hand(2, ["A calls 2", "H checks", "Flop:  [K♥, 9♥, 2♣]"]), { A: { current: player, deviations: [] } });
        const by = Object.fromEntries(cards[0].stats.map((x) => [x.label, x]));
        expect(by["VPIP"]).to.include({ value: 0.5, n: 200, pool: PRIORS.vpip.mean, level: "high" });
        expect(by["PFR"].level).to.equal("low");
        expect(by["3-bet"].level).to.equal("normal");
        expect(by["Fold to flop bet"]).to.include({ n: 3, level: "unknown" });

        expect(statLevel(0.5, 4, 0.35)).to.equal("unknown");
        expect(statLevel(0.5, 8, 0.35)).to.equal("normal");      // too few chances to judge
        expect(statLevel(0.42, 10, 0.35)).to.equal("high");      // exactly 7 points
        expect(statLevel(0.29, 50, 0.35)).to.equal("normal");
        expect(statLevel(0.28, 50, 0.35)).to.equal("low");
        expect(statLevel(0.07, 50, 0.05)).to.equal("high");      // rare action: 40% over its average
        expect(statLevel(0.06, 50, 0.05)).to.equal("normal");
        expect(statLevel(0.03, 50, 0.05)).to.equal("low");
    });

    it("shows pool averages as unknown for a player with no history, and warns about small samples", () => {
        const h = hand(3, ["H raises to 6", "A calls 6", "B calls 6", "Flop:  [K♥, 9♥, 2♣]", "A checks", "B checks"]);
        const { cards, warnings } = cardsFor(h, { B: { current: profile(10), deviations: [] } });
        const [none, small] = cards;
        expect(none).to.include({ name: "A", type: "unknown", type_tone: "unknown", low_sample: true });
        expect(none.hands).to.deep.equal({ before: 0, today: 0 });
        expect(none.exploit).to.match(/No history/);
        for (const x of none.stats) expect(x).to.include({ n: 0, level: "unknown" });
        expect(none.stats.find((x) => x.label === "VPIP")!.value).to.equal(PRIORS.vpip.mean);
        expect(small.low_sample).to.equal(true);
        expect(warnings).to.deep.equal(["2 opponent(s) have under 20 hands: their stats are mostly population defaults."]);

        const known = cardsFor(h, { A: { current: profile(100), deviations: [] }, B: { current: profile(25), deviations: [] } });
        expect(known.cards.map((c) => c.low_sample)).to.deep.equal([false, false]);
        expect(known.warnings).to.deep.equal([]);
    });

    it("gives each player type a color family", () => {
        const tones: Record<PlayerType, string> = {
            "calling station": "loose", "loose-passive": "loose", "maniac": "aggressive", "LAG": "aggressive",
            "nit": "tight", "TAG": "balanced", "regular": "balanced", "unknown": "unknown"
        };
        for (const [type, tone] of Object.entries(tones)) expect(typeTone(type)).to.equal(tone);
        const station = profile(300, {}, { type: "calling station", exploit: "Value bet thinner and bigger." });
        const { cards } = cardsFor(hand(2, ["A calls 2", "H checks", "Flop:  [K♥, 9♥, 2♣]"]), { A: { current: station, deviations: [] } });
        expect(cards[0]).to.include({ type: "calling station", type_tone: "loose", exploit: "Value bet thinner and bigger." });
    });

    it("shows today against usual play, clear changes, the last showdown and the range width", () => {
        const long = profile(300, { vpip: rate(96, 300, 0.32), pfr: rate(54, 300, 0.18) });
        const session = profile(7, { vpip: rate(3, 7), pfr: rate(1, 7) }, {
            showdowns: [{ hand_number: 3, cards: ["9c", "Kd"], hand_class: "K9o", board: [], line: "preflop: call | flop: check/call | river: bet", won: true }]
        });
        const info: PlayerInfo = {
            current: { ...long, showdowns: session.showdowns }, long, session,
            deviations: [{ stat: "vpip", label: "VPIP", session: 0.5, usual: 0.32, chances: 20, text: "playing more hands: VPIP 50% this game vs 32% usually (20 chances)" }]
        };
        const h = hand(2, ["A calls 2", "H checks", "Flop:  [K♥, 9♥, 2♣]"]);
        const card = opponentCards({ ...h, players: lookup({ A: info }), stats: () => ({ vpip: 40, pfr: 10, hands: 300, shrunk: true }) }).cards[0];
        expect(card.today).to.equal("Today VPIP 43% / PFR 14% over 7 hands (usually 32% / 18%)");
        expect(card.hands).to.deep.equal({ before: 300, today: 7 });
        expect(card.flags).to.deep.equal([info.deviations[0].text]);
        expect(card.last_showdown).to.equal("9c Kd after call, check/call, bet");
        expect(card.range_pct).to.be.greaterThan(20).and.lessThan(100);
        // only today's game: no usual numbers to compare with
        expect(opponentCards({ ...h, players: lookup({ A: { current: session, session, deviations: [] } }), stats: noStats }).cards[0].today)
            .to.equal("Today VPIP 43% / PFR 14% over 7 hands (no earlier games)");
    });
});
