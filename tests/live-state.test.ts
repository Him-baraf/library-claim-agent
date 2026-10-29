import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeToSweep } from "../client/live-state";
import type { SweepState } from "../shared/types";
import { state } from "./domain-fixtures";
class Source {
  listeners = new Map<string, ((event: Event) => void)[]>();
  close = vi.fn();
  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }
  event(type: string, data?: unknown) {
    for (const handler of this.listeners.get(type) || [])
      handler({
        data: data === undefined ? undefined : JSON.stringify(data),
      } as unknown as Event);
  }
}
let source: Source;
const callbacks = () => ({
  state: vi.fn(),
  guidance: vi.fn(),
  status: vi.fn(),
  error: vi.fn(),
});
const snapshot = (override: Partial<SweepState> = {}) => state({ ...override });
const options = (fetchState: (signal: AbortSignal) => Promise<SweepState>) => ({
  source: () => source as unknown as EventSource,
  fetchState,
});
beforeEach(() => {
  vi.useFakeTimers();
  source = new Source();
});
afterEach(() => vi.useRealTimers());
describe("streaming inventory with polling fallback", () => {
  it("polls after five seconds even when an SSE connection opens without a state event", async () => {
    const hooks = callbacks(),
      fetchState = vi.fn(async () => snapshot());
    const stop = subscribeToSweep("s1", hooks, options(fetchState));
    source.event("open");
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchState).toHaveBeenCalledTimes(1);
    expect(hooks.state).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchState).toHaveBeenCalledTimes(2);
    expect(hooks.state).toHaveBeenCalledTimes(1);
    stop();
  });
  it("refreshes the watchdog only on valid state events", async () => {
    const hooks = callbacks(),
      fetchState = vi.fn(async () => snapshot());
    const stop = subscribeToSweep("s1", hooks, options(fetchState));
    await vi.advanceTimersByTimeAsync(4000);
    source.event("state", snapshot());
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchState).toHaveBeenCalledTimes(1);
    stop();
  });
  it("has one polling request in flight, aborts on cleanup, and ignores a late response", async () => {
    const hooks = callbacks();
    let release!: (s: SweepState) => void;
    const fetchState = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<SweepState>((resolve) => {
          release = resolve;
        }),
    );
    const stop = subscribeToSweep("s1", hooks, options(fetchState));
    await vi.advanceTimersByTimeAsync(15000);
    expect(fetchState).toHaveBeenCalledTimes(1);
    const signal = fetchState.mock.calls[0][0];
    stop();
    expect(signal.aborted).toBe(true);
    expect(source.close).toHaveBeenCalledOnce();
    release(snapshot());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10000);
    expect(hooks.state).not.toHaveBeenCalled();
    expect(fetchState).toHaveBeenCalledTimes(1);
  });
  it("stops fallback when SSE recovers and cannot overwrite a newer event with an old polled state", async () => {
    const hooks = callbacks();
    let release!: (s: SweepState) => void;
    const fetchState = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<SweepState>((resolve) => {
          release = resolve;
        }),
    );
    const stop = subscribeToSweep("s1", hooks, options(fetchState));
    await vi.advanceTimersByTimeAsync(5000);
    const newer = snapshot({ room_name: "Newer SSE revision" });
    source.event("state", newer);
    expect(fetchState.mock.calls[0][0].aborted).toBe(true);
    release(snapshot({ room_name: "Stale polled revision" }));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchState).toHaveBeenCalledTimes(1);
    expect(hooks.state).toHaveBeenLastCalledWith(newer);
    expect(hooks.state).toHaveBeenCalledTimes(1);
    stop();
  });
  it("uses saved guidance through polling and deduplicates it against SSE guidance events", async () => {
    const hooks = callbacks(),
      fetchState = vi.fn(async () => snapshot({ guidance: ["Move closer"] }));
    const stop = subscribeToSweep("s1", hooks, options(fetchState));
    source.event("state", snapshot({ guidance: ["Slow down"] }));
    source.event("guidance", { text: "Slow down" });
    expect(hooks.guidance.mock.calls).toEqual([["Slow down"]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(hooks.guidance.mock.calls).toEqual([["Slow down"], ["Move closer"]]);
    source.event("guidance", { text: "Move closer" });
    expect(hooks.guidance).toHaveBeenCalledTimes(2);
    stop();
  });
  it("falls back for invalid/mismatched events and never supplies them to the UI", async () => {
    const hooks = callbacks(),
      fetchState = vi.fn(async () => snapshot());
    const stop = subscribeToSweep("s1", hooks, options(fetchState));
    source.event("state", snapshot({ id: "another-sweep" }));
    await Promise.resolve();
    expect(fetchState).toHaveBeenCalledOnce();
    expect(hooks.state).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
    );
    expect(hooks.error).toHaveBeenCalledOnce();
    stop();
  });
  it("uses polling if streaming is unsupported and reports repeated network failures only once", async () => {
    const hooks = callbacks(),
      fetchState = vi.fn(async () => {
        throw new Error("Network unavailable");
      });
    const stop = subscribeToSweep("s1", hooks, {
      source: () => {
        throw new Error("EventSource unavailable");
      },
      fetchState,
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchState).toHaveBeenCalledTimes(3);
    expect(hooks.error).toHaveBeenCalledTimes(1);
    stop();
  });
  it("clears a pending watchdog when leaving a sweep", async () => {
    const hooks = callbacks(),
      fetchState = vi.fn(async () => snapshot());
    const stop = subscribeToSweep("s1", hooks, options(fetchState));
    stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchState).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledOnce();
  });
});
