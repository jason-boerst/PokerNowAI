// Draws a PanelModel as HTML + CSS. Pure (no DOM), so it runs and is tested in Node; the in-page host
// (puppeteer-service.ts) inserts the result. Every piece of text is escaped: player names come from logs.
//
// ---------------------------------------------------------------------------------------------------
// Markup contract with the in-page host (puppeteer-service.ts); keep both sides in sync
// ---------------------------------------------------------------------------------------------------
// Container: the host owns `#pokernow-gpt-suggestion` (position: fixed, width 384px, max-height
//   calc(100vh - 32px), overflow-y: auto, no background or padding) and sets data-tone, data-status
//   and the classes pgpt-compact, pgpt-flash, pgpt-dragging on it. It inserts `html` into it and puts
//   its own CSS, then `css`, into one <style>. All CSS here is scoped under `#pokernow-gpt-suggestion`.
// `.pgpt-panel`       root; draws the panel (background, border, radius). data-tone="fold|check|go"
//                     (red / yellow / green), data-status="thinking|final|stale" (the host rewrites
//                     data-status when the turn passes).
// `.pgpt-top`         header + action banner + countdown + tag; sticky at the top of the container's
//                     scroll, so the action stays in view. Never collapses.
// `.pgpt-header`      drag handle.
// `.pgpt-controls`    buttons, each with data-pgpt-action (the host never starts a drag on them):
//   `[data-pgpt-action="compact"]`  host toggles `pgpt-compact` on the container: every
//                     `.pgpt-section` is hidden; header, banner, tag, Why box and warnings stay.
// `.pgpt-banner`      the suggested action (`.pgpt-verb`, `.pgpt-size`, `.pgpt-chips`). Its status badge:
//                     "Thinking" while the AI works, and "Previous turn" (`.pgpt-stale-banner`, so the
//                     host does not add its own label) when stale.
// `.pgpt-countdown`   only while thinking: data-budget-ms, data-started-at (epoch ms). It is the fill
//                     bar inside `.pgpt-countdown-track`; the host animates its width 100% -> 0.
// `.pgpt-tag`         bet kind chip, data-kind="value|semi-bluff|bluff|neutral".
// `.pgpt-body`        everything below the top.
// `.pgpt-why`         reasoning box, always visible (not a section, never collapses).
// `.pgpt-warnings`    warning box (only when there are warnings).
// `.pgpt-section[data-section="opponents|odds|options|hand|spot"]` one card per analysis section,
//   children `.pgpt-section-title` (the collapse toggle) and `.pgpt-section-body`. The host adds
//   `pgpt-collapsible` and toggles `pgpt-collapsed` (it hides the body); this CSS draws the arrow
//   (`.pgpt-chevron`, the host's ::after arrow is turned off) and keeps `.pgpt-section-summary` in
//   the title so a collapsed section still says something. Sections with no data are left out.
// `.pgpt-opponent[data-seat]` one per opponent; `.pgpt-stat.pgpt-level-{high|low|normal|unknown}`.
// ---------------------------------------------------------------------------------------------------
import { OpponentCard, OpponentStat, PanelModel, PanelOption } from "./panel-model.ts";

export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Escapes anything (numbers, undefined) as text. */
const esc = (x: unknown): string => escapeHtml(x === undefined || x === null ? "" : String(x));

const finite = (x: number | undefined): x is number => typeof x === "number" && Number.isFinite(x);

/** Number with at most `max_decimals` decimals, trailing zeros dropped. */
function num(x: number | undefined, max_decimals = 2): string {
    if (!finite(x)) return "?";
    const f = 10 ** max_decimals;
    const r = Math.round(x * f) / f;
    return String(Object.is(r, -0) ? 0 : r);
}

/** Big blinds: 2 decimals under 10, 1 under 100, whole numbers above. */
function bbText(x: number | undefined): string {
    if (!finite(x)) return "?";
    const a = Math.abs(x);
    return num(x, a < 10 ? 2 : a < 100 ? 1 : 0);
}

function pct(x: number | undefined): string {
    return finite(x) ? `${Math.round(x * 100)}%` : "?";
}

/** 0-100 for inline widths, clamped, fixed format (no user text reaches a style attribute). */
function pctWidth(x: number): string {
    const v = finite(x) ? Math.max(0, Math.min(100, x)) : 0;
    return `${v.toFixed(1)}%`;
}

const SAFE_TOKEN = /^[a-z-]+$/;
/** Enum-ish values that go into attributes and class names (typed, but checked at runtime too). */
function token(x: string | undefined, fallback: string): string {
    return x && SAFE_TOKEN.test(x) ? x : fallback;
}

// ---------------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------------
const SUITS: Record<string, { symbol: string, red: boolean }> = {
    s: { symbol: "♠", red: false }, "♠": { symbol: "♠", red: false },
    c: { symbol: "♣", red: false }, "♣": { symbol: "♣", red: false },
    h: { symbol: "♥", red: true }, "♥": { symbol: "♥", red: true },
    d: { symbol: "♦", red: true }, "♦": { symbol: "♦", red: true }
};
const CARD = /^(10|[2-9TJQKA])([shdc♠♥♦♣])$/i;

/** A card like "A♥", "Kd" or "10s" as a chip; anything else as plain text. */
function cardChip(card: string, extra_class = ""): string {
    const m = CARD.exec(card.trim());
    if (!m) return `<span class="pgpt-card pgpt-card-unknown${extra_class}">${esc(card)}</span>`;
    const suit = SUITS[m[2].toLowerCase()] ?? SUITS[m[2]];
    const rank = m[1].toUpperCase() === "T" ? "10" : m[1].toUpperCase();
    return `<span class="pgpt-card${suit.red ? " pgpt-card-red" : ""}${extra_class}">${esc(rank)}<span class="pgpt-suit">${suit.symbol}</span></span>`;
}

/** Free text in which card tokens ("9c", "K♦") are drawn as small chips. */
function withCards(text: string): string {
    return text.split(/(\s+)/).map((part) => {
        const m = /^([(\[]?)((?:10|[2-9TJQKA])[shdc♠♥♦♣])([)\],.:;]?)$/i.exec(part);
        return m ? `${esc(m[1])}${cardChip(m[2], " pgpt-card-inline")}${esc(m[3])}` : esc(part);
    }).join("");
}

