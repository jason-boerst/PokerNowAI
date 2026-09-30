// Renders sample suggestion panels on a page that looks like a PokerNow table and screenshots each one,
// to review the panel design. Usage: npx tsx scripts/panel-gallery.ts [output dir] (default /tmp/panel-gallery)
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

import { OpponentCard, PanelModel } from "../app/ui/panel-model.ts";
import { escapeHtml, renderPanel } from "../app/ui/panel-render.ts";

const CHROMIUM = "/opt/pw-browsers/chromium";

const spot = (over: Partial<PanelModel["spot"]> = {}): PanelModel["spot"] => ({
    pot_bb: 12, to_call_bb: 0, pot_odds: 0, stack_bb: 96, effective_bb: 88, spr: 7.3, spr_label: "SPR", notes: [], ...over
});

const base = (over: Partial<PanelModel>): PanelModel => ({
    status: "final", tone: "go", source: { label: "Engine", detail: "clear spot" }, context: "Hand #14 · Flop · you: BB",
    action: { verb: "CHECK" }, reasoning: [], warnings: [], spot: spot(),
    hand: { cards: ["A♥", "5♥"], board: ["K♥", "9♥", "2♣"], made: "Ace high", draws: "Nut flush draw: 9 outs, 35% by the river" },
    odds: {}, options: [], opponents: [], more_opponents: 0, ...over
});

const villain = (over: Partial<OpponentCard> = {}): OpponentCard => ({
    seat: "BU", name: "RiverRat", stack_bb: 84.5, type: "calling station", type_tone: "loose",
    hands: { before: 312, today: 18 }, range_pct: 38,
    stats: [
        { label: "Fold to c-bet", value: 0.27, n: 41, pool: 0.45, level: "low", hint: "you're betting: how often they fold" },
        { label: "Went to showdown", value: 0.36, n: 58, pool: 0.28, level: "high", hint: "how often they see it through" },
        { label: "VPIP", value: 0.43, n: 312, pool: 0.32, level: "high" },
        { label: "PFR", value: 0.12, n: 312, pool: 0.18, level: "low" },
        { label: "Aggression", value: 0.31, n: 96, pool: 0.33, level: "normal" }
    ],
    today: "Today VPIP 52% / PFR 9% over 18 hands (usually 43% / 12%)",
    flags: ["Calling much wider than usual today"],
    last_showdown: "9c Kd after call, check/call, check/call, call",
    exploit: "Value bet thinner and bigger; do not bluff.",
    low_sample: false, to_act: true, ...over
});

const newbie = (over: Partial<OpponentCard> = {}): OpponentCard => ({
    seat: "SB", name: "Newcomer42", stack_bb: 100, type: "unknown", type_tone: "unknown",
    hands: { before: 0, today: 6 },
    stats: [
        { label: "VPIP", value: 0.28, n: 6, pool: 0.32, level: "unknown" },
        { label: "PFR", value: 0.16, n: 6, pool: 0.18, level: "unknown" },
        { label: "Fold to 3-bet", value: 0.52, n: 0, pool: 0.52, level: "unknown" }
    ],
    flags: [], low_sample: true, ...over
});

const options_flop: PanelModel["options"] = [
    { label: "bet 8 BB", ev_bb: 3.4, chosen: true, fold_chance: 0.42, raise_chance: 0.08, kind: "semi-bluff, c-bet" },
    { label: "bet 4 BB", ev_bb: 2.1, chosen: false, fold_chance: 0.31, raise_chance: 0.06, kind: "semi-bluff, c-bet" },
    { label: "check", ev_bb: 1.2, chosen: false },
    { label: "bet 12 BB", ev_bb: -0.8, chosen: false, fold_chance: 0.5, raise_chance: 0.1, kind: "bluff, overbet" }
];

/** What the in-page host would have done to the panel: compact view, collapsed sections, scroll. */
interface HostState { compact?: boolean, collapsed?: string[], scroll?: number }

