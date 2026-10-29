import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as proxyRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

const COOKIE = "__Host-library-phone";
const MAX_BODY = 4096;
const MAX_SESSION_MS = 8 * 60 * 60 * 1000;
const digest = (value: string) => createHash("sha256").update(value).digest();
const equalSecret = (a: string, b: string) =>
  timingSafeEqual(digest(a), digest(b));
const hopHeaders = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);

function filteredHeaders(headers: IncomingHttpHeaders) {
  const blocked = new Set(hopHeaders);
  String(headers.connection || "")
    .split(",")
    .forEach((key) => blocked.add(key.trim().toLowerCase()));
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !blocked.has(key)),
  );
}
function json(res: ServerResponse, status: number, error?: string) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(error ? { error } : { ok: true }));
}
function sameOrigin(req: IncomingMessage): boolean {
  if (!req.headers.origin) return true;
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}
async function readCode(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk);
    size += data.length;
    if (size > MAX_BODY) throw new Error("too_large");
    chunks.push(data);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    !input ||
    typeof input !== "object" ||
    typeof (input as { code?: unknown }).code !== "string"
  )
    throw new Error("invalid_body");
  return (input as { code: string }).code.trim();
}
function loginPage(nonce: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Library Claim — phone access</title><style nonce="${nonce}">body{font:16px system-ui;max-width:28rem;margin:12vh auto;padding:1.5rem;color:#183b36}input,button{display:block;box-sizing:border-box;width:100%;font:inherit;padding:.9rem;margin:1rem 0}button{background:#24574c;color:white;border:0;border-radius:.4rem}code{overflow-wrap:anywhere}</style></head><body><h1>Open Library Claim</h1><p>This temporary phone link is protected. Enter the access code shown on the laptop.</p><form id="access-form"><label for="code">Phone access code</label><input id="code" type="password" autocomplete="one-time-code" required autofocus><button id="submit">Open app</button></form><p id="message" role="status"></p><script nonce="${nonce}">const form=document.getElementById('access-form'),code=document.getElementById('code'),message=document.getElementById('message'),button=document.getElementById('submit');async function unlock(event){if(event)event.preventDefault();button.disabled=true;message.textContent='Opening secure session…';try{const response=await fetch('/__phone/access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code.value})});if(!response.ok)throw new Error('Access code was not accepted. Check the code on the laptop.');history.replaceState(null,'','/');location.replace('/');}catch(error){message.textContent=error.message;button.disabled=false;}}form.addEventListener('submit',unlock);const supplied=new URLSearchParams(location.hash.slice(1)).get('access');if(supplied){code.value=supplied;history.replaceState(null,'','/');void unlock();}</script></body></html>`;
}

export type PhoneGatewayOptions = {
  accessCode: string;
  upstreamPort?: number;
  sessionLifetimeMs?: number;
};

/** Callers must bind this protected gateway to loopback; expose only this port through HTTPS. */
export function createPhoneGateway({
  accessCode,
  upstreamPort = 8787,
  sessionLifetimeMs = MAX_SESSION_MS,
}: PhoneGatewayOptions) {
  if (!/^[a-f0-9]{32,256}$/i.test(accessCode))
    throw new Error(
      "Phone access requires a random hexadecimal code of at least 32 characters.",
    );
  if (
    !Number.isInteger(upstreamPort) ||
    upstreamPort < 1 ||
    upstreamPort > 65535
  )
    throw new Error("Invalid upstream port.");
  if (!Number.isFinite(sessionLifetimeMs) || sessionLifetimeMs <= 0)
    throw new Error("Invalid session lifetime.");
  const lifetime = Math.min(sessionLifetimeMs, MAX_SESSION_MS);
  const sessions = new Map<string, number>();
  const authenticated = (req: IncomingMessage) => {
    const cookie = String(req.headers.cookie || "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    const now = Date.now();
    for (const [token, expires] of sessions)
      if (expires <= now) sessions.delete(token);
    return (
      !!cookie &&
      [...sessions.keys()].some((token) => equalSecret(token, cookie))
    );
  };
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const run = async () => {
      if (!req.url?.startsWith("/") || req.url.startsWith("//"))
        return json(res, 400, "Invalid request path.");
      const pathname = req.url.split("?")[0];
      if (pathname === "/__phone/access") {
        if (req.method !== "POST") return json(res, 405, "POST required.");
        if (!sameOrigin(req))
          return json(res, 403, "Cross-origin access refused.");
        let code: string;
        try {
          code = await readCode(req);
        } catch (error) {
          return json(
            res,
            (error as Error).message === "too_large" ? 413 : 400,
            "Invalid access request.",
          );
        }
        if (!equalSecret(code, accessCode))
          return json(res, 401, "Access code was not accepted.");
        const session = randomBytes(32).toString("hex");
        if (sessions.size >= 16) sessions.delete(sessions.keys().next().value!);
        sessions.set(session, Date.now() + lifetime);
        res.setHeader(
          "Set-Cookie",
          `${COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(lifetime / 1000)}`,
        );
        return json(res, 200);
      }
      if (!authenticated(req)) {
        if (req.method === "GET" && pathname === "/") {
          const nonce = randomBytes(18).toString("base64");
          res.setHeader(
            "Content-Security-Policy",
            `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
          );
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(loginPage(nonce));
        }
        return json(res, 401, "Phone access code required.");
      }
      if (!sameOrigin(req))
        return json(res, 403, "Cross-origin access refused.");
      const headers = filteredHeaders(req.headers);
      headers.host = `127.0.0.1:${upstreamPort}`;
      headers["x-forwarded-host"] = req.headers.host || "";
      delete headers["x-forwarded-proto"];
      if (headers.cookie) {
        const remainder = String(headers.cookie)
          .split(";")
          .map((c) => c.trim())
          .filter((c) => !c.startsWith(`${COOKIE}=`))
          .join("; ");
        if (remainder) headers.cookie = remainder;
        else delete headers.cookie;
      }
      const upstream = proxyRequest(
        {
          hostname: "127.0.0.1",
          port: upstreamPort,
          method: req.method,
          path: req.url,
          headers,
        },
        (response) => {
          const responseHeaders = filteredHeaders(response.headers);
          responseHeaders["cache-control"] = "no-store";
          responseHeaders["referrer-policy"] = "no-referrer";
          responseHeaders["x-content-type-options"] = "nosniff";
          res.writeHead(response.statusCode || 502, responseHeaders);
          response.on("error", () => res.destroy());
          response.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent)
          json(res, 502, "Local Library Claim server is unavailable.");
        else res.destroy();
      });
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => {
        if (!res.writableFinished) upstream.destroy();
      });
      req.pipe(upstream);
    };
    void run().catch(() => {
      if (!res.headersSent) json(res, 500, "Phone gateway request failed.");
      else res.destroy();
    });
  });
  server.on("close", () => sessions.clear());
  return server;
}
