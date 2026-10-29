import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Express } from "express";
import type { SweepState } from "../shared/types";
import { book, item, priced, quad } from "./domain-fixtures";

let root: string, app: Express, image: string;
let store: (typeof import("../server/store"))["store"];
const savedKey = process.env.OPENAI_API_KEY,
  savedDir = process.env.DATA_DIR;
async function create(): Promise<SweepState> {
  const response = await request(app)
    .post("/api/sweeps")
    .send({ country: "IN", currency: "INR", device: "Integration fixture" })
    .expect(201);
  return response.body as SweepState;
}
async function upload(s: SweepState) {
  return (
    await request(app)
      .post(`/api/sweeps/${s.id}/frames`)
      .send({ image, shelf_id: "shelf-one", sequence: 1 })
      .expect(202)
  ).body;
}
async function until(
  id: string,
  predicate: (s: SweepState) => boolean,
): Promise<SweepState> {
  for (let i = 0; i < 150; i++) {
    const s = (await request(app).get(`/api/sweeps/${id}`).expect(200))
      .body as SweepState;
    if (predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting for local state transition");
}
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "library-claim-api-"));
  process.env.DATA_DIR = root;
  process.env.OPENAI_API_KEY = "";
  // No request in this suite is permitted to reach any external service.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network access in no-key integration test");
    }),
  );
  const module = await import("../server/app");
  app = module.createApp();
  ({ store } = await import("../server/store"));
  image = `data:image/jpeg;base64,${(
    await sharp({
      create: { width: 64, height: 48, channels: 3, background: "#e4e4e4" },
    })
      .jpeg()
      .toBuffer()
  ).toString("base64")}`;
});
afterAll(async () => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  if (savedDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = savedDir;
  await rm(root, { recursive: true, force: true });
});

