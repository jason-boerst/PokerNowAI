import { expect } from "chai";

import { heroView, parseHand } from "../../app/engine/hand-parser.ts";
import { PlayerProfile, PRIORS, Rate, RATE_KEYS, RateKey } from "../../app/engine/player-profile.ts";
import type { PlayerInfo } from "../../app/services/profile-service.ts";
import { selfStats } from "../../app/ui/self-stats.ts";
import { preflopOverlay } from "../../app/helpers/overlay-builder.ts";
import { renderPanel } from "../../app/ui/panel-render.ts";

const rate = (k: number, n: number): Rate => ({ k, n, value: n ? k / n : 0 });
const profile = (hands: number, rates: Partial<Record<RateKey, Rate>>, extra: Partial<PlayerProfile> = {}): PlayerProfile => {
    const all = {} as Record<RateKey, Rate>;
    for (const key of RATE_KEYS) all[key] = rates[key] ?? { k: 0, n: 0, value: PRIORS[key].mean };
    const flat = rate(0, 0);
    return {
        key: "me", name: "Me", names: ["Me"], hands, net_bb: 0, bb_per_100: 0, avg_bet_to_pot: 0, bets_seen: 0, ...all,
        vpip_by_position: { early: flat, middle: flat, late: flat, blinds: flat }, showdowns: [], last_seen: "",
        type: "regular", exploit: "No strong tendency yet.", ...extra
    };
};

describe("your own stats", () => {
    const long = profile(400, { vpip: rate(100, 400), pfr: rate(80, 400), cbet: rate(30, 50) }, { net_bb: 120, result_hands: 400 });
    const today = profile(40, { vpip: rate(20, 40), pfr: rate(4, 40) }, { net_bb: -20, result_hands: 40 });
    const info: PlayerInfo = { long, session: today, current: { ...long, type: "LAG", exploit: "Loose and aggressive: widen value ranges against them." }, deviations: [] };

    it("counts all your hands (earlier games plus today) together and today on its own, from raw counts", () => {
        const y = selfStats(info)!;
        expect(y.all.hands).to.equal(440);
        expect(y.today.hands).to.equal(40);
        const vpip = y.rows.find((r) => r.label === "VPIP")!;
        expect(vpip.all).to.deep.equal({ value: 120 / 440, n: 440 });
        expect(vpip.today).to.deep.equal({ value: 0.5, n: 40 });
        // a stat with no chances today has no today column
        expect(y.rows.find((r) => r.label === "C-bet")!.today).to.equal(undefined);
        expect(y.all.net_bb).to.equal(100);
        expect(y.all.bb_per_100).to.be.closeTo(100 / 440 * 100, 0.1);
        expect(y.today.bb_per_100).to.equal(-50);
        expect(y.type).to.equal("LAG");
        expect(y.counter).to.match(/Loose and aggressive/);
    });

    it("is empty with no history, and works with today's hands alone", () => {
        expect(selfStats({ deviations: [] })).to.equal(undefined);
        const first = selfStats({ session: today, current: today, deviations: [] })!;
        expect(first.all.hands).to.equal(40);
        expect(first.rows.find((r) => r.label === "PFR")!.all.value).to.equal(0.1);
    });

    it("shows as the last section of the panel, with all hands, today and the pool per stat", () => {
        const s = parseHand([
            `-- starting hand #1 (id: t)  No Limit Texas Hold'em (dealer: "V @ v") --`,
            `Player stacks: #1 "H @ h" (400) | #2 "V @ v" (400)`,
            `Your hand is 9h, 8h`,
            `"V @ v" posts a small blind of 1`, `"H @ h" posts a big blind of 2`, `"V @ v" raises to 6`
        ], { hero_name: "H" });
        const v = heroView(s)!;
        const model = preflopOverlay({ state: s, view: v, players: (ref) => (ref.name === "H" ? info : { deviations: [] }), stats: () => undefined },
            { action: "call", size_bb: 0, scenario: "test", reason: "Call." }, null);
        expect(model.you!.all.hands).to.equal(440);
        const { html } = renderPanel(model);
        const sections = [...html.matchAll(/data-section="(\w+)"/g)].map((m) => m[1]);
        expect(sections[sections.length - 1]).to.equal("you");
        expect(html).to.include("<th>All hands</th><th>Today</th><th>Pool</th>");
        expect(html).to.match(/<th>VPIP<\/th><td class="pgpt-level-\w+"><span class="pgpt-you-val">27%/);
        expect(html).to.include("+100 BB");
    });
});
