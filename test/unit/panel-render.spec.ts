import { expect } from "chai";

import { OpponentCard, PanelModel } from "../../app/ui/panel-model.ts";
import { escapeHtml, renderPanel } from "../../app/ui/panel-render.ts";

const empty = (over: Partial<PanelModel> = {}): PanelModel => ({
    status: "final", tone: "check", source: { label: "Engine" }, context: "",
    action: { verb: "CHECK" }, reasoning: [], warnings: [],
    spot: { pot_bb: 0, to_call_bb: 0, pot_odds: 0, stack_bb: 0, effective_bb: 0, spr: 0, spr_label: "SPR", notes: [] },
    hand: { cards: [], board: [], made: "" }, odds: {}, options: [], opponents: [], more_opponents: 0, ...over
});

const opponent = (over: Partial<OpponentCard> = {}): OpponentCard => ({
    seat: "BU", name: "Villain", stack_bb: 80, type: "calling station", type_tone: "loose",
    hands: { before: 100, today: 5 }, range_pct: 40,
    stats: [
        { label: "Fold to c-bet", value: 0.3, n: 40, pool: 0.45, level: "low", hint: "you're betting: how often they fold" },
        { label: "VPIP", value: 0.45, n: 100, pool: 0.32, level: "high" },
        { label: "PFR", value: 0.18, n: 100, pool: 0.18, level: "normal" },
        { label: "3-bet", value: 0.05, n: 0, level: "unknown" }
    ],
    today: "Today VPIP 60% over 5 hands", flags: ["Looser than usual today"], last_showdown: "9c Kd after call, call",
    exploit: "Value bet thinner.", low_sample: false, to_act: true, ...over
});

