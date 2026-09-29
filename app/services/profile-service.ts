import { HandState, parseHand } from "../engine/hand-parser.ts";
import { ObservedStats, POPULATION_TENDENCIES } from "../engine/opponent-range.ts";
import { blendSession, calibratePriors, Deviation, PlayerProfile, PlayerRef, PRIORS, ProfileBuilder, RATE_KEYS, RateKey, resetPriors, sessionDeviations } from "../engine/player-profile.ts";
import { CalibratedActionWeights, ShowdownCalibrator } from "../engine/showdown-calibration.ts";
import { HandRecorder, HandRow, ME } from "./hand-recorder.ts";

export { ME } from "./hand-recorder.ts";

/** Everything known about one player at the table. */
export interface PlayerInfo {
    /** Estimate used for decisions: this session blended toward their long-term play. */
    current?: PlayerProfile,
    /** All recorded and imported games except the live one. */
    long?: PlayerProfile,
    /** The live game only. */
    session?: PlayerProfile,
    /** Where this session clearly differs from their usual play. */
    deviations: Deviation[]
}

export type PlayerLookup = (ref: PlayerRef) => PlayerInfo;

/**
 * Opponent profiles from every stored hand (imported logs and live play). History is split into
 * long-term (every game except the live one) and the current session, so decisions can use how a
 * player is playing today while leaning on how they usually play.
 */
export class ProfileService {
    private links = new Map<string, string>();
    private long: ProfileBuilder;
    private session: ProfileBuilder;
    private live_game_id: string | null = null;
    /** Every stored hand, parsed once at load. */
    private hands: { row: HandRow, state: HandState, at: string }[] = [];
    /** Live hands added since load, for the action weights. */
    private live_states: HandState[] = [];
    /**
     * What opponents' bets, raises, calls and checks mean, learned from their shown hands. Built on
     * first use (the dashboard and `npm run players` don't need it) and kept up to date after that.
     */
    private calibrator: ShowdownCalibrator | null = null;
    private action_weights: CalibratedActionWeights | null = null;

    constructor(private recorder: HandRecorder) {
        this.long = new ProfileBuilder(this.keyOf);
        this.session = new ProfileBuilder(this.keyOf);
    }

    /** Identity key for a seat: its linked person, or the PokerNow player id. */
    keyOf = (seat: { id: string }): string => this.links.get(seat.id) ?? seat.id;

    /** Loads every stored hand. Hands from `live_game_id` form the current session. Returns the hand count. */
    async load(live_game_id: string | null = null): Promise<number> {
        // build everything first and swap it in at the end, so a concurrent reader never sees a half-built state
        const links = await this.recorder.links();
        const rows = await this.recorder.hands();
        const keyOf = (seat: { id: string }) => links.get(seat.id) ?? seat.id;
        const long = new ProfileBuilder(keyOf);
        const session = new ProfileBuilder(keyOf);
        const hands = rows.map((row) => ({
            row,
            state: parseHand(JSON.parse(row.messages_json), { big_blind: row.big_blind ?? undefined }),
            at: row.started_at ?? row.recorded_at
        }));
        for (const h of hands) (h.row.game_id === live_game_id ? session : long).addHand(h.state, h.at);
        this.calibrate(long, session);
        this.live_game_id = live_game_id;
        this.links = links;
        this.hands = hands;
        this.long = long;
        this.session = session;
        this.live_states = [];
        this.calibrator = null;
        this.action_weights = null;
        return hands.length;
    }

    /**
     * Post-flop action weights per street (`weights`, for the equity engine's range narrowing) and
     * how many shown-hand actions each street was measured from (`samples`). A copy: changing it
     * changes nothing here.
     */
    actionWeights(): CalibratedActionWeights {
        if (!this.calibrator) {
            // your own shown hands say nothing about how opponents bet
            const calibrator = new ShowdownCalibrator((seat) => this.keyOf(seat) !== ME);
            for (const h of this.hands) calibrator.add(h.state);
            for (const s of this.live_states) calibrator.add(s);
            this.calibrator = calibrator;
        }
        this.action_weights ??= this.calibrator.weights();
        return structuredClone(this.action_weights);
    }

    /** Your games' average player (the population averages, 0-1 for each rate) and the opponent hands behind them. */
    poolSummary(): Record<RateKey, number> & { pool_hands: number } {
        const averages = {} as Record<RateKey, number>;
        for (const key of RATE_KEYS) averages[key] = PRIORS[key].mean;
        return { ...averages, pool_hands: this.pool_hands };
    }

    /** Opponent chances the population averages were computed from (0: built-in guesses). */
    pool_hands = 0;

