import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { buildPacket, buildReviewQueue } from "./domain";
import { measureBook, measureRoom, measureItem } from "./measurement";
import { renderReport } from "./report";
import { config, hasKey, safeError } from "./config";
import { store, type SweepStore } from "./store";
import { detectFrame, mergeDetections } from "./vision";
import { priceBook, priceItem } from "./pricing";
import {
  computeFrameQuality,
  isUnusableFrame,
  shouldReplacePendingFrame,
} from "./frame-quality";
import {
  scheduleValuation,
  drainValuation,
  valuationSignal,
  releaseValuation,
} from "./valuation";
import type { FrameRecord, SweepState } from "../shared/types";
import {
  CAPTURE_INSTRUCTIONS,
  frameCaptureInstruction,
} from "../shared/capture-guidance";

const processing = new Map<string, Promise<void>>();
const pending = new Map<string, FrameRecord[]>();
const finalizing = new Map<string, Promise<void>>();
const controllers = new Map<string, AbortController>();
const packetWrites = new Map<string, Promise<void>>();

export function refresh(state: SweepState) {
  state.books = state.books.map((b) => measureBook(b, state.calibrations));
  state.items = state.items.map((i) =>
    /\b(art|portrait|painting|print|wall clock)\b/i.test(
      `${i.category} ${i.description}`,
    )
      ? measureItem(i, state.calibrations)
      : i,
  );
  state.room = measureRoom(state.room_input, state.calibrations);
  state.review_queue = buildReviewQueue(state);
  if (state.packet) state.packet = buildPacket(state);
}
export function enqueueFrame(state: SweepState, frame: FrameRecord) {
  const queue = pending.get(state.id) || [];
  // Preserve the active frame and a clear recent view per shelf; every view remains saved evidence.
  const obsolete = queue.findIndex((f) => f.shelf_id === frame.shelf_id);
  if (obsolete >= 0) {
    if (!shouldReplacePendingFrame(queue[obsolete], frame)) {
      frame.analysis_status = "skipped";
      frame.error = "A clearer recent view of this shelf is already queued.";
      return;
    }
    queue[obsolete].analysis_status = "skipped";
    queue[obsolete].error =
      "Superseded by a clearer or more recent view while identification was busy.";
    queue.splice(obsolete, 1);
  }
  queue.push(frame);
  pending.set(state.id, queue);
  if (!processing.has(state.id)) {
    const work = drain(state).finally(() => processing.delete(state.id));
    processing.set(state.id, work);
  }
}
async function imageData(state: SweepState, frame: FrameRecord) {
  const file = path.join(store.dir(state.id), "frames", `${frame.id}.jpg`);
  return `data:image/jpeg;base64,${(await fs.readFile(file)).toString("base64")}`;
}
async function drain(state: SweepState) {
  const queue = pending.get(state.id)!;
  while (queue.length) {
    const frame = queue.shift()!;
    const analysisStarted = Date.now();
    frame.analysis_status = "processing";
    await store.save(state);
    try {
      if (!hasKey())
        throw new Error(
          "OPENAI_API_KEY is not configured. Frame saved; recognition unavailable.",
        );
      const previous = state.frames
        .filter(
          (f) => f.shelf_id === frame.shelf_id && f.analysis_status === "done",
        )
        .at(-1);
      const image = await imageData(state, frame);
      const references = [
        ...new Set(
          state.books
            .filter((b) => b.shelf === frame.shelf_id && !b.excluded)
            .sort((a, b) => b.id_confidence - a.id_confidence)
            .map((b) => b.frame_ref),
        ),
      ]
        .filter((ref) => ref !== frame.frame_ref && ref !== previous?.frame_ref)
        .map((ref) => state.frames.find((f) => f.frame_ref === ref))
        .filter((f): f is FrameRecord => !!f)
        .slice(0, 2);
      const reference_images = await Promise.all(
        references.map(async (f) => ({
          frame_ref: f.frame_ref,
          image: await imageData(state, f),
        })),
      );
      const { result, metric } = await detectFrame(
        state,
        frame,
        image,
        previous ? await imageData(state, previous) : undefined,
        controllers.get(state.id)?.signal,
        { previous_frame_ref: previous?.frame_ref, reference_images },
      );
      if (controllers.get(state.id)?.signal.aborted)
        throw new Error(
          "Finalization time budget reached before recognition completed.",
        );
      await store.stage(state.id, `vision-${frame.id}`, {
        frame_ref: frame.frame_ref,
        tracking_frame_refs: [
          previous?.frame_ref,
          ...references.map((f) => f.frame_ref),
        ].filter(Boolean),
        ...result,
      });
      state.metrics.push(metric);
      mergeDetections(state, frame, result);
      frame.analysis_status = "done";
      scheduleValuation(state, async () => {
        refresh(state);
        await store.save(state);
      });
      // Keep descriptive diagnostics on screen; automatically speak only a short actionable cue.
      if (result.quality.guidance) state.guidance.push(result.quality.guidance);
      const instruction = frameCaptureInstruction(
        result.quality,
        result.books.some(
          (b) => b.evidence !== "uncertain" && b.detection_confidence >= 0.7,
        ),
      );
      if (instruction) store.guidance(state, instruction);
      for (const item of state.items.filter(
        (i) =>
          i.status === "needs_appraisal" &&
          !i.art_is_print &&
          /\b(art|portrait|painting)\b/i.test(`${i.category} ${i.description}`),
      ))
        if (!state.guidance.includes(CAPTURE_INSTRUCTIONS.art))
          store.guidance(state, CAPTURE_INSTRUCTIONS.art);
    } catch (error) {
      frame.analysis_status = "failed";
      frame.error = safeError(error);
      state.errors.push(`${frame.id}: ${frame.error}`);
      state.metrics.push({
        stage: "identification_failed",
        started_at: new Date(analysisStarted).toISOString(),
        duration_ms: Date.now() - analysisStarted,
        model: config.visionModel,
        estimated_cost_usd: hasKey() ? null : 0,
        notes: frame.error,
      });
    }
    refresh(state);
    await store.save(state);
  }
}
export async function saveFrame(
  state: SweepState,
  input: {
    image: string;
    shelf_id: string;
    sequence: number;
    captured_at?: string;
  },
) {
  if (state.frames.length >= config.maxFrames)
    throw new Error(
      `Frame limit (${config.maxFrames}) reached. Finish the sweep.`,
    );
  const raw = Buffer.from(
    input.image.replace(/^data:image\/(jpeg|jpg|png);base64,/, ""),
    "base64",
  );
  const decoded = sharp(raw, { limitInputPixels: 18000000 });
  const meta = await decoded.metadata();
  if (!["jpeg", "png"].includes(meta.format || ""))
    throw new Error("Only JPEG/PNG capture frames accepted.");
  const encoded = await decoded
    .rotate()
    .resize({
      width: 1920,
      height: 1920,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 90 })
    .toBuffer({ resolveWithObject: true });
  const id = `frame-${String(state.frames.length + 1).padStart(4, "0")}`;
  await fs.writeFile(
    path.join(store.dir(state.id), "frames", `${id}.jpg`),
    encoded.data,
  );
  const frame: FrameRecord = {
    id,
    frame_ref: `/evidence/${state.id}/frames/${id}.jpg`,
    captured_at: input.captured_at || new Date().toISOString(),
    width: encoded.info.width,
    height: encoded.info.height,
    shelf_id: input.shelf_id,
    sequence: input.sequence,
    analysis_status: "queued",
    quality: await computeFrameQuality(encoded.data),
  };
  state.frames.push(frame);
  if (isUnusableFrame(frame.quality)) {
    frame.analysis_status = "skipped";
    frame.error =
      "Near-black frame saved as evidence; recognition needs a lit view.";
  } else {
    enqueueFrame(state, frame);
  }
  refresh(state);
  await store.save(state);
  return frame;
}

