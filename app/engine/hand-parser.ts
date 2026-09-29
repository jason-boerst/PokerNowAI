// Pure parser for one PokerNow hand log. Input: the hand's log messages in chronological order
// (from "-- starting hand #N ..." onward). Output: the complete hand state at that point.
//
// Formats handled (PokerNow log lines, as understood when this was written):
//   -- starting hand #12 (id: abc)  No Limit Texas Hold'em (dealer: "Name @ id") --
//   Player stacks: #1 "Name @ id" (1000) | #3 "Other @ id2" (19.90)
//   Your hand is A♠, K♦
//   "Name @ id" posts a small blind of 10 | posts a big blind of 20 | posts a straddle of 40
//   "Name @ id" posts a missing small blind of 10 (dead money) | posts a missed big blind of 20
//   "Name @ id" folds | checks | calls 20 | bets 40 | raises to 60   (+ " and go all in")
//   Flop:  [A♠, K♦, 2♣]   Turn: A♠, K♦, 2♣ [7♥]   River: A♠, K♦, 2♣, 7♥ [9♣]
//   Uncalled bet of 40 returned to "Name @ id"
//   "Name @ id" shows a A♠, K♦.
//   "Name @ id" collected 120 from pot (with ...)
//   -- ending hand #12 --
// Lines that aren't recognized are collected in `unparsed` instead of throwing, so a changed
// format shows up in diagnostics rather than as a crash.

export type Street = "preflop" | "flop" | "turn" | "river";
export type ActionType = "post_sb" | "post_bb" | "post_straddle" | "post_dead" | "post_ante" | "post_bomb" | "fold" | "check" | "call" | "bet" | "raise";

/** Forced posts (not voluntary actions). */
/**
 * Lines PokerNow writes after "-- ending hand" that still belong to that hand: cards shown after
 * it ended and 7-2 bounty payments.
 */