const full = (over: Partial<PanelModel> = {}): PanelModel => empty({
    tone: "go", source: { label: "AI (test/model)", detail: "80% confident" }, context: "Hand #3 · Flop · you: BB",
    action: { verb: "BET", size_bb: 8, chips: 16, pot_share: 0.66 },
    tag: { text: "Semi-bluff · c-bet", kind: "semi-bluff" },
    reasoning: ["Main reason.", "Second reason."], warnings: ["Careful."],
    spot: { pot_bb: 12, to_call_bb: 0, pot_odds: 0, stack_bb: 90, effective_bb: 88, spr: 7.3, spr_label: "SPR", min_raise_bb: 2, max_raise_bb: 90, in_position: false, notes: ["Antes in play"] },
    hand: { cards: ["A♥", "5♥"], board: ["K♥", "9♥", "2♣"], made: "Ace high", draws: "Nut flush draw" },
    odds: { equity: 0.44, need: 0.3, equity_when_called: 0.37, chart_spot: "single raised pot" },
    options: [
        { label: "bet 8 BB", ev_bb: 4, chosen: true, fold_chance: 0.42, raise_chance: 0.08, kind: "semi-bluff" },
        { label: "check", ev_bb: 2, chosen: false },
        { label: "bet 12 BB", ev_bb: -1, chosen: false }
    ],
    opponents: [opponent()], more_opponents: 2, ...over
});

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("panel renderer", () => {
    it("colors the panel by the action: red to fold, yellow to check, green to play", () => {
        for (const tone of ["fold", "check", "go"] as const) {
            const { html } = renderPanel(full({ tone }));
            expect(html).to.match(new RegExp(`^<div class="pgpt-panel" data-tone="${tone}" data-status="final">`));
        }
        const { css } = renderPanel(full());
        expect(css).to.include(`.pgpt-panel[data-tone="fold"] { --pgpt-tone: #ef4444`);
        expect(css).to.include(`.pgpt-panel[data-tone="check"] { --pgpt-tone: #eab308`);
        expect(css).to.include(`.pgpt-panel[data-tone="go"] { --pgpt-tone: #22c55e`);
    });

    it("scopes every CSS rule under the panel's container", () => {
        const { css } = renderPanel(full());
        const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, "")
            .replace(/@media[^{]+\{/g, "").match(/[^{}]+(?=\{)/g)!;
        for (const group of selectors) {
            for (const sel of group.split(",")) expect(sel.trim()).to.match(/^#pokernow-gpt-suggestion(\.pgpt-[a-z-]+)? /, sel);
        }
    });

    it("escapes all text from the model (player names, AI output)", () => {
        const evil = `<img src=x onerror=alert(1)>`;
        const { html } = renderPanel(full({
            source: { label: evil, detail: `"q" & 'q'` }, context: evil, action: { verb: evil, size_bb: 2 },
            tag: { text: evil, kind: "bluff" }, reasoning: [evil, evil], warnings: [evil],
            hand: { cards: [evil], board: [], made: evil, draws: evil },
            odds: { equity: 0.5, chart_spot: evil },
            options: [{ label: evil, ev_bb: 1, chosen: true, kind: evil }],
            spot: { ...full().spot, spr_label: evil, notes: [evil] },
            opponents: [opponent({ seat: evil, name: evil, type: evil, today: evil, flags: [evil], last_showdown: `${evil} 9c`, exploit: evil,
                stats: [{ label: evil, value: 0.5, n: 3, level: "high", hint: evil }, { label: evil, value: 0.5, n: 3, level: "normal" }] })]
        }));
        expect(html).to.not.include("<img");
        // the only "onerror" left is inside escaped text
        expect(html.split("&lt;img src=x onerror=alert(1)&gt;").join("")).to.not.include("onerror");
        expect(html).to.include("&lt;img src=x onerror=alert(1)&gt;");
        expect(html).to.include("&quot;q&quot; &amp; &#39;q&#39;");
        expect(escapeHtml(`<a href="x">'&'</a>`)).to.equal("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    });

    it("never puts unexpected values into attributes or class names", () => {
        const { html } = renderPanel(full({ tone: `go" onmouseover="x` as any, status: `x"y` as any,
            tag: { text: "t", kind: `a"b` as any }, opponents: [opponent({ type_tone: `z" x="` as any, stats: [{ label: "s", value: 0.1, n: 1, level: `q"` as any }] })] }));
        expect(html).to.not.include(`onmouseover="x`);
        expect(html).to.include(`data-tone="go" data-status="final"`);
        expect(html).to.include(`data-kind="neutral"`);
        expect(html).to.include(`data-type-tone="unknown"`);
        expect(html).to.include(`pgpt-level-unknown`);
    });

    it("draws every section when there is data, in a fixed order", () => {
        const { html } = renderPanel(full());
        const order = [...html.matchAll(/data-section="([a-z]+)"/g)].map((m) => m[1]);
        expect(order).to.deep.equal(["opponents", "odds", "options", "hand", "spot"]);
        expect(count(html, `class="pgpt-section-title"`)).to.equal(5);
        expect(count(html, `class="pgpt-section-body"`)).to.equal(5);
        for (const part of ["pgpt-why-main", "pgpt-why-list", "pgpt-warnings", "pgpt-tag-semi-bluff", "pgpt-meter-need", "pgpt-exploit", "pgpt-flag", "pgpt-more", "pgpt-note"]) {
            expect(html).to.include(part);
        }
        expect(html).to.include("BET</span><span class=\"pgpt-size\">8 BB</span>");
        expect(html).to.include("= 16 chips · 66% of pot");
        expect(html).to.include("+2 more opponents in the hand");
    });

    it("leaves out sections and boxes that have no data", () => {
        const { html } = renderPanel(empty());
        expect(html).to.not.include("data-section=");
        expect(html).to.not.include("pgpt-warnings");
        expect(html).to.not.include("pgpt-tag");
        expect(html).to.not.include("pgpt-countdown");
        expect(html).to.not.include("pgpt-chips");
        expect(html).to.not.include("pgpt-context");
        expect(html).to.not.include("undefined");
        expect(html).to.not.include("NaN");
        // the Why box is always there, even without reasons
        expect(html).to.include(`class="pgpt-why"`);
        expect(html).to.include("No reasoning was given.");
        // only the parts with data
        expect(renderPanel(empty({ odds: { need: 0 } })).html).to.not.include("data-section=");
        const some = renderPanel(empty({ odds: { need: 0.3 }, hand: { cards: ["Ah", "Kd"], board: [], made: "" } })).html;
        expect([...some.matchAll(/data-section="([a-z]+)"/g)].map((m) => m[1])).to.deep.equal(["odds", "hand"]);
    });

    it("marks a thinking panel with a badge and a countdown bar", () => {
        const { html } = renderPanel(full({ status: "thinking", reasoning: [], thinking: { model: "m/x", budget_ms: 20000, started_at: 1700000000000 } }));
        expect(html).to.include(`data-status="thinking"`);
        expect(html).to.include("pgpt-badge-thinking");
        // the host animates the bar's width, inside a track that draws the background
        expect(html).to.include(`<div class="pgpt-countdown-track"><div class="pgpt-countdown" data-budget-ms="20000" data-started-at="1700000000000"></div></div>`);
        expect(html).to.include("up to 20s");
        expect(html).to.include("The AI is working on it.");
    });

    it("marks a stale panel as the previous turn, without a countdown", () => {
        const { html } = renderPanel(full({ status: "stale", thinking: { model: "m", budget_ms: 1000, started_at: 1 } }));
        expect(html).to.include(`data-status="stale"`);
        // labelled as the host expects, so it does not add a second label
        expect(html).to.include(`<span class="pgpt-status-badge pgpt-badge-stale pgpt-stale-banner">Previous turn</span>`);
        expect(html).to.not.include("pgpt-countdown");
    });

    it("scales option EV bars to the largest EV and highlights the chosen option", () => {
        const { html } = renderPanel(full());
        const widths = [...html.matchAll(/class="pgpt-ev-fill pgpt-ev-(pos|neg|zero)" style="width:([\d.]+)%"/g)].map((m) => [m[1], Number(m[2])]);
        expect(widths).to.deep.equal([["pos", 50], ["pos", 25], ["neg", 12.5]]);
        expect(count(html, "pgpt-option-chosen")).to.equal(1);
        expect(html).to.include(`<span class="pgpt-opt-ev pgpt-ev-pos">+4 BB</span>`);
        expect(html).to.include(`<span class="pgpt-opt-ev pgpt-ev-neg">-1 BB</span>`);
        expect(html).to.include("folds 42%");
        // all zero EVs draw no bars
        const zero = renderPanel(full({ options: [{ label: "fold", ev_bb: 0, chosen: true }] })).html;
        expect(zero).to.include(`pgpt-ev-zero" style="width:0.0%"`);
    });

    it("colors opponent stats by how they compare with the pool", () => {
        const { html } = renderPanel(full());
        expect(html).to.include(`pgpt-stat pgpt-stat-key pgpt-level-low" data-level="low"`);
        expect(html).to.include(`pgpt-stat pgpt-stat-tile pgpt-level-high" data-level="high"`);
        expect(html).to.include(`pgpt-stat pgpt-stat-tile pgpt-level-normal" data-level="normal"`);
        expect(html).to.include(`pgpt-stat pgpt-stat-tile pgpt-level-unknown" data-level="unknown"`);
        expect(html).to.include("n=40 · pool 45%");
        expect(html).to.include("no data yet");
        expect(html).to.include(`<span class="pgpt-type pgpt-type-loose" data-type-tone="loose">calling station</span>`);
        expect(html).to.include("Acts after you");
        expect(html).to.include("100 hands + 5 today");
        expect(html).to.include("range ~40%");
        // "Today" is the label, not repeated in the text
        expect(html).to.include(`<span class="pgpt-line-label">Today</span><span>VPIP 60% over 5 hands</span>`);
        expect(renderPanel(full({ opponents: [opponent({ low_sample: true })] })).html).to.include("Low sample");
    });

    it("draws cards as chips with red hearts and diamonds", () => {
        const { html } = renderPanel(full({ hand: { cards: ["Ah", "Td"], board: ["K♠", "2♣"], made: "Ace high" } }));
        expect(html).to.include(`<span class="pgpt-card pgpt-card-red">A<span class="pgpt-suit">♥</span></span>`);
        expect(html).to.include(`<span class="pgpt-card pgpt-card-red">10<span class="pgpt-suit">♦</span></span>`);
        expect(html).to.include(`<span class="pgpt-card">K<span class="pgpt-suit">♠</span></span>`);
        // cards inside the last showdown line too
        expect(html).to.include(`pgpt-card pgpt-card-inline">9<span class="pgpt-suit">♣</span>`);
    });

    it("has the elements the in-page host hooks into", () => {
        const { html } = renderPanel(full({ status: "thinking", thinking: { model: "m", budget_ms: 5000, started_at: 2 } }));
        for (const part of [`class="pgpt-top"`, `class="pgpt-header"`, `class="pgpt-controls"`, `data-pgpt-action="compact"`, `class="pgpt-banner"`,
            `class="pgpt-verb"`, `class="pgpt-body"`, `class="pgpt-why"`, `class="pgpt-countdown"`, `class="pgpt-countdown-text"`,
            `class="pgpt-section-title" role="button" tabindex="0" aria-expanded="true"`, `class="pgpt-chevron"`, `class="pgpt-section-summary"`,
            `class="pgpt-opponent pgpt-opp-loose" data-seat="BU"`]) {
            expect(html).to.include(part);
        }
        const { css } = renderPanel(full());
        expect(css).to.include(`#pokernow-gpt-suggestion .pgpt-collapsed > .pgpt-section-body { display: none; }`);
        expect(css).to.include(`#pokernow-gpt-suggestion.pgpt-compact .pgpt-section { display: none; }`);
        expect(css).to.include(`#pokernow-gpt-suggestion .pgpt-collapsible > .pgpt-section-title::after { content: none; }`);
        // sections are direct children the host can find, and none is named like the ones it never collapses
        expect(html).to.not.match(/data-section="(action|why)"/);
        expect(html).to.match(/<section class="pgpt-section" data-section="odds"><div class="pgpt-section-title"[^>]*>.*?<\/div><div class="pgpt-section-body">/);
        // the Why box and banner are never inside a collapsible section
        const why_at = html.indexOf(`class="pgpt-why"`);
        expect(why_at).to.be.lessThan(html.indexOf("data-section="));
        expect(html.indexOf(`class="pgpt-banner"`)).to.be.lessThan(why_at);
    });
});