const SAMPLES: { name: string, model: PanelModel, host?: HostState }[] = [
    {
        name: "01-fold-preflop", model: base({
            tone: "fold", source: { label: "Preflop chart" }, context: "Hand #3 · Preflop · you: CO",
            action: { verb: "FOLD" },
            reasoning: ["J4 offsuit is well outside a cutoff calling range against a 3.5 BB open from UTG.", "Their opening range is tight (about 14%) and you would be out of position after the flop."],
            spot: spot({ pot_bb: 5, to_call_bb: 3.5, pot_odds: 0.41, stack_bb: 100, effective_bb: 100, spr: 13.6, spr_label: "flop SPR if you call", min_raise_bb: 7, max_raise_bb: 100 }),
            hand: { cards: ["J♣", "4♦"], board: [], made: "Jack high" },
            odds: { equity: 0.29, need: 0.41, chart_spot: "facing a raise, 6 players" },
            opponents: [villain({ seat: "UTG", name: "TightTom", type: "nit", type_tone: "tight", range_pct: 14, stats: [
                { label: "PFR", value: 0.14, n: 220, pool: 0.18, level: "low", hint: "their raises are strong" },
                { label: "VPIP", value: 0.17, n: 220, pool: 0.32, level: "low" },
                { label: "Fold to 3-bet", value: 0.38, n: 26, pool: 0.52, level: "low" },
                { label: "Aggression", value: 0.29, n: 80, pool: 0.33, level: "normal" }
            ], flags: [], today: undefined, last_showdown: "Q♠ Q♦ after raise, bet, bet, check", exploit: "Fold marginal hands to their raises; steal their blinds.", to_act: false })]
        })
    },
    {
        name: "02-check", model: base({
            tone: "check", source: { label: "AI (openai/gpt-5-mini)", detail: "72% confident" }, context: "Hand #21 · Turn · you: BB (out of position)",
            action: { verb: "CHECK" },
            reasoning: ["Medium pair on a board that got worse: check and keep the pot small.", "The button bets when checked to about 60% of the time, so you can call one bet."],
            spot: spot({ pot_bb: 14, stack_bb: 91, effective_bb: 91, spr: 6.5, in_position: false }),
            hand: { cards: ["8♠", "8♦"], board: ["Q♣", "6♦", "3♠", "K♥"], made: "Pair of eights (under two overcards)" },
            odds: { equity: 0.46, equity_when_called: 0.34 },
            options: [
                { label: "check", ev_bb: 1.4, chosen: true },
                { label: "bet 5 BB", ev_bb: 0.6, chosen: false, fold_chance: 0.38, raise_chance: 0.12, kind: "thin value" },
                { label: "bet 10 BB", ev_bb: -1.1, chosen: false, fold_chance: 0.5, raise_chance: 0.1, kind: "bluff" }
            ],
            opponents: [villain()]
        })
    },
    {
        name: "03-call-facing-bet", model: base({
            tone: "go", source: { label: "AI (anthropic/claude)", detail: "81% confident" }, context: "Hand #33 · River · you: BU (in position)",
            action: { verb: "CALL", size_bb: 9, chips: 18 },
            reasoning: ["Bluff catcher against a player who over-bluffs rivers: 34% needed, about 45% equity.", "Their aggression today is well above usual.", "Your king blocks the top of their value range."],
            spot: spot({ pot_bb: 27, to_call_bb: 9, pot_odds: 0.25, stack_bb: 70, effective_bb: 64, spr: 2.4, in_position: true }),
            hand: { cards: ["K♠", "J♠"], board: ["K♦", "8♣", "5♥", "2♠", "7♦"], made: "Top pair, Jack kicker" },
            odds: { equity: 0.45, need: 0.25 },
            options: [
                { label: "call 9 BB", ev_bb: 2.8, chosen: true },
                { label: "raise to 27 BB", ev_bb: -1.9, chosen: false, fold_chance: 0.22, kind: "value" },
                { label: "fold", ev_bb: 0, chosen: false }
            ],
            opponents: [villain({ seat: "BB", name: "Aggro Annie", type: "maniac", type_tone: "aggressive", range_pct: 55, stats: [
                { label: "River bluffs", value: 0.41, n: 22, pool: 0.24, level: "high", hint: "you're facing a bet: how often it's a bluff" },
                { label: "Aggression", value: 0.58, n: 140, pool: 0.33, level: "high" },
                { label: "VPIP", value: 0.51, n: 300, pool: 0.32, level: "high" },
                { label: "PFR", value: 0.33, n: 300, pool: 0.18, level: "high" }
            ], flags: ["Much more aggressive than usual today"], exploit: "Call down lighter; let them bluff." })]
        })
    },
    {
        name: "04-value-bet", model: base({
            tone: "go", source: { label: "Engine", detail: "clear spot" }, context: "Hand #40 · River · you: CO (in position)",
            action: { verb: "BET", size_bb: 16, chips: 32, pot_share: 0.75 },
            tag: { text: "Value · thin but called by worse often", kind: "value" },
            reasoning: ["Two pair on a dry board against a calling station.", "They call a 3/4 pot river bet with any pair about 70% of the time."],
            spot: spot({ pot_bb: 21.5, stack_bb: 64, effective_bb: 52, spr: 2.4, in_position: true }),
            hand: { cards: ["Q♦", "9♦"], board: ["Q♠", "9♣", "4♥", "2♦", "J♠"], made: "Two pair, queens and nines" },
            odds: { equity: 0.78, equity_when_called: 0.66 },
            options: [
                { label: "bet 16 BB", ev_bb: 6.1, chosen: true, fold_chance: 0.3, raise_chance: 0.05, kind: "value" },
                { label: "bet 10 BB", ev_bb: 5.2, chosen: false, fold_chance: 0.22, raise_chance: 0.05, kind: "value" },
                { label: "check", ev_bb: 3.3, chosen: false }
            ],
            opponents: [villain({ to_act: false })]
        })
    },
    {
        name: "05-bluff-lead", model: base({
            tone: "go", source: { label: "AI (openai/gpt-5-mini)", detail: "64% confident" }, context: "Hand #52 · Turn · you: BB (out of position)",
            action: { verb: "BET", size_bb: 7, chips: 14, pot_share: 0.5 },
            tag: { text: "Bluff · lead into the preflop raiser", kind: "bluff" },
            reasoning: ["The turn ace hits your calling range more than theirs.", "They fold to turn leads 58% of the time."],
            warnings: ["The AI disagrees with the engine's top option (check)."],
            spot: spot({ pot_bb: 14, stack_bb: 80, effective_bb: 80, spr: 5.7, in_position: false }),
            hand: { cards: ["7♣", "6♣"], board: ["T♦", "4♠", "2♥", "A♠"], made: "Seven high" },
            odds: { equity: 0.14, equity_when_called: 0.1 },
            options: [
                { label: "check", ev_bb: 0.4, chosen: false },
                { label: "bet 7 BB", ev_bb: 0.3, chosen: true, fold_chance: 0.58, raise_chance: 0.12, kind: "bluff, lead" }
            ],
            opponents: [villain({ seat: "CO", name: "SteadyEddie", type: "TAG", type_tone: "tight", stats: [
                { label: "Fold to turn lead", value: 0.58, n: 12, pool: 0.46, level: "high", hint: "you're betting: how often they fold" },
                { label: "VPIP", value: 0.22, n: 180, pool: 0.32, level: "low" },
                { label: "PFR", value: 0.19, n: 180, pool: 0.18, level: "normal" }
            ], flags: [], today: undefined, exploit: "Barrel scare cards; they give up often." })]
        })
    },
    {
        name: "06-semi-bluff", model: base({
            tone: "go", source: { label: "Engine", detail: "clear spot" }, context: "Hand #14 · Flop · you: BB (out of position)",
            action: { verb: "BET", size_bb: 8, chips: 16, pot_share: 0.66 },
            tag: { text: "Semi-bluff · c-bet with the nut flush draw", kind: "semi-bluff" },
            reasoning: ["Nut flush draw plus an ace: bet to win now or improve.", "They fold to c-bets 45% of the time; you have 35% to hit by the river."],
            options: options_flop, odds: { equity: 0.44, equity_when_called: 0.37 },
            spot: spot({ notes: ["7-2 bounty on: 3 BB from each player", "Antes in play"] }),
            opponents: [villain({ to_act: false })]
        })
    },
    {
        name: "07-raise", model: base({
            tone: "go", source: { label: "AI (anthropic/claude)", detail: "86% confident" }, context: "Hand #61 · Flop · you: BU (in position)",
            action: { verb: "RAISE TO", size_bb: 10.5, chips: 21, pot_share: 0.66 },
            tag: { text: "Value · raise the set before the flush comes", kind: "value" },
            reasoning: ["Set of nines on a two-tone board: raise now for value and protection.", "The small blind leads with draws and top pairs; both pay a raise."],
            spot: spot({ pot_bb: 9.5, to_call_bb: 3, pot_odds: 0.24, stack_bb: 120, effective_bb: 110, spr: 8.7, min_raise_bb: 6, max_raise_bb: 120, in_position: true }),
            hand: { cards: ["9♠", "9♥"], board: ["9♦", "J♦", "3♣"], made: "Set of nines" },
            odds: { equity: 0.82, need: 0.24, equity_when_called: 0.74 },
            options: [
                { label: "raise to 10.5 BB", ev_bb: 7.9, chosen: true, fold_chance: 0.35, raise_chance: 0.1, kind: "value" },
                { label: "call 3 BB", ev_bb: 5.6, chosen: false },
                { label: "raise to 16 BB", ev_bb: 6.7, chosen: false, fold_chance: 0.5, raise_chance: 0.1, kind: "value" },
                { label: "fold", ev_bb: 0, chosen: false }
            ],
            opponents: [villain({ seat: "SB", name: "DrawDan", type: "LAG", type_tone: "aggressive", to_act: false })]
        })
    },
    {
        name: "08-all-in", model: base({
            tone: "go", source: { label: "Engine", detail: "clear spot" }, context: "Hand #77 · Turn · you: HJ",
            action: { verb: "ALL-IN", size_bb: 42.5, chips: 85, pot_share: 1.2 },
            tag: { text: "Value · stack off with the nut straight", kind: "value" },
            reasoning: ["Nut straight with 42.5 BB behind and a 1.2 pot-size stack: shove.", "Any two pair or set calls."],
            spot: spot({ pot_bb: 35, stack_bb: 42.5, effective_bb: 42.5, spr: 1.2, in_position: false }),
            hand: { cards: ["8♥", "7♥"], board: ["9♣", "T♠", "J♦", "2♣"], made: "Straight, jack high (the nuts)" },
            odds: { equity: 0.87, equity_when_called: 0.84 },
            options: [
                { label: "all-in 42.5 BB", ev_bb: 24.6, chosen: true, fold_chance: 0.4, kind: "value" },
                { label: "bet 20 BB", ev_bb: 21.9, chosen: false, fold_chance: 0.3, kind: "value" },
                { label: "check", ev_bb: 15.2, chosen: false }
            ],
            opponents: [newbie({ seat: "BB", name: "QuietQ", stack_bb: 150 })],
            warnings: ["1 opponent(s) have under 20 hands: their stats are mostly population defaults."]
        })
    },
    {
        name: "09-thinking", model: base({
            status: "thinking", tone: "check", source: { label: "Engine pick", detail: "asking openai/gpt-5-mini (up to 20s)" },
            context: "Hand #88 · Flop · you: CO (in position)",
            action: { verb: "CHECK" },
            thinking: { model: "openai/gpt-5-mini", budget_ms: 20000, started_at: Date.now() - 7000 },
            reasoning: [],
            options: [{ label: "check", ev_bb: 0.9, chosen: true }, { label: "bet 3 BB", ev_bb: 0.7, chosen: false, fold_chance: 0.36, kind: "bluff, c-bet" }],
            odds: { equity: 0.33, equity_when_called: 0.24 },
            hand: { cards: ["A♣", "4♣"], board: ["K♦", "8♥", "8♠"], made: "Ace high" },
            opponents: [villain({ to_act: false })]
        })
    },
    {
        name: "10-stale", model: base({
            status: "stale", tone: "go", source: { label: "AI (openai/gpt-5-mini)", detail: "77% confident" }, context: "Hand #88 · Flop · you: CO (in position)",
            action: { verb: "BET", size_bb: 4, chips: 8, pot_share: 0.5 },
            tag: { text: "Bluff · c-bet the paired board", kind: "bluff" },
            reasoning: ["Paired board favors the preflop raiser: small c-bet.", "They fold to c-bets 52% of the time."],
            options: [{ label: "bet 4 BB", ev_bb: 0.8, chosen: true, fold_chance: 0.52, kind: "bluff, c-bet" }, { label: "check", ev_bb: 0.6, chosen: false }],
            odds: { equity: 0.33, equity_when_called: 0.24 },
            hand: { cards: ["A♣", "4♣"], board: ["K♦", "8♥", "8♠"], made: "Ace high" },
            opponents: [villain({ to_act: false })]
        })
    },
    {
        name: "11-multiway", model: base({
            tone: "check", source: { label: "Engine", detail: "clear spot" }, context: "Hand #102 · Flop · you: SB (out of position)",
            action: { verb: "CHECK" },
            reasoning: ["Six players saw the flop: bluffs rarely work multiway.", "Middle pair is a check and a likely fold to a big bet."],
            warnings: ["2 opponent(s) have under 20 hands: their stats are mostly population defaults."],
            spot: spot({ pot_bb: 18, stack_bb: 88, effective_bb: 100, spr: 4.9, in_position: false }),
            hand: { cards: ["T♠", "8♣"], board: ["Q♥", "8♦", "4♣"], made: "Middle pair" },
            odds: { equity: 0.19 },
            options: [{ label: "check", ev_bb: 0.5, chosen: true }, { label: "bet 6 BB", ev_bb: -1.8, chosen: false, fold_chance: 0.12, raise_chance: 0.2, kind: "bluff" }],
            opponents: [
                villain({ seat: "BB" }),
                newbie({ seat: "UTG", name: "FreshFish" }),
                villain({ seat: "HJ", name: "Old Reliable", type: "rock", type_tone: "passive", range_pct: 12, flags: [], today: undefined, last_showdown: undefined, stats: [
                    { label: "Aggression", value: 0.18, n: 205, pool: 0.33, level: "low", hint: "a bet from them means strength" },
                    { label: "VPIP", value: 0.15, n: 410, pool: 0.32, level: "low" },
                    { label: "PFR", value: 0.08, n: 410, pool: 0.18, level: "low" }
                ], exploit: "Fold to their raises; bet small to steal." }),
                newbie({ seat: "CO", name: "Balance Bob", type: "balanced", type_tone: "balanced", hands: { before: 64, today: 0 }, low_sample: false, stats: [
                    { label: "VPIP", value: 0.26, n: 64, pool: 0.32, level: "normal" },
                    { label: "PFR", value: 0.2, n: 64, pool: 0.18, level: "normal" },
                    { label: "3-bet", value: 0.07, n: 40, pool: 0.06, level: "normal" }
                ] })
            ],
            more_opponents: 2
        })
    },
    {
        name: "12-hostile-name", model: base({
            tone: "fold", source: { label: "AI (<b>model</b>)", detail: "\"quoted\" & 'single'" }, context: "Hand #<i>9</i> · River · you: BB & co",
            action: { verb: "FOLD" },
            tag: { text: "<script>alert(1)</script>", kind: "neutral" },
            reasoning: ["<img src=x onerror=alert(1)> is betting big & you have \"nothing\".", "Line 2 with 'quotes' & <tags>"],
            warnings: ["Warning <b>not bold</b> & \"quoted\""],
            spot: spot({ pot_bb: 30, to_call_bb: 22, pot_odds: 0.42, notes: ["<u>note</u> & more"] }),
            hand: { cards: ["7♣", "2♦"], board: ["A♠", "K♠", "Q♠", "5♥", "3♦"], made: "<em>Seven high</em>" },
            odds: { equity: 0.03, need: 0.42, chart_spot: "<x>" },
            options: [{ label: "fold <b>", ev_bb: 0, chosen: true }, { label: "call 22 BB", ev_bb: -21.1, chosen: false }],
            opponents: [villain({ seat: "B<U", name: "<img src=x onerror=alert(1)>", type: "<LAG> & \"crazy\"", type_tone: "aggressive",
                flags: ["<script>alert('x')</script>"], today: "Today & <b>tomorrow</b>", last_showdown: "<img src=y> 9c Kd after <b>raise</b>",
                exploit: "Don't \"trust\" <them> & fold", stats: [{ label: "<VPIP>", value: 0.5, n: 10, pool: 0.3, level: "high", hint: "<i>hint</i> & \"q\"" }] })]
        })
    },
];
// the random-number strip: clear spots (one option at any roll) and mixes of two and three options
const withRng = (name: string, rng: NonNullable<PanelModel["rng"]>) => {
    const sample = SAMPLES.find((x) => x.name === name);
    if (sample) sample.model = { ...sample.model, rng };
};
const MIXED_NOTE = "Close spot: the roll picks (low numbers passive, high aggressive).";
const CLEAR_NOTE = "Clear spot: the same play at any roll.";
withRng("01-fold-preflop", { roll: 67, pure: true, segments: [{ label: "Fold", action: "fold", from: 1, to: 100, picked: true }], note: CLEAR_NOTE });
withRng("02-check", { roll: 41, pure: false, note: MIXED_NOTE, baseline: "Balanced range here: check 52% · bet 48%", segments: [
    { label: "Check", action: "check", from: 1, to: 62, picked: true }, { label: "Bet 4 BB", action: "bet", from: 63, to: 100, picked: false }] });
