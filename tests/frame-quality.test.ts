import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  computeFrameQuality,
  isUnusableFrame,
  shouldReplacePendingFrame,
} from "../server/frame-quality";

const quality = (sharpness: number, brightness = 120, glare = 0) => ({
  blur: 1 / (1 + sharpness),
  glare,
  sharpness,
  brightness,
});
const frame = (
  sequence: number,
  seconds: number,
  q?: ReturnType<typeof quality>,
) => ({
  sequence,
  captured_at: new Date(Date.UTC(2026, 9, 30, 10, 0, seconds)).toISOString(),
  quality: q,
});

describe("server frame quality and pending-view selection", () => {
  it("distinguishes actual sharp edges from a blurred version without claiming OCR", async () => {
    const width = 128,
      height = 128;
    const pixels = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        pixels[y * width + x] =
          (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? 220 : 40;
    const image = await sharp(pixels, { raw: { width, height, channels: 1 } })
      .png()
      .toBuffer();
    const blurred = await sharp(image).blur(3).png().toBuffer();
    const crisp = await computeFrameQuality(image),
      soft = await computeFrameQuality(blurred);
    expect(crisp.sharpness).toBeGreaterThan(soft.sharpness * 2);
    expect(crisp.blur).toBeLessThan(soft.blur);
    expect(crisp.blur).toBeCloseTo(1 / (1 + crisp.sharpness));
    expect(crisp.brightness).toBeGreaterThan(100);
    expect(crisp.glare).toBe(0);
  });
  it("flags near-black frames, without discarding an ordinary low-detail wall or spine", async () => {
    const black = await sharp({
      create: { width: 20, height: 20, channels: 3, background: "#000" },
    })
      .png()
      .toBuffer();
    const plain = await sharp({
      create: { width: 20, height: 20, channels: 3, background: "#888" },
    })
      .png()
      .toBuffer();
    expect(isUnusableFrame(await computeFrameQuality(black))).toBe(true);
    const lowDetail = await computeFrameQuality(plain);
    expect(lowDetail.sharpness).toBe(0);
    expect(isUnusableFrame(lowDetail)).toBe(false);
  });
  it("keeps the clearer view within the last two frame intervals", () => {
    expect(
      shouldReplacePendingFrame(
        frame(1, 0, quality(150)),
        frame(2, 3, quality(20)),
      ),
    ).toBe(false);
    expect(
      shouldReplacePendingFrame(
        frame(1, 0, quality(20)),
        frame(3, 6, quality(150)),
      ),
    ).toBe(true);
  });
  it("does not replace a clear recent image with black sensor noise", () => {
    expect(
      shouldReplacePendingFrame(
        frame(1, 0, quality(100)),
        frame(2, 3, quality(900, 2)),
      ),
    ).toBe(false);
    expect(
      shouldReplacePendingFrame(
        frame(1, 0, quality(900, 2)),
        frame(2, 3, quality(100)),
      ),
    ).toBe(true);
  });
  it("refreshes an older view even if a new region has less detail", () => {
    expect(
      shouldReplacePendingFrame(
        frame(1, 0, quality(100)),
        frame(2, 7, quality(10)),
      ),
    ).toBe(true);
    expect(
      shouldReplacePendingFrame(
        frame(1, 0, quality(100)),
        frame(4, 1, quality(10)),
      ),
    ).toBe(true);
  });
  it("falls back to the latest frame when quality evidence is unavailable", () => {
    expect(
      shouldReplacePendingFrame(frame(1, 0), frame(2, 3, quality(10))),
    ).toBe(true);
    expect(
      shouldReplacePendingFrame(frame(1, 0, quality(10)), frame(2, 3)),
    ).toBe(true);
  });
  it("keeps out-of-order or repeated candidates from resetting the pending view", () => {
    expect(
      shouldReplacePendingFrame(
        frame(2, 3, quality(10)),
        frame(1, 0, quality(100)),
      ),
    ).toBe(false);
    expect(
      shouldReplacePendingFrame(
        frame(2, 3, quality(10)),
        frame(2, 3, quality(100)),
      ),
    ).toBe(false);
  });
  it("uses clipping only as a soft quality factor and favors equally good newer views", () => {
    expect(
      shouldReplacePendingFrame(
        frame(1, 0, quality(100)),
        frame(2, 3, quality(120, 120, 1)),
      ),
    ).toBe(false);
    expect(
      shouldReplacePendingFrame(
        frame(1, 0, quality(100)),
        frame(2, 3, quality(200, 120, 1)),
      ),
    ).toBe(true);
  });
  it("never labels unknown quality or a dim but visible frame unusable", () => {
    expect(isUnusableFrame(undefined)).toBe(false);
    expect(isUnusableFrame({ brightness: Number.NaN })).toBe(false);
    expect(isUnusableFrame({ brightness: 10 })).toBe(false);
    expect(isUnusableFrame({ brightness: 9 })).toBe(true);
  });
});
