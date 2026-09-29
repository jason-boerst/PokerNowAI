// House rules of a PokerNow game (action clock, 7-2 bounty, antes, straddles, bomb pots, run it
// twice), read from the game log. PokerNow logs every settings change, for example:
//   Game Config Changes
//   * Decision Limit Time: 20s » 15s
//   * Cents Mode: off » on
//   * 7-2 bounty: off » 300
//   * Allow Straddle: off » on
//   * Allow Run it Twice: no » ask players
//   * Bomb Pot: off » on
//   The game's ante was changed from 0.00 to 0.20.
// and the hands themselves show which rules are in use ("posts an ante of 0.20", "posts a straddle
// of 2.00", "(bomb pot bet)", "Remaining players decide whether to run it twice.", and after a hand
// '"A @ a" paid 3.00 for the 7-2 bounty to "B @ b"').
//
// With Cents Mode on, settings are in cents ("7-2 bounty: off » 300") while the log shows dollars
// ("paid 3.00"). Rules here are always in log units (the same chips as bets in the log).
import { parseAmount } from "./hand-parser.ts";

export interface GameRules {
    /** Action clock in seconds ("Decision Limit Time"). */
    decision_seconds?: number,
    /** 7-2 bounty each opponent pays the winner, in chips (0: off). */
    seven_deuce_bounty?: number,
    /** Current ante in chips (0: none). */
    ante?: number,
    straddle_allowed?: boolean,
    bomb_pots?: boolean,
    run_it_twice?: boolean
}

