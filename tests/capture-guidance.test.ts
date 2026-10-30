import { describe, expect, it } from "vitest";
import {
  CAPTURE_INSTRUCTIONS,
  frameCaptureInstruction,
  localCaptureInstruction,
  spokenCaptureInstruction,
} from "../shared/capture-guidance";
describe("instruction-only automatic speech", () => {
  it("keeps inventory and diagnostic notes silent", () => {
    for (const text of [
      "Latest verified inventory with IDs: book-123",
      "The wall and decorative loop are clipped.",
      "No books logged; four unpriced items.",
      "Local capture heuristic, not an OCR result: move slowly",
    ])
      expect(spokenCaptureInstruction(text)).toBeNull();
  });
  it("allows only brief actions with no internal IDs", () => {
    for (const cue of Object.values(CAPTURE_INSTRUCTIONS)) {
      expect(spokenCaptureInstruction(cue)).toBe(cue);
      expect(cue.split(/\s+/).length).toBeLessThanOrEqual(11);
    }
  });
  it("does not recapture unrelated clipping or legible spines", () => {
    expect(
      frameCaptureInstruction(
        { blur: true, glare: false, occlusion: true },
        false,
      ),
    ).toBeNull();
    expect(
      frameCaptureInstruction(
        { blur: false, glare: false, occlusion: false },
        true,
      ),
    ).toBeNull();
  });
  it("selects one instruction instead of listing capture problems", () => {
    expect(
      frameCaptureInstruction(
        { blur: true, glare: true, occlusion: true },
        true,
      ),
    ).toBe(CAPTURE_INSTRUCTIONS.blur);
  });
  it("stays quiet during sharp panning or a still blank wall", () => {
    expect(
      localCaptureInstruction({
        mean_luminance: 130,
        motion_fraction: 0.4,
        laplacian_variance: 250,
      }),
    ).toBeNull();
    expect(
      localCaptureInstruction({
        mean_luminance: 130,
        motion_fraction: 0.01,
        laplacian_variance: 5,
      }),
    ).toBeNull();
    expect(
      localCaptureInstruction({
        mean_luminance: 8,
        motion_fraction: 0,
        laplacian_variance: 2,
      }),
    ).toBe(CAPTURE_INSTRUCTIONS.dark);
  });
});
