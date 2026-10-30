import { describe, expect, it } from "vitest";
import { normalizeSpineText, textSupported } from "../server/vision-text";

describe("original-script spine evidence", () => {
  it("accepts Urdu titles and authors without an English translation", () => {
    expect(textSupported("پیر کامل", "پیر کامل / عمیرہ احمد")).toBe(true);
    expect(textSupported("عمیرہ احمد", "پیر کامل / عمیرہ احمد")).toBe(true);
    expect(textSupported("Peer e Kamil", "پیر کامل / عمیرہ احمد")).toBe(false);
    expect(textSupported("The Perfect Mentor", "پیر کامل")).toBe(false);
  });

  it("canonicalizes Arabic/Persian glyph encodings without changing the script", () => {
    expect(textSupported("پیر کامل", "پير كامل")).toBe(true);
    expect(normalizeSpineText("ﻛﺘﺎﺏ")).toBe(normalizeSpineText("كتاب"));
    expect(textSupported("کتاب", "کـتاب")).toBe(true);
    expect(textSupported("على", "علي")).toBe(false);
  });

  it("retains meaningful Indic vowel and conjunct marks", () => {
    expect(textSupported("किताब", "किताब / लेखक")).toBe(true);
    expect(textSupported("किताब", "क त ब")).toBe(false);
    expect(textSupported("किताब", "कताब")).toBe(false);
    expect(normalizeSpineText("किताब")).toBe("किताब");
  });

  it("preserves Arabic diacritics while accepting canonical Unicode composition", () => {
    expect(textSupported("عَلَم", "عَلَم")).toBe(true);
    expect(textSupported("عَلَم", "علم")).toBe(false);
    expect(textSupported("Café", "Cafe\u0301")).toBe(true);
    expect(textSupported("Café", "Cafe")).toBe(false);
  });

  it("allows case and punctuation differences without accepting missing words", () => {
    expect(textSupported("A Visible Title", "A VISIBLE—TITLE / AUTHOR")).toBe(
      true,
    );
    expect(textSupported("A Visible Title", "Visible title")).toBe(false);
    expect(textSupported("", "A Visible Title")).toBe(false);
  });
});
