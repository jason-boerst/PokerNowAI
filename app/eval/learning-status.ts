// What the tool has learned from your stored hands, and what is still running on built-in guesses: the data behind
// each learned table, every data-gated feature with how close it is to switching on (or off), and how reliable each
// regular's stats are. A snapshot (counts only, never names) can be appended to a history so you can see the
// numbers move as you import more logs.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { aiCheck } from "./ai-check.ts";
import { CONSTANT_TEXT } from "../engine/constant-calibration.ts";
import { defaultPrior, PRIORS, RateKey } from "../engine/player-profile.ts";
import { TELL_KINDS, TELL_NAMES, Z_ON } from "../engine/seven-deuce-tells.ts";
import type { DecisionRow } from "../services/hand-recorder.ts";
import { ME, ProfileService } from "../services/profile-service.ts";

export interface LearnedFeature {
    name: string,
    on: boolean,
    /** What it rests on and how far it is from switching, in one line. */
    detail: string
}

export interface RegularStat { key: RateKey, label: string, value: number, chances: number, half_width: number }
export interface Regular { key: string, name: string, hands: number, games: number, stats: RegularStat[], reliable: number }

export interface LearningStatus {
    at: string,
    data: { hands: number, games: number, players: number, opponent_chances: number, your_hands: number },
    /** Your games' average player next to the built-in guess, for the main stats. */
    pool: { key: RateKey, label: string, yours: number, built_in: number }[],
    /** Samples behind each learned table. */
    tables: { name: string, samples: number }[],
    features: LearnedFeature[],
    regulars: Regular[]
}

/** The stats shown per regular, and a stat counts as reliable once its 95% range is this narrow (± share points). */
const REGULAR_STATS: [RateKey, string][] = [
    ["vpip", "VPIP"], ["pfr", "PFR"], ["three_bet", "3-bet"], ["cbet", "c-bet"], ["fold_to_cbet", "fold to c-bet"],
    ["fold_to_bet_turn", "fold to turn bet"], ["fold_to_bet_river", "fold to river bet"], ["aggression", "aggression"]
];
const RELIABLE = 0.1;
const POOL_STATS: [RateKey, string][] = [
    ["vpip", "VPIP"], ["pfr", "PFR"], ["three_bet", "3-bet"], ["cbet", "c-bet"], ["fold_to_bet_flop", "fold to flop bet"],
    ["fold_to_bet_turn", "fold to turn bet"], ["fold_to_bet_river", "fold to river bet"], ["bet_when_checked_to", "bet when checked to"]
];
/** Regulars listed: opponents with at least this many hands, the most hands first. */
const REGULAR_HANDS = 100;
const MAX_REGULARS = 30;

