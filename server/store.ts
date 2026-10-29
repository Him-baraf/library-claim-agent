import { promises as fs } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import { emptyRoom } from "./domain";
import type { SweepState } from "../shared/types";

export class SweepStore {
  events = new EventEmitter();
  private states = new Map<string, SweepState>();
  private writes = new Map<string, Promise<void>>();
  constructor(public root = config.dataDir) {
    this.events.setMaxListeners(100);
  }
  dir(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid sweep ID");
    return path.join(this.root, id);
  }
  async create(input: {
    country: string;
    currency: string;
    device: string;
    room_name?: string;
    appraisal_threshold?: number;
    second_country?: string;
    second_currency?: string;
  }) {
    const now = new Date().toISOString();
    const id = randomUUID();
    const state: SweepState = {
      id,
      captured_at: now,
      started_at: now,
      ended_at: null,
      ...input,
      room_name: input.room_name || "Library",
      appraisal_threshold: input.appraisal_threshold ?? 250,
      second_country:
        input.second_country || (input.country === "US" ? "GB" : "US"),
      second_currency:
        input.second_currency || (input.country === "US" ? "GBP" : "USD"),
      status: "capturing",
      frames: [],
      calibrations: [],
      room_input: {},
      books: [],
      items: [],
      room: emptyRoom(),
      review_queue: [],
      transcript: [],
      corrections: [],
      guidance: [],
      errors: [],
      metrics: [],
    };
    await fs.mkdir(path.join(this.dir(id), "frames"), { recursive: true });
    await fs.mkdir(path.join(this.dir(id), "stages"), { recursive: true });
    await fs.mkdir(path.join(this.dir(id), "sources"), { recursive: true });
    this.states.set(id, state);
    await this.save(state);
    return state;
  }
  async get(id: string) {
    this.dir(id);
    if (this.states.has(id)) return this.states.get(id)!;
    const state = JSON.parse(
      await fs.readFile(path.join(this.dir(id), "state.json"), "utf8"),
    ) as SweepState;
    // In-flight API work cannot survive a process restart; never silently label it complete.
    if (state.status === "processing") {
      state.status = "failed";
      state.errors.push(
        "Server restarted during finalization. Resume and finish again.",
      );
    }
    for (const f of state.frames)
      if (
        f.analysis_status === "processing" ||
        f.analysis_status === "queued"
      ) {
        f.analysis_status = "failed";
        f.error = "Server restarted before frame analysis completed.";
      }
    this.states.set(id, state);
    return state;
  }
  async list() {
    await fs.mkdir(this.root, { recursive: true });
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const states = await Promise.all(
      entries
        .filter((e) => e.isDirectory() && /^[a-f0-9-]{36}$/.test(e.name))
        .map(async (e) => {
          try {
            const s = await this.get(e.name);
            return {
              id: s.id,
              captured_at: s.captured_at,
              country: s.country,
              currency: s.currency,
              status: s.status,
            };
          } catch {
            return null;
          }
        }),
    );
    return states
      .filter((s) => s !== null)
      .sort((a, b) => b.captured_at.localeCompare(a.captured_at));
  }
  async save(state: SweepState) {
    const snapshot = JSON.stringify(state, null, 2);
    const dir = this.dir(state.id);
    const pending = (this.writes.get(state.id) || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "state.json.tmp"), snapshot);
        await fs.rename(
          path.join(dir, "state.json.tmp"),
          path.join(dir, "state.json"),
        );
      });
    this.writes.set(state.id, pending);
    await pending;
    this.events.emit(state.id, "state", state);
  }
  async evidence(id: string, name: string, data: unknown) {
    const clean = name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100);
    const relative = `sources/${Date.now()}-${randomUUID().slice(0, 8)}-${clean}.json`;
    await fs.writeFile(
      path.join(this.dir(id), relative),
      JSON.stringify(data, null, 2),
    );
    return `/evidence/${id}/${relative}`;
  }
  async stage(id: string, name: string, data: unknown) {
    await fs.writeFile(
      path.join(
        this.dir(id),
        "stages",
        `${name.replace(/[^A-Za-z0-9_-]/g, "_")}.json`,
      ),
      JSON.stringify(data, null, 2),
    );
  }
  guidance(state: SweepState, text: string) {
    if (state.guidance.at(-1) !== text) {
      state.guidance.push(text);
      state.guidance = state.guidance.slice(-30);
      this.events.emit(state.id, "guidance", { text });
    }
  }
}
export const store = new SweepStore();
