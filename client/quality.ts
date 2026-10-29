/** Fast capture heuristics, not an OCR or physical-measurement confidence score. */
export type CaptureQuality = {
  laplacian_variance: number;
  clipped_fraction: number;
  mean_luminance: number;
  motion_fraction: number | null;
  cue: string | null;
};
export function assessPixels(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  previous?: Uint8ClampedArray,
): CaptureQuality {
  if (width < 3 || height < 3 || rgba.length !== width * height * 4)
    throw new Error("Expected an RGBA image at least 3 × 3 pixels.");
  const gray = new Float64Array(width * height);
  let sum = 0;
  let clipped = 0;
  let motion = 0;
  for (let index = 0; index < gray.length; index++) {
    const offset = index * 4;
    const luminance =
      0.2126 * rgba[offset] +
      0.7152 * rgba[offset + 1] +
      0.0722 * rgba[offset + 2];
    gray[index] = luminance;
    sum += luminance;
    if (
      rgba[offset] >= 250 &&
      rgba[offset + 1] >= 250 &&
      rgba[offset + 2] >= 250
    )
      clipped++;
    if (previous?.length === rgba.length) {
      const before =
        0.2126 * previous[offset] +
        0.7152 * previous[offset + 1] +
        0.0722 * previous[offset + 2];
      motion += Math.abs(luminance - before);
    }
  }
  let lapSum = 0;
  let lapSquared = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      const laplacian =
        4 * gray[index] -
        gray[index - 1] -
        gray[index + 1] -
        gray[index - width] -
        gray[index + width];
      lapSum += laplacian;
      lapSquared += laplacian * laplacian;
      count++;
    }
  const laplacian_variance = Math.max(
    0,
    lapSquared / count - (lapSum / count) ** 2,
  );
  const clipped_fraction = clipped / gray.length;
  const mean_luminance = sum / gray.length;
  const motion_fraction =
    previous?.length === rgba.length ? motion / gray.length / 255 : null;
  const cue =
    mean_luminance < 35
      ? "The current frame is dark. Add light or face a better-lit shelf before moving on."
      : motion_fraction != null && motion_fraction > 0.13
        ? "The view changed quickly. Slow down and hold this shelf steady for a moment."
        : clipped_fraction > 0.18
          ? "Bright areas may hide spine text. If the books have glare, change the camera angle slightly."
          : laplacian_variance < 28
            ? "This frame has little sharp detail. When showing books, hold still and move closer until spine text is clear."
            : null;
  return {
    laplacian_variance,
    clipped_fraction,
    mean_luminance,
    motion_fraction,
    cue,
  };
}