describe("local sweep API and durable evidence", () => {
  it("validates locale settings and reports missing model access without exposing credentials", async () => {
    const health = await request(app).get("/api/health").expect(200);
    expect(health.body.openai_configured).toBe(false);
    expect(health.text).not.toContain("sk-");
    await request(app)
      .post("/api/sweeps")
      .send({ country: "India", currency: "INR" })
      .expect(400);
    const s = await create();
    expect(s.status).toBe("capturing");
    expect(s.books).toEqual([]);
    expect(s.room.floor_area_m2).toBeNull();
    const list = await request(app).get("/api/sweeps").expect(200);
    expect(list.body.some((x: any) => x.id === s.id)).toBe(true);
    await request(app).post(`/api/sweeps/${s.id}/finish`).expect(400);
    await request(app)
      .post(`/api/sweeps/${s.id}/realtime`)
      .set("Content-Type", "application/sdp")
      .send("v=0")
      .expect(503);
  });
  it("persists a real JPEG before reporting unavailable recognition and produces an honest unknown packet", async () => {
    const s = await create(),
      f = await upload(s);
    const disk = await readFile(path.join(root, s.id, "frames", `${f.id}.jpg`));
    expect(disk.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    await request(app)
      .get(f.frame_ref)
      .expect(200)
      .expect("Content-Type", /image\/jpeg/);
    const failed = await until(
      s.id,
      (x) => x.frames[0]?.analysis_status === "failed",
    );
    expect(failed.frames[0]!.error).toContain("OPENAI_API_KEY");
    await request(app).post(`/api/sweeps/${s.id}/finish`).expect(202);
    const done = await until(s.id, (x) => x.status === "complete");
    expect(done.books).toEqual([]);
    expect(done.items).toEqual([]);
    expect(done.room.floor_area_m2).toBeNull();
    const p = await request(app).get(`/api/sweeps/${s.id}/packet`).expect(200);
    expect(p.headers["content-disposition"]).toContain("claim_packet.json");
    expect(p.body.totals.books_replacement_cost).toBe(0);
    expect(
      p.body.review_queue.some((q: any) =>
        /recognition unavailable/.test(q.reason),
      ),
    ).toBe(true);
    expect(p.body.metrics.some((m: any) => m.stage === "finalization")).toBe(
      true,
    );
    await request(app)
      .post(`/api/sweeps/${s.id}/frames`)
      .send({ image, shelf_id: "shelf-one", sequence: 2 })
      .expect(409);
    const report = await request(app)
      .get(`/api/sweeps/${s.id}/report`)
      .expect(200);
    expect(report.text).toContain("Unknown");
    expect(report.text).toContain("recognition unavailable");
    const diskPacket = JSON.parse(
      await readFile(path.join(root, s.id, "claim_packet.json"), "utf8"),
    );
    expect(diskPacket.sweep.id).toBe(s.id);
    const bundle = await request(app)
      .get(`/api/sweeps/${s.id}/bundle`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((bundle.body as Buffer).subarray(0, 2).toString()).toBe("PK");
    expect(
      (bundle.body as Buffer).includes(Buffer.from("claim_packet.json")),
    ).toBe(true);
    expect(
      (bundle.body as Buffer).includes(Buffer.from(`frames/${f.id}.jpg`)),
    ).toBe(true);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it("requires calibrations to reference this sweep and rejects crossed quadrilaterals", async () => {
    const a = await create(),
      b = await create(),
      f = await upload(a);
    const calibration = {
      frame_ref: f.frame_ref,
      plane: "shelf",
      shelf_id: "shelf-one",
      width_cm: 100,
      height_cm: 50,
      quad,
    };
    await request(app)
      .post(`/api/sweeps/${b.id}/calibrations`)
      .send(calibration)
      .expect(400);
    await request(app)
      .post(`/api/sweeps/${a.id}/calibrations`)
      .send({ ...calibration, quad: [quad[0], quad[2], quad[1], quad[3]] })
      .expect(400);
    const valid = await request(app)
      .post(`/api/sweeps/${a.id}/calibrations`)
      .send(calibration)
      .expect(200);
    expect(valid.body.calibrations).toHaveLength(1);
    const duringPricing = await store.get(a.id);
    duringPricing.status = "processing";
    await store.save(duringPricing);
    const room = await request(app)
      .post(`/api/sweeps/${a.id}/room`)
      .send({
        known: {
          length_m: 4,
          width_m: 3,
          height_m: 2.5,
          source: "Policyholder tape measurement during this sweep",
        },
      })
      .expect(200);
    expect(room.body.room.floor_area_m2).toBe(12);
    expect(room.body.room.wall_area_m2).toBe(35);
    expect(room.body.room.scale_method).toContain("User supplied");
    expect(room.body.room.evidence_refs).toEqual([]);
  });
  it("records print, rarity and exclusion corrections and invalidates identity-specific metadata", async () => {
    const s = await create(),
      f = await upload(s);
    await until(s.id, (x) => x.frames[0]?.analysis_status === "failed");
    const internal = await store.get(s.id);
    internal.books = [
      book({
        frame_ref: f.frame_ref,
        edition: "Old edition",
        isbn: "old-isbn",
        publisher: "Old publisher",
        replacement_cost: priced(50, { currency: "INR" }),
      }),
    ];
    internal.items = [
      item({
        category: "portrait",
        frame_ref: f.frame_ref,
        status: "needs_appraisal",
      }),
    ];
    await store.save(internal);
    const changed = await request(app)
      .patch(`/api/sweeps/${s.id}/lines/b1`)
      .send({ title: "Different title", author: "Different author" })
      .expect(200);
    expect(changed.body.books[0].replacement_cost.amount).toBeNull();
    expect(changed.body.books[0].isbn).toBe("");
    expect(changed.body.books[0].edition).toBe("");
    expect(changed.body.books[0].publisher).toBe("");
    const author = await request(app)
      .patch(`/api/sweeps/${s.id}/lines/b1`)
      .send({ author: "Corrected author" })
      .expect(200);
    expect(author.body.books[0].author).toBe("Corrected author");
    const appraisal = await request(app)
      .post(`/api/sweeps/${s.id}/corrections`)
      .send({ book_id: "b1", action: "appraisal", text: "This copy is signed" })
      .expect(200);
    expect(appraisal.body.books[0].status).toBe("needs_appraisal");
    const print = await request(app)
      .post(`/api/sweeps/${s.id}/corrections`)
      .send({
        item_id: "i1",
        action: "print",
        text: "That portrait is a print",
      })
      .expect(200);
    expect(print.body.items[0].art_is_print).toBe(true);
    expect(print.body.items[0].status).toBe("unpriced");
    const excluded = await request(app)
      .post(`/api/sweeps/${s.id}/corrections`)
      .send({
        shelf_id: "shelf-one",
        action: "exclude",
        text: "That shelf is borrowed",
      })
      .expect(200);
    expect(excluded.body.books[0].excluded).toBe(true);
  });
  it("can finalize saved evidence after the most recent frame upload failed validation", async () => {
    const s = await create();
    await upload(s);
    await until(s.id, (x) => x.frames[0]?.analysis_status === "failed");
    await request(app)
      .post(`/api/sweeps/${s.id}/frames`)
      .send({
        image: "data:image/jpeg;base64,bm90LWFuLWltYWdl",
        shelf_id: "shelf-one",
        sequence: 2,
      })
      .expect(400);
    await request(app).post(`/api/sweeps/${s.id}/finish`).expect(202);
    const done = await until(s.id, (x) => x.status === "complete");
    expect(done.frames).toHaveLength(1);
  });
  it("rejects malformed images and blocks evidence path traversal", async () => {
    const s = await create();
    await request(app)
      .post(`/api/sweeps/${s.id}/frames`)
      .send({
        image: "data:image/jpeg;base64,bm90LWFuLWltYWdl",
        shelf_id: "shelf-one",
        sequence: 1,
      })
      .expect(400);
    await writeFile(
      path.join(root, "outside-secret.txt"),
      "PRIVATE_TEST_MARKER",
    );
    const response = await request(app).get(
      `/evidence/${s.id}/..%2foutside-secret.txt`,
    );
    expect(response.status).not.toBe(200);
    expect(response.text).not.toContain("PRIVATE_TEST_MARKER");
    await request(app).get("/api/sweeps/not-an-id").expect(400);
  });
});
