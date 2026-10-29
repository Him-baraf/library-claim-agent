export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body && typeof options.body === "string"
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      message = JSON.parse(body).error || JSON.parse(body).message || body;
    } catch {
      /* plain upstream response */
    }
    throw new Error(message || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}
export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export function money(
  amount: number | null | undefined,
  currency: string,
): string {
  if (amount == null || !Number.isFinite(amount)) return "Unknown";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}
export const measurement = (
  amount: number | null | undefined,
  unit: string,
  digits = 2,
) => (amount == null ? "Unknown" : `${amount.toFixed(digits)} ${unit}`);
export function safeLink(url: string): string | undefined {
  if (url.startsWith("/evidence/")) return url;
  try {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}
