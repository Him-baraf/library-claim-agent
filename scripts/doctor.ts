import "dotenv/config";
import { promises as fs, constants } from "node:fs";
import { config, hasKey } from "../server/config";
console.log(
  `Node ${process.version}; required >=22: ${Number(process.versions.node.split(".")[0]) >= 22 ? "OK" : "FAIL"}`,
);
console.log(
  `OpenAI API key: ${hasKey() ? "configured (not displayed)" : "MISSING — add OPENAI_API_KEY to .env"}`,
);
console.log(
  `Models: vision=${config.visionModel}, pricing=${config.pricingModel}, realtime=${config.realtimeModel}`,
);
await fs.mkdir(config.dataDir, { recursive: true });
await fs.access(config.dataDir, constants.W_OK);
console.log(`Capture directory writable: ${config.dataDir}`);
console.log(
  "Camera/microphone require localhost or HTTPS. Phone: DEV_HTTPS=true then npm run dev.",
);
if (hasKey()) {
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    signal: AbortSignal.timeout(10000),
  });
  console.log(`OpenAI authentication: HTTP ${response.status}`);
  if (response.ok) {
    const body = (await response.json()) as any;
    for (const model of [
      config.visionModel,
      config.pricingModel,
      config.realtimeModel,
    ])
      console.log(
        `${model}: ${body.data?.some((m: any) => m.id === model) ? "listed" : "not listed; check project model access"}`,
      );
  }
}