    /** Sets the population averages (used for players with little history) from everyone but you. */
    private calibrate(long: ProfileBuilder, session: ProfileBuilder): void {
        const a = long.poolCounts((key) => key === ME), b = session.poolCounts((key) => key === ME);
        const pool = {} as Record<RateKey, { k: number, n: number }>;
        for (const key of RATE_KEYS) pool[key] = { k: a[key].k + b[key].k, n: a[key].n + b[key].n };
        if (pool.vpip.n === 0) resetPriors();
        else calibratePriors(pool);
        POPULATION_TENDENCIES.vpip = PRIORS.vpip.mean * 100;
        POPULATION_TENDENCIES.pfr = PRIORS.pfr.mean * 100;
        POPULATION_TENDENCIES.three_bet = PRIORS.three_bet.mean * 100;
        this.pool_hands = pool.vpip.n;
    }

    /**
     * Adds a finished hand from the live game. With `hero_name` (the seat you play), that seat
     * counts as you right away, as the recorder links it, even on an id first seen this game.
     */
    addHand(messages: string[], big_blind: number, game_id: string, hero_name?: string): void {
        const state = parseHand(messages, { big_blind, hero_name });
        if (state.hero_id && !this.links.has(state.hero_id)) this.links.set(state.hero_id, ME);
        (game_id === this.live_game_id ? this.session : this.long).addHand(state, new Date().toISOString());
        if (this.calibrator) this.calibrator.add(state);
        else this.live_states.push(state);
        this.action_weights = null;
    }

    info(ref: PlayerRef): PlayerInfo {
        const key = this.keyOf(ref);
        const long = this.long.profile(key);
        const session = this.session.profile(key);
        return { current: blendSession(long, session), long, session, deviations: sessionDeviations(long, session) };
    }

    /** Stats in the form the range and preflop engines use (current-form estimate). */
    stats(ref: PlayerRef): ObservedStats | undefined {
        const p = this.info(ref).current;
        if (!p) return undefined;
        return { vpip: p.vpip.value * 100, pfr: p.pfr.value * 100, hands: p.hands, aggression: p.aggression.value, three_bet: p.three_bet.value * 100, shrunk: true };
    }

    /** All known people with long-term and session profiles (for the dashboard and `npm run players`). */
    everyone(): { key: string, info: PlayerInfo, is_me: boolean }[] {
        const keys = new Set([...this.long.keys(), ...this.session.keys()]);
        return [...keys].map((key) => {
            const long = this.long.profile(key);
            const session = this.session.profile(key);
            return { key, is_me: key === ME, info: { current: blendSession(long, session), long, session, deviations: sessionDeviations(long, session) } };
        });
    }

    /** How many games each person has played in. */
    gameCounts(): Map<string, number> {
        const games = new Map<string, Set<string>>();
        for (const h of this.hands) {
            for (const seat of h.state.seats) {
                const key = this.keyOf(seat);
                if (!games.has(key)) games.set(key, new Set());
                games.get(key)!.add(h.row.game_id);
            }
        }
        return new Map([...games.entries()].map(([key, set]) => [key, set.size]));
    }

    /** One person's profile from every game except `game_id` (to compare a game with their usual play). */
    profileExcludingGame(key: string, game_id: string): PlayerProfile | undefined {
        const builder = new ProfileBuilder(this.keyOf);
        for (const h of this.hands) {
            if (h.row.game_id !== game_id && h.state.seats.some((seat) => this.keyOf(seat) === key)) builder.addHand(h.state, h.at);
        }
        return builder.profile(key);
    }

    /** Per-game profiles for one person, most recent game first (for the dashboard's history view). */
    gamesOf(key: string): { game_id: string, first_at: string, profile: PlayerProfile }[] {
        const by_game = new Map<string, { builder: ProfileBuilder, first_at: string }>();
        for (const h of this.hands) {
            if (!h.state.seats.some((seat) => this.keyOf(seat) === key)) continue;
            const entry = by_game.get(h.row.game_id) ?? { builder: new ProfileBuilder(this.keyOf), first_at: h.at };
            entry.builder.addHand(h.state, h.at);
            by_game.set(h.row.game_id, entry);
        }
        return [...by_game.entries()]
            .map(([game_id, e]) => ({ game_id, first_at: e.first_at, profile: e.builder.profile(key)! }))
            .filter((g) => g.profile)
            .sort((a, b) => b.first_at.localeCompare(a.first_at));
    }

    /**
     * Everyone who played in one game: how they played in it, how they play in every other game,
     * the blended estimate, and where the game clearly differs from their usual play.
     */
    gameView(game_id: string): { key: string, info: PlayerInfo }[] {
        const in_game = new ProfileBuilder(this.keyOf);
        const other = new ProfileBuilder(this.keyOf);
        for (const h of this.hands) (h.row.game_id === game_id ? in_game : other).addHand(h.state, h.at);
        return in_game.keys().map((key) => {
            const session = in_game.profile(key);
            const long = other.profile(key);
            return { key, info: { current: blendSession(long, session), long, session, deviations: sessionDeviations(long, session) } };
        });
    }
}
