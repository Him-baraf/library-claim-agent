import type { SweepState } from "../shared/types";
import { api } from "./api";

export type LiveStateCallbacks = {
  state: (state: SweepState) => void;
  guidance: (text: string) => void;
  status: (message: string) => void;
  error: (message: string) => void;
};
export type LiveStateOptions = {
  source?: (url: string) => EventSource;
  fetchState?: (signal: AbortSignal) => Promise<SweepState>;
  staleAfterMs?: number;
  pollEveryMs?: number;
};
function isSweepState(value: unknown, id: string): value is SweepState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SweepState>;
  return (
    candidate.id === id &&
    ["capturing", "processing", "complete", "failed"].includes(
      candidate.status || "",
    ) &&
    [
      "frames",
      "books",
      "items",
      "guidance",
      "metrics",
      "review_queue",
      "calibrations",
      "transcript",
      "corrections",
      "errors",
    ].every((key) => Array.isArray(candidate[key as keyof SweepState]))
  );
}

/** Fall back when SSE opens but a proxy buffers its events; no device access is involved. */
export function subscribeToSweep(
  id: string,
  callbacks: LiveStateCallbacks,
  options: LiveStateOptions = {},
): () => void {
  const url = `/api/sweeps/${encodeURIComponent(id)}`;
  const fetchState =
    options.fetchState ||
    ((signal: AbortSignal) => api<SweepState>(url, { signal }));
  const staleAfterMs = options.staleAfterMs ?? 5000;
  const pollEveryMs = options.pollEveryMs ?? 2000;
  let closed = false;
  let polling = false;
  let source: EventSource | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let lastState = "";
  let lastGuidance: string | undefined;
  let lastPollingError = "";
  const deliverGuidance = (text: unknown) => {
    if (typeof text !== "string" || !text || text === lastGuidance) return;
    lastGuidance = text;
    callbacks.guidance(text);
  };
  const deliverState = (state: SweepState) => {
    const signature = JSON.stringify(state);
    if (signature !== lastState) {
      lastState = signature;
      callbacks.state(state);
    }
    // Saved guidance keeps spoken capture cues available through non-streaming proxies.
    deliverGuidance(state.guidance.at(-1));
  };
  const stopPolling = () => {
    polling = false;
    if (pollTimer) clearTimeout(pollTimer);
    request?.abort();
    request = undefined;
  };
  const poll = async () => {
    if (closed || !polling || request) return;
    const controller = new AbortController();
    request = controller;
    try {
      const state = await fetchState(controller.signal);
      if (closed || !polling || controller.signal.aborted) return;
      if (!isSweepState(state, id))
        throw new Error("The saved sweep response was not valid.");
      lastPollingError = "";
      deliverState(state);
      callbacks.status("Live updates via polling");
    } catch (error) {
      if (closed || controller.signal.aborted) return;
      callbacks.status("Live updates retrying…");
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastPollingError) {
        lastPollingError = message;
        callbacks.error(`Inventory refresh: ${message}`);
      }
    } finally {
      const currentRequest = request === controller;
      if (currentRequest) request = undefined;
      if (currentRequest && !closed && polling)
        pollTimer = setTimeout(() => void poll(), pollEveryMs);
    }
  };
  const startPolling = () => {
    if (closed || polling) return;
    polling = true;
    callbacks.status("Live updates via polling");
    void poll();
  };
  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(startPolling, staleAfterMs);
  };
  callbacks.status("Connecting live updates…");
  armWatchdog();
  try {
    source = (
      options.source || ((endpoint: string) => new EventSource(endpoint))
    )(`${url}/events`);
    source.addEventListener("state", (event) => {
      if (closed) return;
      try {
        const state: unknown = JSON.parse((event as MessageEvent).data);
        if (!isSweepState(state, id)) throw new Error("Invalid sweep update");
        // An open connection is insufficient: only an actual valid state event proves SSE works.
        stopPolling();
        armWatchdog();
        deliverState(state);
        callbacks.status("Live updates connected");
      } catch {
        callbacks.error(
          "An inventory update could not be read; checking the saved sweep.",
        );
        startPolling();
      }
    });
    source.addEventListener("guidance", (event) => {
      if (closed) return;
      try {
        const payload: unknown = JSON.parse((event as MessageEvent).data);
        deliverGuidance(
          typeof payload === "string"
            ? payload
            : (payload as { text?: string } | null)?.text,
        );
      } catch {
        /* A bad cue must not interrupt capture or polling. */
      }
    });
    source.addEventListener("error", (event) => {
      if (closed) return;
      const data = (event as MessageEvent).data;
      if (typeof data === "string" && data) {
        try {
          const payload = JSON.parse(data);
          if (typeof payload.message === "string")
            callbacks.error(payload.message);
        } catch {
          /* Network errors have no JSON body. */
        }
      }
      startPolling();
    });
    source.addEventListener("open", () => {
      if (!closed && !polling) callbacks.status("Waiting for live inventory…");
    });
  } catch {
    startPolling();
  }
  return () => {
    closed = true;
    if (watchdog) clearTimeout(watchdog);
    stopPolling();
    source?.close();
  };
}
