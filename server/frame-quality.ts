import sharp from "sharp";

export type FrameQuality = {
  blur: number;
  glare: number;
  sharpness: number;
  brightness: number;
};
type CandidateFrame = {
  sequence: number;
  captured_at: string;
  quality?: {
    blur?: number;
    glare?: number;
    sharpness?: number;
    brightness?: number;
  };
};

/** Image-quality evidence only: none of these scores estimates OCR or metric scale. */
export async function computeFrameQuality(
  buffer: Buffer,
): Promise<FrameQuality> {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({
      width: 160,
      height: 160,
      fit: "inside",
      withoutEnlargement: true,
    })
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let brightness = 0;
  let clipped = 0;
  for (const value of data) {
    brightness += value;
    if (value >= 250) clipped++;
  }
  brightness /= data.length;
  let count = 0;
  let total = 0;
  let squared = 0;
  for (let y = 1; y < info.height - 1; y++) {
    for (let x = 1; x < info.width - 1; x++) {
      const i = y * info.width + x;
      const edge =
        4 * data[i] -
        data[i - 1] -
        data[i + 1] -
        data[i - info.width] -
        data[i + info.width];
      total += edge;
      squared += edge * edge;
      count++;
    }
  }
  const sharpness = count
    ? Math.max(0, squared / count - (total / count) ** 2)
    : 0;
  return {
    blur: 1 / (1 + sharpness),
    glare: clipped / data.length,
    sharpness,
    brightness,
  };
}

/** Only near-black frames are unusable; low-detail or unreadable spines are still evidence. */
export function isUnusableFrame(
  quality: { brightness?: number } | undefined,
): boolean {
  return (
    typeof quality?.brightness === "number" &&
    Number.isFinite(quality.brightness) &&
    quality.brightness < 10
  );
}

/** Keep the clearer recent view, but never let a pending frame freeze the sweep in the past. */
export function shouldReplacePendingFrame(
  previous: CandidateFrame,
  incoming: CandidateFrame,
): boolean {
  const steps = incoming.sequence - previous.sequence;
  const elapsed =
    Date.parse(incoming.captured_at) - Date.parse(previous.captured_at);
  if (steps < 0 || (steps === 0 && (!Number.isFinite(elapsed) || elapsed <= 0)))
    return false;
  // Time and sequence both constrain freshness, including devices whose clocks change mid-sweep.
  if (steps > 2 || (Number.isFinite(elapsed) && elapsed > 6000)) return true;
  if (
    isUnusableFrame(incoming.quality) &&
    !isUnusableFrame(previous.quality) &&
    previous.quality?.brightness !== undefined
  )
    return false;
  if (
    isUnusableFrame(previous.quality) &&
    !isUnusableFrame(incoming.quality) &&
    incoming.quality?.brightness !== undefined
  )
    return true;
  const before = previous.quality?.sharpness;
  const after = incoming.quality?.sharpness;
  if (
    typeof before !== "number" ||
    typeof after !== "number" ||
    !Number.isFinite(before) ||
    !Number.isFinite(after)
  )
    return true;
  const score = (value: number, glare = 0) =>
    value * (1 - 0.5 * Math.max(0, Math.min(1, glare)));
  // Equally useful images favor recency. Clipping adjusts quality, never excludes a book.
  return (
    score(after, incoming.quality?.glare) >=
    score(before, previous.quality?.glare)
  );
}
