import type { Book, Item, SweepState } from "../shared/types";
import { config, hasKey, safeError } from "./config";
import { store } from "./store";
import { priceBook, priceItem } from "./pricing";
import { resolveWork } from "./catalogue";

type Job = { key: string; run: () => Promise<void> };
type Pool = {
  controller: AbortController;
  active: number;
  queue: Job[];
  seen: Set<string>;
  waiters: (() => void)[];
  onError: (error: unknown, key: string) => void;
};
const pools = new Map<string, Pool>();
const keyBook = (b: Book) =>
  JSON.stringify([
    "book",
    b.id,
    b.title,
    b.author,
    b.publisher,
    b.isbn,
    b.edition,
    b.excluded,
    b.status,
    b.rare_indicators,
  ]);
const keyItem = (i: Item) =>
  JSON.stringify([
    "item",
    i.id,
    i.category,
    i.description,
    i.brand_model,
    i.material,
    i.art_is_print,
    i.excluded,
    i.status === "needs_appraisal",
  ]);
function poolFor(state: SweepState) {
  let p = pools.get(state.id);
  if (!p) {
    p = {
      controller: new AbortController(),
      active: 0,
      queue: [],
      seen: new Set(),
      waiters: [],
      onError: (error, key) => {
        state.errors.push(
          `Valuation job ${key.slice(0, 160)} failed: ${safeError(error)}`,
        );
        void store.save(state).catch(() => {});
      },
    };
    pools.set(state.id, p);
  }
  return p;
}
export function valuationSignal(state: SweepState) {
  return poolFor(state).controller;
}
function pump(pool: Pool) {
  if (pool.controller.signal.aborted) pool.queue = [];
  while (pool.active < config.pricingConcurrency && pool.queue.length) {
    const job = pool.queue.shift()!;
    pool.active++;
    void job
      .run()
      .catch((error) => pool.onError(error, job.key))
      .finally(() => {
        pool.active--;
        pump(pool);
      });
  }
  if (!pool.active && !pool.queue.length) {
    const waiters = pool.waiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }
}
export function scheduleValuation(
  state: SweepState,
  publish: () => Promise<void>,
) {
  if (!hasKey()) return;
  const pool = poolFor(state);
  if (pool.controller.signal.aborted) return;
  const context = {
    saveEvidence: (name: string, data: unknown) =>
      store.evidence(state.id, name, data),
    onMetric: (metric: any) => state.metrics.push(metric),
    signal: pool.controller.signal,
  };
  const locale = {
    country: state.country,
    currency: state.currency,
    appraisal_threshold: state.appraisal_threshold,
  };
  for (const current of state.books.filter(
    (b) => b.status === "identified" && !b.excluded,
  )) {
    const key = keyBook(current);
    if (pool.seen.has(key)) continue;
    pool.seen.add(key);
    const book = structuredClone(current);
    pool.queue.push({
      key,
      run: async () => {
        const resolved = await resolveWork(book, pool.controller.signal);
        if (resolved.evidence)
          await store.stage(
            state.id,
            `catalogue-${book.id}`,
            resolved.evidence,
          );
        const result = await priceBook(book, locale, context);
        if (pool.controller.signal.aborted) return;
        const live = state.books.find((b) => b.id === book.id);
        if (!live || keyBook(live) !== key) return;
        live.replacement_cost = result.replacement_cost;
        live.used_value = result.used_value;
        live.notes = [
          ...new Set([...live.notes, ...book.notes, ...result.notes]),
        ];
        if (result.needs_appraisal) live.status = "needs_appraisal";
        await publish();
      },
    });
  }
  for (const current of state.items.filter(
    (i) => !i.excluded && i.status !== "needs_appraisal",
  )) {
    const key = keyItem(current);
    if (pool.seen.has(key)) continue;
    pool.seen.add(key);
    const item = structuredClone(current);
    pool.queue.push({
      key,
      run: async () => {
        const result = await priceItem(item, locale, context);
        if (pool.controller.signal.aborted) return;
        const live = state.items.find((i) => i.id === item.id);
        if (!live || keyItem(live) !== key) return;
        live.replacement_cost = result.replacement_cost;
        live.status = result.status;
        live.notes = [...new Set([...live.notes, ...result.notes])];
        await publish();
      },
    });
  }
  pump(pool);
}
export async function drainValuation(
  state: SweepState,
  publish: () => Promise<void>,
) {
  scheduleValuation(state, publish);
  const pool = poolFor(state);
  if (pool.active || pool.queue.length)
    await new Promise<void>((resolve) => pool.waiters.push(resolve));
}
export function releaseValuation(id: string) {
  pools.delete(id);
}
