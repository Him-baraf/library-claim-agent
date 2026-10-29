import { describe, expect, it } from "vitest";
import {
  evaluate,
  type GroundTruth,
  type TruthBook,
} from "../scripts/evaluate.js";
import { book, packet, priced } from "./domain-fixtures.js";
const truthBook = (override: Partial<TruthBook> = {}): TruthBook => ({
  truth_id: "t1",
  shelf: "s1",
  system_id: "b1",
  title: "Test title",
  author: "Test author",
  human_legible: true,
  spine_height_cm: null,
  spine_thickness_cm: null,
  price_check: null,
  ...override,
});
const truth = (override: Partial<GroundTruth> = {}): GroundTruth => ({
  sweep_id: "s1",
  collected_at: "2026-10-29T09:00:00Z",
  collected_before_tuning: true,
  true_book_count: 1,
  shelving_units: 2,
  enclosed_rooms: 1,
  books: [truthBook()],
  items: [],
  room: {
    length_m: 4,
    width_m: 3,
    height_m: 2.5,
    floor_area_m2: 12,
    wall_area_m2: 35,
    source: "Tape measurement before capture",
  },
  notes: [],
  ...override,
});
describe("honest complete-run evaluation", () => {
  it("scores missing legible spines in the denominator and confident false positives as wrong", () => {
    const p = packet({
      books: [book(), book({ id: "false-positive", title: "Imaginary title" })],
    });
    const t = truth({
      true_book_count: 2,
      books: [truthBook(), truthBook({ truth_id: "t2", system_id: null })],
    });
    const r = evaluate(p, t);
    expect(
      r.results.find((r) => r.measure === "title_identification_recall")
        ?.actual,
    ).toBe(0.5);
    expect(
      r.results.find((r) => r.measure === "confidently_wrong_rate")?.actual,
    ).toBe(0.5);
    expect(
      r.results.find((r) => r.measure === "confidently_wrong_rate")?.pass,
    ).toBe(false);
  });
  it("does not pass missing sample sizes or zero confident predictions", () => {
    const r = evaluate(packet(), truth());
    expect(
      r.results.find(
        (r) => r.measure === "spine_dimensions_mean_relative_error",
      )?.pass,
    ).toBeNull();
    expect(
      r.results.find((r) => r.measure === "book_prices_mean_relative_error")
        ?.pass,
    ).toBeNull();
    expect(
      r.results.find((r) => r.measure === "confidently_wrong_rate")?.pass,
    ).toBeNull();
    expect(
      r.results.find((r) => r.measure === "floor_area_m2_relative_error")?.pass,
    ).toBe(false);
    expect(r.dataset_eligible).toBe(false);
  });
  it("requires all true books and one-to-one explicit matching", () => {
    expect(() => evaluate(packet(), truth({ true_book_count: 60 }))).toThrow(
      /every true book/,
    );
    expect(() =>
      evaluate(
        packet(),
        truth({
          true_book_count: 2,
          books: [truthBook(), truthBook({ truth_id: "t2" })],
        }),
      ),
    ).toThrow(/more than one/);
  });
  it("evaluates every sampled dimension/price and fails missing or noncomparable predictions", () => {
    const books = Array.from({ length: 60 }, (_, i) =>
      book({
        id: `b${i}`,
        spine_height_cm: 20,
        spine_thickness_cm: 2,
        replacement_cost: priced(10),
      }),
    );
    const truths = books.map((b, i) =>
      truthBook({
        truth_id: `t${i}`,
        system_id: b.id,
        spine_height_cm: i < 20 ? 20 : null,
        spine_thickness_cm: i < 20 ? 2 : null,
        price_check:
          i < 15
            ? {
                kind: "replacement",
                amount: 10,
                currency: "USD",
                source_url: "https://example.com/book",
                source_type: "local retail listing",
                retrieved_at: "2026-10-29",
                condition: "new",
              }
            : null,
      }),
    );
    const t = truth({
      true_book_count: 60,
      books: truths,
      items: Array.from({ length: 8 }, (_, i) => ({
        truth_id: `i${i}`,
        system_id: null,
        category: "lamp",
      })),
    });
    const p = packet({
      books,
      metrics: [
        {
          stage: "finalization",
          duration_ms: 299999,
          started_at: "2026-10-29T10:02:00Z",
          estimated_cost_usd: 0,
        },
      ],
    });
    const result = evaluate(p, t);
    expect(result.dataset_eligible).toBe(true);
    expect(
      result.results.find(
        (r) => r.measure === "spine_dimensions_mean_relative_error",
      )?.pass,
    ).toBe(true);
    expect(
      result.results.find(
        (r) => r.measure === "book_prices_mean_relative_error",
      )?.pass,
    ).toBe(true);
    expect(
      result.results.find((r) => r.measure === "time_to_packet_seconds")?.pass,
    ).toBe(true);
    books[0]!.spine_height_cm = null;
    books[1]!.replacement_cost.url = "https://different.example.com/book";
    const failed = evaluate(p, t);
    expect(
      failed.results.find(
        (r) => r.measure === "spine_dimensions_mean_relative_error",
      )?.pass,
    ).toBe(false);
    expect(
      failed.results.find(
        (r) => r.measure === "book_prices_mean_relative_error",
      )?.pass,
    ).toBe(false);
    expect(
      failed.results.find(
        (r) => r.measure === "non_book_correct_category_recall",
      )?.actual,
    ).toBe(0);
  });
});
