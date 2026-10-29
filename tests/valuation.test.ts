import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book, Item } from "../shared/types";
import { book, item, priced, state } from "./domain-fixtures";
const mocks = vi.hoisted(() => ({
  config: { pricingConcurrency: 6 },
  hasKey: vi.fn(),
  priceBook: vi.fn(),
  priceItem: vi.fn(),
  resolveWork: vi.fn(),
  evidence: vi.fn(),
  stage: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../server/config", () => ({
  config: mocks.config,
  hasKey: mocks.hasKey,
  safeError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));
vi.mock("../server/pricing", () => ({
  priceBook: mocks.priceBook,
  priceItem: mocks.priceItem,
}));
vi.mock("../server/catalogue", () => ({ resolveWork: mocks.resolveWork }));
vi.mock("../server/store", () => ({
  store: { evidence: mocks.evidence, stage: mocks.stage, save: mocks.save },
}));
import {
  drainValuation,
  releaseValuation,
  scheduleValuation,
  valuationSignal,
} from "../server/valuation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const bookPrice = () => ({
  replacement_cost: priced(20),
  used_value: priced(8, { condition_assumed: "good used" }),
  notes: ["Verified fixture price"],
});
const itemPrice = () => ({
  replacement_cost: {
    low: 10,
    high: 20,
    source: "Fixture source",
    url: "https://example.com/item",
    retrieved_at: "2026-10-29",
    currency: "USD",
    evidence_ref: "sources/item.json",
  },
  status: "range" as const,
  notes: ["Fixture comparable range"],
});
const ids: string[] = [];
function fresh(books: Book[] = [], items: Item[] = []) {
  const s = state({ id: crypto.randomUUID(), books, items });
  ids.push(s.id);
  return s;
}
async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.pricingConcurrency = 6;
  mocks.hasKey.mockReturnValue(true);
  mocks.resolveWork.mockImplementation(async (b) => ({
    book: b,
    evidence: { source: "Fixture catalogue" },
  }));
  mocks.priceBook.mockResolvedValue(bookPrice());
  mocks.priceItem.mockResolvedValue(itemPrice());
  mocks.evidence.mockResolvedValue("/fixture/source.json");
  mocks.stage.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue(undefined);
});
afterEach(() => {
  for (const id of ids.splice(0)) releaseValuation(id);
});

