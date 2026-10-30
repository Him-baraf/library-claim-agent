import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectVoice } from "../client/voice";
import { CAPTURE_INSTRUCTIONS } from "../shared/capture-guidance";
class Channel {
  readyState = "open";
  bufferedAmount = 0;
  send = vi.fn<(value: string) => void>();
  close = vi.fn();
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  event(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  messages() {
    return this.send.mock.calls.map(([value]) => JSON.parse(value));
  }
  responses() {
    return this.messages().filter((value) => value.type === "response.create");
  }
}
let channel: Channel;
class Peer {
  connectionState = "new";
  ontrack = null;
  onconnectionstatechange = null;
  createDataChannel() {
    channel = new Channel();
    return channel;
  }
  addTrack() {}
  async createOffer() {
    return { sdp: "v=0" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {}
}
class AudioOutput {
  autoplay = false;
  srcObject = null;
  async play() {}
  pause() {}
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("Audio", AudioOutput);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith("/realtime") ? "v=0" : JSON.stringify({ ok: true }),
          { status: 200 },
        ),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const callbacks = () => ({
  status: vi.fn(),
  caption: vi.fn(),
  correction: vi.fn(async () => ({ ok: true })),
  shelf: vi.fn(),
  finish: vi.fn(async () => ({ ok: true })),
  error: vi.fn(),
  remote: vi.fn(),
});
const stream = { getAudioTracks: () => [] } as unknown as MediaStream;
const done = () =>
  channel.event({ type: "response.done", response: { output: [] } });

describe("quiet voice scheduling", () => {
  it("keeps inventory context silent and separates it from claimant speech", async () => {
    const session = await connectVoice("test", stream, callbacks());
    session.sayContext("Latest inventory: three books, prices and confidence.");
    session.sayContext("Shelf 2 is now active.");
    expect(channel.responses()).toHaveLength(0);
    const messages = channel
      .messages()
      .filter((value) => value.type === "conversation.item.create");
    expect(messages).toHaveLength(2);
    expect(messages.every((value) => value.item.role === "system")).toBe(true);
    expect(messages[0].item.content[0].text).toContain(
      "Do not acknowledge, narrate, quote, or read this aloud",
    );
    expect(messages[0].item.content[0].text).toContain("untrusted data");
    session.close();
  });
  it("refuses to speak raw JSON or long backend explanations even when marked speak", async () => {
    const session = await connectVoice("test", stream, callbacks());
    session.sayContext('{"book_count":3,"id_confidence":0.9}', true);
    session.sayContext(
      "This is a very long internal explanation ".repeat(20),
      true,
    );
    expect(channel.responses()).toHaveLength(0);
    session.close();
  });
  it("opens with one bounded short locale-confirming instruction", async () => {
    const session = await connectVoice("test", stream, callbacks());
    channel.onopen?.();
    const greeting = channel.responses();
    expect(greeting).toHaveLength(1);
    expect(greeting[0].response.max_output_tokens).toBe(384);
    expect(greeting[0].response.instructions).toContain(
      "one sentence of at most 20 words",
    );
    expect(greeting[0].response.instructions).not.toContain("whole workflow");
    expect(greeting[0].response.instructions).toContain(
      "available book spines",
    );
    expect(greeting[0].response.instructions).toContain("that’s all");
    session.close();
  });
  it("spaces automatic cues by twenty seconds, including after the greeting", async () => {
    const session = await connectVoice("test", stream, callbacks());
    channel.onopen?.();
    session.sayContext("Move closer to the shelf.", true);
    done();
    expect(channel.responses()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(19999);
    expect(channel.responses()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(channel.responses()).toHaveLength(2);
    expect(channel.responses()[1].response.instructions).toContain(
      "Move closer to the shelf.",
    );
    expect(channel.responses()[1].response.max_output_tokens).toBe(384);
    session.close();
  });
  it("keeps only the latest necessary cue while the claimant speaks", async () => {
    const session = await connectVoice("test", stream, callbacks());
    channel.event({ type: "input_audio_buffer.speech_started" });
    session.sayContext("Tilt away from the glare.", true);
    session.sayContext("Show the next shelf slowly.", true);
    expect(channel.responses()).toHaveLength(0);
    channel.event({ type: "input_audio_buffer.speech_stopped" });
    done();
    expect(channel.responses()).toHaveLength(1);
    expect(channel.responses()[0].response.instructions).toContain(
      "Show the next shelf slowly.",
    );
    session.close();
  });
  it("does not repeat the same cue for a minute despite case, whitespace or punctuation changes", async () => {
    const session = await connectVoice("test", stream, callbacks());
    session.sayContext("Move closer to the shelf.", true);
    done();
    await vi.advanceTimersByTimeAsync(20000);
    session.sayContext("  MOVE closer   to the shelf! ", true);
    expect(channel.responses()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40000);
    session.sayContext("Move closer to the shelf.", true);
    expect(channel.responses()).toHaveLength(2);
    session.close();
  });
  it("records successful tools once and never speaks an automatic acknowledgement", async () => {
    const hooks = callbacks();
    const session = await connectVoice("test", stream, hooks);
    channel.onopen?.();
    const call = {
      name: "set_shelf",
      arguments: JSON.stringify({ shelf_id: "Shelf 2" }),
      call_id: "call2",
    };
    channel.event({ type: "response.function_call_arguments.done", ...call });
    channel.event({
      type: "response.done",
      response: { output: [{ type: "function_call", ...call }] },
    });
    await vi.advanceTimersByTimeAsync(30000);
    expect(hooks.shelf).toHaveBeenCalledTimes(1);
    expect(
      channel
        .messages()
        .filter((value) => value.item?.type === "function_call_output"),
    ).toHaveLength(1);
    expect(channel.responses()).toHaveLength(1);
    expect(hooks.error).not.toHaveBeenCalled();
    session.close();
  });
  it.each(["rejected", "error result"])(
    "shows an actionable error when a correction fails with %s",
    async (failure) => {
      const hooks = {
        ...callbacks(),
        correction: vi.fn(async () => {
          if (failure === "rejected") throw new Error("Request failed");
          return { error: "No active sweep" };
        }),
      };
      const session = await connectVoice("test", stream, hooks);
      channel.event({
        type: "response.function_call_arguments.done",
        name: "record_correction",
        arguments: JSON.stringify({ text: "Exclude the second book." }),
        call_id: "failed-correction",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(hooks.error).toHaveBeenCalledWith(
        "Correction was not saved. Try again or enter a typed correction.",
      );
      const output = channel
        .messages()
        .find((value) => value.item?.type === "function_call_output");
      expect(JSON.parse(output.item.output).error).toBeTruthy();
      expect(channel.responses()).toHaveLength(0);
      session.close();
    },
  );
  it("shows a failed shelf change and catches asynchronous callback errors", async () => {
    const hooks = {
      ...callbacks(),
      shelf: vi.fn(async () => {
        throw new Error("Could not change shelf");
      }),
    };
    const session = await connectVoice("test", stream, hooks);
    channel.event({
      type: "response.function_call_arguments.done",
      name: "set_shelf",
      arguments: JSON.stringify({ shelf_id: "Shelf 2" }),
      call_id: "failed-shelf",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.error).toHaveBeenCalledWith(
      "Shelf label was not changed. Try saying the shelf label again.",
    );
    expect(channel.responses()).toHaveLength(0);
    session.close();
  });
  it("does not throttle, truncate or cancel a direct user response from the server", async () => {
    const hooks = callbacks();
    const session = await connectVoice("test", stream, hooks);
    session.sayContext("Move closer.", true);
    done();
    channel.event({ type: "input_audio_buffer.speech_started" });
    channel.event({ type: "input_audio_buffer.speech_stopped" });
    channel.event({ type: "response.created" });
    channel.event({
      type: "response.output_audio_transcript.delta",
      delta: "Your measurement needs a known reference.",
    });
    expect(hooks.caption).toHaveBeenCalledWith(
      "assistant",
      "Your measurement needs a known reference.",
      false,
    );
    expect(
      channel.messages().some((value) => value.type === "response.cancel"),
    ).toBe(false);
    expect(channel.responses()).toHaveLength(1);
    session.close();
  });
  it("drops a stale capture cue instead of interrupting with outdated advice", async () => {
    const session = await connectVoice("test", stream, callbacks());
    channel.event({ type: "input_audio_buffer.speech_started" });
    session.sayContext("Tilt away from glare.", true);
    await vi.advanceTimersByTimeAsync(26000);
    channel.event({ type: "input_audio_buffer.speech_stopped" });
    done();
    expect(channel.responses()).toHaveLength(0);
    session.close();
  });
  it("cancels queued speech when the session closes", async () => {
    const session = await connectVoice("test", stream, callbacks());
    channel.onopen?.();
    done();
    session.sayContext("Move closer.", true);
    session.close();
    await vi.advanceTimersByTimeAsync(30000);
    expect(channel.responses()).toHaveLength(1);
  });

  it("finishes only after a completed tool response and submits repeated calls once", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    const hooks = {
      ...callbacks(),
      finish: vi.fn(
        () =>
          new Promise<unknown>((r) => {
            resolve = r;
          }),
      ),
    };
    const session = await connectVoice("test", stream, hooks);
    const call = {
      name: "finish_capture",
      arguments: "{}",
      call_id: "finish-1",
    };
    channel.event({ type: "response.function_call_arguments.done", ...call });
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.finish).not.toHaveBeenCalled();
    const finishEvent = (call_id: string) => ({
      type: "response.done",
      response: {
        status: "completed",
        output: [{ type: "function_call", ...call, call_id }],
      },
    });
    channel.event(finishEvent("finish-1"));
    channel.event(finishEvent("finish-1"));
    channel.event(finishEvent("finish-2"));
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.finish).toHaveBeenCalledTimes(1);
    resolve?.({ ok: true, status: "processing" });
    await vi.advanceTimersByTimeAsync(0);
    channel.event(finishEvent("finish-3"));
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.finish).toHaveBeenCalledTimes(1);
    expect(
      channel
        .messages()
        .filter((event) => event.item?.type === "function_call_output"),
    ).toHaveLength(3);
    expect(hooks.error).not.toHaveBeenCalled();
    expect(channel.responses()).toHaveLength(0);
    session.close();
  });

  it.each(["cancelled", "incomplete", "failed", undefined])(
    "does not finish when the response status is %s",
    async (status) => {
      const hooks = callbacks();
      const session = await connectVoice("test", stream, hooks);
      const call = {
        type: "function_call",
        name: "finish_capture",
        arguments: "{}",
        call_id: "cancelled-finish",
      };
      channel.event({ ...call, type: "response.function_call_arguments.done" });
      channel.event({
        type: "response.done",
        response: { status, output: [call] },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(hooks.finish).not.toHaveBeenCalled();
      expect(
        channel
          .messages()
          .some((event) => event.item?.type === "function_call_output"),
      ).toBe(false);
      session.close();
    },
  );

  it.each(["rejected", "error result", "false result"])(
    "shows a failed finish with %s and allows a later retry",
    async (failure) => {
      const hooks = {
        ...callbacks(),
        finish: vi
          .fn()
          .mockImplementationOnce(async () => {
            if (failure === "rejected") throw new Error("Upload incomplete");
            return failure === "error result"
              ? { error: "Upload incomplete" }
              : { ok: false };
          })
          .mockResolvedValue({ ok: true }),
      };
      const session = await connectVoice("test", stream, hooks);
      const finishEvent = (call_id: string) => ({
        type: "response.done",
        response: {
          status: "completed",
          output: [
            {
              type: "function_call",
              name: "finish_capture",
              arguments: "{}",
              call_id,
            },
          ],
        },
      });
      channel.event(finishEvent("first-finish"));
      await vi.advanceTimersByTimeAsync(0);
      expect(hooks.error).toHaveBeenCalledWith(
        "Capture was not finished. Say that’s all again or tap End capture.",
      );
      channel.event(finishEvent("retry-finish"));
      await vi.advanceTimersByTimeAsync(0);
      expect(hooks.finish).toHaveBeenCalledTimes(2);
      expect(channel.responses()).toHaveLength(0);
      session.close();
    },
  );

  it("rejects malformed finish arguments without ending capture", async () => {
    const hooks = callbacks();
    const session = await connectVoice("test", stream, hooks);
    channel.event({
      type: "response.done",
      response: {
        status: "completed",
        output: [
          {
            type: "function_call",
            name: "finish_capture",
            arguments: '{"force":true}',
            call_id: "invalid-finish",
          },
        ],
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.finish).not.toHaveBeenCalled();
    expect(hooks.error).toHaveBeenCalledTimes(1);
    session.close();
  });

  it("announces finishing promptly after a short capture, then announces readiness once", async () => {
    const session = await connectVoice("test", stream, callbacks());
    channel.onopen?.();
    session.sayContext(CAPTURE_INSTRUCTIONS.finishing, true);
    expect(channel.responses()).toHaveLength(1);
    done();
    expect(channel.responses()).toHaveLength(2);
    expect(channel.responses()[1].response.instructions).toContain(
      CAPTURE_INSTRUCTIONS.finishing,
    );
    session.sayContext(CAPTURE_INSTRUCTIONS.ready, true);
    done();
    expect(channel.responses()).toHaveLength(3);
    expect(channel.responses()[2].response.instructions).toContain(
      CAPTURE_INSTRUCTIONS.ready,
    );
    done();
    session.sayContext(CAPTURE_INSTRUCTIONS.ready, true);
    expect(channel.responses()).toHaveLength(3);
    session.close();
  });

  it("keeps the completion reply queued ahead of quality cues while the claimant speaks", async () => {
    const session = await connectVoice("test", stream, callbacks());
    channel.event({ type: "input_audio_buffer.speech_started" });
    session.sayContext(CAPTURE_INSTRUCTIONS.finishing, true);
    session.sayContext(CAPTURE_INSTRUCTIONS.blur, true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(channel.responses()).toHaveLength(0);
    channel.event({ type: "input_audio_buffer.speech_stopped" });
    done();
    expect(channel.responses()).toHaveLength(1);
    expect(channel.responses()[0].response.instructions).toContain(
      CAPTURE_INSTRUCTIONS.finishing,
    );
    session.close();
  });
});
