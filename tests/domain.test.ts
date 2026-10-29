import { describe, expect, it } from "vitest";
import {
  buildPacket,
  buildReviewQueue,
  computeTotals,
  toMinorUnits,
  validPrice,
} from "../server/domain.js";
import { book, item, priced, state } from "./domain-fixtures.js";

describe("deterministic claim totals and review", () => {
  it("exports unpriced contents using the required status enum without claiming art or rarity", () => {
    const internal = state({
      items: [
        item({
          category: "chair",
          description: "Wooden chair",
          status: "unpriced",
        }),
      ],
    });
    const packet = buildPacket(internal);
    expect(packet.items[0].status).toBe("needs_appraisal");
    expect(packet.items[0].replacement_cost.low).toBeNull();
    expect(packet.items[0].notes.join(" ")).toContain(
      "human valuation required",
    );
    expect(
      packet.review_queue.some((q) =>
        q.reason.includes("ask whether it is a print"),
      ),
    ).toBe(false);
    expect(internal.items[0].status).toBe("unpriced");
  });
  it("sums currency minor units, rounds decimal ties, and handles zero/three-digit currencies", () => {
    expect(toMinorUnits(1.005, 2)).toBe(101n);
    const books = [
      book({ replacement_cost: priced(0.1), used_value: priced(0.2) }),
      book({
        id: "b2",
        replacement_cost: priced(0.2),
        used_value: priced(0.1),
      }),
    ];
    expect(computeTotals(books, []).books_replacement_cost).toBe(0.3);
    expect(
      computeTotals(
        [book({ replacement_cost: priced(10.5, { currency: "JPY" }) })],
        [],
        "JPY",
      ).books_replacement_cost,
    ).toBe(11);
    expect(
      computeTotals(
        [book({ replacement_cost: priced(1.2345, { currency: "KWD" }) })],
        [],
        "KWD",
      ).books_replacement_cost,
    ).toBe(1.235);
  });
  it("excludes rare, unsigned provenance, unidentified, wrong-currency, and explicitly excluded prices", () => {
    const books = [
      book({
        id: "valid",
        replacement_cost: priced(20),
        used_value: priced(8),
        spine_thickness_cm: 2,
      }),
      book({
        id: "rare",
        rare_indicators: ["signed"],
        replacement_cost: priced(100),
      }),
      book({
        id: "unknown",
        status: "unidentified",
        replacement_cost: priced(40),
      }),
      book({ id: "bad", replacement_cost: priced(30, { evidence_ref: "" }) }),
      book({
        id: "foreign",
        replacement_cost: priced(80, { currency: "GBP" }),
      }),
      book({ id: "excluded", excluded: true, replacement_cost: priced(70) }),
    ];
    const totals = computeTotals(books, [], "USD");
    expect(totals.books_replacement_cost).toBe(20);
    expect(totals.books_used_value).toBe(8);
    expect(totals.book_count).toBe(5);
    expect(totals.excluded_from_totals).toBe(5);
    expect(totals.shelf_run_m).toBe(0.02);
    expect(totals.shelf_run_partial).toBe(true);
    expect(totals.valuation_partial).toBe(true);
  });
  it("rejects prices without conditions, dates, source provenance, and verified conversion metadata", () => {
    for (const override of [
      { amount: NaN },
      { amount: -1 },
      { url: "javascript:alert(1)" },
      { condition_assumed: "" },
      { retrieved_at: "" },
      { converted: true },
    ])
      expect(validPrice(priced(20, override))).toBe(false);
    expect(
      validPrice(
        priced(20, {
          converted: true,
          original_amount: 10,
          original_currency: "GBP",
          fx_rate: 2,
          fx_source: "https://example.com/fx",
        }),
      ),
    ).toBe(true);
  });
  it("defaults art to appraisal, excludes amounts, and retains original state for audit", () => {
    const original = state({
      books: [
        book({
          rare_indicators: ["first edition"],
          replacement_cost: priced(100),
        }),
      ],
      items: [
        item({
          category: "portrait",
          status: "priced",
          replacement_cost: {
            low: 100,
            high: 100,
            source: "Test source",
            url: "https://example.com/art",
            retrieved_at: "2026-10-29",
            currency: "USD",
            evidence_ref: "sources/art.json",
          },
        }),
      ],
    });
    const result = buildPacket(original);
    expect(result.books[0]?.status).toBe("needs_appraisal");
    expect(result.books[0]?.replacement_cost.amount).toBeNull();
    expect(result.items[0]?.status).toBe("needs_appraisal");
    expect(result.totals.items_replacement_cost_low).toBe(0);
    expect(result.sweep.duration_s).toBe(120);
    expect(original.books[0]?.replacement_cost.amount).toBe(100);
  });
  it("queues every unknown measurement, missing frame, price, stage failure, and low confidence", () => {
    const q = buildReviewQueue(
      state({
        books: [book({ frame_ref: "/missing.jpg", id_confidence: 0.5 })],
        errors: ["pricing timed out"],
        frames: [],
      }),
    );
    expect(q.some((x) => x.reason.includes("frame is missing"))).toBe(true);
    expect(q.some((x) => x.reason.includes("dimensions unavailable"))).toBe(
      true,
    );
    expect(q.some((x) => x.reason.includes("pricing timed out"))).toBe(true);
    expect(q.filter((x) => x.ref_id === "room")).toHaveLength(3);
  });
});
