import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { ClaimPacket } from "../shared/types.js";
import { validPrice } from "../server/domain.js";
export type TruthBook = {
  truth_id: string;
  shelf: string;
  system_id: string | null;
  title: string;
  author: string;
  human_legible: boolean;
  spine_height_cm: number | null;
  spine_thickness_cm: number | null;
  price_check: {
    kind: "replacement" | "used";
    amount: number;
    currency: string;
    source_url: string;
    source_type: string;
    retrieved_at: string;
    condition: string;
  } | null;
};
export type GroundTruth = {
  sweep_id: string;
  collected_at: string;
  collected_before_tuning: boolean;
  true_book_count: number;
  shelving_units: number;
  enclosed_rooms: number;
  books: TruthBook[];
  items: { truth_id: string; system_id: string | null; category: string }[];
  room: {
    length_m: number | null;
    width_m: number | null;
    height_m: number | null;
    floor_area_m2: number | null;
    wall_area_m2: number | null;
    source: string;
  };
  notes: string[];
};
export type Result = {
  measure: string;
  actual: number | null;
  threshold: string;
  pass: boolean | null;
  numerator: number;
  denominator: number;
  reason: string;
};
const normalize = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const relativeError = (actual: number | null, expected: number) =>
  actual === null || !Number.isFinite(actual)
    ? null
    : Math.abs(actual - expected) / expected;
