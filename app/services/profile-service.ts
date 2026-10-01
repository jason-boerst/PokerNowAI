import { HandState, parseHand, SeatState } from "../engine/hand-parser.ts";
import { calibratePreflopResponses, PreflopResponseTable } from "../engine/preflop-responses.ts";
import { calibrateTells, readTells, TELL_KINDS, TellModel, TellReading } from "../engine/seven-deuce-tells.ts";
import { ObservedStats, POPULATION_TENDENCIES } from "../engine/opponent-range.ts";
import type { PlayerBluffReading } from "../engine/opponent-range.ts";
import { applyBluffScale, fitBluffScale, fitPlayerBluffScales, heldOutPlayerBluffCheck, PlayerBluffFit } from "../engine/bluff-calibration.ts";
import { blendSession, calibratePriors, Deviation, PlayerProfile, PlayerRef, PRIORS, ProfileBuilder, RATE_KEYS, RateKey, resetPriors, sessionDeviations } from "../engine/player-profile.ts";
import { CalibratedActionWeights, ShowdownCalibrator } from "../engine/showdown-calibration.ts";
import { calibrateResponses, ResponseTable } from "../engine/response-calibration.ts";
import { HandRecorder, HandRow, ME } from "./hand-recorder.ts";
import { checkConstants, ConstantCheck, PlayConstants } from "../engine/constant-calibration.ts";
import { chooseHalfLife, gameOrder, gamesSince, HalfLifeCheck, playerGameCounts, recencyWeight } from "../engine/recency.ts";

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
    private tells: TellModel | null = null;
    private preflop: { table: PreflopResponseTable, samples: number } | null = null;
    private player_bluff: ReturnType<ProfileService["playerBluffScales"]> | null = null;
    private responses: { table: ResponseTable, samples: number } | null = null;
    private constants: { values: PlayConstants, checks: ConstantCheck[] } | null = null;
    /** Whether older games count less in long-term profiles, and the check that decided it (see recency.ts). */
    recency: HalfLifeCheck = { half_life: Infinity, cases: 0, test_games: 0, results: [], reason: "Not loaded." };

    constructor(private recorder: HandRecorder) {
        this.long = new ProfileBuilder(this.keyOf);
        this.session = new ProfileBuilder(this.keyOf);
    }

    /** Stored hands loaded, plus live hands added since. */
    handCount(): number {
        return this.hands.length + this.live_states.length;
    }

    /** Identity key for a seat: its linked person, or the PokerNow player id. */
    keyOf = (seat: { id: string }): string => this.links.get(seat.id) ?? seat.id;

    /** Loads every stored hand. Hands from `live_game_id` form the current session. Returns the hand count. */
    async load(live_game_id: string | null = null): Promise<number> {
        // build everything first and swap it in at the end, so a concurrent reader never sees a half-built state
        const links = await this.recorder.links();
        const rows = await this.recorder.hands();
        const keyOf = (seat: { id: string }) => links.get(seat.id) ?? seat.id;
        let long = new ProfileBuilder(keyOf);
        const session = new ProfileBuilder(keyOf);
        const hands = rows.map((row) => ({
            row,
            state: parseHand(JSON.parse(row.messages_json), { big_blind: row.big_blind ?? undefined }),
            at: row.started_at ?? row.recorded_at
        }));
        for (const h of hands) (h.row.game_id === live_game_id ? session : long).addHand(h.state, h.at);
        this.calibrate(long, session);
        // recency: older games count less in each player's long-term profile, when that predicts later games better
        // (the pool's averages above use unweighted counts either way)
        const past = hands.filter((h) => h.row.game_id !== live_game_id).map((h) => ({ state: h.state, game_id: h.row.game_id, at: h.at }));
        const counts = playerGameCounts(past, keyOf);
        const order = gameOrder(past);
        const recency = chooseHalfLife(counts, order, (key) => key !== ME);
        if (Number.isFinite(recency.half_life)) {
            const since = gamesSince(counts, order);
            long = new ProfileBuilder(keyOf);
            for (const h of past) long.addHand(h.state, h.at, (key) => recencyWeight(since.get(key)?.get(h.game_id) ?? 0, recency.half_life));
        }
        this.recency = recency;
        this.live_game_id = live_game_id;
        this.links = links;
        this.hands = hands;
        this.long = long;
        this.session = session;
        this.live_states = [];
        this.calibrator = null;
        this.action_weights = null;
        this.tells = null;
        this.player_bluff = null;
        this.constants = null;
        this.preflop = null;
        this.responses = null;
        return hands.length;
    }

    /**
     * How players in your games answer bets after the flop (fold, call, raise), by street, by who bets and
     * by size, measured from every stored hand with your own answers left out. Built on first use.
     */
    responseTable(): { table: ResponseTable, samples: number } {
        this.responses ??= calibrateResponses([...this.hands.map((h) => h.state), ...this.live_states], (seat) => this.keyOf(seat) !== ME);
        return this.responses;
    }

    /**
     * Post-flop action weights per street (`weights`, for the equity engine's range narrowing) and
     * how many shown-hand actions each street was measured from (`samples`). A copy: changing it
     * changes nothing here.
     */
    /** The action weights as learned from shown hands, before the bluff correction. */
    rawActionWeights(): CalibratedActionWeights["weights"] {
        this.actionWeights();
        return structuredClone(this.calibrator!.weights().weights);
    }

    actionWeights(): CalibratedActionWeights {
        if (!this.calibrator) {
            // your own shown hands say nothing about how opponents bet
            const calibrator = new ShowdownCalibrator((seat) => this.keyOf(seat) !== ME);
            for (const h of this.hands) calibrator.add(h.state);
            for (const s of this.live_states) calibrator.add(s);
            this.calibrator = calibrator;
        }
        if (!this.action_weights) {
            const measured = this.calibrator.weights();
            // shown flop and turn bets lean strong (bluffers who give up never show): correct them against the fair
            // sample of called river bettors, with everyone's ranges built from their stats as the engine does
            const bluff = fitBluffScale([...this.hands.map((h) => h.state), ...this.live_states], measured.weights,
                (p) => this.stats(p), (seat) => this.keyOf(seat) !== ME);
            this.action_weights = { ...measured, weights: applyBluffScale(measured.weights, bluff.scale), bluff };
        }
        return structuredClone(this.action_weights);
    }

    /**
     * Each regular's own bluff scale (relative to the pool) and the held-out check that decides whether the engine
     * uses them: on when, leaving one game out at a time, they predict what called river bettors showed better than
     * the pool alone by more than two standard errors. Built on first use.
     */
    playerBluffScales(): { fits: Map<string, PlayerBluffFit>, check: { samples: number, ll_pool: number, ll_player: number, diff_se: number }, active: boolean } {
        if (!this.player_bluff) {
            const states = [...this.hands.map((h) => h.state), ...this.live_states];
            const include = (seat: SeatState) => this.keyOf(seat) !== ME;
            const fits = fitPlayerBluffScales(states, this.actionWeights().weights, (p) => this.stats(p), this.keyOf, include);
            const check = heldOutPlayerBluffCheck([...this.hands.map((h) => ({ game: h.row.game_id, s: h.state })), ...this.live_states.map((s) => ({ game: "live", s }))],
                this.rawActionWeights(), (p) => this.stats(p), this.keyOf, include);
            this.player_bluff = { fits, check, active: check.ll_player - check.ll_pool > 2 * check.diff_se && check.diff_se > 0 };
        }
        return this.player_bluff;
    }

    /** The engine's per-seat bluff scale reader (null when the per-player scales are off). */
    bluffScaleReader(): ((seat: SeatState) => PlayerBluffReading | undefined) | null {
        const b = this.playerBluffScales();
        if (!b.active) return null;
        return (seat) => {
            if (this.keyOf(seat) === ME) return undefined;
            const f = b.fits.get(this.keyOf(seat));
            if (!f || f.scale === 1) return undefined;
            const more = f.scale > 1;
            return {
                scale: f.scale,
                note: `Bluffs ${more ? "more" : "less"} than most on the flop and turn: air on ${f.air} of ${f.samples} called river bets ` +
                    `(about ${Math.round(f.expected_air * f.samples)} expected); their bets are read ${more ? "wider" : "stronger"}.`
            };
        };
    }

    /**
     * The engine's play constants re-measured on your stored hands (constant-calibration.ts): the values to use (built-in
     * unless a measured one predicts held-out games better) and the check for each. Built on first use.
     */
    playConstants(): { values: PlayConstants, checks: ConstantCheck[] } {
        this.constants ??= checkConstants([...this.hands.map((h) => ({ game: h.row.game_id, s: h.state })), ...this.live_states.map((s) => ({ game: "live", s }))],
            (seat) => this.keyOf(seat) !== ME);
        return this.constants;
    }

    /** How players in your games answer preflop raises (preflop-responses.ts), your own answers left out. Built on first use. */
    preflopResponses(): { table: PreflopResponseTable, samples: number } {
        this.preflop ??= calibratePreflopResponses([...this.hands.map((h) => h.state), ...this.live_states], (seat) => this.keyOf(seat) !== ME);
        return this.preflop;
    }

    /**
     * 7-2 sizing tells measured over your stored hands (seven-deuce-tells.ts), your own actions left out. Built on
     * first use; live hands don't change it during a session.
     */
    sevenDeuceTells(): TellModel {
        this.tells ??= calibrateTells([...this.hands.map((h) => h.state), ...this.live_states], this.keyOf, (seat) => this.keyOf(seat) !== ME);
        return this.tells;
    }

    /** Reads the active 7-2 tells for an opponent in a hand (null when none is significant in your games). */
    tellReader(): ((s: HandState, seat: SeatState) => TellReading) | null {
        const model = this.sevenDeuceTells();
        if (!TELL_KINDS.some((k) => model.stats[k].active)) return null;
        return (s, seat) => this.keyOf(seat) === ME ? { lr: 1, notes: [] } : readTells(model, s, seat, this.keyOf(seat));
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
