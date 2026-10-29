import "dotenv/config";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createPhoneGateway } from "../server/phone-gateway";

const share = process.argv.includes("--share");
const gatewayPort = Number(process.env.PHONE_PORT || 8788);
if (!Number.isInteger(gatewayPort) || gatewayPort < 1024 || gatewayPort > 65535)
  throw new Error("PHONE_PORT must be between 1024 and 65535.");
const upstreamPort = Number(process.env.PORT || 8787);
const health = await fetch(`http://127.0.0.1:${upstreamPort}/api/health`, {
  signal: AbortSignal.timeout(5000),
}).catch(() => null);
if (!health?.ok)
  throw new Error(
    "Start the app first: npm run dev (or npm run build && npm start).",
  );
await fs.access(path.resolve("dist/index.html")).catch(() => {
  throw new Error(
    "Run npm run build first; the phone route serves the production app, without Vite.",
  );
});
const accessCode = randomBytes(32).toString("hex");
const gateway = createPhoneGateway({ accessCode, upstreamPort });
await new Promise<void>((resolve, reject) => {
  gateway.once("error", reject);
  gateway.listen(gatewayPort, "127.0.0.1", resolve);
});
const sessionDir = path.resolve(
  process.env.DATA_DIR || "./data",
  "phone-access",
);
await fs.mkdir(sessionDir, { recursive: true });
const sessionPath = path.join(sessionDir, "session.json");
const session = {
  started_at: new Date().toISOString(),
  pid: process.pid,
  gateway_port: gatewayPort,
  upstream_port: upstreamPort,
  access_code: accessCode,
  public_url: null as string | null,
};
await fs.writeFile(sessionPath, JSON.stringify(session, null, 2), {
  mode: 0o600,
});
console.log(`Protected phone gateway ready on loopback port ${gatewayPort}.`);
let tunnel: ReturnType<typeof spawn> | undefined;
let stopped = false;
const shutdown = () => {
  if (stopped) return;
  stopped = true;
  tunnel?.kill("SIGTERM");
  gateway.close();
  gateway.closeAllConnections();
  void fs.unlink(sessionPath).catch(() => {});
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    shutdown();
    process.exit(0);
  });
if (!share) {
  console.log(
    "No public tunnel was started. Use npm run phone:share only when you want capture traffic relayed through Cloudflare.",
  );
  console.log(
    `Local-only test link: http://127.0.0.1:${gatewayPort}/#access=${accessCode}`,
  );
} else {
  let binary = process.env.CLOUDFLARED_BIN || "cloudflared";
  if (
    !process.env.CLOUDFLARED_BIN &&
    spawnSync(binary, ["--version"], { stdio: "ignore" }).status !== 0
  ) {
    binary = path.join(os.tmpdir(), "library-claim-tools", "cloudflared");
    await fs.access(binary).catch(() => {
      shutdown();
      throw new Error(
        "Install cloudflared from https://developers.cloudflare.com/tunnel/ then rerun npm run phone:share.",
      );
    });
  }
  console.log(
    "Creating a temporary access-code-protected HTTPS route. Frames and transcripts pass through Cloudflare; the OpenAI key stays on this laptop. Stop with Ctrl+C.",
  );
  // Do not pass the OpenAI API key or other application credentials to the tunnel utility.
  const childEnv: NodeJS.ProcessEnv = Object.fromEntries(
    [
      "PATH",
      "LANG",
      "TMPDIR",
      "HOME",
      "USER",
      "LOGNAME",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
    ]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]!]),
  );
  tunnel = spawn(
    binary,
    [
      "tunnel",
      "--config",
      "/dev/null",
      "--no-autoupdate",
      "--url",
      `http://127.0.0.1:${gatewayPort}`,
    ],
    { env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  let pending = "";
  let announced = false;
  const line = (chunk: Buffer) => {
    pending += chunk.toString();
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const entry = pending.slice(0, end);
      pending = pending.slice(end + 1);
      const url = entry.match(
        /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i,
      )?.[0];
      if (url && !announced) {
        announced = true;
        session.public_url = url;
        void fs.writeFile(sessionPath, JSON.stringify(session, null, 2), {
          mode: 0o600,
        });
        console.log(
          `\nOPEN IN IPHONE SAFARI:\n${url}/#access=${accessCode}\n\nThe link grants this temporary session access. It stops working when this process stops. Keep Safari in the foreground; allow camera and microphone when starting.\n`,
        );
      } else if (/ERR|failed|error/i.test(entry)) console.error(entry);
    }
  };
  tunnel.stdout?.on("data", line);
  tunnel.stderr?.on("data", line);
  tunnel.on("error", (error) => {
    console.error(error.message);
    shutdown();
    process.exitCode = 1;
  });
  tunnel.on("exit", (code) => {
    shutdown();
    if (code) console.error(`HTTPS tunnel exited (${code}).`);
    process.exitCode = code || 0;
  });
}