// ---------------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------------
function section(name: string, title: string, summary: string, body: string): string {
    return `<section class="pgpt-section" data-section="${name}">`
        + `<div class="pgpt-section-title" role="button" tabindex="0" aria-expanded="true">`
        + `<span class="pgpt-section-name">${esc(title)}</span>`
        + `<span class="pgpt-section-summary">${summary}</span>`
        + `<span class="pgpt-chevron" aria-hidden="true">▾</span></div>`
        + `<div class="pgpt-section-body">${body}</div></section>`;
}

function header(m: PanelModel): string {
    const detail = m.source.detail ? `<span class="pgpt-source-detail">${esc(m.source.detail)}</span>` : "";
    const context = m.context ? `<div class="pgpt-context">${esc(m.context)}</div>` : "";
    return `<div class="pgpt-header">`
        + `<div class="pgpt-header-main">`
        + `<div class="pgpt-source"><span class="pgpt-dot" aria-hidden="true"></span><span class="pgpt-source-label">${esc(m.source.label)}</span>${detail}</div>`
        + context
        + `</div>`
        + `<div class="pgpt-controls">`
        + `<button type="button" class="pgpt-btn" data-pgpt-action="compact" title="Compact view: action and reasons only" aria-label="Toggle compact view" aria-pressed="false">`
        + `<span class="pgpt-btn-icon" aria-hidden="true">▤</span></button>`
        + `</div></div>`;
}

const TONE_WORD: Record<string, string> = { fold: "Fold", check: "Check", go: "Play" };

function banner(m: PanelModel): string {
    const a = m.action;
    const size = finite(a.size_bb) && a.size_bb > 0 ? `<span class="pgpt-size">${esc(bbText(a.size_bb))} BB</span>` : "";
    const extras: string[] = [];
    if (finite(a.chips) && a.chips > 0) extras.push(`${esc(num(a.chips))} chips`);
    if (finite(a.pot_share) && a.pot_share > 0) extras.push(`${esc(pct(a.pot_share))} of pot`);
    const chips = extras.length ? `<div class="pgpt-chips">= ${extras.join(" · ")}</div>` : "";
    const badge = m.status === "thinking" ? `<span class="pgpt-status-badge pgpt-badge-thinking"><span class="pgpt-spinner" aria-hidden="true"></span>Thinking</span>`
        : m.status === "stale" ? `<span class="pgpt-status-badge pgpt-badge-stale pgpt-stale-banner">Previous turn</span>`
        : "";
    const label = m.status === "thinking" ? "Provisional pick" : m.status === "stale" ? "Was suggested" : "Suggested play";
    return `<div class="pgpt-banner" role="status" aria-live="polite">`
        + `<div class="pgpt-banner-top"><span class="pgpt-banner-label">${label}</span>${badge}</div>`
        + `<div class="pgpt-verb"><span class="pgpt-verb-text">${esc(a.verb)}</span>${size}</div>`
        + chips
        + `</div>`;
}

function countdown(m: PanelModel): string {
    const t = m.thinking;
    if (m.status !== "thinking" || !t) return "";
    const budget = finite(t.budget_ms) ? Math.max(0, Math.round(t.budget_ms)) : 0;
    const started = finite(t.started_at) ? Math.round(t.started_at) : 0;
    const secs = Math.round(budget / 1000);
    return `<div class="pgpt-countdown-box">`
        + `<div class="pgpt-countdown-row"><span class="pgpt-countdown-model">Asking ${esc(t.model)}</span>`
        + `<span class="pgpt-countdown-text">up to ${secs}s</span></div>`
        + `<div class="pgpt-countdown-track"><div class="pgpt-countdown" data-budget-ms="${budget}" data-started-at="${started}"></div></div></div>`;
}

function tag(m: PanelModel): string {
    if (!m.tag || !m.tag.text) return "";
    const kind = token(m.tag.kind, "neutral");
    return `<div class="pgpt-tag-row"><span class="pgpt-tag pgpt-tag-${kind}" data-kind="${kind}">${esc(m.tag.text)}</span></div>`;
}

