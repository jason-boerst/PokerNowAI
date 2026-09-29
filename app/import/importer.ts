import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { HandRecorder } from "../services/hand-recorder.ts";
import { ME } from "../services/profile-service.ts";
import { detectHero, gameIdFromFileName, handsDealtToYou, readLogRows, splitHands } from "./pokernow-csv.ts";

export interface ImportSummary {
    file_name: string,
    game_id: string,
    hands: number,
    added: number,
    already_had: number,
    incomplete: number,
    players: number,
    game_types: Record<string, number>,
    /** Your player id in this game, found from your hole cards (see detectHero). */
    you: string | null,
    /** Hands where the log shows your hole cards (0: you weren't dealt in). */
    dealt_to_you: number,
    /** First complete hand number in the file; above 1 means earlier hands aren't in this export. */
    first_hand: number | null,
    linked_ids: number
}

/** Imports one PokerNow log export (CSV text). Safe to repeat: hands already stored are skipped. */
export async function importLog(recorder: HandRecorder, file_name: string, csv_text: string): Promise<ImportSummary> {
    const rows = readLogRows(csv_text);
    const { hands, incomplete } = splitHands(rows);
    const game_id = gameIdFromFileName(path.basename(file_name))
        ?? `import-${createHash("sha1").update(rows.slice(0, 50).map((r) => r.entry + r.at).join("\n")).digest("hex").slice(0, 12)}`;
    const you = detectHero(hands);
    const result = await recorder.importHands(game_id, path.basename(file_name), hands, you);

    // identity links: your detected id(s), and PokerNow's "changed the ID" messages
    const links = await recorder.links();
    let linked = 0;
    if (you && links.get(you) !== ME) {
        await recorder.link(you, ME, "detected from your hole cards");
        linked++;
    }
    for (const r of rows) {
        const m = r.entry.match(/^The player "(.+?) @ ([^"]+)" changed the ID from (\S+) to (\S+?)[ .]/);
        if (!m) continue;
        const [old_id, new_id] = [m[3], m[4]];
        const person = links.get(new_id) ?? links.get(old_id) ?? new_id;
        for (const id of [old_id, new_id]) {
            if (links.get(id) !== person) {
                await recorder.link(id, person, `PokerNow ID change (${m[1]})`);
                links.set(id, person);
                linked++;
            }
        }
    }

    const players = new Set<string>();
    const game_types: Record<string, number> = {};
    for (const h of hands) {
        for (const m of h.messages[1]?.matchAll(/"(?:.+?) @ ([^"]+)"/g) ?? []) players.add(m[1]);
        const type = h.game_type || "unknown";
        game_types[type] = (game_types[type] ?? 0) + 1;
    }
    return {
        file_name: path.basename(file_name), game_id, hands: hands.length, added: result.added, already_had: result.already_had,
        incomplete, players: players.size, game_types, you, dealt_to_you: handsDealtToYou(hands),
        first_hand: hands[0]?.hand_number ?? null, linked_ids: linked
    };
}

/** PokerNow log files in a folder (or the file itself), for importing. */
export function findLogFiles(target: string): string[] {
    const stat = statSync(target);
    if (stat.isFile()) return [target];
    return readdirSync(target)
        .filter((f) => /^poker_now_log_.*\.csv$/i.test(f) || /\.csv$/i.test(f))
        .map((f) => path.join(target, f));
}

export async function importFiles(recorder: HandRecorder, targets: string[], log: (line: string) => void = console.log): Promise<ImportSummary[]> {
    const out: ImportSummary[] = [];
    for (const target of targets) {
        for (const file of findLogFiles(target)) {
            try {
                const summary = await importLog(recorder, file, readFileSync(file, "utf8"));
                out.push(summary);
                log(describeImport(summary));
            } catch (err) {
                log(`${path.basename(file)}: skipped (${err instanceof Error ? err.message : err})`);
            }
        }
    }
    return out;
}

export function describeImport(s: ImportSummary): string {
    const types = Object.entries(s.game_types).map(([t, n]) => `${n} ${t}`).join(", ");
    const missing = s.first_hand && s.first_hand > 1 ? `, starts at hand #${s.first_hand} (the export left out earlier hands)` : "";
    return `${s.file_name}: ${s.added} new hand(s)${s.already_had ? `, ${s.already_had} already imported` : ""} (${types}), ` +
        `${s.players} players${s.incomplete ? `, ${s.incomplete} incomplete hand(s) skipped` : ""}${missing}` +
        `${s.you ? `, you = ${s.you}` : s.dealt_to_you ? ", couldn't tell which player is you" : ", you weren't dealt in"}${s.linked_ids ? `, ${s.linked_ids} id link(s)` : ""}`;
}
