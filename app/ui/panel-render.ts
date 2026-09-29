// Draws a PanelModel as HTML + CSS. Pure (no DOM), so it runs and is tested in Node; the in-page host
// (puppeteer-service.ts) inserts the result. Every piece of text is escaped: player names come from logs.
import { PanelModel } from "./panel-model.ts";

export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Minimal version (replaced by the full design). */
export function renderPanel(model: PanelModel): { html: string, css: string } {
    const color = model.tone === "fold" ? "#ef4444" : model.tone === "check" ? "#eab308" : "#22c55e";
    const size = model.action.size_bb ? ` ${model.action.size_bb} BB` : "";
    const lines = [
        `<div class="pgpt-source">${escapeHtml(model.source.label)}${model.source.detail ? ` · ${escapeHtml(model.source.detail)}` : ""}</div>`,
        `<div class="pgpt-context">${escapeHtml(model.context)}</div>`,
        `<div class="pgpt-action" style="color:${color}">${escapeHtml(model.action.verb + size)}</div>`,
        ...model.reasoning.map((r) => `<div class="pgpt-why">${escapeHtml(r)}</div>`),
        ...model.warnings.map((w) => `<div class="pgpt-warn">${escapeHtml(w)}</div>`)
    ];
    return { html: `<div class="pgpt-panel pgpt-${model.tone}">${lines.join("")}</div>`, css: ".pgpt-panel{font-family:system-ui,sans-serif;color:#e5e7eb}" };
}