async function concurrent<T>(
  values: T[],
  limit: number,
  fn: (v: T) => Promise<void>,
  signal: AbortSignal,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length && !signal.aborted) {
        const value = values[next++];
        try {
          await fn(value);
        } catch (error) {
          if (signal.aborted) break;
          throw error;
        }
      }
    }),
  );
}
function context(state: SweepState, signal: AbortSignal) {
  return {
    saveEvidence: (name: string, data: unknown) =>
      store.evidence(state.id, name, data),
    onMetric: (metric: any) => {
      state.metrics.push(metric);
    },
    signal,
  };
}
export async function priceComparison(
  state: SweepState,
  country: string,
  currency: string,
  signal: AbortSignal,
) {
  const eligible = state.books
    .filter((b) => b.status === "identified" && !b.excluded)
    .slice(0, 10);
  const comparison = {
    country,
    currency,
    generated_at: new Date().toISOString(),
    books: [] as any[],
    notes: [] as string[],
  };
  await concurrent(
    eligible,
    4,
    async (book) => {
      const result = await priceBook(
        book,
        { country, currency, appraisal_threshold: state.appraisal_threshold },
        context(state, signal),
      );
      comparison.books.push({
        id: book.id,
        title: book.title,
        replacement_cost: result.replacement_cost,
        used_value: result.used_value,
      });
    },
    signal,
  );
  comparison.books.sort(
    (a, b) =>
      eligible.findIndex((x) => x.id === a.id) -
      eligible.findIndex((x) => x.id === b.id),
  );
  if (eligible.length < 10)
    comparison.notes.push(
      `Only ${eligible.length} eligible identified books; 10-book proof requires a real sweep with at least 10 eligible titles.`,
    );
  if (signal.aborted)
    comparison.notes.push(
      "Locale comparison reached time budget. Missing books remain unpriced.",
    );
  state.locale_comparison = comparison;
}
export function finishSweep(state: SweepState, force = false) {
  if (finalizing.has(state.id)) return finalizing.get(state.id)!;
  if (state.status === "complete" && !force) return Promise.resolve();
  const job = finalize(state).finally(() => finalizing.delete(state.id));
  finalizing.set(state.id, job);
  return job;
}
async function finalize(state: SweepState) {
  state.status = "processing";
  state.ended_at ||= new Date().toISOString();
  await store.save(state);
  const start = Date.now(),
    controller = valuationSignal(state);
  controllers.set(state.id, controller);
  const timer = setTimeout(
    () => controller.abort(new Error("Finalization deadline reached")),
    config.finalizationMs,
  );
  try {
    await processing.get(state.id);
    await drainValuation(state, async () => {
      refresh(state);
      await store.save(state);
    });
    if (!controller.signal.aborted)
      await priceComparison(
        state,
        state.second_country,
        state.second_currency,
        controller.signal,
      );
    if (controller.signal.aborted)
      state.errors.push(
        "Finalization time budget reached. Unfinished valuations are unknown and excluded.",
      );
    state.status = "complete";
  } catch (error) {
    state.errors.push(`Finalization: ${safeError(error)}`);
    state.status = "failed";
  } finally {
    clearTimeout(timer);
    controllers.delete(state.id);
    releaseValuation(state.id);
    const measurementStarted = Date.now();
    refresh(state);
    state.metrics.push({
      stage: "measurement",
      started_at: new Date(measurementStarted).toISOString(),
      duration_ms: Date.now() - measurementStarted,
      estimated_cost_usd: 0,
      notes:
        "Deterministic same-frame geometry and review rules; no model-authored metric values.",
    });
    const finalMetric = {
      stage: "finalization",
      started_at: new Date(start).toISOString(),
      duration_ms: Date.now() - start,
      estimated_cost_usd: 0,
      notes:
        "Wall clock total; stage metrics inside may overlap. A complete packet may contain unresolved review items.",
    };
    state.metrics.push(finalMetric);
    state.packet = buildPacket(state);
    await writePacket(state);
    finalMetric.duration_ms = Date.now() - start;
    state.packet = buildPacket(state);
    await writePacket(state);
    await store.save(state);
    store.guidance(state, CAPTURE_INSTRUCTIONS.ready);
  }
}
export async function writePacket(state: SweepState) {
  const job = (packetWrites.get(state.id) || Promise.resolve())
    .catch(() => {})
    .then(() => writePacketFiles(structuredClone(state)));
  packetWrites.set(state.id, job);
  await job;
}
async function writePacketFiles(state: SweepState) {
  const packet = buildPacket(state);
  await fs.writeFile(
    path.join(store.dir(state.id), "claim_packet.json"),
    JSON.stringify(packet, null, 2).replaceAll(`/evidence/${state.id}/`, "./"),
  );
  const report = renderReport(packet).replaceAll(
    `/evidence/${state.id}/`,
    "./",
  );
  await fs.writeFile(path.join(store.dir(state.id), "report.html"), report);
  await store.stage(state.id, "measurement", {
    calibrations: state.calibrations,
    room_input: state.room_input,
    room: state.room,
    books: state.books.map((b) => ({
      id: b.id,
      frame_ref: b.frame_ref,
      spine_height_cm: b.spine_height_cm,
      spine_thickness_cm: b.spine_thickness_cm,
      measurement_method: b.measurement_method,
    })),
  });
  await store.stage(state.id, "review", {
    review_queue: state.review_queue,
    errors: state.errors,
  });
}
