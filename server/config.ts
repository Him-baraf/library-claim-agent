import "dotenv/config";
import path from "node:path";
/** Keep public price lookups bounded even when an environment value is invalid. */
export function parsePricingConcurrency(raw: string | undefined): number {
  if (!raw?.trim()) return 10;
  const value = Number(raw);
  return Number.isFinite(value)
    ? Math.min(12, Math.max(1, Math.floor(value)))
    : 10;
}
export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "127.0.0.1",
  dataDir: path.resolve(process.env.DATA_DIR || "./data"),
  visionModel: process.env.OPENAI_VISION_MODEL || "gpt-6.1-terra",
  pricingModel: process.env.OPENAI_PRICING_MODEL || "gpt-6.1-sol",
  pricingConcurrency: parsePricingConcurrency(process.env.PRICING_CONCURRENCY),
  realtimeModel: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1",
  maxFrames: Number(process.env.MAX_SWEEP_FRAMES || 90),
  finalizationMs: Math.min(
    270000,
    Math.max(30000, Number(process.env.FINALIZATION_TIMEOUT_MS || 240000)),
  ),
};
export function hasKey() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}
export function apiHeaders() {
  return {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  };
}
export function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 600);
}