function why(m: PanelModel): string {
    const lines = m.reasoning.map((r) => r.trim()).filter(Boolean);
    let body: string;
    if (!lines.length) {
        const placeholder = m.status === "thinking" ? "The AI is working on it. The engine's pick is shown meanwhile." : "No reasoning was given.";
        body = `<p class="pgpt-why-empty">${esc(placeholder)}</p>`;
    } else {
        body = `<p class="pgpt-why-main">${esc(lines[0])}</p>`
            + (lines.length > 1 ? `<ul class="pgpt-why-list">${lines.slice(1).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : "");
    }
    return `<div class="pgpt-why"><div class="pgpt-box-label">Why</div>${body}</div>`;
}

function warnings(m: PanelModel): string {
    const list = m.warnings.map((w) => w.trim()).filter(Boolean);
    if (!list.length) return "";
    return `<div class="pgpt-warnings" role="note"><span class="pgpt-warn-icon" aria-hidden="true">⚠</span>`
        + `<ul class="pgpt-warn-list">${list.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`;
}

// ---------------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------------
function statLevelMark(level: string): string {
    return level === "high" ? `<span class="pgpt-level-mark" title="Above your games' average">▲</span>`
        : level === "low" ? `<span class="pgpt-level-mark" title="Below your games' average">▼</span>` : "";
}

function statMeta(s: OpponentStat): string {
    const parts = [s.n > 0 ? `n=${esc(num(s.n, 0))}` : "no data yet"];
    if (finite(s.pool)) parts.push(`pool ${esc(pct(s.pool))}`);
    return parts.join(" · ");
}

/** A stat that matters for this decision (has a hint): full-width row with a bar and the pool mark. */
function keyStat(s: OpponentStat): string {
    const level = token(s.level, "unknown");
    const pool = finite(s.pool) ? `<span class="pgpt-stat-pool-mark" style="left:${pctWidth(s.pool * 100)}" title="Pool average"></span>` : "";
    return `<div class="pgpt-stat pgpt-stat-key pgpt-level-${level}" data-level="${level}">`
        + `<div class="pgpt-stat-key-text"><div class="pgpt-stat-label">${esc(s.label)}</div>`
        + `<div class="pgpt-stat-hint">${esc(s.hint)}</div></div>`
        + `<div class="pgpt-stat-key-value"><div class="pgpt-stat-value">${esc(pct(s.value))}${statLevelMark(level)}</div>`
        + `<div class="pgpt-stat-meta">${statMeta(s)}</div></div>`
        + `<div class="pgpt-stat-bar"><span class="pgpt-stat-bar-fill" style="width:${pctWidth(s.value * 100)}"></span>${pool}</div>`
        + `</div>`;
}

function tileStat(s: OpponentStat): string {
    const level = token(s.level, "unknown");
    return `<div class="pgpt-stat pgpt-stat-tile pgpt-level-${level}" data-level="${level}">`
        + `<div class="pgpt-stat-label">${esc(s.label)}</div>`
        + `<div class="pgpt-stat-value">${esc(pct(s.value))}${statLevelMark(level)}</div>`
        + `<div class="pgpt-stat-meta">${statMeta(s)}</div></div>`;
}

function handsText(h: { before: number, today: number }): string {
    const before = finite(h.before) ? h.before : 0, today = finite(h.today) ? h.today : 0;
    if (before <= 0 && today <= 0) return "no history";
    if (before <= 0) return `${num(today, 0)} hands today`;
    return `${num(before, 0)} hands${today > 0 ? ` + ${num(today, 0)} today` : ""}`;
}

function opponent(o: OpponentCard): string {
    const type_tone = token(o.type_tone, "unknown");
    const badges = [
        `<span class="pgpt-type pgpt-type-${type_tone}" data-type-tone="${type_tone}">${esc(o.type || "unknown")}</span>`,
        o.to_act ? `<span class="pgpt-badge pgpt-badge-act">Acts after you</span>` : "",
        o.low_sample ? `<span class="pgpt-badge pgpt-badge-low" title="Under 20 hands: mostly population defaults">Low sample</span>` : ""
    ].join("");
    const facts = [`<span>${esc(handsText(o.hands))}</span>`];
    if (finite(o.range_pct)) facts.push(`<span>range ~${esc(num(o.range_pct, 0))}%</span>`);
    const key = o.stats.filter((s) => s.hint);
    const tiles = o.stats.filter((s) => !s.hint);
    const stats = (key.length ? `<div class="pgpt-stat-keys">${key.map(keyStat).join("")}</div>` : "")
        + (tiles.length ? `<div class="pgpt-stat-grid">${tiles.map(tileStat).join("")}</div>` : "")
        + (!o.stats.length ? `<div class="pgpt-muted-line">No stats yet</div>` : "");
    const extra: string[] = [];
    const today = (o.today ?? "").replace(/^\s*today\b[:\s]*/i, "").trim();
    if (today) extra.push(`<div class="pgpt-opp-line"><span class="pgpt-line-label">Today</span><span>${esc(today)}</span></div>`);
    for (const f of o.flags.filter((x) => x && x.trim())) extra.push(`<div class="pgpt-flag"><span class="pgpt-flag-icon" aria-hidden="true">⚑</span><span>${esc(f)}</span></div>`);
    if (o.last_showdown) extra.push(`<div class="pgpt-opp-line"><span class="pgpt-line-label">Showed</span><span>${withCards(o.last_showdown)}</span></div>`);
    if (o.exploit) extra.push(`<div class="pgpt-exploit"><span class="pgpt-exploit-label">Exploit</span><span>${esc(o.exploit)}</span></div>`);
    return `<div class="pgpt-opponent pgpt-opp-${type_tone}" data-seat="${esc(o.seat)}">`
        + `<div class="pgpt-opp-head">`
        + `<span class="pgpt-seat">${esc(o.seat)}</span>`
        + `<span class="pgpt-opp-name" title="${esc(o.name)}">${esc(o.name)}</span>`
        + `<span class="pgpt-opp-stack">${esc(bbText(o.stack_bb))} BB</span></div>`
        + `<div class="pgpt-opp-badges">${badges}<span class="pgpt-opp-facts">${facts.join(`<span class="pgpt-sep">·</span>`)}</span></div>`
        + stats
        + (extra.length ? `<div class="pgpt-opp-extra">${extra.join("")}</div>` : "")
        + `</div>`;
}

function opponentsSection(m: PanelModel): string {
    const more = finite(m.more_opponents) && m.more_opponents > 0 ? m.more_opponents : 0;
    if (!m.opponents.length && !more) return "";
    const total = m.opponents.length + more;
    const body = m.opponents.map(opponent).join("")
        + (more ? `<div class="pgpt-more">+${esc(num(more, 0))} more opponent${more === 1 ? "" : "s"} in the hand</div>` : "");
    return section("opponents", `Opponents`, `${total} in hand`, body);
}

function oddsSection(m: PanelModel): string {
    const o = m.odds;
    if (!finite(o.equity) && !(finite(o.need) && o.need > 0) && !finite(o.equity_when_called) && !o.chart_spot) return "";
    const parts: string[] = [];
    let summary = "";
    if (finite(o.equity)) {
        const has_need = finite(o.need) && o.need > 0;
        const verdict = has_need ? (o.equity >= o.need! ? "enough" : "short") : "neutral";
        const need_mark = has_need
            ? `<span class="pgpt-meter-need" style="left:${pctWidth(o.need! * 100)}"><span class="pgpt-meter-need-label">need ${esc(pct(o.need))}</span></span>` : "";
        parts.push(`<div class="pgpt-odds-row"><span class="pgpt-odds-big pgpt-odds-${verdict}">${esc(pct(o.equity))}</span>`
            + `<span class="pgpt-odds-caption">equity vs their likely hands${has_need ? (verdict === "enough" ? ": enough to call" : ": not enough to call") : ""}</span></div>`
            + `<div class="pgpt-meter pgpt-meter-${verdict}" role="img" aria-label="Equity ${esc(pct(o.equity))}${has_need ? `, need ${esc(pct(o.need))}` : ""}">`
            + `<span class="pgpt-meter-fill" style="width:${pctWidth(o.equity * 100)}"></span>${need_mark}</div>`);
        summary = `${pct(o.equity)} equity${has_need ? ` / need ${pct(o.need)}` : ""}`;
    } else if (finite(o.need) && o.need > 0) {
        parts.push(`<div class="pgpt-kv"><span>Need to call</span><b>${esc(pct(o.need))}</b></div>`);
        summary = `need ${pct(o.need)}`;
    }
    if (finite(o.equity_when_called)) parts.push(`<div class="pgpt-kv"><span>Equity when a bet is called</span><b>${esc(pct(o.equity_when_called))}</b></div>`);
    if (o.chart_spot) {
        parts.push(`<div class="pgpt-kv"><span>Chart spot</span><b>${esc(o.chart_spot)}</b></div>`);
        if (!summary) summary = o.chart_spot;
    }
    return section("odds", "Odds", esc(summary), parts.join(""));
}

function optionRow(o: PanelOption, max: number): string {
    const ev = finite(o.ev_bb) ? o.ev_bb : 0;
    const half = max > 0 ? Math.abs(ev) / max * 50 : 0;
    const sign = ev > 0 ? "pos" : ev < 0 ? "neg" : "zero";
    const meta: string[] = [];
    if (o.kind) meta.push(`<span class="pgpt-opt-kind">${esc(o.kind)}</span>`);
    if (finite(o.fold_chance)) meta.push(`<span>folds ${esc(pct(o.fold_chance))}</span>`);
    if (finite(o.raise_chance)) meta.push(`<span>raised ${esc(pct(o.raise_chance))}</span>`);
    return `<div class="pgpt-option${o.chosen ? " pgpt-option-chosen" : ""}" data-chosen="${o.chosen ? "1" : "0"}">`
        + `<div class="pgpt-opt-head"><span class="pgpt-opt-mark" aria-hidden="true">${o.chosen ? "▶" : ""}</span>`
        + `<span class="pgpt-opt-label">${esc(o.label)}</span>`
        + `<span class="pgpt-opt-ev pgpt-ev-${sign}">${ev > 0 ? "+" : ""}${esc(num(ev, 1))} BB</span></div>`
        + (meta.length ? `<div class="pgpt-opt-meta">${meta.join(`<span class="pgpt-sep">·</span>`)}</div>` : "")
        + `<div class="pgpt-ev-track"><span class="pgpt-ev-axis"></span><span class="pgpt-ev-fill pgpt-ev-${sign}" style="width:${pctWidth(half)}"></span></div>`
        + `</div>`;
}

function optionsSection(m: PanelModel): string {
    if (!m.options.length) return "";
    const max = Math.max(0, ...m.options.map((o) => finite(o.ev_bb) ? Math.abs(o.ev_bb) : 0));
    const best = m.options.reduce((a, b) => (finite(b.ev_bb) ? b.ev_bb : -Infinity) > (finite(a.ev_bb) ? a.ev_bb : -Infinity) ? b : a);
    const summary = `best: ${esc(best.label)}`;
    return section("options", "Options (rough EV)", summary, `<div class="pgpt-options">${m.options.map((o) => optionRow(o, max)).join("")}</div>`);
}

function handSection(m: PanelModel): string {
    const h = m.hand;
    if (!h.cards.length && !h.board.length && !h.made && !h.draws) return "";
    const cards = h.cards.length ? `<div class="pgpt-cardset"><span class="pgpt-cardset-label">You</span><span class="pgpt-cards">${h.cards.map((c) => cardChip(c)).join("")}</span></div>` : "";
    const board = h.board.length ? `<div class="pgpt-cardset"><span class="pgpt-cardset-label">Board</span><span class="pgpt-cards">${h.board.map((c) => cardChip(c)).join("")}</span></div>` : "";
    const made = h.made ? `<div class="pgpt-made">${esc(h.made)}</div>` : "";
    const draws = h.draws ? `<div class="pgpt-draws"><span class="pgpt-line-label">Draw</span><span>${esc(h.draws)}</span></div>` : "";
    return section("hand", "Your hand", esc(h.made || h.cards.join(" ")), `<div class="pgpt-hand-row">${cards}${board}</div>${made}${draws}`);
}

function spotSection(m: PanelModel): string {
    const s = m.spot;
    const notes = s.notes.map((n) => n.trim()).filter(Boolean);
    // nothing known about the spot yet (e.g. a status-only panel)
    if (!(s.pot_bb > 0) && !(s.stack_bb > 0) && !notes.length) return "";
    const cells: [string, string, string?][] = [
        ["Pot", `${bbText(s.pot_bb)} BB`],
        s.to_call_bb > 0 ? ["To call", `${bbText(s.to_call_bb)} BB`, `${pct(s.pot_odds)} of final pot`] : ["To call", "nothing"],
        ["Your stack", `${bbText(s.stack_bb)} BB`],
        ["Effective", `${bbText(s.effective_bb)} BB`],
        [s.spr_label || "SPR", num(s.spr, 1)]
    ];
    if (finite(s.min_raise_bb) || finite(s.max_raise_bb)) cells.push(["Raise", `${finite(s.min_raise_bb) ? bbText(s.min_raise_bb) : "?"} to ${finite(s.max_raise_bb) ? bbText(s.max_raise_bb) : "?"} BB`]);
    if (s.in_position !== undefined) cells.push(["Position", s.in_position ? "in position" : "out of position"]);
    const grid = `<div class="pgpt-spot-grid">${cells.map(([k, v, sub]) => `<div class="pgpt-spot-cell"><div class="pgpt-spot-k">${esc(k)}</div>`
        + `<div class="pgpt-spot-v">${esc(v)}</div>${sub ? `<div class="pgpt-spot-sub">${esc(sub)}</div>` : ""}</div>`).join("")}</div>`;
    const notes_html = notes.length ? `<div class="pgpt-notes">${notes.map((n) => `<span class="pgpt-note">${esc(n)}</span>`).join("")}</div>` : "";
    const summary = `pot ${bbText(s.pot_bb)} BB${s.to_call_bb > 0 ? ` · call ${bbText(s.to_call_bb)}` : ""}`;
    return section("spot", "Spot", esc(summary), grid + notes_html);
}

// ---------------------------------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------------------------------
const R = "#pokernow-gpt-suggestion";

const CSS = `
${R} .pgpt-panel, ${R} .pgpt-panel *, ${R} .pgpt-panel *::before, ${R} .pgpt-panel *::after {
  box-sizing: border-box; margin: 0; padding: 0; border: 0; font: inherit; color: inherit;
  letter-spacing: normal; text-transform: none; text-shadow: none; line-height: inherit; background: none;
}
${R} .pgpt-panel {
  --pgpt-bg: #0d1512; --pgpt-card: #15201b; --pgpt-card-2: #1b2822; --pgpt-line: rgba(255,255,255,0.08);
  --pgpt-text: #eef2f0; --pgpt-muted: #9aa8a1; --pgpt-faint: #6f7d76;
  --pgpt-tone: #22c55e; --pgpt-tone-strong: #16a34a; --pgpt-tone-ink: #04200e; --pgpt-tone-soft: rgba(34,197,94,0.14);
  position: relative; display: block; width: 100%;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 13px; line-height: 1.4; color: var(--pgpt-text); text-align: left;
  background: var(--pgpt-bg); border: 2px solid var(--pgpt-tone); border-radius: 14px;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.6), 0 12px 40px rgba(0,0,0,0.55), 0 0 24px var(--pgpt-tone-soft);
  -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums;
}
${R} .pgpt-panel[data-tone="fold"] { --pgpt-tone: #ef4444; --pgpt-tone-strong: #dc2626; --pgpt-tone-ink: #ffffff; --pgpt-tone-soft: rgba(239,68,68,0.18); }
${R} .pgpt-panel[data-tone="check"] { --pgpt-tone: #eab308; --pgpt-tone-strong: #facc15; --pgpt-tone-ink: #1f1600; --pgpt-tone-soft: rgba(234,179,8,0.16); }
${R} .pgpt-panel[data-tone="go"] { --pgpt-tone: #22c55e; --pgpt-tone-strong: #22c55e; --pgpt-tone-ink: #03210d; --pgpt-tone-soft: rgba(34,197,94,0.16); }
${R} .pgpt-panel[data-status="stale"] { --pgpt-tone: #4b5563; --pgpt-tone-strong: #374151; --pgpt-tone-ink: #d1d5db; --pgpt-tone-soft: rgba(0,0,0,0); }

${R} .pgpt-top { position: sticky; top: 0; z-index: 2; padding-bottom: 10px; background: var(--pgpt-bg); border-radius: 12px 12px 0 0;
  border-bottom: 1px solid var(--pgpt-line); box-shadow: 0 6px 12px -8px rgba(0,0,0,0.8); }
${R} .pgpt-body { padding: 10px 10px 12px; display: flex; flex-direction: column; gap: 10px; }
${R} .pgpt-body > * { flex: none; }

/* header (drag handle) */
${R} .pgpt-header { display: flex; align-items: flex-start; gap: 8px; padding: 9px 10px 8px 12px; user-select: none;
  border-radius: 12px 12px 0 0; background: linear-gradient(180deg, var(--pgpt-tone-soft), rgba(0,0,0,0)); }
${R} .pgpt-header-main { flex: 1 1 auto; min-width: 0; }
${R} .pgpt-source { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; font-size: 12px; font-weight: 700; color: var(--pgpt-text); }
${R} .pgpt-source-label { overflow-wrap: anywhere; }
${R} .pgpt-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--pgpt-tone); flex: none; box-shadow: 0 0 0 3px var(--pgpt-tone-soft); }
${R} .pgpt-source-detail { font-size: 11px; font-weight: 600; color: var(--pgpt-muted); padding: 1px 7px; border-radius: 999px; background: rgba(255,255,255,0.07); }
${R} .pgpt-context { margin-top: 2px; font-size: 12px; color: var(--pgpt-muted); overflow-wrap: anywhere; }
${R} .pgpt-controls { display: flex; gap: 4px; flex: none; }
${R} .pgpt-btn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 7px; cursor: pointer;
  background: rgba(255,255,255,0.06); color: var(--pgpt-muted); font-size: 14px; line-height: 1; border: 1px solid var(--pgpt-line); }
${R} .pgpt-btn:hover, ${R} .pgpt-btn:focus-visible { background: rgba(255,255,255,0.14); color: var(--pgpt-text); outline: none; }
${R} .pgpt-btn[aria-pressed="true"] { color: var(--pgpt-tone); border-color: var(--pgpt-tone); }

/* action banner */
${R} .pgpt-banner { position: relative; overflow: hidden; margin: 0 10px; padding: 9px 14px 11px; border-radius: 10px;
  background: var(--pgpt-tone-strong); color: var(--pgpt-tone-ink);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.25), inset 0 -2px 0 rgba(0,0,0,0.18); }
${R} .pgpt-panel[data-tone="go"] .pgpt-banner { background: linear-gradient(180deg, #34d86a, #1fb953); }
${R} .pgpt-panel[data-tone="check"] .pgpt-banner { background: linear-gradient(180deg, #fad63b, #eab308); }
${R} .pgpt-panel[data-tone="fold"] .pgpt-banner { background: linear-gradient(180deg, #ef4444, #c81e1e); }
${R} .pgpt-panel[data-status="stale"] .pgpt-banner { background: #2b3330; color: #c3cbc7; box-shadow: none; }
${R} .pgpt-banner-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 18px; }
${R} .pgpt-banner-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.78; }
${R} .pgpt-verb { display: flex; align-items: baseline; flex-wrap: wrap; column-gap: 9px; margin-top: 1px;
  font-size: 28px; font-weight: 800; line-height: 1.1; letter-spacing: 0.01em; text-transform: uppercase; overflow-wrap: anywhere; }
${R} .pgpt-size { font-size: 28px; font-weight: 800; white-space: nowrap; }
${R} .pgpt-chips { margin-top: 3px; font-size: 13px; font-weight: 600; opacity: 0.85; }
${R} .pgpt-status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 800;
  text-transform: uppercase; letter-spacing: 0.06em; background: rgba(0,0,0,0.28); color: #fff; white-space: nowrap; }
${R} .pgpt-panel[data-tone="check"] .pgpt-badge-thinking, ${R} .pgpt-panel[data-tone="go"] .pgpt-badge-thinking { background: rgba(0,0,0,0.72); }
${R} .pgpt-status-badge.pgpt-stale-banner { display: inline-flex; margin: 0; padding: 2px 8px; border: 0; border-radius: 999px;
  background: #4b5563; color: #f3f4f6; font-size: 11px; letter-spacing: 0.06em; }
${R} .pgpt-status-badge.pgpt-stale-banner::before { content: none; }
${R} .pgpt-spinner { width: 9px; height: 9px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.35); border-top-color: #fff;
  animation: pgpt-spin 0.8s linear infinite; }
${R} .pgpt-panel[data-status="thinking"] .pgpt-banner::after { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(100deg, rgba(255,255,255,0) 20%, rgba(255,255,255,0.28) 50%, rgba(255,255,255,0) 80%);
  transform: translateX(-100%); animation: pgpt-shimmer 1.8s ease-in-out infinite; }
${R} .pgpt-panel[data-status="thinking"] { border-style: dashed; }

/* countdown */
${R} .pgpt-countdown-box { margin: 7px 10px 0; }
${R} .pgpt-countdown-row { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--pgpt-muted); margin-bottom: 3px; }
${R} .pgpt-countdown-model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
${R} .pgpt-countdown-text { font-weight: 700; color: var(--pgpt-text); white-space: nowrap; }
${R} .pgpt-countdown-track { height: 5px; border-radius: 3px; background: rgba(255,255,255,0.1); overflow: hidden; }
${R} .pgpt-countdown { height: 100%; width: 100%; border-radius: 3px; background: var(--pgpt-tone); }

/* tag chip */
${R} .pgpt-tag-row { margin: 8px 10px 0; }
${R} .pgpt-tag { display: inline-block; max-width: 100%; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 700;
  border: 1px solid currentColor; overflow-wrap: anywhere; }
${R} .pgpt-tag-value { color: #4ade80; background: rgba(34,197,94,0.12); }
${R} .pgpt-tag-semi-bluff { color: #fbbf24; background: rgba(245,158,11,0.13); }
${R} .pgpt-tag-bluff { color: #fb7185; background: rgba(244,63,94,0.13); }
${R} .pgpt-tag-neutral { color: #cbd5e1; background: rgba(148,163,184,0.12); }

/* why + warnings */
${R} .pgpt-box-label, ${R} .pgpt-section-name { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.09em; color: var(--pgpt-muted); }
${R} .pgpt-why { padding: 9px 12px 10px; border-radius: 10px; background: var(--pgpt-card); border: 1px solid var(--pgpt-line);
  border-left: 4px solid var(--pgpt-tone); }
${R} .pgpt-why .pgpt-box-label { margin-bottom: 4px; }
${R} .pgpt-why-main { font-size: 14px; font-weight: 700; line-height: 1.38; color: #fff; overflow-wrap: anywhere; }
${R} .pgpt-why-list { list-style: none; margin-top: 5px; display: flex; flex-direction: column; gap: 3px; }
${R} .pgpt-why-list li { position: relative; padding-left: 13px; font-size: 13px; color: #d7dfdb; overflow-wrap: anywhere; }
${R} .pgpt-why-list li::before { content: ""; position: absolute; left: 2px; top: 0.6em; width: 5px; height: 5px; border-radius: 50%; background: var(--pgpt-tone); }
${R} .pgpt-why-empty { font-size: 13px; color: var(--pgpt-muted); font-style: italic; }
${R} .pgpt-warnings { display: flex; gap: 9px; padding: 8px 11px; border-radius: 10px; background: rgba(245,158,11,0.12);
  border: 1px solid rgba(245,158,11,0.55); color: #fde68a; }
${R} .pgpt-warn-icon { flex: none; font-size: 15px; line-height: 1.2; color: #fbbf24; }
${R} .pgpt-warn-list { list-style: none; display: flex; flex-direction: column; gap: 3px; font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }

/* section cards */
${R} .pgpt-section { border-radius: 10px; background: var(--pgpt-card); border: 1px solid var(--pgpt-line); overflow: hidden; }
${R} .pgpt-section-title { display: flex; align-items: center; gap: 8px; padding: 7px 11px; user-select: none;
  background: rgba(255,255,255,0.03); border-bottom: 1px solid var(--pgpt-line); }
${R} .pgpt-collapsible > .pgpt-section-title { cursor: pointer; }
${R} .pgpt-collapsible > .pgpt-section-title:hover { background: rgba(255,255,255,0.07); }
${R} .pgpt-section-name { flex: none; color: #cfd8d3; }
${R} .pgpt-section-summary { flex: 1 1 auto; min-width: 0; text-align: right; font-size: 11px; color: var(--pgpt-faint);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
${R} .pgpt-chevron { display: none; flex: none; font-size: 11px; color: var(--pgpt-muted); transition: transform 0.15s ease; }
${R} .pgpt-collapsible > .pgpt-section-title::after { content: none; }
${R} .pgpt-collapsible > .pgpt-section-title > .pgpt-chevron { display: inline-block; }
${R} .pgpt-section-body { padding: 9px 11px 10px; }
${R} .pgpt-collapsed > .pgpt-section-body { display: none; }
${R} .pgpt-collapsed > .pgpt-section-title { border-bottom: 0; }
${R} .pgpt-collapsed .pgpt-chevron { transform: rotate(-90deg); }
${R} .pgpt-collapsed .pgpt-section-summary { color: var(--pgpt-text); }
${R}.pgpt-compact .pgpt-section { display: none; }
${R} .pgpt-sep { color: var(--pgpt-faint); margin: 0 5px; }
${R} .pgpt-line-label { flex: none; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; color: var(--pgpt-faint); margin-right: 7px; padding-top: 1px; }
${R} .pgpt-muted-line { font-size: 12px; color: var(--pgpt-faint); font-style: italic; }

/* opponents */
${R} .pgpt-opponent { padding: 10px 0 11px; border-top: 1px solid var(--pgpt-line); }
${R} .pgpt-opponent:first-child { padding-top: 1px; border-top: 0; }
${R} .pgpt-opponent:last-child { padding-bottom: 0; }
${R} .pgpt-opp-head { display: flex; align-items: center; gap: 8px; }
${R} .pgpt-seat { flex: none; min-width: 32px; padding: 2px 6px; border-radius: 6px; text-align: center; font-size: 11px; font-weight: 800;
  background: #e6ece9; color: #0d1512; letter-spacing: 0.02em; }
${R} .pgpt-opp-name { flex: 1 1 auto; min-width: 0; font-size: 15px; font-weight: 800; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
${R} .pgpt-opp-stack { flex: none; font-size: 13px; font-weight: 700; color: #d7dfdb; }
${R} .pgpt-opp-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 6px; }
${R} .pgpt-type, ${R} .pgpt-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 800; line-height: 1.35; }
${R} .pgpt-type { text-transform: uppercase; letter-spacing: 0.04em; border: 1px solid currentColor; overflow-wrap: anywhere; }
${R} .pgpt-type-loose { color: #fb923c; background: rgba(249,115,22,0.13); }
${R} .pgpt-type-tight { color: #60a5fa; background: rgba(59,130,246,0.13); }
${R} .pgpt-type-aggressive { color: #f472b6; background: rgba(236,72,153,0.13); }
${R} .pgpt-type-passive { color: #2dd4bf; background: rgba(20,184,166,0.13); }
${R} .pgpt-type-balanced { color: #c4b5fd; background: rgba(139,92,246,0.13); }
${R} .pgpt-type-unknown { color: #9ca3af; background: rgba(156,163,175,0.1); }
${R} .pgpt-badge-act { background: rgba(255,255,255,0.1); color: #e5e7eb; }
${R} .pgpt-badge-low { background: rgba(245,158,11,0.16); color: #fbbf24; }
${R} .pgpt-opp-facts { padding-left: 2px; font-size: 12px; color: var(--pgpt-muted); }
${R} .pgpt-stat-keys { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
${R} .pgpt-stat { --pgpt-level: #eef2f0; }
${R} .pgpt-level-high { --pgpt-level: #fb923c; }
${R} .pgpt-level-low { --pgpt-level: #60a5fa; }
${R} .pgpt-level-normal { --pgpt-level: #eef2f0; }
${R} .pgpt-level-unknown { --pgpt-level: #7d8a84; }
${R} .pgpt-stat-key { display: grid; grid-template-columns: 1fr auto; column-gap: 10px; row-gap: 5px; align-items: center;
  padding: 7px 9px 8px; border-radius: 8px; background: var(--pgpt-card-2); border: 1px solid var(--pgpt-line); border-left: 3px solid var(--pgpt-level); }
${R} .pgpt-stat-key-text { min-width: 0; }
${R} .pgpt-stat-key-value { text-align: right; }
${R} .pgpt-stat-label { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: #b9c5bf; overflow-wrap: anywhere; }
${R} .pgpt-stat-hint { margin-top: 1px; font-size: 12px; color: var(--pgpt-muted); overflow-wrap: anywhere; }
${R} .pgpt-stat-value { font-size: 22px; font-weight: 800; line-height: 1.1; color: var(--pgpt-level); white-space: nowrap; }
${R} .pgpt-stat-key .pgpt-stat-value { font-size: 24px; }
${R} .pgpt-level-mark { font-size: 11px; margin-left: 3px; vertical-align: 4px; }
${R} .pgpt-stat-meta { font-size: 11px; color: var(--pgpt-faint); white-space: nowrap; }
${R} .pgpt-level-unknown .pgpt-stat-value { font-weight: 700; }
${R} .pgpt-stat-bar { grid-column: 1 / -1; position: relative; height: 5px; border-radius: 3px; background: rgba(255,255,255,0.09); }
${R} .pgpt-stat-bar-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; background: var(--pgpt-level); opacity: 0.85; }
${R} .pgpt-stat-pool-mark { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: #fff; border-radius: 1px; box-shadow: 0 0 0 1px rgba(0,0,0,0.6); }
${R} .pgpt-stat-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-top: 6px; }
${R} .pgpt-stat-tile { padding: 6px 8px 7px; border-radius: 8px; background: var(--pgpt-card-2); border: 1px solid var(--pgpt-line); border-top: 3px solid var(--pgpt-level); min-width: 0; }
${R} .pgpt-stat-tile .pgpt-stat-label { font-size: 11px; }
${R} .pgpt-stat-tile .pgpt-stat-meta { white-space: normal; }
${R} .pgpt-opp-extra { display: flex; flex-direction: column; gap: 5px; margin-top: 8px; font-size: 12px; color: #d7dfdb; }
${R} .pgpt-opp-line { display: flex; align-items: flex-start; overflow-wrap: anywhere; }
${R} .pgpt-flag { display: flex; gap: 7px; padding: 4px 8px; border-radius: 7px; background: rgba(245,158,11,0.1); color: #fcd34d; font-weight: 600; overflow-wrap: anywhere; }
${R} .pgpt-flag-icon { flex: none; color: #fbbf24; }
${R} .pgpt-exploit { display: flex; align-items: flex-start; gap: 8px; padding: 6px 9px; border-radius: 7px; background: rgba(34,197,94,0.1);
  border: 1px solid rgba(34,197,94,0.35); color: #d1fae5; font-weight: 600; overflow-wrap: anywhere; }
${R} .pgpt-exploit-label { flex: none; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; color: #4ade80; padding-top: 1px; }
${R} .pgpt-more { margin-top: 2px; padding: 6px 9px; border-radius: 7px; border: 1px dashed rgba(255,255,255,0.18); text-align: center; font-size: 12px; font-weight: 700; color: var(--pgpt-muted); }

/* odds */
${R} .pgpt-odds-row { display: flex; align-items: baseline; gap: 9px; }
${R} .pgpt-odds-big { font-size: 26px; font-weight: 800; line-height: 1.1; }
${R} .pgpt-odds-enough { color: #4ade80; }
${R} .pgpt-odds-short { color: #f87171; }
${R} .pgpt-odds-neutral { color: #e5e7eb; }
${R} .pgpt-odds-caption { font-size: 12px; color: var(--pgpt-muted); }
${R} .pgpt-meter { position: relative; height: 10px; margin: 7px 0 20px; border-radius: 5px; background: rgba(255,255,255,0.09); }
${R} .pgpt-meter-neutral { margin-bottom: 8px; }
${R} .pgpt-meter-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 5px; background: #94a3b8; }
${R} .pgpt-meter-enough .pgpt-meter-fill { background: linear-gradient(90deg, #16a34a, #4ade80); }
${R} .pgpt-meter-short .pgpt-meter-fill { background: linear-gradient(90deg, #b91c1c, #f87171); }
${R} .pgpt-meter-need { position: absolute; top: -4px; bottom: -4px; width: 3px; margin-left: -1.5px; border-radius: 2px; background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,0.7); }
${R} .pgpt-meter-need-label { position: absolute; top: 17px; left: 50%; transform: translateX(-50%); font-size: 11px; font-weight: 700; color: #e5e7eb; white-space: nowrap; }
${R} .pgpt-kv { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; padding: 4px 0; font-size: 12px; color: var(--pgpt-muted); border-top: 1px solid var(--pgpt-line); }
${R} .pgpt-kv b { font-weight: 700; color: var(--pgpt-text); text-align: right; overflow-wrap: anywhere; }
${R} .pgpt-odds-row + .pgpt-meter + .pgpt-kv { border-top: 0; }

/* options */
${R} .pgpt-options { display: flex; flex-direction: column; gap: 4px; }
${R} .pgpt-option { padding: 6px 8px 7px; border-radius: 8px; border: 1px solid transparent; }
${R} .pgpt-option-chosen { background: var(--pgpt-tone-soft); border-color: var(--pgpt-tone); }
${R} .pgpt-opt-head { display: flex; align-items: baseline; gap: 6px; }
${R} .pgpt-opt-mark { flex: none; width: 10px; font-size: 11px; color: var(--pgpt-tone); }
${R} .pgpt-opt-label { flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: 700; overflow-wrap: anywhere; }
${R} .pgpt-option:not(.pgpt-option-chosen) .pgpt-opt-label { font-weight: 600; color: #d7dfdb; }
${R} .pgpt-opt-ev { flex: none; font-size: 13px; font-weight: 800; }
${R} .pgpt-ev-pos { color: #4ade80; }
${R} .pgpt-ev-neg { color: #f87171; }
${R} .pgpt-ev-zero { color: var(--pgpt-muted); }
${R} .pgpt-opt-meta { margin: 1px 0 0 16px; font-size: 11px; color: var(--pgpt-muted); }
${R} .pgpt-opt-kind { color: #cbd5e1; font-weight: 600; }
${R} .pgpt-ev-track { position: relative; height: 6px; margin: 5px 0 0 16px; border-radius: 3px; background: rgba(255,255,255,0.06); }
${R} .pgpt-ev-axis { position: absolute; left: 50%; top: -2px; bottom: -2px; width: 1px; background: rgba(255,255,255,0.35); }
${R} .pgpt-ev-fill { position: absolute; top: 0; bottom: 0; }
${R} .pgpt-ev-fill.pgpt-ev-pos { left: 50%; border-radius: 0 3px 3px 0; background: #22c55e; }
${R} .pgpt-ev-fill.pgpt-ev-neg { right: 50%; border-radius: 3px 0 0 3px; background: #ef4444; }
${R} .pgpt-ev-fill.pgpt-ev-zero { display: none; }

/* hand */
${R} .pgpt-hand-row { display: flex; flex-wrap: wrap; gap: 8px 16px; }
${R} .pgpt-cardset { display: flex; flex-direction: column; gap: 3px; }
${R} .pgpt-cardset-label { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; color: var(--pgpt-faint); }
${R} .pgpt-cards { display: flex; gap: 4px; }
${R} .pgpt-card { display: inline-flex; align-items: center; justify-content: center; gap: 1px; min-width: 30px; height: 38px; padding: 0 4px; border-radius: 5px;
  background: #f8fafc; color: #111827; font-size: 17px; font-weight: 800; line-height: 1; box-shadow: 0 1px 0 rgba(0,0,0,0.5), inset 0 -2px 0 rgba(0,0,0,0.08); }
${R} .pgpt-card-red { color: #dc2626; }
${R} .pgpt-suit { font-size: 15px; }
${R} .pgpt-card-inline { min-width: 0; height: 18px; padding: 0 3px; font-size: 12px; border-radius: 3px; vertical-align: 1px; margin: 0 1px; }
${R} .pgpt-card-inline .pgpt-suit { font-size: 11px; }
${R} .pgpt-card-unknown { color: #6b7280; }
${R} .pgpt-made { margin-top: 8px; font-size: 15px; font-weight: 800; color: #fff; overflow-wrap: anywhere; }
${R} .pgpt-draws { display: flex; align-items: flex-start; margin-top: 4px; font-size: 12px; color: #d7dfdb; overflow-wrap: anywhere; }

/* spot */
${R} .pgpt-spot-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
${R} .pgpt-spot-cell { padding: 5px 8px 6px; border-radius: 7px; background: var(--pgpt-card-2); min-width: 0; }
${R} .pgpt-spot-k { font-size: 11px; color: var(--pgpt-faint); overflow-wrap: anywhere; }
${R} .pgpt-spot-v { font-size: 14px; font-weight: 800; color: var(--pgpt-text); overflow-wrap: anywhere; }
${R} .pgpt-spot-sub { font-size: 11px; color: var(--pgpt-muted); }
${R} .pgpt-notes { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
${R} .pgpt-note { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; color: #c4b5fd; background: rgba(139,92,246,0.14); border: 1px solid rgba(139,92,246,0.4); overflow-wrap: anywhere; }

@keyframes pgpt-spin { to { transform: rotate(360deg); } }
@keyframes pgpt-shimmer { 0% { transform: translateX(-100%); } 60%, 100% { transform: translateX(100%); } }
@media (prefers-reduced-motion: reduce) {
  ${R} .pgpt-panel *, ${R} .pgpt-panel *::after { animation: none !important; }
}
`;

/** The panel as HTML (for `#pokernow-gpt-suggestion`) and its scoped CSS. See the contract at the top. */
export function renderPanel(model: PanelModel): { html: string, css: string } {
    const tone = token(model.tone, "go");
    const status = token(model.status, "final");
    const top = header(model) + banner(model) + countdown(model) + tag(model);
    const body = why(model) + warnings(model)
        + opponentsSection(model) + oddsSection(model) + optionsSection(model) + handSection(model) + spotSection(model);
    const html = `<div class="pgpt-panel" data-tone="${tone}" data-status="${status}">`
        + `<div class="pgpt-top">${top}</div>`
        + `<div class="pgpt-body">${body}</div></div>`;
    return { html, css: CSS };
}
