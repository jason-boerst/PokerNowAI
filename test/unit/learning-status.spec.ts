import { expect } from "chai";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendHistory, formatStatus, learningStatus, readHistory, snapshot } from "../../app/eval/learning-status.ts";
import { importLog } from "../../app/import/importer.ts";
import { DBService } from "../../app/services/db-service.ts";
import { HandRecorder } from "../../app/services/hand-recorder.ts";
import { ProfileService } from "../../app/services/profile-service.ts";

const FIXTURE_NAME = "poker_now_log_fixtureGame01.csv";
const FIXTURE = readFileSync(new URL(`../fixtures/${FIXTURE_NAME}`, import.meta.url), "utf8");

describe("learning status", () => {
    let db: DBService;
    let status: ReturnType<typeof learningStatus>;
    before(async () => {
        db = new DBService(":memory:");
        await db.init();
        await db.createTables();
        const recorder = new HandRecorder(db);
        await importLog(recorder, FIXTURE_NAME, FIXTURE);
        const profiles = new ProfileService(recorder);
        await profiles.load();
        status = learningStatus(profiles, await recorder.decisions());
    });
    after(async () => { await db.close(); });

    it("reports the data, the learned tables and every data-gated feature with where it stands", () => {
        expect(status.data.hands).to.be.greaterThan(0);
        expect(status.data.games).to.equal(1);
        expect(status.tables.map((t) => t.name)).to.include("Answers to post-flop bets");
        const names = status.features.map((f) => f.name);
        for (const n of ["Bluff correction", "Per-player bluffing", "Recency", "Learned constant", "AI check"]) expect(names.some((x) => x.startsWith(n))).to.equal(true, n);
        // one game: nothing can be checked on other games yet
        expect(status.features.find((f) => f.name.startsWith("Recency"))!.on).to.equal(false);
        expect(status.pool.find((p) => p.key === "vpip")!.built_in).to.equal(0.35);
        expect(formatStatus(status).join("\n")).to.match(/Features that switch on only when your hands support them/);
    });

    it("keeps a history of counts and switches, never names or ids", () => {
        const dir = mkdtempSync(join(tmpdir(), "learning-"));
        try {
            const file = join(dir, "reports", "history.jsonl");
            appendHistory(file, status);
            appendHistory(file, status);
            const rows = readHistory(file);
            expect(rows.length).to.equal(2);
            const text = JSON.stringify(snapshot(status));
            for (const r of status.regulars) {
                expect(text).to.not.include(r.name);
                expect(text).to.not.include(r.key);
            }
            expect(rows[0]).to.include({ hands: status.data.hands, games: 1 });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
