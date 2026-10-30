/** Canonicalize glyph encoding, not language: never translate or transliterate evidence. */
export function normalizeSpineText(value: string): string {
  return (
    value
      // Presentation forms represent the same shaped Arabic letters, not another work.
      .replace(/[\uFB50-\uFDFF\uFE70-\uFEFC]/gu, (glyph) =>
        glyph.normalize("NFKC"),
      )
      .normalize("NFC")
      .toLowerCase()
      .replace(/\u0640/gu, "") // Tatweel is ornamental elongation.
      .replace(/\u0643/gu, "\u06A9") // Arabic/Persian Kaf glyph encoding.
      .replace(/\u064A/gu, "\u06CC") // Arabic/Persian Yeh glyph encoding.
      .replace(/[\u200C-\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
      // Marks are part of Indic/Arabic text; dropping them can turn different words into matches.
      .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
      .trim()
      .replace(/\s+/gu, " ")
  );
}
export function spineWords(value: string): string[] {
  return normalizeSpineText(value)
    .split(" ")
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
}
export function textSupported(value: string, visible: string): boolean {
  const expected = spineWords(value),
    seen = new Set(spineWords(visible));
  return expected.length > 0 && expected.every((token) => seen.has(token));
}
