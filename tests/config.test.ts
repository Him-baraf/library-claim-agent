import { describe, expect, it } from "vitest";
import { parsePricingConcurrency } from "../server/config";

describe("bounded pricing concurrency configuration", () => {
  it.each([undefined, "", "   ", "not-a-number", "NaN", "Infinity"])(
    "defaults invalid or missing input %s to ten",
    (raw) => {
      expect(parsePricingConcurrency(raw)).toBe(10);
    },
  );
  it.each([
    ["-8", 1],
    ["0", 1],
    ["1", 1],
    ["6", 6],
    ["10", 10],
    ["12", 12],
    ["1000", 12],
    ["3.9", 3],
  ] as const)("clamps and floors %s to %s", (raw, expected) => {
    expect(parsePricingConcurrency(raw)).toBe(expected);
  });
});
