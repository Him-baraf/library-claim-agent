import type {
  Book,
  ClaimPacket,
  Item,
  Price,
  ReviewEntry,
  Room,
  SweepState,
  Totals,
} from "../shared/types.js";

export function emptyPrice(currency: string): Price {
  return {
    amount: null,
    source: "",
    url: "",
    retrieved_at: "",
    converted: false,
    condition_assumed: "",
    currency,
  };
}
export function emptyRoom(): Room {
  return {
    length_m: null,
    width_m: null,
    height_m: null,
    floor_area_m2: null,
    wall_area_m2: null,
    shelved_wall_area_m2: null,
    floor_area_sqft: null,
    wall_area_sqft: null,
    scale_method: "",
    confidence: 0,
    shape: "",
    evidence_refs: [],
    notes: [],
  };
}
export function safeSourceUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !!u.hostname &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
const dated = (value: string) => !!value && Number.isFinite(Date.parse(value));
export function validPrice(p: Price, currency?: string): boolean {
  return (
    p.amount !== null &&
    Number.isFinite(p.amount) &&
    p.amount >= 0 &&
    p.amount <= 1e12 &&
    !!p.source.trim() &&
    safeSourceUrl(p.url) &&
    dated(p.retrieved_at) &&
    !!p.condition_assumed.trim() &&
    !!p.evidence_ref &&
    /^[A-Z]{3}$/.test(p.currency) &&
    (!currency || p.currency === currency) &&
    (!p.converted ||
      (Number.isFinite(p.original_amount) &&
        !!p.original_currency &&
        Number.isFinite(p.fx_rate) &&
        p.fx_rate! > 0 &&
        !!p.fx_source &&
        safeSourceUrl(p.fx_source)))
  );
}
export function validItemPrice(item: Item, currency?: string): boolean {
  const p = item.replacement_cost;
  return (
    p.low !== null &&
    p.high !== null &&
    Number.isFinite(p.low) &&
    Number.isFinite(p.high) &&
    p.low >= 0 &&
    p.high >= p.low &&
    p.high <= 1e12 &&
    !!p.source.trim() &&
    safeSourceUrl(p.url) &&
    dated(p.retrieved_at) &&
    !!p.evidence_ref &&
    /^[A-Z]{3}$/.test(p.currency) &&
    (!currency || p.currency === currency)
  );
}
export function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}
/** Decimal-to-minor-unit conversion avoids accumulating binary floating point errors. */
export function toMinorUnits(amount: number, digits: number): bigint {
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e12)
    throw new Error("Invalid monetary amount.");
  const text = amount.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits: 20,
  });
  const [whole, fraction = ""] = text.split(".");
  const padded = fraction.padEnd(digits + 1, "0");
  let result =
    BigInt(whole!) * 10n ** BigInt(digits) +
    BigInt(padded.slice(0, digits) || "0");
  if (Number(padded[digits]) >= 5) result += 1n;
  return result;
}
const moneySum = (values: number[], currency: string) => {
  const digits = currencyDigits(currency),
    value = values.reduce(
      (sum, amount) => sum + toMinorUnits(amount, digits),
      0n,
    );
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Monetary total exceeds supported precision.");
  return Number(value) / 10 ** digits;
};
const bookEligible = (b: Book) =>
  !b.excluded &&
  b.status === "identified" &&
  !!b.title.trim() &&
  !b.rare_indicators.length;
const itemEligible = (i: Item) =>
  !i.excluded &&
  ["priced", "range"].includes(i.status) &&
  (!/\b(art|portrait|painting)\b/i.test(`${i.category} ${i.description}`) ||
    i.art_is_print);
