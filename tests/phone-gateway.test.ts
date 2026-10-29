import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { createPhoneGateway } from "../server/phone-gateway";
const CODE = "c".repeat(64);
let upstream: Server,
  gateway: Server,
  calls: { url: string; headers: Record<string, unknown>; body: string }[];
const listen = (server: Server) =>
  new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));
const client = () => request(gateway);
const sessionCookie = (value: unknown) =>
  String(Array.isArray(value) ? value[0] : value).split(";")[0];
async function login() {
  const r = await client()
    .post("/__phone/access")
    .set("Host", "phone.example")
    .set("Origin", "https://phone.example")
    .send({ code: CODE })
    .expect(200);
  return sessionCookie(r.headers["set-cookie"]);
}
beforeEach(async () => {
  calls = [];
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    calls.push({
      url: req.url!,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    });
    if (req.url === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "public,max-age=3600",
      });
      res.write('event: state\ndata: {"ok":true}\n\n');
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        upstream: true,
        url: req.url,
        body: calls.at(-1)!.body,
      }),
    );
  });
  await listen(upstream);
  gateway = createPhoneGateway({
    accessCode: CODE,
    upstreamPort: (upstream.address() as AddressInfo).port,
    sessionLifetimeMs: 4000,
  });
  await listen(gateway);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close(gateway);
  await close(upstream);
});
describe("temporary protected phone gateway", () => {
  it("requires random-length access code and a valid fixed upstream port", () => {
    expect(() => createPhoneGateway({ accessCode: "short" })).toThrow();
    expect(() =>
      createPhoneGateway({ accessCode: CODE, upstreamPort: 0 }),
    ).toThrow();
    expect(() =>
      createPhoneGateway({ accessCode: CODE, sessionLifetimeMs: NaN }),
    ).toThrow();
  });
  it("serves a nonce-protected login page without leaking code or contacting upstream", async () => {
    const r = await client().get("/").expect(200);
    expect(r.text).toContain("Phone access code");
    expect(r.text).not.toContain(CODE);
    expect(r.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    expect(r.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(calls).toHaveLength(0);
  });
  it("blocks unauthenticated API, images, bundles and static files", async () => {
    for (const path of [
      "/api/health",
      "/api/sweeps",
      "/evidence/id/frames/frame.jpg",
      "/assets/app.js",
      "/api/sweeps/id/bundle",
    ])
      await client().get(path).expect(401);
    await client().post("/api/sweeps").send({ country: "US" }).expect(401);
    expect(calls).toHaveLength(0);
  });
  it("rejects wrong code, malformed body, cross-origin login and oversized body", async () => {
    await client()
      .post("/__phone/access")
      .send({ code: "d".repeat(64) })
      .expect(401);
    await client()
      .post("/__phone/access")
      .set("Host", "phone.example")
      .set("Origin", "https://attacker.example")
      .send({ code: CODE })
      .expect(403);
    await client()
      .post("/__phone/access")
      .set("Content-Type", "application/json")
      .send("{invalid")
      .expect(400);
    await client()
      .post("/__phone/access")
      .send({ code: "x".repeat(5000) })
      .expect(413);
    await client().get("/__phone/access").expect(405);
    expect(calls).toHaveLength(0);
  });
  it("creates an opaque Secure HttpOnly session cookie and streams authenticated bodies to fixed loopback", async () => {
    const auth = await client()
      .post("/__phone/access")
      .send({ code: CODE })
      .expect(200);
    const setCookie = String(
      Array.isArray(auth.headers["set-cookie"])
        ? auth.headers["set-cookie"][0]
        : auth.headers["set-cookie"],
    );
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toContain(CODE);
    const cookie = setCookie.split(";")[0];
    const r = await client()
      .post("/api/sweeps?test=1")
      .set("Host", "phone.example")
      .set("Origin", "https://phone.example")
      .set("X-Forwarded-Host", "attacker.example")
      .set("Cookie", `${cookie}; other=value`)
      .send({ country: "GB" })
      .expect(200);
    expect(r.body.upstream).toBe(true);
    expect(calls[0].url).toBe("/api/sweeps?test=1");
    expect(JSON.parse(calls[0].body)).toEqual({ country: "GB" });
    expect(calls[0].headers.host).toMatch(/^127\.0\.0\.1:/);
    expect(calls[0].headers["x-forwarded-host"]).toBe("phone.example");
    expect(calls[0].headers.cookie).toBe("other=value");
  });
  it("rejects tampered and expired sessions and cross-origin authenticated mutations", async () => {
    const cookie = await login();
    await client()
      .get("/api/health")
      .set("Cookie", cookie + "tampered")
      .expect(401);
    await client()
      .post("/api/sweeps")
      .set("Host", "phone.example")
      .set("Origin", "https://attacker.example")
      .set("Cookie", cookie)
      .send({})
      .expect(403);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5000);
    await client().get("/api/health").set("Cookie", cookie).expect(401);
    expect(calls).toHaveLength(0);
  });
  it("preserves event stream content while preventing cache storage", async () => {
    const cookie = await login();
    const r = await client()
      .get("/api/events")
      .set("Cookie", cookie)
      .expect(200);
    expect(r.headers["content-type"]).toBe("text/event-stream");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.text).toContain('event: state\ndata: {"ok":true}');
  });
  it("returns a sanitized error when the local app is unavailable", async () => {
    const cookie = await login();
    await close(upstream);
    const r = await client()
      .get("/api/health")
      .set("Cookie", cookie)
      .expect(502);
    expect(r.body.error).toBe("Local Library Claim server is unavailable.");
    expect(r.text).not.toContain(CODE);
  });
  it("rejects protocol-relative paths before proxying", async () => {
    await client().get("//attacker.example/api/health").expect(400);
    expect(calls).toHaveLength(0);
  });
  it("revokes existing sessions when gateway stops", async () => {
    const cookie = await login();
    await close(gateway);
    await listen(gateway);
    await client().get("/api/health").set("Cookie", cookie).expect(401);
  });
});
