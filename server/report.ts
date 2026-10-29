import type { ClaimPacket, Price } from "../shared/types.js";
import { safeSourceUrl, validPrice, validItemPrice } from "./domain.js";
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
function link(url: string, label: string): string {
  const relative =
    /^(?:\/evidence\/|frames\/|sources\/|\.\/frames\/|\.\/sources\/)/.test(
      url,
    ) &&
    !/[<>"'\u0000-\u0020]/.test(url) &&
    !url.includes("..");
  return safeSourceUrl(url) || relative
    ? `<a href="${escapeHtml(url)}" rel="noreferrer noopener">${escapeHtml(label)}</a>`
    : escapeHtml(label || "Unknown");
}
const number = (v: number | null | undefined, unit = "") =>
  v === null || v === undefined
    ? '<span class="unknown">Unknown</span>'
    : `${escapeHtml(v.toLocaleString("en", { maximumFractionDigits: 4 }))}${unit ? ` ${escapeHtml(unit)}` : ""}`;
const money = (v: number | null | undefined, currency: string) =>
  v === null || v === undefined
    ? '<span class="unknown">Unpriced</span>'
    : `${escapeHtml(currency)} ${escapeHtml(v.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 3 }))}`;
function price(p: Price, currency: string): string {
  if (!validPrice(p, currency))
    return '<span class="unknown">Unpriced / evidence incomplete; excluded</span>';
  return `${money(p.amount, p.currency)}<small>${link(p.url, p.source)} · retrieved ${escapeHtml(p.retrieved_at)}<br>Condition: ${escapeHtml(p.condition_assumed)}${p.converted ? `<br>Converted from ${escapeHtml(p.original_currency)} ${escapeHtml(p.original_amount)} × ${escapeHtml(p.fx_rate)} (${link(p.fx_source || "", "FX source")})` : ""}${p.evidence_ref ? `<br>Saved evidence: ${link(p.evidence_ref, p.evidence_ref)}` : ""}</small>`;
}
export function renderReport(packet: ClaimPacket): string {
  const { sweep, room, totals } = packet;
  const bookRows = packet.books
    .map(
      (b) =>
        `<tr><td>${escapeHtml(b.id)}<small>${escapeHtml(b.shelf)} · #${b.position}<br>${link(b.frame_ref, "Open saved frame")}</small></td><td>${escapeHtml(b.title || "Unidentified book")}<small>${escapeHtml(b.author)}<br>${escapeHtml(b.publisher)} ${escapeHtml(b.edition)} ${escapeHtml(b.isbn)}<br>Visible text: ${escapeHtml(b.visible_text)}<br>${escapeHtml(b.notes.join("; "))}</small></td><td>${escapeHtml(b.status)}${b.excluded ? "<br>EXCLUDED" : ""}<small>Identification: ${number(b.id_confidence)}<br>${escapeHtml(b.rare_indicators.join("; "))}</small></td><td>${number(b.spine_height_cm, "cm")} × ${number(b.spine_thickness_cm, "cm")}<small>${escapeHtml(b.measurement_method)}</small></td><td>${price(b.replacement_cost, sweep.currency)}</td><td>${price(b.used_value, sweep.currency)}</td></tr>`,
    )
    .join("");
  const itemRows = packet.items
    .map(
      (i) =>
        `<tr><td>${escapeHtml(i.id)}<small>${link(i.frame_ref, "Open saved frame")}</small></td><td>${escapeHtml(i.category)}: ${escapeHtml(i.description)}<small>${escapeHtml(i.brand_model || "Brand/model unknown")}<br>Material: ${escapeHtml(i.material)}<br>${escapeHtml(i.notes.join("; "))}</small></td><td>${escapeHtml(i.status)}${i.excluded ? "<br>EXCLUDED" : ""}<small>Confidence: ${number(i.confidence)}</small></td><td>${number(i.dimensions_cm.w)} × ${number(i.dimensions_cm.h)} × ${number(i.dimensions_cm.d)} cm</td><td>${validItemPrice(i, sweep.currency) ? `${money(i.replacement_cost.low, sweep.currency)} – ${money(i.replacement_cost.high, sweep.currency)}<small>${link(i.replacement_cost.url, i.replacement_cost.source)} · retrieved ${escapeHtml(i.replacement_cost.retrieved_at)}<br>${i.replacement_cost.evidence_ref ? link(i.replacement_cost.evidence_ref, "Saved price evidence") : ""}</small>` : '<span class="unknown">Unpriced / excluded</span>'}</td></tr>`,
    )
    .join("");
  const metrics = packet.metrics || [];
  const knownCost = metrics
    .filter((m) => m.estimated_cost_usd !== null)
    .reduce((s, m) => s + m.estimated_cost_usd!, 0);
  const comparison = packet.locale_comparison;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Library claim ${escapeHtml(sweep.id)}</title><style>
  *{box-sizing:border-box}body{font:14px/1.5 system-ui,sans-serif;color:#182327;margin:0;background:#f4f6f5}main{max-width:1300px;margin:auto;padding:32px;background:white}h1{font-size:30px;margin:0 0 8px}h2{margin-top:30px}small{display:block;font-size:11px;color:#526066;max-width:350px;overflow-wrap:anywhere}a{color:#087064}table{width:100%;border-collapse:collapse;margin:12px 0;font-size:12px}th,td{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid #dbe3e1}th{background:#edf2f0}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.card{padding:14px;border:1px solid #dbe3e1;border-radius:6px}.card strong{display:block;font-size:20px}.unknown{color:#875900}.notice{padding:14px;background:#fff8e7;border-left:3px solid #b77c1a}ul{padding-left:20px}button{padding:8px 16px;float:right}code{overflow-wrap:anywhere}@media(max-width:700px){main{padding:16px}.scroll{overflow:auto}table{min-width:750px}}@media print{body,main{background:white;padding:0}button{display:none}h2{break-after:avoid}tr{break-inside:avoid}.scroll{overflow:visible}a{color:inherit}.card{border:1px solid #aaa}table{min-width:0;font-size:9px}small{font-size:8px}th,td{padding:5px}}
  </style></head><body><main><button onclick="window.print()">Print / Save PDF</button><h1>Library contents claim packet</h1><p>Sweep <code>${escapeHtml(sweep.id)}</code> · ${escapeHtml(sweep.captured_at)} · ${escapeHtml(sweep.country)} / ${escapeHtml(sweep.currency)}<br>Device: ${escapeHtml(sweep.device)} · Capture duration: ${number(sweep.duration_s, "s")}</p>
  <p class="notice">${totals.valuation_partial ? "Valuation is partial: unknown, excluded, and appraisal lines do not contribute money. " : ""}${totals.shelf_run_partial ? "Shelf run is a partial sum of measured spines. " : ""}Counts describe captured evidence; complete room coverage and accuracy require ground-truth evaluation. This packet records evidence and estimates for human review.</p>
  <div class="summary"><div class="card">Books<strong>${totals.book_count}</strong>${totals.books_identified} identified · ${totals.books_unidentified} unidentified</div><div class="card">Books replacement<strong>${money(totals.books_replacement_cost, sweep.currency)}</strong>Used: ${money(totals.books_used_value, sweep.currency)}</div><div class="card">Other contents replacement<strong>${money(totals.items_replacement_cost_low, sweep.currency)} – ${money(totals.items_replacement_cost_high, sweep.currency)}</strong></div><div class="card">Shelf run<strong>${number(totals.shelf_run_m, "m")}${totals.shelf_run_partial ? " (partial)" : ""}</strong>${totals.excluded_from_totals} lines missing at least one value or excluded</div></div>
  <h2>Room measurements</h2><p>Shape: ${escapeHtml(room.shape || "Unknown")}<br>Length × width × height: ${number(room.length_m)} × ${number(room.width_m)} × ${number(room.height_m)} m<br>Floor: ${number(room.floor_area_m2, "m²")} / ${number(room.floor_area_sqft, "ft²")}<br>Total walls: ${number(room.wall_area_m2, "m²")} / ${number(room.wall_area_sqft, "ft²")}<br>Wall area covered by shelving: ${number(room.shelved_wall_area_m2, "m²")}<br>Metric scale: ${escapeHtml(room.scale_method || "Unknown")}<br>Confidence: ${number(room.confidence)}</p><p>${room.evidence_refs.map((r) => link(r, "Room evidence frame")).join(" · ")}</p><ul>${room.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>
  <h2>Books</h2><div class="scroll"><table><thead><tr><th>Evidence</th><th>Spine identity</th><th>Status</th><th>Height × thickness</th><th>Replacement</th><th>Used</th></tr></thead><tbody>${bookRows || '<tr><td colspan="6">No books recorded.</td></tr>'}</tbody></table></div>
  <h2>Other contents</h2><div class="scroll"><table><thead><tr><th>Evidence</th><th>Visible attributes</th><th>Status</th><th>W × H × D</th><th>Replacement range</th></tr></thead><tbody>${itemRows || '<tr><td colspan="5">No non-book items recorded.</td></tr>'}</tbody></table></div>
  <h2>Review queue (${packet.review_queue.length})</h2><ul>${packet.review_queue.map((r) => `<li><strong>${escapeHtml(r.ref_id)}</strong>: ${escapeHtml(r.reason)}</li>`).join("") || "<li>No automatic flags.</li>"}</ul>
  <h2>Stage latency and estimated API cost</h2><p>Known stage cost: USD ${knownCost.toFixed(6)}${metrics.some((m) => m.estimated_cost_usd === null) ? " (partial; some usage has no configured rate)" : ""}. Cost estimates are not invoices.</p><table><thead><tr><th>Stage / model</th><th>Started</th><th>Latency</th><th>Tokens in / out</th><th>Estimated USD</th></tr></thead><tbody>${metrics.map((m) => `<tr><td>${escapeHtml(m.stage)}<small>${escapeHtml(m.model)} ${escapeHtml(m.notes)}</small></td><td>${escapeHtml(m.started_at)}</td><td>${number(m.duration_ms, "ms")}</td><td>${number(m.input_tokens)} / ${number(m.output_tokens)}</td><td>${number(m.estimated_cost_usd)}</td></tr>`).join("")}</tbody></table>
  ${comparison ? `<h2>Same books in ${escapeHtml(comparison.country)} / ${escapeHtml(comparison.currency)}</h2><p>Retrieved ${escapeHtml(comparison.generated_at)}. ${escapeHtml(comparison.notes.join(" "))}</p><table><thead><tr><th>Book / ID</th><th>Replacement</th><th>Used</th></tr></thead><tbody>${comparison.books.map((b) => `<tr><td>${escapeHtml(b.title)}<small>${escapeHtml(b.id)}</small></td><td>${price(b.replacement_cost, comparison.currency)}</td><td>${price(b.used_value, comparison.currency)}</td></tr>`).join("")}</tbody></table>` : ""}
  <p>Totals are computed from eligible lines in code using currency minor units. Saved frames and source snapshots accompany the evidence ZIP. Missing evidence is reported as unknown.</p></main></body></html>`;
}
