import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { portableReferences, streamBundle } from "../server/bundle.js";

const id = "12345678-1234-1234-1234-123456789abc";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

/** Read ZIP central directory metadata; avoids any platform-specific unzip binary. */
function zipEntries(buffer: Buffer): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("Missing ZIP end directory");
  let cursor = buffer.readUInt32LE(end + 16);
  const count = buffer.readUInt16LE(end + 10);
  for (let i = 0; i < count; i++) {
    expect(buffer.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString();
    const contentOffset =
      offset +
      30 +
      buffer.readUInt16LE(offset + 26) +
      buffer.readUInt16LE(offset + 28);
    const data = buffer.subarray(contentOffset, contentOffset + compressedSize);
    result.set(name, method === 8 ? inflateRawSync(data) : data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

describe("portable evidence ZIP", () => {
  it("resolves root and nested references relative to their own entry", () => {
    expect(
      portableReferences(`/evidence/${id}/frames/frame.jpg`, "report.html", id),
    ).toBe("./frames/frame.jpg");
    expect(
      portableReferences(
        `/evidence/${id}/sources/offer.json`,
        "stages/review.json",
        id,
      ),
    ).toBe("../sources/offer.json");
    expect(
      portableReferences(
        `/evidence/${id}/frames/frame.jpg`,
        "sources/deep/offer.json",
        id,
      ),
    ).toBe("../../frames/frame.jpg");
    expect(
      portableReferences(
        "/evidence/another-sweep/frames/frame.jpg",
        "report.html",
        id,
      ),
    ).toBe("/evidence/another-sweep/frames/frame.jpg");
  });
  it("exports a linked packet/report/source chain, unchanged binary evidence, and excludes temp/symlink files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claim-bundle-"));
    roots.push(root);
    await Promise.all(
      ["frames", "sources", "stages"].map((dir) =>
        fs.mkdir(path.join(root, dir)),
      ),
    );
    const frame = Buffer.from([0xff, 0xd8, 0x00, 0x23, 0xff, 0xd9]);
    await Promise.all([
      fs.writeFile(
        path.join(root, "claim_packet.json"),
        JSON.stringify({
          frame_ref: `/evidence/${id}/frames/frame.jpg`,
          evidence_ref: `/evidence/${id}/sources/range.json`,
        }),
      ),
      fs.writeFile(
        path.join(root, "report.html"),
        `<a href="/evidence/${id}/frames/frame.jpg">Saved frame</a>`,
      ),
      fs.writeFile(
        path.join(root, "sources/range.json"),
        JSON.stringify({
          evidence_ref: `/evidence/${id}/sources/offer.json`,
          url: "https://retailer.example/product",
        }),
      ),
      fs.writeFile(
        path.join(root, "sources/offer.json"),
        JSON.stringify({ frame_ref: `/evidence/${id}/frames/frame.jpg` }),
      ),
      fs.writeFile(
        path.join(root, "stages/review.json"),
        JSON.stringify({ frame_ref: `/evidence/${id}/frames/frame.jpg` }),
      ),
      fs.writeFile(path.join(root, "frames/frame.jpg"), frame),
      fs.writeFile(path.join(root, "state.json.tmp"), "partial"),
      fs.symlink("/etc/hosts", path.join(root, "external-link")),
    ]);
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(chunk));
    await streamBundle(root, id, output);
    const entries = zipEntries(Buffer.concat(chunks));
    expect(entries.size).toBe(6);
    expect(entries.get("frames/frame.jpg")).toEqual(frame);
    expect(
      JSON.parse(entries.get("claim_packet.json")!.toString()).frame_ref,
    ).toBe("./frames/frame.jpg");
    expect(entries.get("report.html")!.toString()).toContain(
      'href="./frames/frame.jpg"',
    );
    expect(JSON.parse(entries.get("sources/range.json")!.toString())).toEqual({
      evidence_ref: "../sources/offer.json",
      url: "https://retailer.example/product",
    });
    expect(
      JSON.parse(entries.get("sources/offer.json")!.toString()).frame_ref,
    ).toBe("../frames/frame.jpg");
    expect(
      JSON.parse(entries.get("stages/review.json")!.toString()).frame_ref,
    ).toBe("../frames/frame.jpg");
    expect(entries.has("state.json.tmp")).toBe(false);
    expect(entries.has("external-link")).toBe(false);
    // Export transformations never alter the application's stored evidence.
    expect(
      await fs.readFile(path.join(root, "sources/offer.json"), "utf8"),
    ).toContain(`/evidence/${id}/frames/frame.jpg`);
  });
  it("rejects invalid sweep identifiers before creating an archive", async () => {
    await expect(
      streamBundle("/tmp", "../../secrets", new PassThrough()),
    ).rejects.toThrow("Invalid sweep ID");
  });
});
