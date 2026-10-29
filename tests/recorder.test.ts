import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareRecordingAudio, startDemoRecorder } from "../client/recorder";
class Track {
  stop = vi.fn();
}
class Stream {
  tracks = [new Track()];
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
  addTrack(track: Track) {
    this.tracks.push(track);
  }
}
let audio: FakeAudio;
class FakeAudio {
  state = "suspended";
  onstatechange: (() => void) | null = null;
  shouldResume = true;
  sources: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  destination = { stream: new Stream() };
  constructor() {
    audio = this;
  }
  resume = vi.fn(async () => {
    if (this.shouldResume) this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
  createMediaStreamDestination() {
    return this.destination;
  }
  createMediaStreamSource() {
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    this.sources.push(source);
    return source;
  }
}
let nativeRecorder: FakeRecorder;
class FakeRecorder {
  static fail = false;
  static isTypeSupported = (type: string) => type === "video/mp4";
  state = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, options: { mimeType?: string } = {}) {
    if (FakeRecorder.fail) throw new Error("Encoder unavailable");
    this.mimeType = options.mimeType || "video/mp4";
    nativeRecorder = this;
  }
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob(["demo"], { type: this.mimeType }),
    });
    this.onstop?.();
  });
}
const output = () => new Stream();
let canvasOutput: Stream;
class Canvas {
  width = 0;
  height = 0;
  captureStream() {
    canvasOutput = output();
    return canvasOutput;
  }
  getContext() {
    return {
      fillRect() {},
      drawImage() {},
      fillText() {},
      measureText: (text: string) => ({ width: text.length }),
    };
  }
}
const video = {
  readyState: 2,
  videoWidth: 1280,
  videoHeight: 720,
} as HTMLVideoElement;
const snapshot = () => ({ sweep: null, caption: "", shelf: "Shelf 1" });
beforeEach(() => {
  vi.useFakeTimers();
  FakeRecorder.fail = false;
  vi.stubGlobal("AudioContext", FakeAudio);
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("HTMLCanvasElement", Canvas);
  vi.stubGlobal("window", {
    MediaRecorder: FakeRecorder,
    setInterval,
    clearInterval,
  });
  vi.stubGlobal("document", { createElement: () => new Canvas() });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recorded-demo");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("gesture-prepared recording audio", () => {
  it("invokes resume synchronously before caller awaits camera or network and closes unused preparation once", async () => {
    const prepared = prepareRecordingAudio();
    expect(audio.resume).toHaveBeenCalledOnce();
    expect(audio.state).toBe("running");
    await prepared.ready;
    prepared.cleanup();
    prepared.cleanup();
    expect(audio.close).toHaveBeenCalledOnce();
  });
  it("reports a still-suspended context instead of accepting silent audio", async () => {
    vi.spyOn(FakeAudio.prototype, "createMediaStreamDestination");
    const prepared = prepareRecordingAudio();
    await prepared.ready;
    audio.state = "suspended";
    expect(() =>
      startDemoRecorder(
        video,
        new Stream() as unknown as MediaStream,
        snapshot,
        prepared,
      ),
    ).toThrow("audio is not running");
    expect(audio.close).toHaveBeenCalledOnce();
  });
  it("bounds a pending resume and makes it possible to retry from a later gesture", async () => {
    const prepared = prepareRecordingAudio();
    await prepared.ready;
    audio.state = "suspended";
    audio.resume.mockImplementationOnce(() => new Promise(() => undefined));
    const attempt = prepared.resumeAudio();
    const assertion = expect(attempt).rejects.toThrow("audio is not running");
    await vi.advanceTimersByTimeAsync(1500);
    await assertion;
    await prepared.resumeAudio();
    expect(audio.state).toBe("running");
    prepared.cleanup();
  });
  it("records microphone and remote tracks, warns on suspension, and resumes recording audio", async () => {
    const prepared = prepareRecordingAudio();
    await prepared.ready;
    const microphone = new Stream(),
      remote = new Stream(),
      warning = vi.fn();
    const recorder = startDemoRecorder(
      video,
      microphone as unknown as MediaStream,
      snapshot,
      prepared,
      warning,
    );
    recorder.addRemote(remote as unknown as MediaStream);
    expect(audio.sources).toHaveLength(2);
    expect(nativeRecorder.start).toHaveBeenCalledWith(1000);
    audio.state = "suspended";
    audio.onstatechange?.();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("audio was interrupted"),
    );
    await recorder.resumeAudio();
    expect(audio.state).toBe("running");
    const result = await recorder.stop();
    expect(result.filename).toMatch(/\.mp4$/);
    expect(result.url).toBe("blob:recorded-demo");
    expect(audio.close).toHaveBeenCalledOnce();
    expect(
      canvasOutput
        .getTracks()
        .every((track) => track.stop.mock.calls.length === 1),
    ).toBe(true);
    expect(microphone.getTracks()[0].stop).not.toHaveBeenCalled();
  });
  it("exposes a failed resume as a visible recording issue", async () => {
    const prepared = prepareRecordingAudio();
    await prepared.ready;
    const warning = vi.fn();
    const recorder = startDemoRecorder(
      video,
      new Stream() as unknown as MediaStream,
      snapshot,
      prepared,
      warning,
    );
    audio.state = "suspended";
    audio.shouldResume = false;
    await expect(recorder.resumeAudio()).rejects.toThrow(
      "audio is not running",
    );
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Tap Enable speaker"),
    );
    recorder.cleanup();
  });
  it("releases output tracks and prepared audio if encoder setup fails", async () => {
    const prepared = prepareRecordingAudio();
    await prepared.ready;
    FakeRecorder.fail = true;
    expect(() =>
      startDemoRecorder(
        video,
        new Stream() as unknown as MediaStream,
        snapshot,
        prepared,
      ),
    ).toThrow("Encoder unavailable");
    expect(audio.close).toHaveBeenCalledOnce();
    expect(
      canvasOutput
        .getTracks()
        .every((track) => track.stop.mock.calls.length === 1),
    ).toBe(true);
    expect(audio.sources[0].disconnect).toHaveBeenCalledOnce();
  });
  it("closes prepared audio when browser recording is unsupported", async () => {
    const prepared = prepareRecordingAudio();
    await prepared.ready;
    vi.stubGlobal("window", {});
    expect(() =>
      startDemoRecorder(
        video,
        new Stream() as unknown as MediaStream,
        snapshot,
        prepared,
      ),
    ).toThrow("cannot record a demo");
    expect(audio.close).toHaveBeenCalledOnce();
  });
});
