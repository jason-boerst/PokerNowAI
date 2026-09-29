// Reads PokerNow's "Download log" CSV export (columns: entry, at, order; newest first) and splits
// it into complete hands.
import { code } from "../engine/cards.ts";
import { AFTER_HAND_LINE, parseCards, parseHand } from "../engine/hand-parser.ts";

export interface LogRow {
    entry: string,
    at: string,
    order: string
}

export interface ImportedHand {
    hand_number: number,
    /** Chronological log lines from "-- starting hand" to "-- ending hand". */
    messages: string[],
    started_at: string,
    game_type: string,
    big_blind: number
}

/** Parses CSV text (RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes). */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else quoted = false;
            } else {
                field += c;
            }
        } else if (c === '"') {
            quoted = true;
        } else if (c === ",") {
            row.push(field); field = "";
        } else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            row.push(field); field = "";
            if (row.length > 1 || row[0] !== "") rows.push(row);
            row = [];
        } else {
            field += c;
        }
    }
    if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

/** Log rows from a PokerNow CSV export, oldest first. Throws if the columns aren't PokerNow's. */
export function readLogRows(csv_text: string): LogRow[] {
    const [header, ...rows] = parseCsv(csv_text.replace(/^﻿/, ""));
    const col = (name: string) => header?.findIndex((h) => h.trim().toLowerCase() === name) ?? -1;
    const [ie, ia, io] = [col("entry"), col("at"), col("order")];
    if (ie < 0 || ia < 0) {
        throw new Error(`Not a PokerNow log export (expected columns "entry,at,order", found "${(header ?? []).join(",")}").`);
    }
    const out = rows.filter((r) => r.length > ie).map((r) => ({ entry: r[ie], at: r[ia] ?? "", order: io >= 0 ? r[io] ?? "" : "" }));
    // PokerNow exports newest first; sort by the order column (or timestamp) to get chronological order
    const key = (r: LogRow) => r.order ? BigInt(r.order.replace(/\D/g, "") || "0") : BigInt(Date.parse(r.at) || 0);
    out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    return out;
}

/** Splits chronological rows into complete hands; hands cut off by the export limit are skipped. */
export function splitHands(rows: LogRow[]): { hands: ImportedHand[], incomplete: number } {
    const hands: ImportedHand[] = [];
    let incomplete = 0;
    let current: { number: number, rows: LogRow[] } | null = null;
    // the hand that just ended, which still receives shows and bounty payments logged after its end
    let finished: ImportedHand | null = null;
    for (const row of rows) {
        const start = row.entry.match(/^-- starting hand #(\d+)/);
        if (start) {
            if (current) incomplete++;
            current = { number: Number(start[1]), rows: [row] };
            finished = null;
            continue;
        }
        if (!current) {
            if (finished && AFTER_HAND_LINE.test(row.entry)) finished.messages.push(row.entry);
            // the end of a hand whose start was cut off (the export keeps only the newest lines)
            else if (/^-- ending hand #/.test(row.entry)) incomplete++;
            continue;
        }
        current.rows.push(row);
        const end = row.entry.match(/^-- ending hand #(\d+)/);
        if (end) {
            if (Number(end[1]) === current.number) {
                const messages = current.rows.map((r) => r.entry);
                const bb_post = messages.map((m) => m.match(/posts a big blind of ([\d,.]+)/)).find(Boolean);
                finished = {
                    hand_number: current.number,
                    messages,
                    started_at: current.rows[0].at,
                    game_type: messages[0].match(/\(id: [^)]+\)\s+(.*?)\s+\((?:dealer|dead button)/)?.[1] ?? "",
                    big_blind: bb_post ? Number(bb_post[1].replace(/,/g, "")) : 0
                };
                hands.push(finished);
            } else {
                incomplete++;
            }
            current = null;
        }
    }
    if (current) incomplete++;
    // hands without a big blind post (e.g. bomb pots) use the game's most common big blind
    const counts = new Map<number, number>();
    for (const h of hands) if (h.big_blind > 0) counts.set(h.big_blind, (counts.get(h.big_blind) ?? 0) + 1);
    const typical = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    for (const h of hands) if (!h.big_blind) h.big_blind = typical;
    return { hands, incomplete };
}

/** Game id from a PokerNow export file name like "poker_now_log_pglAbC123.csv". */
export function gameIdFromFileName(file_name: string): string | null {
    return file_name.match(/poker_now_log_([A-Za-z0-9_-]+)\.csv$/i)?.[1] ?? null;
}

/**
 * Your player id in a log. The log includes your hole cards ("Your hand is ..."), so first match
 * them to cards a player showed. If you never showed down, fall back to the only player seated in
 * every hand where you were dealt cards and in none of the hands where you weren't.
 */
export function detectHero(hands: ImportedHand[]): string | null {
    const votes = new Map<string, number>();
    let in_every: Set<string> | undefined;
    const seated_without_cards = new Set<string>();
    let dealt = 0;
    for (const h of hands) {
        const seated = new Set(parseHand(h.messages).seats.map((p) => p.id));
        const your = h.messages.find((m) => m.startsWith("Your hand is"));
        if (!your) {
            for (const id of seated) seated_without_cards.add(id);
            continue;
        }
        dealt++;
        in_every = in_every ? new Set([...in_every].filter((id: string) => seated.has(id))) : seated;
        const mine = parseCards(your).map(code).sort().join(",");
        for (const m of h.messages) {
            const shown = m.match(/^"(.+?) @ ([^"]+)" shows a (.+?)\.?$/);
            if (shown && parseCards(shown[3]).map(code).sort().join(",") === mine) {
                votes.set(shown[2], (votes.get(shown[2]) ?? 0) + 1);
            }
        }
    }
    const by_showdown = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (by_showdown) return by_showdown;
    const by_seating = [...(in_every ?? [])].filter((id) => !seated_without_cards.has(id));
    return dealt >= 5 && by_seating.length === 1 ? by_seating[0] : null;
}

/** Hands in which the log shows your hole cards (0 when you weren't dealt in, e.g. spectating). */
export function handsDealtToYou(hands: ImportedHand[]): number {
    return hands.filter((h) => h.messages.some((m) => m.startsWith("Your hand is"))).length;
}

/** Sanity check used by tests and the importer: chips paid out equal chips put in. */
export function potBalances(messages: string[]): boolean {
    const s = parseHand(messages);
    const paid = s.seats.reduce((sum, p) => sum + p.collected, 0);
    return Math.abs(paid - s.pot) < 0.011;
}
