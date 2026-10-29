import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { gunzipSync, brotliDecompressSync, inflateSync } from "node:zlib";

export interface SourcePage {
  url: string;
  body: string;
  retrieved_at: string;
  sha256: string;
}

/** Reject non-public ranges, including mapped IPv4 and link-local addresses. */
export function isPublicAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  if (v !== 6) return false;
  // Only global unicast, excluding documentation and transition ranges.
  const groups = address.toLowerCase().split(":");
  const first = Number.parseInt(groups[0], 16);
  const second = Number.parseInt(groups[1] || "0", 16);
  return (
    first >= 0x2000 &&
    first <= 0x3ffe &&
    first !== 0x2002 &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
  );
}

export function validateSourceUrl(input: string): URL {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new Error("Sources must use public HTTPS on port 443");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(".") && !isIP(host))
    throw new Error("Source hostname is not public");
  if (
    host === "localhost" ||
    /\.(?:localhost|local|internal|home|lan)$/.test(host)
  )
    throw new Error("Private source hostname");
  if (isIP(host) && !isPublicAddress(host))
    throw new Error("Private source address");
  return url;
}

/** DNS is checked and pinned into HTTPS lookup; redirects are checked again. */
export async function fetchSourcePage(
  input: string,
  signal?: AbortSignal,
): Promise<SourcePage> {
  let next = input;
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal?.throwIfAborted();
    const url = validateSourceUrl(next);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const records = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await Promise.race([
          lookup(host, { all: true, verbatim: true }),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Source DNS timed out")),
              5000,
            );
            timer.unref();
          }),
        ]);
    if (!records.length || records.some((r) => !isPublicAddress(r.address)))
      throw new Error("Source resolved to a private or reserved address");
    const selected = records[0];
    const response = await new Promise<{
      status: number;
      location?: string;
      body: string;
    }>((resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          signal,
          autoSelectFamily: false,
          lookup: (_hostname, _options, callback) =>
            callback(null, selected.address, selected.family),
          headers: {
            "User-Agent": "LibraryClaimAgent/1.0 (price evidence retrieval)",
            Accept: "text/html,application/json,text/plain",
            "Accept-Encoding": "identity",
          },
        } as RequestOptions & { autoSelectFamily: boolean },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            resolve({ status, location: res.headers.location, body: "" });
            return;
          }
          if (status !== 200) {
            res.resume();
            reject(new Error(`Source returned HTTP ${status}`));
            return;
          }
          if (
            !/(?:text\/|application\/(?:json|ld\+json|xhtml\+xml))/.test(
              String(res.headers["content-type"] ?? ""),
            )
          ) {
            res.resume();
            reject(new Error("Source is not HTML, text or JSON"));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 2_000_000) {
              req.destroy(new Error("Source exceeded 2 MB"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              let raw = Buffer.concat(chunks);
              const enc = res.headers["content-encoding"];
              if (enc === "gzip")
                raw = gunzipSync(raw, { maxOutputLength: 2_000_000 });
              if (enc === "br")
                raw = brotliDecompressSync(raw, { maxOutputLength: 2_000_000 });
              if (enc === "deflate")
                raw = inflateSync(raw, { maxOutputLength: 2_000_000 });
              resolve({ status, body: raw.toString("utf8") });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.setTimeout(9000, () =>
        req.destroy(new Error("Source request timed out")),
      );
      const total = setTimeout(
        () => req.destroy(new Error("Source retrieval timed out")),
        12_000,
      );
      total.unref();
      req.on("close", () => clearTimeout(total));
      req.on("error", reject);
      req.end();
    });
    if (response.status >= 300 && response.status < 400) {
      if (!response.location)
        throw new Error("Source redirect has no destination");
      next = new URL(response.location, url).href;
      continue;
    }
    return {
      url: url.href,
      body: response.body,
      retrieved_at: new Date().toISOString(),
      sha256: createHash("sha256").update(response.body).digest("hex"),
    };
  }
  throw new Error("Too many source redirects");
}
