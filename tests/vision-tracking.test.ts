import { describe, expect, it } from "vitest";
import { buildVisionContent } from "../server/vision";
import { book, state } from "./domain-fixtures";
import type { FrameRecord } from "../shared/types";

const current: FrameRecord = {
  id: "f5",
  frame_ref: "/evidence/s1/frames/f5.jpg",
  captured_at: "2026-10-29T10:00:05Z",
  width: 1000,
  height: 1000,
  shelf_id: "shelf-one",
  sequence: 5,
  analysis_status: "queued",
};

describe("physical-copy image anchors", () => {
  it("attaches coordinates only to their exact evidence image", () => {
    const s = state({
      books: [
        book(),
        book({ id: "b2", frame_ref: "/evidence/s1/frames/f2.jpg" }),
      ],
    });
    const content = buildVisionContent(
      s,
      current,
      "data:current",
      "data:previous",
      {
        previous_frame_ref: "/evidence/s1/frames/f4.jpg",
        reference_images: [
          { frame_ref: "/evidence/s1/frames/f1.jpg", image: "data:anchor" },
        ],
      },
    );
    const text = content[0].text as string;
    const records = JSON.parse(
      text
        .split("Existing books for this shelf: ")[1]!
        .split(".\nExisting nonbook IDs:")[0]!,
    );
    expect(records[0].quad_in_evidence_frame).toEqual(s.books[0]!.quad);
    expect(records[0].evidence_frame_ref).toBe("/evidence/s1/frames/f1.jpg");
    expect(records[1]).not.toHaveProperty("quad_in_evidence_frame");
    expect(
      content.filter((c) => c.type === "input_image").map((c) => c.image_url),
    ).toEqual(["data:previous", "data:anchor", "data:current"]);
    expect(content.at(-2)?.text).toBe(
      "CURRENT frame_ref=/evidence/s1/frames/f5.jpg. Inventory only this image.",
    );
  });

  it("deduplicates anchors and bounds history to two images", () => {
    const content = buildVisionContent(
      state(),
      current,
      "data:current",
      "data:previous",
      {
        previous_frame_ref: "previous",
        reference_images: [
          { frame_ref: "previous", image: "data:duplicate" },
          { frame_ref: current.frame_ref, image: "data:duplicate-current" },
          { frame_ref: "anchor1", image: "data:anchor1" },
          { frame_ref: "anchor1", image: "data:duplicate-anchor" },
          { frame_ref: "anchor2", image: "data:anchor2" },
          { frame_ref: "anchor3", image: "data:too-many" },
        ],
      },
    );
    expect(
      content.filter((c) => c.type === "input_image").map((c) => c.image_url),
    ).toEqual([
      "data:previous",
      "data:anchor1",
      "data:anchor2",
      "data:current",
    ]);
  });

  it("locates the legacy previous image without assigning other frames' quads", () => {
    const content = buildVisionContent(
      state({ books: [book()] }),
      current,
      "data:current",
      "data:previous",
    );
    expect(
      content.some(
        (c) =>
          typeof c.text === "string" &&
          c.text.startsWith("PREVIOUS frame_ref=/evidence/s1/frames/f1.jpg"),
      ),
    ).toBe(true);
    expect(content[0].text).toContain("quad_in_evidence_frame");
  });
});