export const AFTER_HAND_LINE = /^"[^"]+ @ [^"]+" (shows a |paid [\d,.]+ for the .*bounty|collected [\d,.]+ from the .*bounty)/;
export const POST_TYPES: ReadonlySet<ActionType> = new Set(["post_sb", "post_bb", "post_straddle", "post_dead", "post_ante", "post_bomb"]);

export interface ActionRecord {
    street: Street,
    player_id: string,
    type: ActionType,
    /** Chips put in by this action (increment), after all-in capping. */
    amount: number,
    /** The player's total contribution on this street after the action. */
    street_total: number,
    all_in: boolean,
    /** Pot size (all streets, incl. current-street bets) just before this action. */
    pot_before: number,
    /** Highest bet on the street just before this action. */
    bet_to_call_before: number
}

export interface SeatState {
    id: string,
    name: string,
    seat: number,
    position: string,
    stack_start: number,
    /** Chips not yet committed to the pot. */
    stack: number,
    street_contribution: number,
    total_contribution: number,
    folded: boolean,
    all_in: boolean,
    shown_cards?: string[],
    /** Chips won from the pot(s). */
    collected: number,
    /** Side payments such as the 7-2 bounty: received minus paid (not part of the pot). */
    bounty_net: number
}

export interface HandState {
    hand_number: number | null,
    hand_id: string | null,
    /** e.g. "No Limit Texas Hold'em" or "Pot Limit Omaha Hi". */
    game_type: string,
    /** Bomb pot: everyone posts a forced bet and the flop is dealt with no preflop action. */
    bomb_pot: boolean,
    dealer_id: string | null,
    big_blind: number,
    small_blind: number,
    street: Street,
    board: string[],
    seats: SeatState[],
    actions: ActionRecord[],
    pot: number,
    /** Highest total bet on the current street. */
    current_bet: number,
    /** Size of the last full raise on this street (minimum raise increment). */
    last_raise_size: number,
    hero_id: string | null,
    hero_cards: string[],
    ended: boolean,
    unparsed: string[]
}

const AMOUNT = "([\\d,]+(?:\\.\\d+)?)";
const PLAYER = '"(.+?) @ ([^"]+)"';

export function parseAmount(text: string): number {
    return Number(text.replace(/,/g, ""));
}

/** Normalizes cards like "10♥", "A♠", "Kd" to "Th", "As", "Kd". */
export function parseCards(text: string): string[] {
    const suits: Record<string, string> = { "♠": "s", "♥": "h", "♦": "d", "♣": "c", s: "s", h: "h", d: "d", c: "c" };
    const cards: string[] = [];
    for (const m of text.matchAll(/(10|[2-9TJQKA])([♠♥♦♣shdc])/g)) {
        cards.push((m[1] === "10" ? "T" : m[1]) + suits[m[2]]);
    }
    return cards;
}

/**
 * Position labels in seat order starting from the small blind, for n players dealt in.
 * Counts back from the button: BU, CO, HJ, LJ, MP, UTG+1, and the first seat after the BB is UTG.
 * Heads-up: the button posts the small blind, labelled "SB".
 */
export function positionLabels(n: number): string[] {
    if (n <= 1) return ["BU"].slice(0, n);
    if (n === 2) return ["SB", "BB"];
    if (n === 3) return ["SB", "BB", "BU"];
    // seats after the big blind: the last ones count back from the button (BU, CO, HJ, LJ, MP),
    // the rest count forward from the first seat (UTG, UTG+1, UTG+2, ...)
    const non_blind = n - 2;
    const back = ["BU", "CO", "HJ", "LJ", "MP"];
    const n_back = Math.min(non_blind - 1, back.length);
    const front = Array.from({ length: non_blind - n_back }, (_, i) => (i === 0 ? "UTG" : `UTG+${i}`));
    return ["SB", "BB", ...front, ...back.slice(0, n_back).reverse()];
}

function emptyState(): HandState {
    return {
        hand_number: null, hand_id: null, game_type: "", bomb_pot: false, dealer_id: null, big_blind: 0, small_blind: 0,
        street: "preflop", board: [], seats: [], actions: [], pot: 0, current_bet: 0, last_raise_size: 0,
        hero_id: null, hero_cards: [], ended: false, unparsed: []
    };
}

export interface ParseOptions {
    /** Hero's display name (used when the log has no "Your hand is" line to identify them). */
    hero_name?: string,
    /** Hero's hole cards read from the table, if known. */
    hero_cards?: string[],
    /** Big blind from the table header; used until a big blind post is seen. */
    big_blind?: number,
    small_blind?: number
}

export function parseHand(messages: string[], options: ParseOptions = {}): HandState {
    const s = emptyState();
    s.big_blind = options.big_blind ?? 0;
    s.small_blind = options.small_blind ?? 0;
    s.hero_cards = options.hero_cards ?? [];
    const byId = new Map<string, SeatState>();
    let dealer_name: string | null = null;
    let sb_poster: string | null = null;
    let bb_poster: string | null = null;

    const seatOf = (id: string, name: string): SeatState => {
        let seat = byId.get(id);
        if (!seat) {
            // player not listed in "Player stacks" (shouldn't happen); track them anyway
            seat = { id, name, seat: 99, position: "?", stack_start: 0, stack: Infinity, street_contribution: 0,
                total_contribution: 0, folded: false, all_in: false, collected: 0, bounty_net: 0 };
            byId.set(id, seat);
            s.seats.push(seat);
        }
        return seat;
    };
    const potNow = () => s.seats.reduce((sum, p) => sum + p.total_contribution, 0);
    const commit = (seat: SeatState, street_total: number, type: ActionType, all_in_flag: boolean) => {
        const target = Math.min(street_total, seat.street_contribution + seat.stack);
        const amount = Math.max(0, target - seat.street_contribution);
        const record: ActionRecord = {
            street: s.street, player_id: seat.id, type, amount, street_total: target,
            all_in: false, pot_before: potNow(), bet_to_call_before: s.current_bet
        };
        seat.street_contribution = target;
        seat.total_contribution += amount;
        seat.stack -= amount;
        if (all_in_flag || seat.stack <= 1e-9) {
            seat.all_in = true;
            record.all_in = true;
        }
        s.actions.push(record);
        return record;
    };
    const raiseTo = (seat: SeatState, to: number, type: ActionType, all_in_flag: boolean) => {
        const previous_bet = s.current_bet;
        const record = commit(seat, to, type, all_in_flag);
        const increment = record.street_total - previous_bet;
        // an all-in for less than a full raise doesn't reopen the minimum raise size
        if (increment >= s.last_raise_size) {
            s.last_raise_size = increment;
        }
        s.current_bet = Math.max(s.current_bet, record.street_total);
    };
    const newStreet = (street: Street, cards: string[]) => {
        s.street = street;
        s.board = cards;
        s.current_bet = 0;
        s.last_raise_size = s.big_blind;
        for (const seat of s.seats) {
            seat.street_contribution = 0;
        }
    };

    for (const raw of messages) {
        const msg = raw.trim();
        let m: RegExpMatchArray | null;

        if ((m = msg.match(/^-- starting hand #(\d+)/))) {
            s.hand_number = Number(m[1]);
            s.hand_id = msg.match(/\(id: ([^)]+)\)/)?.[1] ?? null;
            s.game_type = msg.match(/\(id: [^)]+\)\s+(.*?)\s+\((?:dealer|dead button)/)?.[1] ?? "";
            const dealer = msg.match(/\(dealer: "(.+) @ ([^"]+)"\)/);
            if (dealer) {
                dealer_name = dealer[1];
                s.dealer_id = dealer[2];
            }
            continue;
        }
        if ((m = msg.match(/^-- ending hand #(\d+)/))) {
            s.ended = true;
            continue;
        }
        if (msg.startsWith("Player stacks:")) {
            for (const p of msg.matchAll(new RegExp(`#(\\d+) ${PLAYER} \\(${AMOUNT}\\)`, "g"))) {
                const stack = parseAmount(p[4]);
                const seat: SeatState = { id: p[3], name: p[2], seat: Number(p[1]), position: "?", stack_start: stack, stack,
                    street_contribution: 0, total_contribution: 0, folded: false, all_in: false, collected: 0, bounty_net: 0 };
                byId.set(seat.id, seat);
                s.seats.push(seat);
            }
            s.seats.sort((a, b) => a.seat - b.seat);
            continue;
        }
        if ((m = msg.match(/^Your hand is (.+)$/))) {
            s.hero_cards = parseCards(m[1]);
            continue;
        }
        if ((m = msg.match(/^(Flop|Turn|River)( \([^)]*\))?:\s*(.*)$/i))) {
            if (m[2]) continue; // ignore the second run of a run-it-twice, or a bomb pot's second board
            newStreet(m[1].toLowerCase() as Street, parseCards(m[3]));
            continue;
        }
        if ((m = msg.match(new RegExp(`^Uncalled bet of ${AMOUNT} returned to ${PLAYER}`)))) {
            const seat = seatOf(m[3], m[2]);
            const amount = parseAmount(m[1]);
            seat.total_contribution -= amount;
            seat.street_contribution -= amount;
            seat.stack += amount;
            continue;
        }

        m = msg.match(new RegExp(`^${PLAYER} (.+)$`));
        if (!m) {
            if (msg) s.unparsed.push(msg);
            continue;
        }
        const seat = seatOf(m[2], m[1]);
        const rest = m[3];
        const all_in = /and go all in/.test(rest);
        let a: RegExpMatchArray | null;

        if (/\(bomb pot bet\)/.test(rest) && (a = rest.match(new RegExp(`^(?:posts a bet of|calls) ${AMOUNT}`)))) {
            // bomb pot: a forced bet from everyone, then the flop; not a voluntary action
            s.bomb_pot = true;
            commit(seat, parseAmount(a[1]), "post_bomb", all_in);
            s.current_bet = Math.max(s.current_bet, seat.street_contribution);
        } else if ((a = rest.match(new RegExp(`^posts (?:a |an )?(.*?) of ${AMOUNT}`)))) {
            const kind = a[1].toLowerCase();
            const amount = parseAmount(a[2]);
            if (kind.includes("ante")) {
                // antes are dead money: in the pot, but they don't count toward calling
                const paid = Math.min(amount, seat.stack);
                s.actions.push({ street: s.street, player_id: seat.id, type: "post_ante", amount: paid, street_total: seat.street_contribution,
                    all_in: false, pot_before: potNow(), bet_to_call_before: s.current_bet });
                seat.stack -= paid;
                seat.total_contribution += paid;
            } else if (/missing|missed|dead/.test(kind) && kind.includes("small")) {
                // dead small blind: goes in the pot, doesn't count toward calling
                const paid = Math.min(amount, seat.stack);
                s.actions.push({ street: s.street, player_id: seat.id, type: "post_dead", amount: paid, street_total: seat.street_contribution,
                    all_in: false, pot_before: potNow(), bet_to_call_before: s.current_bet });
                seat.stack -= paid;
                seat.total_contribution += paid;
            } else if (kind.includes("straddle")) {
                raiseTo(seat, amount, "post_straddle", all_in);
                // after a straddle the minimum raise is the straddle amount
                s.last_raise_size = Math.max(s.last_raise_size, amount);
            } else if (kind.includes("small blind")) {
                sb_poster = seat.id;
                if (!s.small_blind) s.small_blind = amount;
                commit(seat, amount, "post_sb", all_in);
                s.current_bet = Math.max(s.current_bet, seat.street_contribution);
            } else {
                // big blind, or a missed big blind posted live
                if (kind.includes("big blind") && !/missing|missed/.test(kind)) {
                    bb_poster = seat.id;
                    s.big_blind = amount;
                    s.last_raise_size = amount;
                }
                commit(seat, amount, "post_bb", all_in);
                s.current_bet = Math.max(s.current_bet, seat.street_contribution);
            }
        } else if (/^folds/.test(rest)) {
            seat.folded = true;
            s.actions.push({ street: s.street, player_id: seat.id, type: "fold", amount: 0, street_total: seat.street_contribution,
                all_in: false, pot_before: potNow(), bet_to_call_before: s.current_bet });
        } else if (/^checks/.test(rest)) {
            s.actions.push({ street: s.street, player_id: seat.id, type: "check", amount: 0, street_total: seat.street_contribution,
                all_in: false, pot_before: potNow(), bet_to_call_before: s.current_bet });
        } else if (/^calls/.test(rest)) {
            // calling always matches the current bet (capped by stack), whatever number is shown
            commit(seat, s.current_bet, "call", all_in);
        } else if ((a = rest.match(new RegExp(`^bets ${AMOUNT}`)))) {
            raiseTo(seat, parseAmount(a[1]), "bet", all_in);
        } else if ((a = rest.match(new RegExp(`^raises to ${AMOUNT}`)))) {
            raiseTo(seat, parseAmount(a[1]), "raise", all_in);
        } else if ((a = rest.match(/^shows a (.+?)\.?$/))) {
            seat.shown_cards = parseCards(a[1]);
        } else if ((a = rest.match(new RegExp(`^collected ${AMOUNT} from pot`)))) {
            seat.collected += parseAmount(a[1]);
        } else if ((a = rest.match(new RegExp(`^collected ${AMOUNT} from the .*bounty`)))) {
            seat.bounty_net += parseAmount(a[1]);
        } else if ((a = rest.match(new RegExp(`^paid ${AMOUNT} for the .*bounty`)))) {
            seat.bounty_net -= parseAmount(a[1]);
        } else {
            s.unparsed.push(msg);
        }
    }

    s.pot = potNow();
    if (!s.last_raise_size) s.last_raise_size = s.big_blind;

    // hero
    if (options.hero_name) {
        s.hero_id = s.seats.find((p) => p.name === options.hero_name)?.id ?? null;
    }

    // positions: order seats clockwise starting with the small blind
    assignPositions(s, sb_poster, bb_poster, dealer_name);
    return s;
}

function assignPositions(s: HandState, sb_poster: string | null, bb_poster: string | null, dealer_name: string | null): void {
    const seats = s.seats.filter((p) => p.seat !== 99);
    const n = seats.length;
    if (n === 0) return;
    let start = -1;
    if (n === 2) {
        // heads-up: the button posts the small blind
        start = seats.findIndex((p) => p.id === (sb_poster ?? s.dealer_id));
    } else if (sb_poster) {
        start = seats.findIndex((p) => p.id === sb_poster);
    } else if (bb_poster) {
        // no small blind posted: the seat before the BB takes the SB label
        start = (seats.findIndex((p) => p.id === bb_poster) - 1 + n) % n;
    } else if (s.dealer_id) {
        start = (seats.findIndex((p) => p.id === s.dealer_id) + 1) % n;
    }
    if (start < 0) {
        const byName = dealer_name ? seats.findIndex((p) => p.name === dealer_name) : -1;
        start = byName >= 0 ? (byName + 1) % n : 0;
    }
    const labels = positionLabels(n);
    for (let i = 0; i < n; i++) {
        seats[(start + i) % n].position = labels[i];
    }
}

// ---------------------------------------------------------------------------------------------
// Hero-relative view, used by the prompt, the engine and the recorder.

export interface HeroView {
    position: string,
    stack: number,
    to_call: number,
    /** Minimum legal raise-to amount (null if hero can't raise). */
    min_raise_to: number | null,
    max_raise_to: number,
    pot: number,
    /** Share of the final pot hero must win to break even on a call. */
    pot_odds: number,
    effective_stack: number,
    spr: number,
    active_opponents: SeatState[],
    /** Players who limped preflop (called the big blind before any raise). */
    limpers: number
}

export function heroView(s: HandState): HeroView | null {
    const hero = s.seats.find((p) => p.id === s.hero_id);
    if (!hero) return null;
    const opponents = s.seats.filter((p) => p.id !== hero.id && !p.folded);
    const to_call = Math.max(0, Math.min(s.current_bet - hero.street_contribution, hero.stack));
    const can_raise = hero.stack > to_call && opponents.some((p) => !p.all_in);
    const min_raise_to = can_raise
        ? Math.min(s.current_bet + Math.max(s.last_raise_size, s.big_blind), hero.street_contribution + hero.stack)
        : null;
    const max_opp_stack = opponents.reduce((mx, p) => Math.max(mx, p.stack + p.street_contribution), 0);
    const effective_stack = Math.min(hero.stack + hero.street_contribution, max_opp_stack);
    const pot_start_of_street = s.pot - s.seats.reduce((sum, p) => sum + p.street_contribution, 0);
    return {
        position: hero.position,
        stack: hero.stack,
        to_call,
        min_raise_to,
        max_raise_to: hero.street_contribution + hero.stack,
        pot: s.pot,
        pot_odds: to_call > 0 ? to_call / (s.pot + to_call) : 0,
        effective_stack,
        // preflop the pot so far is all blinds (current-street bets), so fall back to the whole pot
        spr: effective_stack / (pot_start_of_street > 0 ? pot_start_of_street : Math.max(s.pot, 1e-9)),
        active_opponents: opponents,
        limpers: countLimpers(s)
    };
}

export function countLimpers(s: HandState): number {
    let limpers = 0;
    for (const a of s.actions) {
        if (a.street !== "preflop") break;
        if (a.type === "raise" || a.type === "bet") break;
        if (a.type === "call" && a.bet_to_call_before <= s.big_blind) limpers++;
    }
    return limpers;
}

/** Net chips won or lost by a player in a completed hand. */
export function netResult(s: HandState, player_id: string): number {
    const p = s.seats.find((x) => x.id === player_id);
    return p ? p.collected + p.bounty_net - p.total_contribution : 0;
}
