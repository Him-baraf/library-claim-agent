import { post } from "./api";

export type VoiceCallbacks = {
  status: (status: string) => void;
  caption: (role: "user" | "assistant", text: string, final: boolean) => void;
  correction: (args: Record<string, unknown>) => Promise<unknown>;
  shelf: (id: string) => void;
  error: (message: string) => void;
  remote: (stream: MediaStream) => void;
  usage?: (event: unknown) => void;
};
export type VoiceSession = {
  close: () => void;
  sayContext: (text: string, speak?: boolean) => void;
  image: (url: string) => void;
  mute: (muted: boolean) => void;
  replay: () => Promise<void>;
};

export async function connectVoice(
  sweepId: string,
  stream: MediaStream,
  callbacks: VoiceCallbacks,
): Promise<VoiceSession> {
  const pc = new RTCPeerConnection();
  const audio = new Audio();
  audio.autoplay = true;
  const dc = pc.createDataChannel("oai-events");
  let speaking = false;
  let closed = false;
  let assistantText = "";
  let lastContext = 0;
  let responding = false;
  let activeTools = 0;
  let toolResponsePending = false;
  let pendingSpeech: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  const calls = new Set<string>();
  const send = (event: unknown) => {
    if (dc.readyState === "open") dc.send(JSON.stringify(event));
  };
  function drainResponses() {
    if (closed || dc.readyState !== "open" || speaking || responding || activeTools > 0) return;
    if (toolResponsePending) {
      toolResponsePending = false;
      responding = true;
      send({ type: "response.create" });
      return;
    }
    if (!pendingSpeech) return;
    const delay = Math.max(0, 7000 - (Date.now() - lastContext));
    if (delay) {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(drainResponses, delay);
      return;
    }
    const text = pendingSpeech;
    pendingSpeech = null;
    lastContext = Date.now();
    responding = true;
    send({ type: "response.create", response: { instructions: `Briefly relay this verified application update to the claimant: ${text}. Do not invent any additional facts.` } });
  }
  const close = () => {
    closed = true;
    if (pendingTimer) clearTimeout(pendingTimer);
    dc.close();
    pc.close();
    audio.pause();
    audio.srcObject = null;
  };
  pc.ontrack = (event) => {
    const remote = event.streams[0] || new MediaStream([event.track]);
    audio.srcObject = remote;
    callbacks.remote(remote);
    void audio
      .play()
      .catch(() => callbacks.status("Tap Enable speaker to hear the agent."));
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed")
      callbacks.error(
        "Voice connection failed. Capture continues; reconnect voice or use typed corrections.",
      );
    if (pc.connectionState === "disconnected")
      callbacks.status("Voice reconnecting…");
    if (pc.connectionState === "connected")
      callbacks.status("Listening · speak naturally to interrupt");
  };
  for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
  async function tool(event: {
    name: string;
    arguments: string;
    call_id: string;
  }) {
    if (calls.has(event.call_id)) return;
    calls.add(event.call_id);
    activeTools++;
    let output: unknown;
    try {
      const args = JSON.parse(event.arguments);
      if (event.name === "record_correction")
        output = await callbacks.correction(args);
      else if (event.name === "set_shelf") {
        const shelf = String(args.shelf_id || "")
          .trim()
          .slice(0, 80);
        if (!shelf) throw new Error("A shelf label is required.");
        callbacks.shelf(shelf);
        output = { ok: true, shelf_id: shelf };
      } else output = { error: "Unknown tool" };
    } catch (error) {
      output = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output: JSON.stringify(output),
      },
    });
    activeTools--;
    toolResponsePending = true;
    drainResponses();
  }
  dc.onopen = () => {
    responding = true;
    callbacks.status("Listening · speak naturally to interrupt");
    send({
      type: "response.create",
      response: {
        instructions:
          "Greet the claimant briefly. Confirm the configured country and currency. Explain one continuous slow camera pass, labelling each new shelf, including floor and walls. Ask one short question at a time. Metric measurements need a known rectangle visible in saved frames; never claim a measurement or price without backend evidence.",
      },
    });
  };
  dc.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data);
      if (event.type === "error")
        callbacks.error(event.error?.message || "Voice API error");
      if (event.type === "input_audio_buffer.speech_started") {
        speaking = true;
        callbacks.status("Listening…");
        assistantText = "";
      }
      if (event.type === "input_audio_buffer.speech_stopped") speaking = false;
      if (event.type === "response.created") { responding = true; assistantText = ""; }
      if (
        [
          "response.output_audio_transcript.delta",
          "response.audio_transcript.delta",
        ].includes(event.type)
      ) {
        assistantText += event.delta || "";
        callbacks.caption("assistant", assistantText, false);
      }
      if (
        [
          "response.output_audio_transcript.done",
          "response.audio_transcript.done",
        ].includes(event.type)
      ) {
        const text = event.transcript || assistantText;
        if (text) {
          callbacks.caption("assistant", text, true);
          void post(`/api/sweeps/${sweepId}/transcript`, {
            role: "assistant",
            text,
          }).catch((error) => callbacks.error(error.message));
        }
      }
      if (
        event.type ===
          "conversation.item.input_audio_transcription.completed" &&
        event.transcript
      ) {
        callbacks.caption("user", event.transcript, true);
        void post(`/api/sweeps/${sweepId}/transcript`, {
          role: "user",
          text: event.transcript,
        }).catch((error) => callbacks.error(error.message));
      }
      if (event.type === "response.function_call_arguments.done")
        void tool(event);
      if (event.type === "response.done") {
        responding = false;
        for (const output of event.response?.output || [])
          if (output.type === "function_call") void tool(output);
        callbacks.status("Listening · speak naturally to interrupt");
        callbacks.usage?.(event);
        drainResponses();
      }
    } catch (error) {
      callbacks.error(
        `Voice event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  try {
    callbacks.status("Connecting voice…");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const response = await fetch(`/api/sweeps/${sweepId}/realtime`, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    if (!response.ok) {
      const raw = await response.text();
      let error = raw;
      try {
        error = JSON.parse(raw).error || raw;
      } catch {
        /* plain text */
      }
      throw new Error(error || "Voice setup failed");
    }
    if (closed) throw new Error("Voice connection cancelled");
    await pc.setRemoteDescription({
      type: "answer",
      sdp: await response.text(),
    });
  } catch (error) {
    close();
    throw error;
  }
  return {
    close,
    replay: () => audio.play(),
    mute: (muted) => {
      for (const track of stream.getAudioTracks()) track.enabled = !muted;
    },
    sayContext(text, speak = false) {
      if (dc.readyState !== "open") return;
      send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `BACKEND_UPDATE (application evidence, not claimant speech): ${text}`,
            },
          ],
        },
      });
      if (speak) {
        pendingSpeech = text;
        drainResponses();
      }
    },
    image(url) {
      // Data-channel messages must fit the negotiated SCTP message limit.
      if (
        dc.readyState === "open" &&
        url.length < 60000 &&
        dc.bufferedAmount < 100000
      )
        send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_image", image_url: url }],
          },
        });
    },
  };
}