describe("bounded live valuation pool and finalization drain", () => {
  it("avoids duplicate charges for the same identity signature across repeated frame schedules", async () => {
    const gate = deferred<ReturnType<typeof bookPrice>>();
    mocks.priceBook.mockReturnValue(gate.promise);
    const s = fresh([book()]);
    const publish = vi.fn(async () => {});
    scheduleValuation(s, publish);
    scheduleValuation(s, publish);
    await settle();
    expect(mocks.priceBook).toHaveBeenCalledTimes(1);
    gate.resolve(bookPrice());
    await drainValuation(s, publish);
    scheduleValuation(s, publish);
    await drainValuation(s, publish);
    expect(mocks.priceBook).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(s.books[0]!.replacement_cost.amount).toBe(20);
  });
  it.each(["title", "author", "edition", "isbn", "publisher"] as const)(
    "discards late book prices after %s evidence changes",
    async (field) => {
      const gate = deferred<ReturnType<typeof bookPrice>>();
      mocks.priceBook.mockReturnValue(gate.promise);
      const s = fresh([book()]);
      const publish = vi.fn(async () => {});
      scheduleValuation(s, publish);
      await settle();
      expect(mocks.priceBook).toHaveBeenCalledTimes(1);
      s.books[0]![field] = "Changed identity evidence";
      gate.resolve(bookPrice());
      await settle();
      expect(s.books[0]!.replacement_cost.amount).toBeNull();
      expect(publish).not.toHaveBeenCalled();
    },
  );
  it("discards late results after a line is excluded or sent for appraisal", async () => {
    const gate = deferred<ReturnType<typeof bookPrice>>();
    mocks.priceBook.mockReturnValue(gate.promise);
    const s = fresh([book()]);
    const publish = vi.fn(async () => {});
    scheduleValuation(s, publish);
    await settle();
    s.books[0]!.excluded = true;
    s.books[0]!.status = "needs_appraisal";
    gate.resolve(bookPrice());
    await settle();
    expect(s.books[0]!.replacement_cost.amount).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });
  it("discards late item prices after brand/model changes", async () => {
    const gate = deferred<ReturnType<typeof itemPrice>>();
    mocks.priceItem.mockReturnValue(gate.promise);
    const s = fresh([], [item()]);
    const publish = vi.fn(async () => {});
    scheduleValuation(s, publish);
    await settle();
    s.items[0]!.brand_model = "Changed model";
    gate.resolve(itemPrice());
    await settle();
    expect(s.items[0]!.replacement_cost.low).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });
  it("runs at most six jobs at once and finalization waits for active and queued jobs", async () => {
    const gates: ReturnType<typeof deferred<ReturnType<typeof bookPrice>>>[] =
      [];
    let active = 0,
      maxActive = 0;
    mocks.priceBook.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      const gate = deferred<ReturnType<typeof bookPrice>>();
      gates.push(gate);
      const result = await gate.promise;
      active--;
      return result;
    });
    const s = fresh(
      Array.from({ length: 10 }, (_, i) => book({ id: `book-${i}` })),
    );
    const publish = vi.fn(async () => {});
    scheduleValuation(s, publish);
    await settle();
    expect(mocks.priceBook).toHaveBeenCalledTimes(6);
    expect(maxActive).toBe(6);
    let drained = false;
    const draining = drainValuation(s, publish).then(() => {
      drained = true;
    });
    await settle();
    expect(drained).toBe(false);
    gates.slice(0, 6).forEach((g) => g.resolve(bookPrice()));
    await settle();
    expect(mocks.priceBook).toHaveBeenCalledTimes(10);
    expect(drained).toBe(false);
    gates.slice(6).forEach((g) => g.resolve(bookPrice()));
    await draining;
    expect(drained).toBe(true);
    expect(maxActive).toBe(6);
    expect(publish).toHaveBeenCalledTimes(10);
  });
  it("aborts active results, drops queued jobs, and unblocks finalization when active jobs settle", async () => {
    const gate = deferred<ReturnType<typeof bookPrice>>();
    mocks.priceBook.mockReturnValue(gate.promise);
    const s = fresh(
      Array.from({ length: 10 }, (_, i) => book({ id: `book-${i}` })),
    );
    const publish = vi.fn(async () => {});
    scheduleValuation(s, publish);
    await settle();
    expect(mocks.priceBook).toHaveBeenCalledTimes(6);
    const draining = drainValuation(s, publish);
    valuationSignal(s).abort(new Error("Finalization deadline"));
    gate.resolve(bookPrice());
    await draining;
    expect(mocks.priceBook).toHaveBeenCalledTimes(6);
    expect(publish).not.toHaveBeenCalled();
    expect(s.books.every((b) => b.replacement_cost.amount === null)).toBe(true);
    scheduleValuation(s, publish);
    await settle();
    expect(mocks.priceBook).toHaveBeenCalledTimes(6);
  });
  it("records unexpected valuation failures with line context and still drains", async () => {
    mocks.priceBook.mockRejectedValue(
      new Error("fixture upstream pricing failure"),
    );
    const s = fresh([book()]);
    const publish = vi.fn(async () => {});
    await drainValuation(s, publish);
    expect(s.errors.join(" ")).toContain("fixture upstream pricing failure");
    expect(s.errors.join(" ")).toContain("b1");
    expect(s.books[0]!.replacement_cost.amount).toBeNull();
  });
  it("honors a configured worker limit smaller than the default", async () => {
    mocks.config.pricingConcurrency = 2;
    const gates: ReturnType<typeof deferred<ReturnType<typeof bookPrice>>>[] =
      [];
    mocks.priceBook.mockImplementation(() => {
      const gate = deferred<ReturnType<typeof bookPrice>>();
      gates.push(gate);
      return gate.promise;
    });
    const s = fresh(
      Array.from({ length: 4 }, (_, i) => book({ id: `configured-${i}` })),
    );
    const publish = vi.fn(async () => {});
    scheduleValuation(s, publish);
    await settle();
    expect(mocks.priceBook).toHaveBeenCalledTimes(2);
    const draining = drainValuation(s, publish);
    gates.slice(0, 2).forEach((gate) => gate.resolve(bookPrice()));
    await settle();
    expect(mocks.priceBook).toHaveBeenCalledTimes(4);
    gates.slice(2).forEach((gate) => gate.resolve(bookPrice()));
    await draining;
    expect(publish).toHaveBeenCalledTimes(4);
  });
  it("does no model work without credentials and drains an empty pool", async () => {
    mocks.hasKey.mockReturnValue(false);
    const s = fresh([book()], [item()]);
    const publish = vi.fn(async () => {});
    await drainValuation(s, publish);
    expect(mocks.resolveWork).not.toHaveBeenCalled();
    expect(mocks.priceBook).not.toHaveBeenCalled();
    expect(mocks.priceItem).not.toHaveBeenCalled();
  });
});
