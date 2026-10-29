import { describe, expect, it } from "vitest";
import { renderReport } from "../server/report.js";
import { book, packet, priced } from "./domain-fixtures.js";
describe("portable human-readable report", () => {
  it("escapes untrusted text, rejects executable links, and renders unknown values", () => {
    const report = renderReport(
      packet({
        books: [
          book({
            title: "<script>alert(1)</script>",
            frame_ref: "javascript:alert(1)",
            notes: ["<img src=x onerror=alert(1)>"],
          }),
        ],
      }),
    );
    expect(report).not.toContain("<script>");
    expect(report).not.toContain('href="javascript:');
    expect(report).toContain("&lt;script&gt;");
    expect(report).toContain("Unknown");
    expect(report).toContain("Unpriced");
    expect(report).toContain("@media print");
  });
  it("contains source dates, condition, frame evidence, review flags, and cost/latency", () => {
    const report = renderReport(
      packet({
        books: [book({ replacement_cost: priced(12) })],
        review_queue: [{ ref_id: "b1", reason: "Review edition" }],
        metrics: [
          {
            stage: "finalization",
            started_at: "2026-10-29T10:02:00Z",
            duration_ms: 100,
            estimated_cost_usd: null,
          },
        ],
      }),
    );
    expect(report).toContain("https://example.com/book");
    expect(report).toContain("2026-10-29T10:00:00Z");
    expect(report).toContain("Condition: new");
    expect(report).toContain("/evidence/s1/frames/f1.jpg");
    expect(report).toContain("Review edition");
    expect(report).toContain("partial; some usage");
  });
});
