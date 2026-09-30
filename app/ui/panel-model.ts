// What the in-game panel shows, independent of how it is drawn (see panel-render.ts) and where
// (the in-page host in puppeteer-service.ts). Builders: helpers/overlay-builder.ts and ui/opponent-cards.ts.

/** Panel color by the suggested action: red to fold, yellow to check, green to call, bet, raise or go all-in. */
export type PanelTone = "fold" | "check" | "go";

export function toneFor(action: string): PanelTone {
    const a = action.toLowerCase();
    if (a === "fold") return "fold";
    if (a === "check") return "check";
    return "go";
}

/** How a stat compares with the average player in your games (for coloring). */
export type StatLevel = "high" | "low" | "normal" | "unknown";

export interface OpponentStat {
    /** Short label, e.g. "VPIP", "Fold to flop bet". */
    label: string,
    /** 0-1 (the estimate the engine uses). */
    value: number,
    /** Chances it was measured over (0: population default only). */
    n: number,
    /** Your games' average for this stat, 0-1. */
    pool?: number,
    level: StatLevel,
    /** Why it matters right now, e.g. "you're betting: how often they fold". */
    hint?: string
}

/** Player type badge and its color family. */
export type TypeTone = "loose" | "tight" | "aggressive" | "passive" | "balanced" | "unknown";

export interface OpponentCard {
    /** Position, e.g. "BU". */
    seat: string,
    name: string,
    stack_bb: number,
    /** e.g. "calling station", "LAG", "unknown". */
    type: string,
    type_tone: TypeTone,
    hands: { before: number, today: number },
    /** Estimated range width, percent of all hands (when known). */
    range_pct?: number,
    /** The stats that matter for this decision first. */
    stats: OpponentStat[],
    /** e.g. "Today VPIP 43% / PFR 14% over 7 hands (usually 32% / 18%)". */
    today?: string,
    /** Clear changes from their usual play today. */
    flags: string[],
    /** e.g. "9c Kd after call, check/call, check/raise, bet". */
    last_showdown?: string,
    /** One line: how to exploit this player. */
    exploit?: string,
    /** Under 20 hands: mostly population defaults. */
    low_sample: boolean,
    /** Still to act after you in this betting round. */
    to_act?: boolean
}

export interface PanelOption {
    /** e.g. "bet 5.3 BB", "check", "call 2 BB". */
    label: string,
    ev_bb: number,
    chosen: boolean,
    /** Chance everyone folds / hero gets raised (bets and raises). */
    fold_chance?: number,
    raise_chance?: number,
    /** e.g. "bluff, lead" or "value, c-bet". */
    kind?: string,
    /** Share of the time the mix plays it (0-1) and its random-number range, e.g. "63-100". */
    mix?: number,
    mix_range?: string
}

/** One option of the mix on the random-number strip. */
export interface RngSegment {
    /** e.g. "Check", "Bet 4 BB". */
    label: string,
    /** fold, check, call, bet, raise or all-in (for its color). */
    action: string,
    /** Its range of numbers, inclusive, within 1-100. */
    from: number,
    to: number,
    /** The roll landed here. */
    picked: boolean
}

/** This turn's random number and the mix it picks from: low numbers are the passive options, high the aggressive ones. */
export interface PanelRng {
    /** 1-100. */
    roll: number,
    /** One option at every roll (a clear spot). */
    pure: boolean,
    /** Passive to aggressive; together they cover 1-100. */
    segments: RngSegment[],
    /** One line on why it mixes or doesn't, e.g. "Close spot: check and bet 4 BB are within 0.3 BB". */
    note?: string,
    /** How a balanced range plays this spot as a whole, e.g. "Balanced range here: fold 33% · continue 67%". */
    baseline?: string
}

export interface PanelModel {
    /** thinking: provisional pick while the AI works; final; stale: the turn has passed. */
    status: "thinking" | "final" | "stale",
    tone: PanelTone,
    /** Who decided: label e.g. "AI (openai/x)", "Engine", "Preflop chart"; detail e.g. "86% confident", "clear spot". */
    source: { label: string, detail?: string },
    /** e.g. "Hand #14 · River · you: BB (out of position)". */
    context: string,
    action: {
        /** e.g. "FOLD", "CHECK", "CALL", "BET", "RAISE TO", "ALL-IN". */
        verb: string,
        size_bb?: number,
        chips?: number,
        /** Bet or raise as a share of the pot, e.g. 0.66. */
        pot_share?: number
    },
    /** Bets and raises: "Bluff · lead into the preflop raiser" and its kind (for color). */
    tag?: { text: string, kind: "value" | "semi-bluff" | "bluff" | "neutral" },
    /** The random number and the mixed strategy (when mixing is on). */
    rng?: PanelRng,
    /** Always visible: why this action, in short plain lines (first line is the main reason). */
    reasoning: string[],
    warnings: string[],
    /** While the AI thinks: to draw a countdown. */
    thinking?: { model: string, budget_ms: number, started_at: number },
    spot: {
        pot_bb: number,
        to_call_bb: number,
        /** Share of the final pot a call costs (0 when nothing to call). */
        pot_odds: number,
        stack_bb: number,
        effective_bb: number,
        spr: number,
        /** "SPR" or "flop SPR if you call". */
        spr_label: string,
        min_raise_bb?: number,
        max_raise_bb?: number,
        in_position?: boolean,
        /** Table rules that change decisions, e.g. "7-2 bounty on: 3 BB from each player". */
        notes: string[]
    },
    hand: {
        cards: string[],
        board: string[],
        /** e.g. "Top pair, Ace kicker". */
        made: string,
        /** e.g. "Flush draw: 9 outs, 35% by the river". */
        draws?: string
    },
    odds: {
        /** 0-1. */
        equity?: number,
        /** Equity a call needs, 0-1 (when facing a bet or raise). */
        need?: number,
        equity_when_called?: number,
        /** Preflop chart scenario, e.g. "heads-up, facing a raise". */
        chart_spot?: string
    },
    options: PanelOption[],
    opponents: OpponentCard[],
    /** Opponents in the hand not shown as cards. */
    more_opponents: number
}
