/** Short actions only. Inventory and diagnostic notes stay on screen. */
export const CAPTURE_INSTRUCTIONS = {
  dark: "Uncover the lens and add a little light.",
  blur: "Hold still and move closer to the book spines.",
  glare: "Tilt the camera slightly to reduce glare.",
  occlusion: "Show the full spines, including the shelf edges.",
  art: "Is that artwork an original or a print?",
  finishing: "Sweep saved. I’m preparing your report.",
  ready: "Your report is ready. Review the flagged items.",
} as const;
const allowed = new Set<string>(Object.values(CAPTURE_INSTRUCTIONS));
export function spokenCaptureInstruction(text: string): string | null {
  const value = text.trim().replace(/\s+/g, " ");
  return allowed.has(value) ? value : null;
}
export function frameCaptureInstruction(
  q: { blur: boolean; glare: boolean; occlusion: boolean },
  hasBooks: boolean,
): string | null {
  if (!hasBooks) return null;
  if (q.blur) return CAPTURE_INSTRUCTIONS.blur;
  if (q.glare) return CAPTURE_INSTRUCTIONS.glare;
  if (q.occlusion) return CAPTURE_INSTRUCTIONS.occlusion;
  return null;
}
export function localCaptureInstruction(q: {
  mean_luminance: number;
  motion_fraction: number | null;
  laplacian_variance: number;
}): string | null {
  if (q.mean_luminance < 35) return CAPTURE_INSTRUCTIONS.dark;
  // Changing view is normal: speak only when fast movement also lacks sharp detail.
  if (
    q.motion_fraction !== null &&
    q.motion_fraction > 0.13 &&
    q.laplacian_variance < 28
  )
    return CAPTURE_INSTRUCTIONS.blur;
  return null;
}
