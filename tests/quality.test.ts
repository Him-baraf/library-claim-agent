import { describe, expect, it } from "vitest";
import { assessPixels } from "../client/quality";
function pixels(
  width: number,
  height: number,
  value: (x: number, y: number) => number,
) {
  return Uint8ClampedArray.from(
    Array.from({ length: width * height * 4 }, (_, index) =>
      index % 4 === 3
        ? 255
        : value(
            Math.floor(index / 4) % width,
            Math.floor(Math.floor(index / 4) / width),
          ),
    ),
  );
}
describe("capture quality heuristics", () => {
  it("detects darkness without claiming OCR legibility", () => {
    expect(
      assessPixels(
        pixels(20, 20, () => 12),
        20,
        20,
      ).cue,
    ).toContain("dark");
  });
  it("detects clipped bright regions and distinguishes ordinary well-lit detail", () => {
    expect(
      assessPixels(
        pixels(20, 20, () => 255),
        20,
        20,
      ).clipped_fraction,
    ).toBe(1);
    expect(
      assessPixels(
        pixels(20, 20, () => 255),
        20,
        20,
      ).cue,
    ).toContain("glare");
    expect(
      assessPixels(
        pixels(20, 20, (x, y) => ((x + y) % 2 ? 180 : 80)),
        20,
        20,
      ).cue,
    ).toBeNull();
  });
  it("flags motion only when a same-size previous thumbnail is supplied", () => {
    const before = pixels(20, 20, (x, y) => ((x + y) % 2 ? 180 : 80));
    const after = pixels(20, 20, (x, y) => ((x + y) % 2 ? 80 : 180));
    expect(assessPixels(after, 20, 20, before).cue).toContain(
      "changed quickly",
    );
    expect(
      assessPixels(after, 20, 20, new Uint8ClampedArray(4)).motion_fraction,
    ).toBeNull();
  });
  it("flags low detail as a conditional capture cue, never an identification failure", () => {
    const result = assessPixels(
      pixels(20, 20, () => 128),
      20,
      20,
    );
    expect(result.laplacian_variance).toBe(0);
    expect(result.cue).toContain("When showing books");
  });
  it("rejects malformed pixel buffers", () => {
    expect(() => assessPixels(new Uint8ClampedArray(2), 20, 20)).toThrow(
      "RGBA",
    );
  });
});