withRng("03-call-facing-bet", { roll: 88, pure: false, note: MIXED_NOTE, baseline: "Balanced range here: fold 33% · continue 67%", segments: [
    { label: "Fold", action: "fold", from: 1, to: 24, picked: false }, { label: "Call 6 BB", action: "call", from: 25, to: 100, picked: true }] });
withRng("04-value-bet", { roll: 12, pure: true, segments: [{ label: "Bet 16 BB", action: "bet", from: 1, to: 100, picked: true }], note: CLEAR_NOTE });
withRng("06-semi-bluff", { roll: 90, pure: false, note: MIXED_NOTE, baseline: "Balanced range here: check 45% · bet 55%", segments: [
    { label: "Check", action: "check", from: 1, to: 30, picked: false }, { label: "Bet 4 BB", action: "bet", from: 31, to: 55, picked: false },
    { label: "Bet 8 BB", action: "bet", from: 56, to: 100, picked: true }] });
withRng("07-raise", { roll: 3, pure: true, segments: [{ label: "Raise to 10.5 BB", action: "raise", from: 1, to: 100, picked: true }], note: CLEAR_NOTE });
withRng("09-thinking", { roll: 34, pure: false, note: MIXED_NOTE, segments: [
    { label: "Check", action: "check", from: 1, to: 71, picked: true }, { label: "Bet 3 BB", action: "bet", from: 72, to: 100, picked: false }] });
