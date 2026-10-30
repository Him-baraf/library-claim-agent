import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCameraPreview } from "../client/camera-preview";

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
class Video extends EventTarget {
  readyState = 0;
  videoWidth = 0;
  paused = true;
  muted = false;
  defaultMuted = false;
  playsInline = false;
  autoplay = false;
  assignments = 0;
  private source: unknown = null;
  get srcObject() {
    return this.source;
  }
  set srcObject(value: unknown) {
    this.assignments++;
    this.source = value;
  }
  play = vi.fn<() => Promise<void>>(() => {
    this.paused = false;
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.fire("pause");
  });
  setAttribute = vi.fn();
  fire(type: string) {
    this.dispatchEvent(new Event(type));
  }
  frames() {
    this.readyState = 2;
    this.videoWidth = 1280;
    this.fire("canplay");
  }
}
const element = (video: Video) => video as unknown as HTMLVideoElement;
const media = () =>
  ({ getTracks: vi.fn(() => [{ stop: vi.fn() }]) }) as unknown as MediaStream;
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const abort = () =>
  new DOMException("The operation was aborted.", "AbortError");
function setup() {
  const state = vi.fn(),
    error = vi.fn();
  return { controller: createCameraPreview({ state, error }), state, error };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("camera preview lifecycle", () => {
  it("binds once and shares an in-flight play across repeated React attachment calls", async () => {
    const { controller, state } = setup(),
      video = new Video(),
      stream = media(),
      pending = deferred();
    video.play.mockImplementation(() => pending.promise);
    controller.setElement(element(video));
    controller.setStream(stream);
    controller.setElement(element(video));
    controller.setStream(stream);
    void controller.resume();
    expect(video.assignments).toBe(1);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(
      video.muted && video.defaultMuted && video.playsInline && video.autoplay,
    ).toBe(true);
    const playing = controller.whenPlaying();
    video.paused = false;
    video.frames();
    pending.resolve();
    await flush();
    expect(await playing).toBe(element(video));
    expect(state).toHaveBeenLastCalledWith("playing");
    controller.dispose();
  });
  it("waits for the React video mount and actual unpaused frames before returning readiness", async () => {
    const { controller } = setup(),
      video = new Video();
    controller.setStream(media());
    const playing = controller.whenPlaying();
    const resolved = vi.fn();
    void playing.then(resolved);
    controller.setElement(element(video));
    await flush();
    expect(resolved).not.toHaveBeenCalled();
    video.readyState = 2;
    video.videoWidth = 1280;
    video.paused = true;
    video.fire("canplay");
    await flush();
    expect(resolved).not.toHaveBeenCalled();
    video.paused = false;
    video.fire("playing");
    await flush();
    expect(resolved).toHaveBeenCalledWith(element(video));
    controller.dispose();
  });
  it("ignores a pending old video rejection after React remount and never stops capture tracks", async () => {
    const { controller, error } = setup(),
      oldVideo = new Video(),
      nextVideo = new Video(),
      stream = media(),
      old = deferred();
    oldVideo.play.mockImplementation(() => old.promise);
    controller.setElement(element(oldVideo));
    controller.setStream(stream);
    const ready = controller.whenPlaying();
    controller.setElement(null);
    controller.setElement(element(nextVideo));
    old.reject(abort());
    await flush();
    nextVideo.frames();
    await flush();
    expect(await ready).toBe(element(nextVideo));
    expect(error).not.toHaveBeenCalled();
    expect(oldVideo.srcObject).toBeNull();
    expect(stream.getTracks).not.toHaveBeenCalled();
    controller.dispose();
  });
  it("ignores an aborted play from a superseded stream", async () => {
    const { controller, error } = setup(),
      video = new Video(),
      old = deferred();
    video.play.mockImplementationOnce(() => old.promise);
    controller.setElement(element(video));
    controller.setStream(media());
    const next = media();
    controller.setStream(next);
    old.reject(abort());
    await flush();
    video.frames();
    await flush();
    expect(await controller.whenPlaying()).toBe(element(video));
    expect(video.srcObject).toBe(next);
    expect(error).not.toHaveBeenCalled();
    controller.dispose();
  });
  it("retries one transient AbortError without assigning the stream again", async () => {
    const { controller, error, state } = setup(),
      video = new Video();
    video.play.mockRejectedValueOnce(abort());
    controller.setElement(element(video));
    controller.setStream(media());
    await flush();
    expect(video.assignments).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    video.frames();
    await flush();
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(video.assignments).toBe(1);
    expect(error).not.toHaveBeenCalled();
    expect(state).toHaveBeenLastCalledWith("playing");
    controller.dispose();
  });
  it("bounds repeated AbortError recovery and asks for a manual tap", async () => {
    const { controller, error, state } = setup(),
      video = new Video();
    video.play.mockRejectedValue(abort());
    controller.setElement(element(video));
    controller.setStream(media());
    await flush();
    await vi.advanceTimersByTimeAsync(50);
    await flush();
    video.fire("canplay");
    await vi.advanceTimersByTimeAsync(500);
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(state).toHaveBeenLastCalledWith("needs_tap");
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Resume camera preview"),
    );
    controller.dispose();
  });
  it("keeps a NotAllowed stream and resumes synchronously from a user tap", async () => {
    const { controller, state, error } = setup(),
      video = new Video(),
      stream = media();
    video.play.mockRejectedValueOnce(
      new DOMException("Not allowed", "NotAllowedError"),
    );
    controller.setElement(element(video));
    controller.setStream(stream);
    await flush();
    expect(state).toHaveBeenLastCalledWith("needs_tap");
    expect(error).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBe(stream);
    const resumed = controller.resume();
    expect(video.play).toHaveBeenCalledTimes(2);
    await resumed;
    video.frames();
    await flush();
    expect(await controller.whenPlaying()).toBe(element(video));
    expect(video.assignments).toBe(1);
    controller.dispose();
  });
  it("shows current hardware/browser playback errors without an automatic retry loop", async () => {
    const { controller, state, error } = setup(),
      video = new Video();
    video.play.mockRejectedValue(new Error("Decoder failed"));
    controller.setElement(element(video));
    controller.setStream(media());
    await flush();
    video.fire("canplay");
    await flush();
    expect(state).toHaveBeenLastCalledWith("needs_tap");
    expect(error).toHaveBeenCalledTimes(1);
    expect(video.play).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
  it("does not remain falsely playing after pause, waiting, or emptied events", async () => {
    const { controller, state } = setup(),
      video = new Video();
    controller.setElement(element(video));
    controller.setStream(media());
    await flush();
    video.frames();
    await flush();
    expect(state).toHaveBeenLastCalledWith("playing");
    video.fire("waiting");
    expect(state).toHaveBeenLastCalledWith("waiting");
    video.fire("canplay");
    expect(state).toHaveBeenLastCalledWith("playing");
    video.paused = true;
    video.fire("pause");
    expect(state).toHaveBeenLastCalledWith("needs_tap");
    await controller.resume();
    video.fire("canplay");
    expect(state).toHaveBeenLastCalledWith("playing");
    video.readyState = 0;
    video.fire("emptied");
    expect(state).toHaveBeenLastCalledWith("waiting");
    controller.dispose();
  });
  it("times out readiness with a recoverable UI state instead of waiting forever", async () => {
    const { controller, state } = setup();
    controller.setStream(media());
    const ready = controller.whenPlaying(100);
    const rejected = expect(ready).rejects.toThrow("Resume camera preview");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(state).toHaveBeenLastCalledWith("needs_tap");
    controller.dispose();
  });
  it("allows a user tap to recover from a play promise that never settled before timeout", async () => {
    const { controller, error } = setup(),
      video = new Video(),
      old = deferred();
    video.play.mockImplementationOnce(() => old.promise);
    controller.setElement(element(video));
    controller.setStream(media());
    const waiting = controller.whenPlaying(100);
    const rejected = expect(waiting).rejects.toThrow("Resume camera preview");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    await controller.resume();
    expect(video.play).toHaveBeenCalledTimes(2);
    video.frames();
    old.reject(abort());
    await flush();
    expect(await controller.whenPlaying()).toBe(element(video));
    expect(error).not.toHaveBeenCalled();
    controller.dispose();
  });
  it("disposes listeners, retry timers, and readiness waiters while ignoring late play results", async () => {
    const { controller, error } = setup(),
      video = new Video(),
      pending = deferred();
    video.play.mockImplementation(() => pending.promise);
    controller.setElement(element(video));
    controller.setStream(media());
    const wait = controller.whenPlaying();
    const rejected = expect(wait).rejects.toThrow("closed");
    controller.dispose();
    await rejected;
    pending.reject(abort());
    video.fire("playing");
    video.frames();
    await flush();
    expect(video.srcObject).toBeNull();
    expect(error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await expect(controller.whenPlaying()).rejects.toThrow("closed");
  });
  it("rejects waiting consumers when capture disconnects without stopping tracks itself", async () => {
    const { controller } = setup(),
      stream = media();
    controller.setStream(stream);
    const wait = controller.whenPlaying();
    const rejected = expect(wait).rejects.toThrow("not connected");
    controller.setStream(null);
    await rejected;
    expect(stream.getTracks).not.toHaveBeenCalled();
    controller.dispose();
  });
});
