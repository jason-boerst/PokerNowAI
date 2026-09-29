// Lists opponent profiles built from recorded hands, most-played first.
//   npm run players            (all players)
//   npm run players -- alice   (one player, with their recent showdowns)
import { DBService } from "../app/services/db-service.ts";
import { HandRecorder } from "../app/services/hand-recorder.ts";
import { ProfileService } from "../app/services/profile-service.ts";
import { describeProfile, PlayerProfile } from "../app/engine/player-profile.ts";

const db = new DBService("./app/pokernow-gpt.db");
await db.init();
await db.createTables();
const recorder = new HandRecorder(db);
const service = new ProfileService(recorder);
const n = await service.load();
const name = process.argv[2];

const show = (p: PlayerProfile, detail: boolean) => {
    console.log(`${describeProfile(p)}\n  -> ${p.exploit}`);
    if (!detail) return;
    const pct = (r: { value: number, k: number, n: number }) => `${Math.round(r.value * 100)}% (${r.k}/${r.n})`;
    console.log(`  limp ${pct(p.limp)}, fold to 3-bet ${pct(p.fold_to_three_bet)}, c-bet ${pct(p.cbet)}, won at showdown ${pct(p.won_at_showdown)}, avg bet ${Math.round(p.avg_bet_to_pot * 100)}% of pot (${p.bets_seen} bets)`);
    for (const s of p.showdowns) {
        console.log(`  hand ${s.hand_number}: showed ${s.cards.join(" ")} (${s.hand_class}) on ${s.board.join(" ")} after ${s.line}${s.won ? " - won" : ""}`);
    }
};

if (n === 0) {
    console.log("No recorded hands yet.");
} else if (name) {
    const p = service.profile(name);
    if (p) show(p, true); else console.log(`No player named "${name}" in ${n} recorded hand(s).`);
} else {
    const recorded_heroes = new Set((await recorder.hands()).map((h) => h.hero_name));
    const profiles = (await Promise.all([...new Set((await recorder.hands()).flatMap((h) =>
        [...JSON.parse(h.messages_json).join("\n").matchAll(/"(.+?) @ [^"]+"/g)].map((m) => m[1])))]
        .filter((player) => !recorded_heroes.has(player))
        .map((player) => service.profile(player)!)))
        .filter(Boolean)
        .sort((a, b) => b.hands - a.hands);
    console.log(`${profiles.length} opponent(s) from ${n} recorded hand(s). Stats are blended toward population averages until the sample is large; [n] = chances observed.\n`);
    profiles.forEach((p) => show(p, false));
}
await db.close();