function validateTruth(t: GroundTruth, p: ClaimPacket): void {
  if (!t.sweep_id || t.sweep_id !== p.sweep.id)
    throw new Error("Ground truth must name the same sweep ID as the packet.");
  if (
    !Number.isInteger(t.true_book_count) ||
    t.true_book_count < 1 ||
    t.books.length !== t.true_book_count
  )
    throw new Error(
      "List every true book, including unreadable and unmatched books; books.length must equal true_book_count.",
    );
  if (!Number.isFinite(Date.parse(t.collected_at)))
    throw new Error("Record a valid ground-truth collection date.");
  const ids = new Set<string>(),
    matched = new Set<string>();
  for (const b of t.books) {
    if (!b.truth_id || ids.has(b.truth_id))
      throw new Error("Ground-truth book IDs must be unique.");
    ids.add(b.truth_id);
    if (
      typeof b.human_legible !== "boolean" ||
      (b.human_legible && !b.title.trim())
    )
      throw new Error(
        "Every spine needs a human-legible flag; legible spines require a hand-read title.",
      );
    if (b.system_id) {
      if (matched.has(b.system_id))
        throw new Error("A system book cannot match more than one true book.");
      matched.add(b.system_id);
    }
    for (const d of [b.spine_height_cm, b.spine_thickness_cm])
      if (d !== null && (!Number.isFinite(d) || d <= 0))
        throw new Error("Measured spine dimensions must be positive or null.");
    if ((b.spine_height_cm === null) !== (b.spine_thickness_cm === null))
      throw new Error(
        "Each sampled spine requires both hand-measured dimensions.",
      );
    const c = b.price_check;
    if (
      c &&
      (!Number.isFinite(c.amount) ||
        c.amount <= 0 ||
        !c.source_url ||
        !c.source_type ||
        !c.condition ||
        !Number.isFinite(Date.parse(c.retrieved_at)))
    )
      throw new Error(
        "Each hand-checked price requires amount, currency, source URL/type, date, and condition.",
      );
  }
  const itemIds = new Set<string>(),
    itemMatches = new Set<string>();
  for (const i of t.items) {
    if (!i.truth_id || itemIds.has(i.truth_id) || !i.category)
      throw new Error("Every true item needs a unique ID and category.");
    itemIds.add(i.truth_id);
    if (i.system_id) {
      if (itemMatches.has(i.system_id))
        throw new Error("A system item cannot match multiple true items.");
      itemMatches.add(i.system_id);
    }
  }
}
export function evaluate(
  packet: ClaimPacket,
  truth: GroundTruth,
): {
  sweep_id: string;
  generated_at: string;
  dataset_eligible: boolean;
  results: Result[];
  details: Record<string, unknown>;
} {
  validateTruth(truth, packet);
  const results: Result[] = [],
    books = packet.books.filter((b) => !b.excluded),
    items = packet.items.filter((i) => !i.excluded);
  const byId = new Map(books.map((b) => [b.id, b])),
    itemById = new Map(items.map((i) => [i.id, i]));
  const bookError =
    Math.abs(books.length - truth.true_book_count) / truth.true_book_count;
  results.push({
    measure: "book_count_relative_error",
    actual: bookError,
    threshold: "≤0.05",
    pass: bookError <= 0.05,
    numerator: Math.abs(books.length - truth.true_book_count),
    denominator: truth.true_book_count,
    reason: `All owned lines counted; system ${books.length}, truth ${truth.true_book_count}.`,
  });
  const legible = truth.books.filter((b) => b.human_legible);
  const correct = legible.filter((b) => {
    const s = b.system_id ? byId.get(b.system_id) : undefined;
    return (
      !!s &&
      s.status !== "unidentified" &&
      normalize(s.title) === normalize(b.title) &&
      (!b.author || (!!s.author && normalize(s.author) === normalize(b.author)))
    );
  });
  const titleRate = legible.length ? correct.length / legible.length : null;
  results.push({
    measure: "title_identification_recall",
    actual: titleRate,
    threshold: "≥0.70",
    pass: titleRate === null ? null : titleRate >= 0.7,
    numerator: correct.length,
    denominator: legible.length,
    reason:
      "Every human-legible spine is in the denominator, including missed detections. Title and hand-read author must match after punctuation/case normalization.",
  });
  const confident = books.filter(
    (b) => b.status !== "unidentified" && !!b.title && b.id_confidence >= 0.85,
  );
  const confidentWrong = confident.filter((s) => {
    const t = truth.books.find((b) => b.system_id === s.id);
    return (
      !t ||
      !t.title ||
      normalize(s.title) !== normalize(t.title) ||
      (!!t.author && normalize(s.author) !== normalize(t.author))
    );
  });
  const wrongRate = confident.length
    ? confidentWrong.length / confident.length
    : null;
  results.push({
    measure: "confidently_wrong_rate",
    actual: wrongRate,
    threshold: "≤0.03 at confidence ≥0.85",
    pass: wrongRate === null ? null : wrongRate <= 0.03,
    numerator: confidentWrong.length,
    denominator: confident.length,
    reason:
      "Unmatched confident outputs and confidently asserted titles on unreadable ground truth count as wrong. No confident predictions means not measured, not a zero-error pass.",
  });
  const dimensionSample = truth.books.filter(
    (b) => b.spine_height_cm !== null && b.spine_thickness_cm !== null,
  );
  const dimensionDetails = dimensionSample.map((t) => {
    const s = t.system_id ? byId.get(t.system_id) : undefined;
    return {
      truth_id: t.truth_id,
      height_error: relativeError(
        s?.spine_height_cm ?? null,
        t.spine_height_cm!,
      ),
      thickness_error: relativeError(
        s?.spine_thickness_cm ?? null,
        t.spine_thickness_cm!,
      ),
    };
  });
  const dimensionErrors = dimensionDetails.flatMap((d) => [
    d.height_error,
    d.thickness_error,
  ]);
  const dimensionMean = dimensionErrors.length
    ? dimensionErrors.reduce<number>((sum, v) => sum + (v ?? 1), 0) /
      dimensionErrors.length
    : null;
  const dimensionMissing = dimensionErrors.filter((n) => n === null).length;
  results.push({
    measure: "spine_dimensions_mean_relative_error",
    actual: dimensionMean,
    threshold:
      "≤0.15; ≥20 complete hand-measured spines; zero missing predictions",
    pass:
      dimensionSample.length < 20
        ? null
        : dimensionMissing > 0
          ? false
          : dimensionMean! <= 0.15,
    numerator: dimensionErrors.filter((v) => v !== null && v <= 0.15).length,
    denominator: dimensionErrors.length,
    reason: `${dimensionSample.length} measured spines; ${dimensionMissing} missing dimension outputs. Both dimensions are scored; missing values receive 100% error and cannot pass.`,
  });
  const priceSample = truth.books.filter((b) => b.price_check);
  const priceDetails = priceSample.map((t) => {
    const c = t.price_check!,
      s = t.system_id ? byId.get(t.system_id) : undefined;
    const p = s
      ? c.kind === "replacement"
        ? s.replacement_cost
        : s.used_value
      : undefined;
    // Exact source URL and condition enforce a like-for-like source type/condition comparison.
    const comparable =
      !!p &&
      validPrice(p, c.currency) &&
      p.url.replace(/\/$/, "") === c.source_url.replace(/\/$/, "") &&
      normalize(p.condition_assumed) === normalize(c.condition);
    return {
      truth_id: t.truth_id,
      comparable,
      error: comparable ? relativeError(p!.amount, c.amount) : null,
    };
  });
  const priceMean = priceDetails.length
    ? priceDetails.reduce((sum, d) => sum + (d.error ?? 1), 0) /
      priceDetails.length
    : null;
  const nonComparable = priceDetails.filter((d) => !d.comparable).length;
  results.push({
    measure: "book_prices_mean_relative_error",
    actual: priceMean,
    threshold: "≤0.25; ≥15 hand-checked books; same source and condition",
    pass:
      priceSample.length < 15
        ? null
        : nonComparable
          ? false
          : priceMean! <= 0.25,
    numerator: priceDetails.filter((d) => d.error !== null && d.error <= 0.25)
      .length,
    denominator: priceSample.length,
    reason: `${nonComparable} missing or non-comparable prices; these remain in the denominator. Source URL and condition must match; currency conversion must be explicit in packet.`,
  });
  const correctItems = truth.items.filter((t) => {
    const s = t.system_id ? itemById.get(t.system_id) : undefined;
    return s && normalize(s.category) === normalize(t.category);
  });
  const itemRecall = truth.items.length
    ? correctItems.length / truth.items.length
    : null;
  results.push({
    measure: "non_book_correct_category_recall",
    actual: itemRecall,
    threshold: "≥0.80",
    pass: itemRecall === null ? null : itemRecall >= 0.8,
    numerator: correctItems.length,
    denominator: truth.items.length,
    reason:
      "All ground-truth non-book items count, including unseen or unmatched items. Categories use exact case/punctuation-normalized matching; resolve aliases before evaluation.",
  });
  for (const [key, threshold] of [
    ["floor_area_m2", 0.1],
    ["wall_area_m2", 0.15],
  ] as const) {
    const expected = truth.room[key],
      actual = packet.room[key];
    const error =
      expected !== null && expected > 0
        ? relativeError(actual, expected)
        : null;
    results.push({
      measure: `${key}_relative_error`,
      actual: error,
      threshold: `≤${threshold}`,
      pass:
        expected === null ? null : error === null ? false : error <= threshold,
      numerator: actual ?? 0,
      denominator: expected ?? 0,
      reason: truth.room.source || "Tape measurement source not recorded.",
    });
  }
  const finalization = packet.metrics?.find((m) => m.stage === "finalization");
  results.push({
    measure: "time_to_packet_seconds",
    actual: finalization ? finalization.duration_ms / 1000 : null,
    threshold: "<300 seconds",
    pass: finalization ? finalization.duration_ms < 300_000 : null,
    numerator: finalization?.duration_ms ?? 0,
    denominator: 1000,
    reason:
      "Measured from the finalization stage, not the duration of the camera sweep.",
  });
  const eligible =
    truth.true_book_count >= 60 &&
    truth.shelving_units >= 2 &&
    truth.items.length >= 8 &&
    truth.enclosed_rooms === 1 &&
    truth.collected_before_tuning;
  return {
    sweep_id: packet.sweep.id,
    generated_at: new Date().toISOString(),
    dataset_eligible: eligible,
    results,
    details: {
      confident_wrong_ids: confidentWrong.map((b) => b.id),
      missed_legible_truth_ids: legible
        .filter((b) => !correct.includes(b))
        .map((b) => b.truth_id),
      dimensions: dimensionDetails,
      prices: priceDetails,
      unmatched_system_books: books
        .filter((b) => !truth.books.some((t) => t.system_id === b.id))
        .map((b) => b.id),
      unmatched_system_items: items
        .filter((i) => !truth.items.some((t) => t.system_id === i.id))
        .map((i) => i.id),
      dataset_requirements:
        "≥60 books, ≥2 shelving units, ≥8 other items, exactly 1 enclosed room, ground truth before tuning",
    },
  };
}
const csvCell = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const packetPath = get("--packet"),
    truthPath = get("--truth"),
    output = resolve(get("--out") || "evaluation/results");
  if (!packetPath || !truthPath)
    throw new Error(
      "Usage: npm run evaluate -- --packet path/claim_packet.json --truth path/ground_truth.json --out evaluation/results",
    );
  const packet = JSON.parse(
    await readFile(resolve(packetPath), "utf8"),
  ) as ClaimPacket;
  const truth = JSON.parse(
    await readFile(resolve(truthPath), "utf8"),
  ) as GroundTruth;
  const result = evaluate(packet, truth);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${output}.json`, JSON.stringify(result, null, 2));
  const headers: (keyof Result)[] = [
    "measure",
    "actual",
    "threshold",
    "pass",
    "numerator",
    "denominator",
    "reason",
  ];
  await writeFile(
    `${output}.csv`,
    [
      headers.join(","),
      ...result.results.map((r) => headers.map((k) => csvCell(r[k])).join(",")),
    ].join("\n") + "\n",
  );
  await writeFile(
    `${output}.md`,
    `# Ground-truth results\n\nSweep: ${result.sweep_id}\n\nDataset meets capture requirements: ${result.dataset_eligible ? "yes" : "NO"}\n\n| Measure | Observed | Pass bar | Result |\n|---|---:|---|---|\n${result.results.map((r) => `| ${r.measure} | ${r.actual ?? "not measured"} | ${r.threshold} | ${r.pass === null ? "NOT MEASURED" : r.pass ? "PASS" : "FAIL"} |`).join("\n")}\n\nSee the JSON for missing predictions, unmatched outputs, sample coverage, and per-line errors. No real-space benchmark is claimed until this file is generated from your full capture.\n`,
  );
  process.stdout.write(`Wrote ${output}.{json,csv,md}\n`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
