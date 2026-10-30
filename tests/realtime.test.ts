import { describe, expect, it } from "vitest";
import {
  realtimeSessionConfig,
  realtimeUpstreamError,
} from "../server/realtime";
import { config } from "../server/config";
import { book, item, state } from "./domain-fixtures";

describe("shared Realtime session configuration", () => {
  it("defaults to silence and one short capture action without inventory narration", () => {
    const session = realtimeSessionConfig(state());
    expect(session.max_output_tokens).toBe(384);
    expect(session.instructions).toContain("Default to silence");
    expect(session.instructions).toContain("8–12 words");
    expect(session.instructions).toContain(
      "Successful tool calls need no spoken acknowledgement",
    );
    expect(session.instructions).toContain("Never read them aloud");
    expect(session.instructions).toContain("one sentence of at most 20 words");
    expect(session.instructions).not.toContain(
      "read supplied deterministic totals",
    );
    expect(session.audio.input.turn_detection.create_response).toBe(true);
  });
  it("uses the configured model, audio transcription, and interruptible turn detection", () => {
    const session = realtimeSessionConfig(state());
    expect(session.type).toBe("realtime");
    expect(session.model).toBe(config.realtimeModel);
    expect(session.output_modalities).toEqual(["audio"]);
    expect(session.audio.input.transcription.model).toBe(
      "gpt-4o-mini-transcribe",
    );
    expect(session.audio.input.turn_detection).toMatchObject({
      type: "server_vad",
      interrupt_response: true,
      create_response: true,
    });
    expect(session.audio.output.voice).toBe("marin");
  });
  it("grounds spoken intake in locale and current inventory and exposes capture tools", () => {
    const original = state({
      country: "IN",
      currency: "INR",
      books: [book()],
      items: [item()],
    });
    const before = structuredClone(original);
    const session = realtimeSessionConfig(original);
    expect(session.instructions).toContain("Country=IN,currency=INR");
    expect(session.instructions).toContain('"id":"b1"');
    expect(session.instructions).toContain('"id":"i1"');
    expect(session.instructions).toContain(
      "Never invent titles, counts, prices, dimensions, or source URLs",
    );
    expect(session.tools.map((tool) => tool.name)).toEqual([
      "record_correction",
      "set_shelf",
      "finish_capture",
    ]);
    expect(
      session.tools.find((tool) => tool.name === "record_correction"),
    ).toMatchObject({
      parameters: {
        properties: {
          action: { enum: ["exclude", "appraisal", "print", "note"] },
        },
      },
    });
    expect(original).toEqual(before);
    expect(session).not.toHaveProperty("api_key");
    expect(session).not.toHaveProperty("client_secret");
  });
  it("accepts a few available books without requiring room coverage or measurements", () => {
    const session = realtimeSessionConfig(state());
    expect(session.instructions).toContain(
      "A few books on a desk or shelf are enough",
    );
    expect(session.instructions).toContain(
      "Do not ask them to sweep the whole room",
    );
    expect(session.instructions).toContain(
      "Unknown room dimensions and areas remain unknown",
    );
    expect(session.instructions).toContain("available book spines");
    expect(session.instructions).not.toContain(
      "One continuous room sweep, including stacked books, walls, corners and floor",
    );
  });
  it("offers parameter-free whole-capture completion and distinguishes continuing or quoted speech", () => {
    const session = realtimeSessionConfig(state());
    expect(
      session.tools.find((tool) => tool.name === "finish_capture"),
    ).toMatchObject({
      type: "function",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
        required: [],
      },
    });
    for (const phrase of ["that's all", "no other books", "I'm done"])
      expect(session.instructions).toContain(phrase);
    expect(session.instructions).toContain("call finish_capture immediately");
    expect(session.instructions).toContain("I'm not done");
    expect(session.instructions).toContain("question or quoted example");
    expect(session.instructions).toContain("that's all for this shelf");
    expect(session.instructions).toContain(
      "The client gives one brief preparing-report reply",
    );
    expect(session.instructions).toContain(
      "report-ready notice comes only after actual completion",
    );
  });
  it("redacts standard and ephemeral credentials from bounded provider error messages", () => {
    const result = realtimeUpstreamError(
      401,
      JSON.stringify({
        error: {
          message: "Invalid keys sk-fixture_main and ek_fixture_ephemeral",
        },
        value: "ek_never_return_this",
      }),
    );
    expect(result).toContain("Realtime API 401");
    expect(result).toContain("[redacted]");
    expect(result).not.toContain("sk-fixture_main");
    expect(result).not.toContain("ek_fixture_ephemeral");
    expect(result).not.toContain("ek_never_return_this");
    expect(
      realtimeUpstreamError(502, "<html>raw credential ek_not_json</html>"),
    ).not.toContain("ek_not_json");
    expect(
      realtimeUpstreamError(
        400,
        JSON.stringify({ error: { message: "x".repeat(10000) } }),
      ).length,
    ).toBeLessThan(450);
  });
});
