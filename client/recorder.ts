import type { SweepState } from "../shared/types";
import { money } from "./api";

type Snapshot = { sweep: SweepState | null; caption: string; shelf: string };
export type DemoRecorder = {
  addRemote: (stream: MediaStream) => void;
  stop: () => Promise<{ url: string; filename: string }>;
  cleanup: () => void;
};
export function startDemoRecorder(
  video: HTMLVideoElement,
  microphone: MediaStream,
  snapshot: () => Snapshot,
): DemoRecorder {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream)
    throw new Error(
      "This browser cannot record a demo. Use your device screen recorder with microphone and system audio.",
    );
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 900;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable.");
  const audio = new AudioContext();
  void audio.resume();
  const destination = audio.createMediaStreamDestination();
  const sources: MediaStreamAudioSourceNode[] = [];
  function addAudio(stream: MediaStream) {
    if (!stream.getAudioTracks().length) return;
    const source = audio.createMediaStreamSource(stream);
    source.connect(destination);
    sources.push(source);
  }
  addAudio(microphone);
  const output = canvas.captureStream(15);
  for (const track of destination.stream.getAudioTracks())
    output.addTrack(track);
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/mp4",
    "video/webm",
  ];
  const mimeType = candidates.find((value) =>
    MediaRecorder.isTypeSupported(value),
  );
  const recorder = new MediaRecorder(
    output,
    mimeType ? { mimeType, videoBitsPerSecond: 2500000 } : undefined,
  );
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  const started = Date.now();
  let stopped = false;
  function lines(
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    maxLines: number,
    lineHeight = 27,
  ): number {
    const words = text.split(/\s+/);
    let line = "";
    let count = 0;
    for (const word of words) {
      const next = `${line}${line ? " " : ""}${word}`;
      if (ctx!.measureText(next).width > maxWidth && line) {
        ctx!.fillText(line, x, y);
        y += lineHeight;
        count++;
        line = word;
        if (count >= maxLines - 1) break;
      } else line = next;
    }
    if (line) ctx!.fillText(line, x, y);
    return y + lineHeight;
  }
  function draw() {
    const current = snapshot();
    const state = current.sweep;
    ctx!.fillStyle = "#0d1724";
    ctx!.fillRect(0, 0, 1600, 900);
    if (video.readyState >= 2) {
      const scale = Math.min(1100 / video.videoWidth, 700 / video.videoHeight);
      const w = video.videoWidth * scale;
      const h = video.videoHeight * scale;
      ctx!.drawImage(video, (1100 - w) / 2 + 20, (700 - h) / 2 + 80, w, h);
    }
    ctx!.fillStyle = "#f3f7fb";
    ctx!.font = "bold 30px system-ui";
    ctx!.fillText("Library Claim · continuous live capture", 30, 45);
    ctx!.font = "21px system-ui";
    const elapsed = Math.floor((Date.now() - started) / 1000);
    ctx!.fillStyle = "#f1bc84";
    ctx!.fillText(
      `● REC ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}    ${state?.status || "Starting"}    ${current.shelf}`,
      30,
      80,
    );
    ctx!.fillStyle = "#b9c9dc";
    ctx!.font = "22px system-ui";
    lines(
      current.caption || "Agent voice and microphone are recorded live.",
      30,
      805,
      1050,
      3,
      28,
    );
    ctx!.fillStyle = "#16283a";
    ctx!.fillRect(1150, 0, 450, 900);
    ctx!.fillStyle = "#fff";
    ctx!.font = "bold 27px system-ui";
    ctx!.fillText("Live claim file", 1175, 45);
    ctx!.font = "21px system-ui";
    ctx!.fillText(
      `${state?.country || ""} ${state?.currency || ""} · ${state?.frames.length || 0} frames`,
      1175,
      80,
    );
    const included = state?.books.filter((book) => !book.excluded) || [];
    ctx!.fillText(
      `${included.length} books · ${state?.items.filter((item) => !item.excluded).length || 0} room items`,
      1175,
      116,
    );
    let y = 156;
    ctx!.font = "18px system-ui";
    for (const book of included.slice(-10)) {
      ctx!.fillStyle = book.status === "identified" ? "#d7eee7" : "#f0c887";
      y =
        lines(
          book.title || `Unidentified book · ${book.shelf}`,
          1175,
          y,
          390,
          2,
          24,
        ) + 8;
    }
    if (state?.packet) {
      const totals = state.packet.totals;
      ctx!.fillStyle = "#93dfc5";
      ctx!.font = "bold 24px system-ui";
      ctx!.fillText("PACKET READY", 1175, 620);
      ctx!.font = "20px system-ui";
      lines(
        `Books replacement: ${money(totals.books_replacement_cost, state.currency)}`,
        1175,
        660,
        390,
        2,
      );
      lines(
        `Books used: ${money(totals.books_used_value, state.currency)}`,
        1175,
        716,
        390,
        2,
      );
      ctx!.fillText(
        `Floor: ${state.room.floor_area_m2 == null ? "Unknown" : `${state.room.floor_area_m2.toFixed(2)} m²`}`,
        1175,
        775,
      );
      ctx!.fillText(`${state.review_queue.length} review flags`, 1175, 818);
      ctx!.font = "16px system-ui";
      ctx!.fillText("Sourced lines · unknowns excluded", 1175, 860);
    } else {
      ctx!.fillStyle = "#b9c9dc";
      ctx!.font = "19px system-ui";
      ctx!.fillText(
        `${state?.review_queue.length || 0} review flags`,
        1175,
        790,
      );
      lines(
        state?.guidance.at(-1) || "One pass. No invented prices or dimensions.",
        1175,
        830,
        390,
        2,
        24,
      );
    }
  }
  draw();
  const timer = window.setInterval(draw, 66);
  recorder.start(1000);
  const cleanup = () => {
    window.clearInterval(timer);
    for (const source of sources) source.disconnect();
    for (const track of output.getTracks()) track.stop();
    void audio.close();
  };
  return {
    addRemote: addAudio,
    cleanup,
    stop: () =>
      new Promise((resolve, reject) => {
        if (stopped) {
          reject(new Error("Recording was already stopped."));
          return;
        }
        stopped = true;
        recorder.onerror = () => {
          cleanup();
          reject(
            new Error(
              "Demo recording failed. Use the device screen recorder for another one-take run.",
            ),
          );
        };
        recorder.onstop = () => {
          cleanup();
          const blob = new Blob(chunks, { type: recorder.mimeType });
          resolve({
            url: URL.createObjectURL(blob),
            filename: `library-claim-demo-${new Date(started).toISOString().replace(/[:.]/g, "-")}.${recorder.mimeType.includes("mp4") ? "mp4" : "webm"}`,
          });
        };
        recorder.stop();
      }),
  };
}