/** Log entries that change the rules: re-read the rules when one appears. */
export const RULES_CHANGE = /^(?:Game Config Changes|The game's ante was changed)/;

const AMOUNT = "(\\d[\\d,]*(?:\\.\\d+)?)";
const SETTING = /^\* (.+?): (.*) » (.*)$/;
const ANTE_CHANGE = new RegExp(`^The game's ante was changed from [\\d,.]+ to ${AMOUNT}`);
const ANTE_POST = new RegExp(`" posts an ante of ${AMOUNT}`);
const BOUNTY_PAID = new RegExp(`^".+" paid ${AMOUNT} for the .*bounty`);
// a line whose amount shows how the log writes chips: "1.00" in Cents Mode, "2" otherwise
const AMOUNT_FORMAT = /(?:" posts an? [a-z ]+ of|^The game's [a-z ]+ was changed from) \d[\d,]*(\.\d+)?/;
const RUN_IT_TWICE = /run it twice\.$|^(?:Flop|Turn|River) \(second run\)/;

/** "on", "ask players", "3" are on; "off", "no", "none" are off. */
function isOn(value: string): boolean {
    return !/^(?:off|no|none|never|disabled|false|0)$/i.test(value.trim());
}

/** The first number in a value: "15s" -> 15, "1,000" -> 1000, "0.50" -> 0.5, "off" -> undefined. */
function numberIn(value: string): number | undefined {
    const m = value.match(/\d[\d,]*(?:\.\d+)?/);
    return m ? parseAmount(m[0]) : undefined;
}

/** "15s" -> 15, "1m 30s" -> 90, "1:30" -> 90, "off" -> undefined. */
function seconds(value: string): number | undefined {
    if (!isOn(value)) return undefined;
    const clock = value.match(/^(\d+):(\d{2})$/);
    if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
    const minutes = value.match(/(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?\b/i);
    const secs = value.match(/(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)?$/i);
    const total = (minutes ? Number(minutes[1]) * 60 : 0) + (secs ? Number(secs[1]) : 0);
    return total > 0 ? total : undefined;
}

/**
 * The rules in effect at the end of `entries` (log messages, oldest first). Later settings
 * override earlier ones. What the hands show (antes posted, straddles, bomb pots, run it twice,
 * bounties paid) counts where no setting says otherwise, and only from hands that started after
 * the setting, since a change made during a hand applies from the next one. Only rules the log
 * shows are returned, so an empty object means "unknown", not "none".
 */
export function parseGameRules(entries: string[]): GameRules {
    const rules: GameRules = {};
    // hands started so far, and the hand count when each rule was last set
    let hand = 0;
    const set_at: Partial<Record<keyof GameRules, number>> = {};
    const setting = <K extends keyof GameRules>(key: K, value: GameRules[K]) => {
        if (value === undefined) delete rules[key];
        else rules[key] = value;
        set_at[key] = hand;
    };
    const evidence = <K extends keyof GameRules>(key: K, value: GameRules[K]) => {
        if (set_at[key] === undefined || hand > set_at[key]!) rules[key] = value;
    };
    let cents_mode: boolean | undefined;
    let amounts_in_cents: boolean | undefined;
    let bounty_setting: string | undefined;
    // the largest ante posted in the latest hand with antes (a short stack posts less)
    let ante = { hand: -1, amount: 0 };

    const line = (text: string) => {
        let m: RegExpMatchArray | null;
        if ((m = text.match(SETTING))) {
            const name = m[1].trim().toLowerCase();
            const value = m[3].trim();
            // a clock turned off is left unknown, so the bot keeps answering as if there were one
            if (name === "decision limit time") setting("decision_seconds", seconds(value));
            else if (name.includes("7-2 bounty")) bounty_setting = value;
            else if (name === "allow straddle") setting("straddle_allowed", isOn(value));
            else if (name === "bomb pot") setting("bomb_pots", isOn(value));
            else if (name.includes("run it twice")) setting("run_it_twice", isOn(value));
            else if (name === "cents mode") cents_mode = isOn(value);
            return;
        }
        if ((m = text.match(AMOUNT_FORMAT))) amounts_in_cents = m[1] !== undefined;
        if ((m = text.match(ANTE_CHANGE))) {
            setting("ante", parseAmount(m[1]));
        } else if ((m = text.match(ANTE_POST))) {
            const amount = parseAmount(m[1]);
            ante = { hand, amount: ante.hand === hand ? Math.max(ante.amount, amount) : amount };
            evidence("ante", ante.amount);
        } else if (text.includes('" posts a straddle of ')) {
            evidence("straddle_allowed", true);
        } else if (text.includes("(bomb pot bet)")) {
            evidence("bomb_pots", true);
        } else if ((m = text.match(BOUNTY_PAID))) {
            // with no setting in the log so far, the bounty hasn't changed, and the largest payment
            // is the full bounty (a short stack pays less); payments never override a setting
            if (bounty_setting === undefined) rules.seven_deuce_bounty = Math.max(rules.seven_deuce_bounty ?? 0, parseAmount(m[1]));
        } else if (RUN_IT_TWICE.test(text)) {
            evidence("run_it_twice", true);
        }
    };

    for (const entry of entries) {
        const text = entry.trim();
        if (text.startsWith("-- starting hand #")) {
            hand++;
        } else if (text.startsWith('"')) {
            line(text);
        } else {
            // settings come as one multi-line entry
            for (const part of text.split("\n")) line(part.trim());
        }
    }
    if (bounty_setting !== undefined) {
        const n = numberIn(bounty_setting);
        // settings are in cents in Cents Mode, unless PokerNow ever writes them with a decimal point
        const in_cents = (cents_mode ?? amounts_in_cents ?? false) && !bounty_setting.includes(".");
        if (!isOn(bounty_setting)) rules.seven_deuce_bounty = 0;
        else if (n !== undefined) rules.seven_deuce_bounty = in_cents ? n / 100 : n;
    }
    return rules;
}

/**
 * True when `messages` (any order) settle the rules that matter most: they include the clock and
 * the bounty settings, and show whether settings are in cents (a Cents Mode setting, or any blind
 * or ante amount). Used to stop paging back through the log early.
 */
export function hasKeyRules(messages: string[]): boolean {
    let clock = false, bounty = false, units = false;
    for (const raw of messages) {
        const msg = raw.trim();
        if (msg.includes("»")) {
            clock ||= /^\s*\* Decision Limit Time:/im.test(msg);
            bounty ||= /^\s*\* 7-2 bounty:/im.test(msg);
            units ||= /^\s*\* Cents Mode:/im.test(msg);
        }
        units ||= AMOUNT_FORMAT.test(msg);
    }
    return clock && bounty && units;
}

/**
 * The 7-2 bounty per player from stored hands (each hand's messages, oldest hand first): the
 * largest payment after the most recent hand with one, or undefined if no hand has one.
 */
export function bountyFromHands(hands: string[][]): number | undefined {
    for (let i = hands.length - 1; i >= 0; i--) {
        let largest: number | undefined;
        for (const msg of hands[i]) {
            const m = msg.trim().match(BOUNTY_PAID);
            if (m) largest = Math.max(largest ?? 0, parseAmount(m[1]));
        }
        if (largest !== undefined) return largest;
    }
    return undefined;
}

/** Combines rules from several sources; for each rule, the last source that knows it wins. */
export function mergeRules(...rules: GameRules[]): GameRules {
    const merged: GameRules = {};
    for (const r of rules) {
        for (const [key, value] of Object.entries(r ?? {})) {
            if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
        }
    }
    return merged;
}

/** Short plain notes for the overlay and the AI prompt, e.g. ["7-2 bounty on: 3 BB from each player", "Clock 15 s"]. */
export function describeRules(rules: GameRules, big_blind: number): string[] {
    const round = (x: number) => String(Math.round(x * 100) / 100);
    const size = (chips: number) => big_blind > 0 ? `${round(chips / big_blind)} BB` : `${round(chips)} chips`;
    const notes: string[] = [];
    if (rules.seven_deuce_bounty) notes.push(`7-2 bounty on: ${size(rules.seven_deuce_bounty)} from each player`);
    if (rules.ante) notes.push(`Antes ${size(rules.ante)}`);
    if (rules.straddle_allowed) notes.push("Straddles allowed");
    if (rules.bomb_pots) notes.push("Bomb pots on");
    if (rules.run_it_twice) notes.push("Run it twice allowed");
    if (rules.decision_seconds) notes.push(`Clock ${rules.decision_seconds} s`);
    return notes;
}
