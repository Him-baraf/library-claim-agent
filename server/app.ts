import express from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { streamBundle } from "./bundle";
import { config, apiHeaders, hasKey, safeError } from "./config";
import { store } from "./store";
import { buildPacket, emptyPrice } from "./domain";
import { renderReport } from "./report";
import { realtimeSessionConfig, realtimeUpstreamError } from "./realtime";
import {
  enqueueFrame,
  finishSweep,
  priceComparison,
  refresh,
  saveFrame,
  writePacket,
} from "./pipeline";
import type { SweepState } from "../shared/types";

const country = z.string().regex(/^[A-Z]{2}$/),
  currency = z.string().regex(/^[A-Z]{3}$/);
const point = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
const quad = z.tuple([point, point, point, point]);
const polygon = z.array(point).min(3).max(30);
const geometry = z.object({
  calibration_id: z.string().max(100),
  frame_ref: z.string().max(300),
  polygon,
});
const roomSchema = z.object({
  floor: geometry.optional(),
  height: z
    .object({
      calibration_id: z.string(),
      frame_ref: z.string(),
      points: z.tuple([point, point]),
    })
    .optional(),
  shelving: z.array(geometry).max(30).optional(),
  known: z
    .object({
      length_m: z.number().positive().max(100),
      width_m: z.number().positive().max(100),
      height_m: z.number().positive().max(20),
      source: z.string().min(3).max(500),
    })
    .optional(),
});
const correctionSchema = z.object({
  text: z.string().min(1).max(2000),
  book_id: z.string().max(100).optional(),
  item_id: z.string().max(100).optional(),
  shelf_id: z.string().max(80).optional(),
  action: z.enum(["exclude", "appraisal", "print", "note"]).optional(),
  title: z.string().max(300).optional(),
  author: z.string().max(300).optional(),
});
const frameWrites = new Map<string, Promise<unknown>>();
const repricing = new Set<string>();
function ownFrame(s: SweepState, ref: string) {
  if (!s.frames.some((f) => f.frame_ref === ref))
    throw new Error("Frame reference must belong to this sweep.");
}
function mutable(s: SweepState) {
  if (s.status === "processing")
    throw new Error("Wait for finalization before changing evidence.");
}
function lineCorrection(
  s: SweepState,
  input: z.infer<typeof correctionSchema>,
) {
  const books = s.books.filter(
    (b) =>
      (input.book_id && b.id === input.book_id) ||
      (input.shelf_id && b.shelf === input.shelf_id && !input.item_id),
  );
  for (const b of books) {
    if (input.action === "exclude") b.excluded = true;
    if (input.action === "appraisal") {
      b.status = "needs_appraisal";
      b.rare_indicators.push(`User statement: ${input.text}`);
      b.replacement_cost = emptyPrice(s.currency);
      b.used_value = emptyPrice(s.currency);
    }
    if (input.title !== undefined || input.author !== undefined) {
      b.title = input.title ?? b.title;
      b.author = input.author ?? b.author;
      b.edition = "";
      b.isbn = "";
      b.publisher = "";
      b.status =
        b.status === "needs_appraisal"
          ? "needs_appraisal"
          : b.title
            ? "identified"
            : "unidentified";
      b.id_confidence = 0.6;
      b.replacement_cost = emptyPrice(s.currency);
      b.used_value = emptyPrice(s.currency);
    }
    b.notes.push(`User statement: ${input.text}`);
  }
  const item = s.items.find((i) => i.id === input.item_id);
  if (item) {
    if (input.action === "exclude") item.excluded = true;
    if (input.action === "appraisal") item.status = "needs_appraisal";
    if (input.action === "print") {
      item.art_is_print = true;
      item.status = "unpriced";
    }
    item.notes.push(`User statement: ${input.text}`);
    if (input.action === "appraisal")
      item.replacement_cost = {
        low: null,
        high: null,
        source: "",
        url: "",
        retrieved_at: "",
        currency: s.currency,
      };
  }
}
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const o = new URL(origin);
        const forwarded = req.headers["x-forwarded-host"];
        const host =
          typeof forwarded === "string" ? forwarded : req.headers.host;
        if (o.host !== host)
          return res
            .status(403)
            .json({ error: "Cross-origin request refused." });
      } catch {
        return res.status(403).json({ error: "Invalid origin." });
      }
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(express.json({ limit: "10mb" }));
  app.get("/api/health", (_req, res) =>
    res.json({
      version: "0.1.0",
      openai_configured: hasKey(),
      models: {
        vision: config.visionModel,
        pricing: config.pricingModel,
        realtime: config.realtimeModel,
      },
    }),
  );
  app.get("/api/sweeps", async (_req, res) => res.json(await store.list()));
  app.post("/api/sweeps", async (req, res) => {
    const input = z
      .object({
        country,
        currency,
        device: z.string().max(500).default("Browser"),
        room_name: z.string().max(100).optional(),
        appraisal_threshold: z.number().positive().max(1e9).optional(),
        second_country: country.optional(),
        second_currency: currency.optional(),
      })
      .parse(req.body);
    res.status(201).json(await store.create(input));
  });
  app.get("/api/sweeps/:id", async (req, res) =>
    res.json(await store.get(req.params.id)),
  );
  app.get("/api/sweeps/:id/events", async (req, res) => {
    const state = await store.get(req.params.id);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("state", state);
    store.events.on(state.id, send);
    const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      store.events.off(state.id, send);
    });
  });
  app.post("/api/sweeps/:id/frames", async (req, res) => {
    const state = await store.get(req.params.id);
    if (state.status !== "capturing")
      return res
        .status(409)
        .json({ error: "This sweep is no longer capturing." });
    const input = z
      .object({
        image: z.string().startsWith("data:image/").max(9e6),
        shelf_id: z.string().min(1).max(80),
        sequence: z.number().int().nonnegative(),
        captured_at: z.string().datetime().optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
      })
      .parse(req.body);
    const work = (frameWrites.get(state.id) || Promise.resolve())
      .catch(() => {})
      .then(() => saveFrame(state, input));
    frameWrites.set(state.id, work);
    res.status(202).json(await work);
  });
  app.post("/api/sweeps/:id/frames/:frameId/retry", async (req, res) => {
    const state = await store.get(req.params.id);
    mutable(state);
    const frame = state.frames.find((f) => f.id === req.params.frameId);
    if (!frame) return res.status(404).json({ error: "Unknown frame" });
    frame.analysis_status = "queued";
    enqueueFrame(state, frame);
    res.json(state);
  });
  app.post("/api/sweeps/:id/transcript", async (req, res) => {
    const state = await store.get(req.params.id);
    const input = z
      .object({
        role: z.enum(["user", "assistant"]),
        text: z.string().min(1).max(8000),
      })
      .parse(req.body);
    state.transcript.push({ ...input, at: new Date().toISOString() });
    state.transcript = state.transcript.slice(-500);
    await store.save(state);
    res.json({ ok: true });
  });
  app.post("/api/sweeps/:id/realtime-usage", async (req, res) => {
    const state = await store.get(req.params.id);
    const usage = z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        response_id: z.string().max(200),
      })
      .parse(req.body);
    if (!state.metrics.some((m) => m.notes === usage.response_id))
      state.metrics.push({
        stage: "realtime",
        started_at: new Date().toISOString(),
        duration_ms: 0,
        model: config.realtimeModel,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        estimated_cost_usd: null,
        notes: usage.response_id,
      });
    await store.save(state);
    res.json({ ok: true });
  });
  app.post("/api/sweeps/:id/corrections", async (req, res) => {
    const state = await store.get(req.params.id);
    mutable(state);
    const input = correctionSchema.parse(req.body);
    state.corrections.push({ ...input, at: new Date().toISOString() });
    lineCorrection(state, input);
    refresh(state);
    await store.save(state);
    if (state.packet) await writePacket(state);
    res.json(state);
  });
  app.patch("/api/sweeps/:id/lines/:lineId", async (req, res) => {
    const state = await store.get(req.params.id);
    mutable(state);
    const input = z
      .object({
        title: z.string().max(300).optional(),
        author: z.string().max(300).optional(),
        excluded: z.boolean().optional(),
        status: z
          .enum(["identified", "unidentified", "needs_appraisal", "unpriced"])
          .optional(),
        art_is_print: z.boolean().optional(),
        notes: z.string().max(2000).optional(),
      })
      .parse(req.body);
    const book = state.books.find((b) => b.id === req.params.lineId),
      item = state.items.find((i) => i.id === req.params.lineId);
    if (!book && !item)
      return res.status(404).json({ error: "Unknown inventory line." });
    if (book) {
      if (input.excluded !== undefined) book.excluded = input.excluded;
      lineCorrection(state, {
        text: input.notes || "Manual adjuster correction",
        book_id: book.id,
        title: input.title,
        author: input.author,
        action: input.status === "needs_appraisal" ? "appraisal" : "note",
      });
    }
    if (item) {
      if (input.excluded !== undefined) item.excluded = input.excluded;
      lineCorrection(state, {
        text: input.notes || "Manual adjuster correction",
        item_id: item.id,
        action: input.art_is_print
          ? "print"
          : input.status === "needs_appraisal"
            ? "appraisal"
            : "note",
      });
    }
    refresh(state);
    await store.save(state);
    if (state.packet) await writePacket(state);
    res.json(state);
  });
  app.post("/api/sweeps/:id/calibrations", async (req, res) => {
    const state = await store.get(req.params.id);
    const input = z
      .object({
        frame_ref: z.string().max(300),
        plane: z.enum(["shelf", "floor", "wall"]),
        shelf_id: z.string().max(80).optional(),
        width_cm: z.number().positive().max(10000),
        height_cm: z.number().positive().max(10000),
        quad,
      })
      .parse(req.body);
    ownFrame(state, input.frame_ref);
    const { makeProjector } = await import("./measurement");
    makeProjector({ ...input, id: "validation" });
    state.calibrations.push({ ...input, id: randomUUID() });
    refresh(state);
    await store.save(state);
    if (state.packet) await writePacket(state);
    res.json(state);
  });
  app.post("/api/sweeps/:id/room", async (req, res) => {
    const state = await store.get(req.params.id);
    const input = roomSchema.parse(req.body);
    for (const part of [input.floor, input.height, ...(input.shelving || [])])
      if (part) {
        ownFrame(state, part.frame_ref);
        if (
          !state.calibrations.some(
            (c) =>
              c.id === part.calibration_id && c.frame_ref === part.frame_ref,
          )
        )
          throw new Error("Geometry needs a matching same-frame calibration.");
      }
    state.room_input = { ...state.room_input, ...input };
    refresh(state);
    await store.save(state);
    if (state.packet) await writePacket(state);
    res.json(state);
  });
  app.post("/api/sweeps/:id/finish", async (req, res) => {
    const state = await store.get(req.params.id);
    const force = req.body?.recompute === true;
    if (state.status === "capturing") state.status = "processing";
    try {
      await frameWrites.get(state.id);
    } catch (error) {
      state.errors.push(`Last frame upload failed: ${safeError(error)}`);
    }
    if (state.frames.length === 0) {
      state.status = "capturing";
      await store.save(state);
      return res
        .status(400)
        .json({ error: "Save at least one sweep frame before finishing." });
    }
    void finishSweep(state, force).catch((error) => {
      console.error("Finalization failed", safeError(error));
    });
    res.status(202).json(state);
  });
  app.post("/api/sweeps/:id/reprice", async (req, res) => {
    const state = await store.get(req.params.id);
    mutable(state);
    if (repricing.has(state.id))
      return res
        .status(409)
        .json({ error: "Locale comparison already running." });
    const input = z.object({ country, currency }).parse(req.body);
    repricing.add(state.id);
    void priceComparison(
      state,
      input.country,
      input.currency,
      AbortSignal.timeout(120000),
    )
      .then(async () => {
        refresh(state);
        await writePacket(state);
        await store.save(state);
      })
      .catch(async (error) => {
        state.errors.push(safeError(error));
        await store.save(state);
      })
      .finally(() => repricing.delete(state.id));
    res.status(202).json(state);
  });
  app.post(
    "/api/sweeps/:id/realtime",
    express.text({ type: ["application/sdp", "text/plain"], limit: "100kb" }),
    async (req, res) => {
      const state = await store.get(req.params.id);
      if (!hasKey())
        return res.status(503).json({
          error: "Set OPENAI_API_KEY in the server .env and restart.",
        });
      if (typeof req.body !== "string" || !req.body.startsWith("v="))
        return res.status(400).json({ error: "Expected SDP offer." });
      const form = new FormData();
      form.set("sdp", req.body);
      form.set("session", JSON.stringify(realtimeSessionConfig(state)));
      const upstream = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: { Authorization: apiHeaders().Authorization },
        body: form,
        signal: AbortSignal.timeout(30000),
      });
      if (!upstream.ok)
        return res.status(502).json({
          error: realtimeUpstreamError(upstream.status, await upstream.text()),
        });
      res.type("application/sdp").send(await upstream.text());
    },
  );
  app.get("/api/sweeps/:id/packet", async (req, res) => {
    const state = await store.get(req.params.id);
    refresh(state);
    res.attachment("claim_packet.json").json(buildPacket(state));
  });
  app.get("/api/sweeps/:id/report", async (req, res) => {
    const state = await store.get(req.params.id);
    refresh(state);
    res.type("html").send(renderReport(buildPacket(state)));
  });
  app.get("/api/sweeps/:id/bundle", async (req, res) => {
    const state = await store.get(req.params.id);
    refresh(state);
    await writePacket(state);
    await store.save(state);
    res.attachment(`library-claim-${state.id}.zip`);
    await streamBundle(store.dir(state.id), state.id, res);
  });
  app.use("/evidence/:id", async (req, res, next) => {
    try {
      const dir = store.dir(req.params.id);
      res.setHeader("Cache-Control", "private, max-age=3600");
      express.static(dir, {
        dotfiles: "deny",
        index: false,
        fallthrough: false,
      })(req, res, next);
    } catch (error) {
      next(error);
    }
  });
  app.use(express.static(path.resolve("dist")));
  app.get("/{*path}", async (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    try {
      await fs.access("dist/index.html");
      res.sendFile(path.resolve("dist/index.html"));
    } catch {
      res
        .status(404)
        .json({ error: "Run npm run dev or npm run build first." });
    }
  });
  app.use(
    (
      error: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const message = safeError(error);
      const status =
        error instanceof z.ZodError
          ? 400
          : error.code === "ENOENT"
            ? 404
            : /Invalid|must|Expected|Wait|Geometry|calibration|Frame reference|Polygon|Quad|Calibration|image|Input buffer|unsupported image/i.test(
                  message,
                )
              ? 400
              : 500;
      res.status(status).json({ error: message });
    },
  );
  return app;
}
