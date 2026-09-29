// Player metrics from every stored hand (imported logs and live play).
//   npm run players                      everyone, most hands first
//   npm run players -- <name or id>      one player: stats, game-by-game history, recent showdowns
//   npm run players -- link <a> <b>      treat two ids (or names) as the same person
//   npm run players -- unlink <id>       undo a link
import { DBService } from "../app/services/db-service.ts";
import { HandRecorder } from "../app/services/hand-recorder.ts";
import { ME, PlayerInfo, ProfileService } from "../app/services/profile-service.ts";
import { PlayerProfile, Rate } from "../app/engine/player-profile.ts";

const db = new DBService("./app/pokernow-gpt.db");
await db.init();
await db.createTables();
const recorder = new HandRecorder(db);
const service = new ProfileService(recorder);
const total = await service.load();
const [command, ...args] = process.argv.slice(2);

const pct = (r: Rate) => `${Math.round(r.value * 100)}%`.padStart(4);
const everyone = service.everyone().filter((e) => e.info.long);
const find = (query: string) => {
    const q = query.toLowerCase();
    return everyone.find((e) => e.key.toLowerCase() === q)
        ?? everyone.find((e) => e.info.long!.names.some((n) => n.toLowerCase() === q))
        ?? everyone.find((e) => e.info.long!.names.some((n) => n.toLowerCase().includes(q)));
};
const label = (key: string, p: PlayerProfile) => `${key === ME ? "YOU " : ""}${p.name}${p.names.length > 1 ? ` (aka ${p.names.slice(1).join(", ")})` : ""}`;

if (total === 0) {
    console.log("No hands stored yet. Import PokerNow logs with `npm run import -- <file or folder>`, or play with the bot running.");
} else if (command === "link" || command === "unlink") {
    const links = await recorder.links();
    if (command === "unlink") {
        await recorder.unlink(args[0]);
        console.log(`Unlinked ${args[0]}.`);
    } else {
        const [a, b] = args.map((x) => find(x));
        if (!a || !b) {
            console.log(`Couldn't find ${!a ? args[0] : args[1]}. Use a name or id from \`npm run players\`.`);
        } else {
            // every id of b's person joins a's person
            const target = a.key;
            const ids = [b.key, ...[...links.entries()].filter(([, person]) => person === b.key).map(([id]) => id)];
            for (const id of ids) await recorder.link(id, target, "linked by user");
            if (!links.has(a.key) && a.key !== ME) await recorder.link(a.key, target, "linked by user");
            console.log(`Linked ${b.info.long!.name} (${b.key}) to ${a.info.long!.name} (${a.key}).`);
        }
    }
} else if (command) {
    const e = find([command, ...args].join(" "));
    if (!e) {
        console.log(`No player matching "${command}".`);
    } else {
        const p = e.info.long!;
        const r = (x: Rate) => `${Math.round(x.value * 100)}% (${x.k}/${x.n})`;
        console.log(`${label(e.key, p)}  [${e.key}]  ${p.type}: ${p.exploit}`);
        console.log(`  ${p.hands} Hold'em hands, won ${p.net_bb >= 0 ? "+" : ""}${p.net_bb.toFixed(1)} BB (${p.bb_per_100.toFixed(1)} bb/100), last seen ${p.last_seen.slice(0, 10)}`);
        console.log(`  VPIP ${r(p.vpip)}, PFR ${r(p.pfr)}, limp ${r(p.limp)}, 3-bet ${r(p.three_bet)}, fold to 3-bet ${r(p.fold_to_three_bet)}`);
        console.log(`  steal ${r(p.steal)}, fold to steal ${r(p.fold_to_steal)}, c-bet ${r(p.cbet)}, fold to c-bet ${r(p.fold_to_cbet)}`);
        console.log(`  aggression ${r(p.aggression)}, went to showdown ${r(p.went_to_showdown)}, won at showdown ${r(p.won_at_showdown)}, avg bet ${Math.round(p.avg_bet_to_pot * 100)}% of pot`);
        console.log(`  VPIP by position: early ${r(p.vpip_by_position.early)}, middle ${r(p.vpip_by_position.middle)}, late ${r(p.vpip_by_position.late)}, blinds ${r(p.vpip_by_position.blinds)}`);
        console.log(`  Game by game (newest first):`);
        for (const g of service.gamesOf(e.key)) {
            const x = g.profile;
            console.log(`    ${g.first_at.slice(0, 10)} ${g.game_id}: ${x.hands} hands, VPIP ${pct(x.vpip)} PFR ${pct(x.pfr)} aggression ${pct(x.aggression)}, ${x.net_bb >= 0 ? "+" : ""}${x.net_bb.toFixed(1)} BB`);
        }
        if (p.showdowns.length) console.log(`  Recent showdowns:`);
        for (const s of p.showdowns.slice(0, 10)) {
            console.log(`    ${(s.at ?? "").slice(0, 10)} ${s.cards.join(" ")} (${s.hand_class}) on ${s.board.join(" ")}: ${s.line}${s.won ? " - won" : ""}`);
        }
    }
} else {
    console.log(`${everyone.length} player(s) from ${total} stored hand(s). Rates are blended toward population averages for small samples.\n`);
    console.log(`${"player".padEnd(34)} ${"hands".padStart(6)}  VPIP  PFR 3bet steal fCB  agg WTSD  ${"bb/100".padStart(7)}  type`);
    for (const e of everyone.sort((a, b) => b.info.long!.hands - a.info.long!.hands)) {
        const p = e.info.long!;
        console.log(`${label(e.key, p).slice(0, 34).padEnd(34)} ${String(p.hands).padStart(6)}  ${pct(p.vpip)} ${pct(p.pfr)} ${pct(p.three_bet)} ${pct(p.steal)}  ${pct(p.fold_to_cbet)} ${pct(p.aggression)} ${pct(p.went_to_showdown)}  ${p.bb_per_100.toFixed(1).padStart(7)}  ${p.type}`);
    }
    console.log(`\nDetails: npm run players -- <name>.  Same person on two ids: npm run players -- link <name-or-id> <name-or-id>`);
}
await db.close();