export function computeTotals(
  books: Book[],
  items: Item[],
  currency?: string,
): Totals {
  const selectedCurrency =
    currency ||
    books.find((b) => validPrice(b.replacement_cost))?.replacement_cost
      .currency ||
    items.find((i) => validItemPrice(i))?.replacement_cost.currency ||
    "USD";
  const owned = books.filter((b) => !b.excluded);
  const pricedBooks = books.filter(bookEligible),
    pricedItems = items.filter(itemEligible);
  const replacement = pricedBooks.filter((b) =>
    validPrice(b.replacement_cost, selectedCurrency),
  );
  const used = pricedBooks.filter((b) =>
    validPrice(b.used_value, selectedCurrency),
  );
  const valuedItems = pricedItems.filter((i) =>
    validItemPrice(i, selectedCurrency),
  );
  const measured = owned.filter(
    (b) =>
      b.spine_thickness_cm !== null &&
      Number.isFinite(b.spine_thickness_cm) &&
      b.spine_thickness_cm > 0,
  );
  const countExcluded =
    books.filter(
      (b) =>
        !bookEligible(b) ||
        !validPrice(b.replacement_cost, selectedCurrency) ||
        !validPrice(b.used_value, selectedCurrency),
    ).length +
    items.filter(
      (i) => !itemEligible(i) || !validItemPrice(i, selectedCurrency),
    ).length;
  return {
    book_count: owned.length,
    books_identified: owned.filter(
      (b) => b.status !== "unidentified" && !!b.title.trim(),
    ).length,
    books_unidentified: owned.filter(
      (b) => b.status === "unidentified" || !b.title.trim(),
    ).length,
    shelf_run_m: Number(
      (measured.reduce((s, b) => s + b.spine_thickness_cm!, 0) / 100).toFixed(
        4,
      ),
    ),
    books_replacement_cost: moneySum(
      replacement.map((b) => b.replacement_cost.amount!),
      selectedCurrency,
    ),
    books_used_value: moneySum(
      used.map((b) => b.used_value.amount!),
      selectedCurrency,
    ),
    items_replacement_cost_low: moneySum(
      valuedItems.map((i) => i.replacement_cost.low!),
      selectedCurrency,
    ),
    items_replacement_cost_high: moneySum(
      valuedItems.map((i) => i.replacement_cost.high!),
      selectedCurrency,
    ),
    excluded_from_totals: countExcluded,
    shelf_run_partial: measured.length !== owned.length,
    valuation_partial:
      replacement.length !== owned.length ||
      used.length !== owned.length ||
      valuedItems.length !== items.filter((i) => !i.excluded).length,
    books_needing_appraisal: owned.filter(
      (b) => b.status === "needs_appraisal" || b.rare_indicators.length > 0,
    ).length,
  };
}
export function buildReviewQueue(state: SweepState): ReviewEntry[] {
  const queue: ReviewEntry[] = [],
    refs = new Set(state.frames.map((f) => f.frame_ref));
  const add = (ref_id: string, reason: string) => {
    if (!queue.some((q) => q.ref_id === ref_id && q.reason === reason))
      queue.push({ ref_id, reason });
  };
  for (const book of state.books) {
    if (!refs.has(book.frame_ref))
      add(book.id, "Referenced evidence frame is missing.");
    if (book.excluded) {
      add(
        book.id,
        "Excluded by policyholder; retained for audit and excluded from all totals.",
      );
      continue;
    }
    if (book.status === "unidentified" || !book.title)
      add(book.id, "Spine is unidentified; no guessed title or valuation.");
    if (book.id_confidence < 0.85)
      add(
        book.id,
        `Identification confidence ${book.id_confidence.toFixed(2)} is below 0.85.`,
      );
    if (book.status === "needs_appraisal" || book.rare_indicators.length)
      add(
        book.id,
        `Human appraisal required${book.rare_indicators.length ? `: ${book.rare_indicators.join(", ")}` : ""}; excluded from automatic valuation.`,
      );
    if (book.spine_height_cm === null || book.spine_thickness_cm === null)
      add(
        book.id,
        "Spine dimensions unavailable: no valid same-frame coplanar metric calibration.",
      );
    if (!validPrice(book.replacement_cost, state.currency))
      add(
        book.id,
        "No verified replacement price in the sweep currency; excluded from replacement total.",
      );
    if (!validPrice(book.used_value, state.currency))
      add(
        book.id,
        "No verified used price in the sweep currency; excluded from used total.",
      );
    if (book.replacement_cost.converted || book.used_value.converted)
      add(
        book.id,
        "Price converted from another market; inspect source, FX evidence, condition, and equivalence.",
      );
    if (book.notes.length) book.notes.forEach((note) => add(book.id, note));
  }
  for (const item of state.items) {
    if (!refs.has(item.frame_ref))
      add(item.id, "Referenced evidence frame is missing.");
    if (item.excluded) {
      add(item.id, "Excluded by policyholder; retained for audit.");
      continue;
    }
    if (
      !item.art_is_print &&
      /\b(art|portrait|painting)\b/i.test(
        `${item.category} ${item.description}`,
      )
    )
      add(
        item.id,
        "Art, portrait, or valuable object requires human appraisal; ask whether it is a print.",
      );
    else if (item.status === "needs_appraisal")
      add(
        item.id,
        "Human valuation or appraisal is required; excluded from automatic item totals.",
      );
    if (!validItemPrice(item, state.currency))
      add(
        item.id,
        "No verified local replacement price or range; excluded from item totals.",
      );
    if (item.status === "range")
      add(
        item.id,
        "Sourced comparable range; exact brand/model or condition is unconfirmed.",
      );
    if (item.confidence < 0.85)
      add(item.id, "Item identification confidence is below 0.85.");
    if (Object.values(item.dimensions_cm).some((n) => n === null))
      add(
        item.id,
        "One or more item dimensions are unknown; perspective alone does not establish depth.",
      );
    item.notes.forEach((note) => add(item.id, note));
  }
  for (const key of [
    "floor_area_m2",
    "wall_area_m2",
    "shelved_wall_area_m2",
  ] as const)
    if (state.room[key] === null) add("room", `${key} is unknown.`);
  state.room.notes.forEach((note) => add("room", note));
  if (!state.frames.length)
    add(
      "sweep",
      "No camera evidence captured; inventory coverage cannot be assessed.",
    );
  state.frames
    .filter((f) =>
      ["failed", "skipped", "queued", "processing"].includes(f.analysis_status),
    )
    .forEach((f) =>
      add(
        f.id,
        `Frame analysis ${f.analysis_status}${f.error ? `: ${f.error}` : ""}. Coverage is incomplete.`,
      ),
    );
  state.errors.forEach((message) => add("sweep", message));
  if (state.metrics.some((m) => m.estimated_cost_usd === null))
    add(
      "metrics",
      "One or more stage costs are unknown; reported cost is a partial estimate.",
    );
  return queue;
}
export function buildPacket(state: SweepState): ClaimPacket {
  const books = state.books.map((book) => {
    const b = structuredClone(book);
    if (b.status !== "identified" || b.rare_indicators.length || !b.title) {
      if (b.rare_indicators.length) b.status = "needs_appraisal";
      b.replacement_cost = emptyPrice(state.currency);
      b.used_value = emptyPrice(state.currency);
    }
    return b;
  });
  const items = state.items.map((item) => {
    const i = structuredClone(item);
    // Preserve the brief's exported status enum while keeping UI-only 'unpriced' internal.
    if (i.status === "unpriced") {
      i.status = "needs_appraisal";
      i.notes.push(
        "No verified replacement source; human valuation required. This flag does not assert rarity or originality.",
      );
    }
    if (
      !i.art_is_print &&
      /\b(art|portrait|painting)\b/i.test(`${i.category} ${i.description}`)
    )
      i.status = "needs_appraisal";
    if (i.status === "needs_appraisal")
      i.replacement_cost = {
        low: null,
        high: null,
        source: "",
        url: "",
        retrieved_at: "",
        currency: state.currency,
      };
    return i;
  });
  const duration =
    (Date.parse(state.ended_at || new Date().toISOString()) -
      Date.parse(state.started_at)) /
    1000;
  return {
    sweep: {
      id: state.id,
      captured_at: state.captured_at,
      device: state.device,
      duration_s: Number.isFinite(duration)
        ? Math.max(0, Math.round(duration))
        : 0,
      country: state.country,
      currency: state.currency,
    },
    room: structuredClone(state.room),
    books,
    items,
    totals: computeTotals(books, items, state.currency),
    review_queue: buildReviewQueue({ ...state, books, items }),
    metrics: structuredClone(state.metrics),
    ...(state.locale_comparison
      ? { locale_comparison: structuredClone(state.locale_comparison) }
      : {}),
  };
}
