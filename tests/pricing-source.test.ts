import { describe, expect, it } from "vitest";
import { isPublicAddress, validateSourceUrl } from "../server/source-fetch.js";

describe("price source network boundary", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.1.2",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "192.0.2.1",
    "198.51.100.2",
    "203.0.113.4",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2001:0db8::1",
    "2002:7f00:1::1",
    "3fff::1",
  ])("rejects private/reserved %s", (ip) =>
    expect(isPublicAddress(ip)).toBe(false),
  );
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])("allows public %s", (ip) => expect(isPublicAddress(ip)).toBe(true));
  it.each([
    "http://example.com",
    "https://localhost",
    "https://router.local",
    "https://127.0.0.1",
    "https://[::1]",
    "https://example.com:8080",
    "https://user:pass@example.com",
    "file:///etc/passwd",
  ])("rejects unsafe URL %s", (url) =>
    expect(() => validateSourceUrl(url)).toThrow(),
  );
  it("allows a public HTTPS retailer URL", () =>
    expect(
      validateSourceUrl("https://books.example.com/book?id=123").hostname,
    ).toBe("books.example.com"));
});