export function learningStatus(profiles: ProfileService, decisions: DecisionRow[] = []): LearningStatus {
    const everyone = profiles.everyone();
    const me = everyone.find((e) => e.key === ME)?.info.long;
    const games = new Set<string>();
    const games_of = new Map<string, number>();
    for (const e of everyone) {
        const g = profiles.gamesOf(e.key);
        games_of.set(e.key, g.length);
        for (const x of g) games.add(x.game_id);
    }
    const pool = profiles.poolSummary();
    const weights = profiles.actionWeights();
    const bluff = weights.bluff;
    const responses = profiles.responseTable();
    const preflop = profiles.preflopResponses();
    const tells = profiles.sevenDeuceTells();
    const player_bluff = profiles.playerBluffScales();
    const constants = profiles.playConstants();
    const recency = profiles.recency;
    const ai = aiCheck(decisions);
    const f1 = (x: number) => (Math.round(x * 10) / 10).toString();

    const features: LearnedFeature[] = [];
    features.push({
        name: "Bluff correction (flop and turn bets)", on: !!bluff && bluff.scale !== 1,
        detail: bluff && bluff.samples ? `Fit on ${bluff.samples} called river bettors: flop and turn bluffs count x${bluff.scale}.` : "No called river bettors yet."
    });
    for (const kind of TELL_KINDS) {
        const t = tells.stats[kind];
        if (!t.n72) continue;
        features.push({ name: `7-2 tell: ${TELL_NAMES[kind]}`, on: t.active, detail: `${t.n72} shown 7-2; z ${f1(t.z)} (on at ${Z_ON}).` });
    }
    const pb = player_bluff.check;
    features.push({
        name: "Per-player bluffing", on: player_bluff.active,
        detail: pb.samples ? `Held-out gain ${f1(pb.ll_player - pb.ll_pool)} vs needed ${f1(2 * pb.diff_se)} (2 SE), on ${pb.samples} called river bets.` : "No called river bets yet."
    });
    const best_h = recency.results.slice(1).reduce<typeof recency.results[number] | undefined>((x, y) => (!x || y.gain > x.gain ? y : x), undefined);
    features.push({
        name: "Recency (recent games count more)", on: Number.isFinite(recency.half_life),
        detail: best_h ? `Best half-life ${best_h.half_life} games: gain ${f1(best_h.gain)} vs needed ${f1(2 * best_h.se)} (2 SE), ${recency.cases} player-games tested.` : recency.reason
    });
    for (const c of constants.checks) {
        features.push({
            name: `Learned constant: ${CONSTANT_TEXT[c.name]}`, on: c.active,
            detail: `${c.built_in} built in, ${Math.round(c.measured * 1000) / 1000} measured on ${c.cases} cases; held-out gain ${f1(c.gain)} vs needed ${f1(2 * c.se)}.`
        });
    }
    features.push({
        name: "AI check (\"auto\" turns the AI off if it loses)", on: ai.verdict === "ai_worse",
        detail: `${ai.ai.measured} AI decisions with engine EVs recorded (the check needs 200): ${ai.reason}`
    });

    const regulars: Regular[] = everyone
        .filter((e) => e.key !== ME && (e.info.long?.hands ?? 0) >= REGULAR_HANDS)
        .sort((a, b) => b.info.long!.hands - a.info.long!.hands)
        .slice(0, MAX_REGULARS)
        .map((e) => {
            const p = e.info.long!;
            const stats = REGULAR_STATS.map(([key, label]): RegularStat => {
                const r = p[key];
                const n = r.n + PRIORS[key].weight;
                return { key, label, value: r.value, chances: Math.round(r.n), half_width: 1.96 * Math.sqrt(r.value * (1 - r.value) / n) };
            });
            return { key: e.key, name: p.name, hands: p.hands, games: games_of.get(e.key) ?? 0, stats, reliable: stats.filter((s) => s.half_width <= RELIABLE).length };
        });

    return {
        at: new Date().toISOString(),
        data: {
            hands: profiles.handCount(),
            games: games.size, players: everyone.length, opponent_chances: pool.pool_hands, your_hands: me?.hands ?? 0
        },
        pool: POOL_STATS.map(([key, label]) => ({ key, label, yours: pool[key], built_in: defaultPrior(key) })),
        tables: [
            { name: "Showdowns behind how bets are read (flop/turn/river)", samples: weights.samples.flop + weights.samples.turn + weights.samples.river },
            { name: "Answers to post-flop bets", samples: responses.samples },
            { name: "Answers to preflop raises", samples: preflop.samples },
            { name: "Called river bettors (bluff fit)", samples: bluff?.samples ?? 0 }
        ],
        features,
        regulars
    };
}

/** One history row: counts and switches only (no names, no ids). */
export function snapshot(s: LearningStatus): Record<string, unknown> {
    return {
        at: s.at, ...s.data,
        regulars: s.regulars.length,
        reliable_stats: s.regulars.reduce((n, r) => n + r.reliable, 0),
        tables: Object.fromEntries(s.tables.map((t) => [t.name, t.samples])),
        on: s.features.filter((f) => f.on).map((f) => f.name)
    };
}

export function appendHistory(file: string, s: LearningStatus): void {
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(snapshot(s)) + "\n");
}

export function readHistory(file: string): Record<string, unknown>[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
    });
}

export function formatStatus(s: LearningStatus, history: Record<string, unknown>[] = []): string[] {
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const out: string[] = [];
    out.push(`Data: ${s.data.hands} hands in ${s.data.games} games, ${s.data.players} players; ${s.data.opponent_chances} opponent hands behind your games' averages; ${s.data.your_hands} of your own hands.`);
    out.push("");
    out.push("Your games' average player (learned) vs the built-in guess:");
    for (const p of s.pool) out.push(`  ${p.label.padEnd(22)} ${pct(p.yours).padStart(5)}  (built in ${pct(p.built_in)})`);
    out.push("");
    out.push("Learned tables (more samples, steadier numbers):");
    for (const t of s.tables) out.push(`  ${t.name.padEnd(56)} ${String(t.samples).padStart(7)}`);
    out.push("");
    out.push("Features that switch on only when your hands support them:");
    for (const f of s.features) out.push(`  ${f.on ? "ON " : "off"}  ${f.name}: ${f.detail}`);
    out.push("");
    out.push(`Regulars (${REGULAR_HANDS}+ hands): a stat is reliable once its 95% range is within ±${Math.round(RELIABLE * 100)} points.`);
    for (const r of s.regulars) {
        out.push(`  ${r.name.slice(0, 18).padEnd(18)} ${String(r.hands).padStart(5)} hands, ${r.games} games, ${r.reliable}/${r.stats.length} reliable: ` +
            r.stats.map((x) => `${x.label} ${pct(x.value)}±${Math.round(x.half_width * 100)}`).join(", "));
    }
    if (history.length > 1) {
        out.push("");
        out.push("History (one row per run):");
        for (const h of history.slice(-10)) {
            out.push(`  ${String(h.at).slice(0, 16)}  ${String(h.hands).padStart(6)} hands  ${String(h.games).padStart(3)} games  ${String(h.reliable_stats).padStart(4)} reliable regular stats  on: ${(h.on as string[]).length}`);
        }
    }
    return out;
}
