// Exports recorded hands and decisions to JSON (for regression tests, evals, or sharing).
//   npm run export-hands              -> hand-export.json with player names anonymized
//   npm run export-hands -- --keep-names
import { writeFileSync } from "node:fs";

import { DBService } from "../app/services/db-service.ts";
import { HandRecorder } from "../app/services/hand-recorder.ts";

const keep_names = process.argv.includes("--keep-names");
const out_file = process.argv.find((a) => a.endsWith(".json")) ?? "hand-export.json";

const db = new DBService("./app/pokernow-gpt.db");
await db.init();
await db.createTables();
const recorder = new HandRecorder(db);
const hands = await recorder.hands();
const decisions = await recorder.decisions();

// consistent pseudonyms across the whole export; the hero becomes "Hero"
const aliases = new Map<string, string>();
const alias = (name: string, hero_names: Set<string>) => {
    if (hero_names.has(name)) return "Hero";
    if (!aliases.has(name)) aliases.set(name, `P${aliases.size + 1}`);
    return aliases.get(name)!;
};
const hero_names = new Set([...hands.map((h) => h.hero_name), ...decisions.map((d) => d.hero_name)].filter((n): n is string => !!n));
const clean = (messages: string[]) => keep_names ? messages : messages.map((m) =>
    m.replace(/"(.+?) @ ([^"]+)"/g, (_all, name: string) => {
        const a = alias(name, hero_names);
        return `"${a} @ ${a.toLowerCase()}"`;
    }));

const out = {
    exported_at: new Date().toISOString(),
    anonymized: !keep_names,
    hands: hands.map((h) => ({
        game_id: keep_names ? h.game_id : "game",
        hand_number: h.hand_number,
        big_blind: h.big_blind,
        hero_net: h.hero_net,
        messages: clean(JSON.parse(h.messages_json))
    })),
    decisions: decisions.map((d) => ({
        id: d.id,
        hand_number: d.hand_number,
        street: d.street,
        hero_cards: d.hero_cards,
        big_blind: d.big_blind,
        model: d.model,
        source: d.source,
        latency_ms: d.latency_ms,
        action: JSON.parse(d.action_json ?? "null"),
        label: d.label,
        messages: clean(JSON.parse(d.messages_json)),
        response: d.response
    }))
};
writeFileSync(out_file, JSON.stringify(out, null, 2));
console.log(`Wrote ${out.hands.length} hands and ${out.decisions.length} decisions to ${out_file}${keep_names ? "" : " (player names anonymized)"}.`);
await db.close();