withRng("10-stale", { roll: 83, pure: false, note: MIXED_NOTE, segments: [
    { label: "Check", action: "check", from: 1, to: 58, picked: false }, { label: "Bet 4 BB", action: "bet", from: 59, to: 100, picked: true }] });
withRng("12-hostile-name", { roll: 5, pure: false, note: "<b>note</b> & \"q\"", baseline: "<i>base</i>", segments: [
    { label: "<b>Fold</b>", action: "fold", from: 1, to: 50, picked: true }, { label: "Call & \"x\" <script>", action: "call", from: 51, to: 100, picked: false }] });
// the same panels as the host shows them after a click: compact, some sections collapsed, scrolled down
SAMPLES.push(
    { name: "13-compact", model: SAMPLES[6].model, host: { compact: true } },
    { name: "14-collapsed", model: SAMPLES[2].model, host: { collapsed: ["opponents", "options"] } },
    { name: "15-scrolled", model: SAMPLES[10].model, host: { scroll: 900 } }
);

function page(inner: string, css: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>panel</title><style>
html,body{margin:0;height:100%;background:#0e1512;font-family:system-ui,sans-serif;overflow:hidden}
.felt{position:absolute;left:170px;top:150px;width:880px;height:470px;border-radius:235px;
  background:radial-gradient(ellipse at center,#2f7d4f 0%,#1f5e3a 60%,#153f28 100%);border:14px solid #2a1c12;box-shadow:0 0 0 4px #3c2a1c, 0 30px 80px rgba(0,0,0,0.7)}
.seat{position:absolute;width:120px;height:44px;border-radius:8px;background:#1c2420;border:1px solid #33413a;color:#cbd5d0;font-size:12px;display:flex;align-items:center;justify-content:center}
.actions{position:absolute;right:24px;bottom:24px;display:flex;gap:10px}
.actions div{width:120px;height:48px;border-radius:6px;background:#2d3a33;color:#e5e7eb;display:flex;align-items:center;justify-content:center;font-weight:700}
/* what the in-page host sets on its container */
#pokernow-gpt-suggestion{position:fixed;top:16px;right:16px;width:384px;max-height:calc(100vh - 32px);z-index:999999;box-sizing:border-box;
  overflow-y:auto;overflow-x:hidden;border-radius:14px;scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.4) transparent}
#pokernow-gpt-suggestion[data-status="stale"]{filter:grayscale(1) brightness(.8)}
${css}
</style></head><body>
<div class="felt"></div>
<div class="seat" style="left:550px;top:80px">Seat 1</div><div class="seat" style="left:1070px;top:360px">Seat 2</div>
<div class="seat" style="left:550px;top:650px">You</div><div class="seat" style="left:40px;top:360px">Seat 4</div>
<div class="actions"><div>FOLD</div><div>CHECK</div><div>RAISE</div></div>
<div id="pokernow-gpt-suggestion">${inner}</div>
</body></html>`;
}

async function main(): Promise<void> {
    const out = process.argv[2] || "/tmp/panel-gallery";
    fs.mkdirSync(out, { recursive: true });
    const browser = await puppeteer.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"], headless: true });
    const errors: string[] = [];
    const shots: string[] = [];
    try {
        const tab = await browser.newPage();
        await tab.setViewport({ width: 1400, height: 900 });
        tab.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
        tab.on("dialog", async (d) => { errors.push(`dialog opened: ${d.message()}`); await d.dismiss(); });
        tab.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
        for (const sample of SAMPLES) {
            const { html, css } = renderPanel(sample.model);
            const doc = page(html, css);
            fs.writeFileSync(path.join(out, `${sample.name}.html`), doc);
            await tab.setContent(doc, { waitUntil: "load" });
            // act like the host: status and tone on the container, collapsible sections, countdown width
            await tab.evaluate((model: { status: string, tone: string }, host: HostState) => {
                const el = document.getElementById("pokernow-gpt-suggestion")!;
                el.dataset.status = model.status;
                el.dataset.tone = model.tone;
                if (host.compact) el.classList.add("pgpt-compact");
                el.querySelector('[data-pgpt-action="compact"]')?.setAttribute("aria-pressed", host.compact ? "true" : "false");
                el.querySelectorAll<HTMLElement>(".pgpt-section[data-section]").forEach((section) => {
                    section.classList.add("pgpt-collapsible");
                    const collapsed = (host.collapsed ?? []).includes(section.dataset.section ?? "");
                    section.classList.toggle("pgpt-collapsed", collapsed);
                    section.querySelector(".pgpt-section-title")?.setAttribute("aria-expanded", collapsed ? "false" : "true");
                });
                el.querySelectorAll<HTMLElement>(".pgpt-countdown[data-budget-ms][data-started-at]").forEach((bar) => {
                    const budget = Number(bar.dataset.budgetMs), started = Number(bar.dataset.startedAt);
                    bar.style.width = `${Math.max(0, Math.min(1, (budget - (Date.now() - started)) / budget)) * 100}%`;
                });
                el.scrollTop = host.scroll ?? 0;
            }, { status: sample.model.status, tone: sample.model.tone }, sample.host ?? {});
            // stop animations mid-way so shots are stable
            await tab.evaluate(() => document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 700; }));
            const overflow = await tab.evaluate(() => {
                const panel = document.querySelector("#pokernow-gpt-suggestion .pgpt-panel") as HTMLElement;
                // any text or box sticking out of the panel's sides
                const edge = panel.getBoundingClientRect();
                const bad: string[] = [];
                panel.querySelectorAll<HTMLElement>(".pgpt-body *, .pgpt-header *, .pgpt-tag-row *, .pgpt-verb *").forEach((el) => {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && (r.left < edge.left - 0.5 || r.right > edge.right + 0.5)) bad.push(String(el.className));
                });
                return bad;
            });
            if (overflow.length) errors.push(`${sample.name}: horizontal overflow in ${overflow.join(", ")}`);
            const file = path.join(out, `${sample.name}.png`);
            await tab.screenshot({ path: file as `${string}.png` });
            // the full panel, scrolled content included, for review
            const full = path.join(out, `${sample.name}-full.png`);
            await tab.evaluate(() => {
                const box = document.getElementById("pokernow-gpt-suggestion")!;
                box.style.maxHeight = "none";
                box.style.overflow = "visible";
                box.scrollTop = 0;
                document.documentElement.style.overflow = "visible";
                document.body.style.overflow = "visible";
            });
            const box = await tab.$("#pokernow-gpt-suggestion");
            await box!.screenshot({ path: full as `${string}.png` });
            shots.push(sample.name);
        }
    } finally {
        await browser.close();
    }
    const index = `<!doctype html><html><head><meta charset="utf-8"><title>Panel gallery</title><style>
body{background:#111;color:#ddd;font-family:system-ui,sans-serif;margin:24px}figure{margin:0 0 32px}
.row{display:flex;gap:16px;align-items:flex-start}img{border:1px solid #333}.full{width:384px}.table{width:900px}</style></head><body>
<h1>Panel gallery</h1>${shots.map((s) => `<figure><figcaption>${escapeHtml(s)}</figcaption><div class="row">`
        + `<img class="table" src="${encodeURIComponent(s)}.png"><img class="full" src="${encodeURIComponent(s)}-full.png"></div></figure>`).join("")}
</body></html>`;
    fs.writeFileSync(path.join(out, "index.html"), index);
    console.log(`${shots.length} panels written to ${out} (index.html)`);
    if (errors.length) {
        console.error(errors.join("\n"));
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
