export type CameraPreviewState = "off" | "waiting" | "playing" | "needs_tap";
export type CameraPreviewCallbacks = {
  state: (state: CameraPreviewState) => void;
  error: (message: string) => void;
};
export type CameraPreview = {
  setElement: (element: HTMLVideoElement | null) => void;
  setStream: (stream: MediaStream | null) => void;
  resume: () => Promise<void>;
  whenPlaying: (timeoutMs?: number) => Promise<HTMLVideoElement>;
  dispose: () => void;
};
type Binding = {
  video: HTMLVideoElement;
  stream: MediaStream;
  pending?: Promise<void>;
  retry?: ReturnType<typeof setTimeout>;
  retries: number;
  attempt: number;
  playAccepted: boolean;
  needsTap: boolean;
  listeners: [string, EventListener][];
};
type Waiter = {
  resolve: (video: HTMLVideoElement) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const ready = (video: HTMLVideoElement) =>
  video.readyState >= 2 && video.videoWidth > 0 && !video.paused;
const aborted = (error: unknown) =>
  (error as { name?: string } | null)?.name === "AbortError";
const readinessMessage =
  "Camera preview is not ready yet. Tap Resume camera preview and try again.";

/** One owner for camera preview attachment; this controller never stops capture tracks. */
export function createCameraPreview(
  callbacks: CameraPreviewCallbacks,
): CameraPreview {
  let element: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;
  let binding: Binding | undefined;
  let disposed = false;
  let state: CameraPreviewState = "off";
  const waiters = new Set<Waiter>();
  const emit = (next: CameraPreviewState) => {
    if (state === next) return;
    state = next;
    callbacks.state(next);
  };
  const current = (candidate: Binding) => !disposed && binding === candidate;
  const rejectWaiters = (message: string) => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    waiters.clear();
  };
  const markReady = (candidate: Binding) => {
    if (
      !current(candidate) ||
      !candidate.playAccepted ||
      !ready(candidate.video)
    )
      return;
    candidate.needsTap = false;
    if (candidate.retry) {
      clearTimeout(candidate.retry);
      candidate.retry = undefined;
    }
    emit("playing");
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(candidate.video);
    }
    waiters.clear();
  };
  const requireTap = (candidate: Binding, error: unknown) => {
    if (!current(candidate)) return;
    candidate.needsTap = true;
    candidate.playAccepted = false;
    if (candidate.retry) {
      clearTimeout(candidate.retry);
      candidate.retry = undefined;
    }
    const wasBlocked = state === "needs_tap";
    emit("needs_tap");
    if (!wasBlocked) {
      const name = (error as { name?: string } | null)?.name;
      callbacks.error(
        name === "NotAllowedError"
          ? "Camera preview needs a tap to start. Tap Resume camera preview."
          : aborted(error)
            ? "Camera preview was interrupted. Tap Resume camera preview to continue."
            : "Camera preview could not start. Tap Resume camera preview to try again.",
      );
    }
  };
  const attempt = (candidate: Binding): Promise<void> => {
    if (!current(candidate)) return Promise.resolve();
    if (candidate.pending) return candidate.pending;
    candidate.needsTap = false;
    candidate.playAccepted = false;
    emit("waiting");
    const operation = ++candidate.attempt;
    let play: Promise<void>;
    try {
      play = Promise.resolve(candidate.video.play());
    } catch (error) {
      play = Promise.reject(error);
    }
    const pending = play
      .then(() => {
        if (!current(candidate) || candidate.attempt !== operation) return;
        candidate.pending = undefined;
        candidate.playAccepted = true;
        markReady(candidate);
      })
      .catch((error: unknown) => {
        if (!current(candidate) || candidate.attempt !== operation) return;
        candidate.pending = undefined;
        // A playing event can precede a rejected superseded play promise in WebKit.
        if (aborted(error) && candidate.playAccepted && ready(candidate.video))
          return;
        if (aborted(error) && candidate.retries < 1) {
          candidate.retries++;
          candidate.retry = setTimeout(
            () => {
              candidate.retry = undefined;
              if (current(candidate) && !candidate.needsTap)
                void attempt(candidate);
            },
            ready(candidate.video) ? 0 : 50,
          );
          return;
        }
        requireTap(candidate, error);
      });
    candidate.pending = pending;
    return pending;
  };
  const release = () => {
    const previous = binding;
    binding = undefined;
    if (!previous) return;
    if (previous.retry) clearTimeout(previous.retry);
    for (const [name, listener] of previous.listeners)
      previous.video.removeEventListener(name, listener);
    try {
      previous.video.pause();
    } catch {
      /* A detached element may no longer accept playback operations. */
    }
    if (previous.video.srcObject === previous.stream)
      previous.video.srcObject = null;
  };
  const bind = () => {
    release();
    if (disposed || !stream) {
      emit("off");
      return;
    }
    emit("waiting");
    if (!element) return;
    const candidate: Binding = {
      video: element,
      stream,
      retries: 0,
      attempt: 0,
      playAccepted: false,
      needsTap: false,
      listeners: [],
    };
    binding = candidate;
    const attached = () =>
      current(candidate) && candidate.video.srcObject === candidate.stream;
    const onReady = () => {
      if (!attached()) return;
      markReady(candidate);
      if (
        !candidate.playAccepted &&
        !candidate.pending &&
        !candidate.needsTap
      ) {
        if (candidate.retry) {
          clearTimeout(candidate.retry);
          candidate.retry = undefined;
        }
        void attempt(candidate);
      }
    };
    const onPlaying = () => {
      if (!attached()) return;
      candidate.playAccepted = true;
      markReady(candidate);
    };
    const onPause = () => {
      if (!attached()) return;
      candidate.playAccepted = false;
      candidate.needsTap = true;
      emit("needs_tap");
    };
    const onWaiting = () => {
      if (attached()) emit("waiting");
    };
    const onEmptied = () => {
      if (!attached()) return;
      candidate.playAccepted = false;
      emit("waiting");
    };
    candidate.listeners = [
      ["loadedmetadata", onReady],
      ["canplay", onReady],
      ["playing", onPlaying],
      ["pause", onPause],
      ["waiting", onWaiting],
      ["emptied", onEmptied],
    ];
    for (const [name, listener] of candidate.listeners)
      element.addEventListener(name, listener);
    element.muted = true;
    element.defaultMuted = true;
    element.playsInline = true;
    element.autoplay = true;
    element.setAttribute("playsinline", "");
    element.setAttribute("webkit-playsinline", "");
    if (element.srcObject !== stream) element.srcObject = stream;
    void attempt(candidate);
  };
  return {
    setElement(next) {
      if (disposed || element === next) return;
      element = next;
      bind();
    },
    setStream(next) {
      if (disposed || stream === next) return;
      stream = next;
      bind();
      if (!next)
        rejectWaiters(
          "Camera is not connected. Start or resume camera capture.",
        );
    },
    resume() {
      if (disposed || !binding) return Promise.resolve();
      binding.retries = 0;
      binding.needsTap = false;
      if (binding.video.srcObject !== binding.stream)
        binding.video.srcObject = binding.stream;
      if (binding.retry) {
        clearTimeout(binding.retry);
        binding.retry = undefined;
      }
      // Calling play happens synchronously here, retaining the user's tap gesture.
      return attempt(binding);
    },
    whenPlaying(timeoutMs = 10000) {
      if (disposed)
        return Promise.reject(new Error("Camera preview has been closed."));
      if (!stream)
        return Promise.reject(
          new Error("Camera is not connected. Start or resume camera capture."),
        );
      if (binding?.playAccepted && ready(binding.video))
        return Promise.resolve(binding.video);
      const delay =
        Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000;
      return new Promise<HTMLVideoElement>((resolve, reject) => {
        const waiter: Waiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            if (!disposed && state !== "playing") {
              if (binding) binding.needsTap = true;
              if (binding) {
                // Permit a new user-gesture attempt even if WebKit left an old play promise pending.
                binding.attempt++;
                binding.pending = undefined;
                if (binding.retry) {
                  clearTimeout(binding.retry);
                  binding.retry = undefined;
                }
              }
              emit("needs_tap");
            }
            reject(new Error(readinessMessage));
          }, delay),
        };
        waiters.add(waiter);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      release();
      element = null;
      stream = null;
      rejectWaiters("Camera preview has been closed.");
      emit("off");
    },
  };
}
