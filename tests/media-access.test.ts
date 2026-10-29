import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserCaptureAccessIssue,
  captureAccessIssue,
  mediaRequestError,
} from "../client/media-access";

const supported = {
  secureContext: true,
  hasGetUserMedia: true,
  embedded: false,
};
afterEach(() => vi.unstubAllGlobals());

describe("camera access prerequisites", () => {
  it("accepts a secure localhost browser with a media API", () => {
    expect(captureAccessIssue(supported)).toBeNull();
  });
  it("identifies an HTTP LAN context before a missing API", () => {
    const issue = captureAccessIssue({
      ...supported,
      secureContext: false,
      hasGetUserMedia: false,
    });
    expect(issue?.code).toBe("insecure");
    expect(issue?.message).toContain("HTTPS address on your phone");
  });
  it("does not mislabel a secure preview with a missing API as an HTTPS issue", () => {
    const issue = captureAccessIssue({
      ...supported,
      hasGetUserMedia: false,
      embedded: true,
    });
    expect(issue?.code).toBe("unsupported");
    expect(issue?.message).toContain("embedded preview");
    expect(issue?.message).not.toContain("HTTPS");
  });
  it("allows an embedded document when its API and policies allow capture", () => {
    expect(captureAccessIssue({ ...supported, embedded: true })).toBeNull();
  });
  it("explains explicit camera or microphone policy blocks without treating other policies as media blocks", () => {
    const blocked = captureAccessIssue({
      ...supported,
      blockedFeatures: ["camera", "microphone", "camera", "geolocation"],
    });
    expect(blocked?.code).toBe("policy_blocked");
    expect(blocked?.message).toContain("camera and microphone");
    expect(blocked?.message).not.toContain("geolocation");
    expect(
      captureAccessIssue({ ...supported, blockedFeatures: ["geolocation"] }),
    ).toBeNull();
  });
  it("handles missing media support in a top-level browser", () => {
    expect(
      captureAccessIssue({ ...supported, hasGetUserMedia: false })?.code,
    ).toBe("unsupported");
  });
});

function stubBrowser(policy?: object, modern = true) {
  const currentWindow = { isSecureContext: true } as Record<string, unknown>;
  currentWindow.self = currentWindow;
  currentWindow.top = currentWindow;
  vi.stubGlobal("window", currentWindow);
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn() },
  });
  vi.stubGlobal(
    "document",
    policy ? { [modern ? "permissionsPolicy" : "featurePolicy"]: policy } : {},
  );
}

describe("browser capability inspection", () => {
  it("uses optional modern permissions policy diagnostics without requesting devices", () => {
    const allowsFeature = vi.fn((feature: string) => feature !== "microphone");
    stubBrowser({ allowsFeature });
    expect(browserCaptureAccessIssue()?.code).toBe("policy_blocked");
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
  it("supports legacy featurePolicy diagnostics", () => {
    stubBrowser(
      { allowsFeature: (feature: string) => feature !== "camera" },
      false,
    );
    expect(browserCaptureAccessIssue()?.message).toContain("camera access");
  });
  it("does not infer denial when optional diagnostics are absent or throw", () => {
    stubBrowser();
    expect(browserCaptureAccessIssue()).toBeNull();
    stubBrowser({
      allowsFeature: () => {
        throw new Error("unknown feature");
      },
    });
    expect(browserCaptureAccessIssue()).toBeNull();
  });
  it("handles an embedded host denying access to the mediaDevices property", () => {
    stubBrowser();
    vi.stubGlobal(
      "navigator",
      Object.defineProperty({}, "mediaDevices", {
        get: () => {
          throw new Error("Host blocked API access");
        },
      }),
    );
    expect(browserCaptureAccessIssue()?.code).toBe("unsupported");
  });
});

describe("capture request errors", () => {
  it.each([
    ["NotAllowedError", "permission was denied"],
    ["NotFoundError", "could not be found"],
    ["NotReadableError", "Close other apps"],
    ["OverconstrainedError", "capture settings"],
    ["AbortError", "was interrupted"],
  ])("explains %s", (name, message) => {
    expect(mediaRequestError({ name })).toContain(message);
  });
  it("preserves a meaningful unknown error and handles null", () => {
    expect(mediaRequestError(new Error("Custom camera failure"))).toBe(
      "Custom camera failure",
    );
    expect(mediaRequestError("A readable failure")).toBe("A readable failure");
    expect(mediaRequestError(null)).toContain("access failed");
  });
});
