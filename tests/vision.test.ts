import { describe, expect, it } from "vitest";
import {
  detectionSchema,
  mergeDetections,
  textSupported,
  visibleIsbn,
} from "../server/vision";
import { book, item, priced, quad, state } from "./domain-fixtures";
import type { FrameRecord } from "../shared/types";
const frame: FrameRecord = {
  id: "f2",
  frame_ref: "/evidence/s1/frames/f2.jpg",
  captured_at: "2026-10-29T10:00:02Z",
  width: 1000,
  height: 1000,
  shelf_id: "shelf-one",
  sequence: 2,
  analysis_status: "done",
};
const detection = (override: Record<string, unknown> = {}) => ({
  existing_id: "",
  title: "Test title",
  author: "Test author",
  publisher: "",
  edition: "",
  isbn: "",
  visible_text: "Test title / Test author",
  confidence: 0.98,
  quad,
  rare_indicators: [],
  ...override,
});
const result = (books: ReturnType<typeof detection>[], items: any[] = []) =>
  detectionSchema.parse({
    quality: { blur: false, glare: false, occlusion: false, guidance: "" },
    books,
    items,
    coverage_notes: [],
  });
describe("evidence-grounded physical-copy tracking", () => {
  it("rejects an asserted title unsupported by the visible OCR text", () => {
    const s = state();
    mergeDetections(
      s,
      frame,
      result([
        detection({ title: "An invented title", visible_text: "Test author" }),
      ]),
    );
    expect(s.books[0].title).toBe("");
    expect(s.books[0].status).toBe("unidentified");
    expect(textSupported("The Hobbit", "J R R Tolkien")).toBe(false);
  });
  it("retains ISBNs only when visible and checksum valid", () => {
    expect(visibleIsbn("9780306406157", "ISBN 978-0-306-40615-7")).toBe(
      "9780306406157",
    );
    expect(visibleIsbn("9780306406158", "ISBN 9780306406158")).toBe("");
    expect(visibleIsbn("9780306406157", "A title")).toBe("");
  });
  it("retains separate physical copies sharing a title and never merges by title alone", () => {
    const s = state();
    mergeDetections(s, frame, result([detection(), detection()]));
    expect(s.books).toHaveLength(2);
    expect(s.books[0]!.id).not.toBe(s.books[1]!.id);
  });
  it("requires visible text and adequate confidence before asserting a title", () => {
    const s = state();
    mergeDetections(
      s,
      frame,
      result([detection({ visible_text: "" }), detection({ confidence: 0.7 })]),
    );
    expect(
      s.books.every(
        (b) =>
          b.status === "unidentified" &&
          b.title === "" &&
          b.id_confidence <= 0.4,
      ),
    ).toBe(true);
  });
  it("reuses a known same-shelf physical ID and preserves stronger evidence on a blurry recapture", () => {
    const s = state({
      books: [book({ id_confidence: 0.99, replacement_cost: priced(20) })],
    });
    mergeDetections(
      s,
      frame,
      result([
        detection({
          existing_id: "b1",
          confidence: 0.3,
          visible_text: "",
          title: "",
        }),
      ]),
    );
    expect(s.books).toHaveLength(1);
    expect(s.books[0]!.title).toBe("Test title");
    expect(s.books[0]!.frame_ref).toBe("/evidence/s1/frames/f1.jpg");
  });
  it("does not reuse an existing book ID from a different physical shelf", () => {
    const s = state({ books: [book({ shelf: "another-shelf" })] });
    mergeDetections(s, frame, result([detection({ existing_id: "b1" })]));
    expect(s.books).toHaveLength(2);
  });
  it("invalidates stale valuation when same-title author or edition evidence changes", () => {
    const s = state({
      books: [
        book({
          id_confidence: 0.8,
          author: "Old author",
          publisher: "Old publisher",
          isbn: "old-isbn",
          replacement_cost: priced(20),
          used_value: priced(5),
        }),
      ],
    });
    mergeDetections(
      s,
      frame,
      result([
        detection({
          existing_id: "b1",
          author: "New author",
          publisher: "New publisher",
          isbn: "new-isbn",
        }),
      ]),
    );
    expect(s.books[0]!.replacement_cost.amount).toBeNull();
    expect(s.books[0]!.used_value.amount).toBeNull();
  });
  it("keeps an ambiguous second physical detection when a model reuses one track ID twice", () => {
    const s = state({ books: [book({ id_confidence: 0.8 })] });
    mergeDetections(
      s,
      frame,
      result([
        detection({ existing_id: "b1" }),
        detection({ existing_id: "b1" }),
      ]),
    );
    expect(s.books).toHaveLength(2);
    expect(s.errors.join(" ")).toMatch(/duplicate|ambiguous/i);
  });
  it("applies shelf exclusions to future detections, not only existing books", () => {
    const s = state({
      corrections: [
        {
          text: "Those books are not mine",
          at: "2026-10-29",
          shelf_id: "shelf-one",
          action: "exclude",
        },
      ],
    });
    mergeDetections(s, frame, result([detection()]));
    expect(s.books[0]!.excluded).toBe(true);
  });
  it("defaults art to appraisal and preserves user print confirmation across frames", () => {
    const d = {
      existing_id: "",
      category: "portrait",
      description: "Framed portrait",
      brand_model: "",
      material: "",
      confidence: 0.9,
      quad,
      is_art: true,
    };
    const s = state();
    mergeDetections(s, frame, result([], [d]));
    expect(s.items[0]!.status).toBe("needs_appraisal");
    const confirmed = state({
      items: [
        item({
          id: "print",
          category: "portrait",
          art_is_print: true,
          confidence: 0.8,
        }),
      ],
    });
    mergeDetections(
      confirmed,
      frame,
      result([], [{ ...d, existing_id: "print" }]),
    );
    expect(confirmed.items[0]!.art_is_print).toBe(true);
    expect(confirmed.items[0]!.status).toBe("unpriced");
  });
  it("keeps new appraisal evidence even when a recapture has weaker title confidence", () => {
    const s = state({
      books: [book({ id_confidence: 0.99, replacement_cost: priced(100) })],
    });
    mergeDetections(
      s,
      frame,
      result([
        detection({
          existing_id: "b1",
          confidence: 0.8,
          rare_indicators: ["signed copy"],
        }),
      ]),
    );
    expect(s.books[0]!.status).toBe("needs_appraisal");
    expect(s.books[0]!.replacement_cost.amount).toBeNull();
    expect(s.books[0]!.rare_indicators).toContain("signed copy");
  });
  it("invalidates non-book pricing when stronger evidence changes the brand or model", () => {
    const s = state({
      items: [
        item({
          id: "lamp",
          brand_model: "Old model",
          confidence: 0.8,
          status: "priced",
          replacement_cost: {
            low: 20,
            high: 20,
            source: "Fixture",
            url: "https://example.com/lamp",
            retrieved_at: "2026-10-29",
            currency: "USD",
            evidence_ref: "sources/lamp.json",
          },
        }),
      ],
    });
    mergeDetections(
      s,
      frame,
      result(
        [],
        [
          {
            existing_id: "lamp",
            category: "lamp",
            description: "Floor lamp",
            brand_model: "New model",
            material: "metal",
            confidence: 0.98,
            quad,
            is_art: false,
          },
        ],
      ),
    );
    expect(s.items[0]!.replacement_cost.low).toBeNull();
    expect(s.items[0]!.replacement_cost.high).toBeNull();
  });
  it("rejects out-of-bounds coordinates before detection records enter inventory", () => {
    expect(() =>
      result([detection({ quad: [{ x: -1, y: 0 }, ...quad.slice(1)] })]),
    ).toThrow();
  });
});
