export type CaptureAccessIssue = {
  code: "insecure" | "policy_blocked" | "unsupported";
  message: string;
};

export type CaptureAccessEnvironment = {
  secureContext: boolean;
  hasGetUserMedia: boolean;
  embedded: boolean;
  blockedFeatures?: string[];
};

/** Diagnose browser capabilities without requesting permission or enumerating devices. */
export function captureAccessIssue(
  environment: CaptureAccessEnvironment,
): CaptureAccessIssue | null {
  if (!environment.secureContext) {
    return {
      code: "insecure",
      message: `${environment.embedded ? "This embedded page is not a secure camera context." : "This connection is not a secure camera context."} Open the app directly at localhost in Chrome or Safari on this computer, or use the HTTPS address on your phone.`,
    };
  }

  const blocked = [...new Set(environment.blockedFeatures || [])].filter(
    (feature) => feature === "camera" || feature === "microphone",
  );
  if (blocked.length) {
    return {
      code: "policy_blocked",
      message: `This page's permissions policy blocks ${blocked.join(" and ")} access. Open the app directly in Chrome or Safari, or allow these features in the page embedding it.`,
    };
  }

  if (!environment.hasGetUserMedia) {
    return {
      code: "unsupported",
      message: environment.embedded
        ? "This embedded preview does not expose camera and microphone access. Open the app directly in Chrome or Safari."
        : "This browser does not expose camera and microphone access. Open the app directly in Chrome or Safari instead of an embedded preview.",
    };
  }

  return null;
}

type CapturePolicy = { allowsFeature?: (feature: string) => boolean };

/** Optional policy APIs differ between browsers; missing diagnostics are not a denial. */
export function browserCaptureAccessIssue(): CaptureAccessIssue | null {
  let embedded = false;
  try {
    embedded = window.self !== window.top;
  } catch {
    embedded = true;
  }

  const policyDocument = document as Document & {
    permissionsPolicy?: CapturePolicy;
    featurePolicy?: CapturePolicy;
  };
  const blockedFeatures: string[] = [];
  try {
    const policy =
      policyDocument.permissionsPolicy || policyDocument.featurePolicy;
    if (typeof policy?.allowsFeature === "function") {
      for (const feature of ["camera", "microphone"]) {
        try {
          if (policy.allowsFeature(feature) === false)
            blockedFeatures.push(feature);
        } catch {
          // A browser may expose the policy API without understanding a feature.
        }
      }
    }
  } catch {
    // An unavailable host diagnostic must not prevent a supported capture API.
  }

  let hasGetUserMedia = false;
  try {
    hasGetUserMedia =
      typeof navigator.mediaDevices?.getUserMedia === "function";
  } catch {
    // Some embedded hosts deny access to the mediaDevices property itself.
  }

  return captureAccessIssue({
    secureContext: window.isSecureContext === true,
    hasGetUserMedia,
    embedded,
    blockedFeatures,
  });
}

/** Keep permission, hardware, and constraints failures distinct from HTTPS problems. */
export function mediaRequestError(error: unknown): string {
  const detail = error as { name?: unknown; message?: unknown } | null;
  switch (detail?.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "Camera or microphone permission was denied. Allow both for this site in your browser, and check your device's camera and microphone privacy settings. Then try again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "A camera or microphone could not be found. Connect or enable both devices, then try again.";
    case "NotReadableError":
    case "TrackStartError":
      return "The camera or microphone could not start. Close other apps using them, check device privacy settings, and try again.";
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "The camera or microphone cannot support the requested capture settings. Try another device or browser.";
    case "AbortError":
      return "Camera or microphone startup was interrupted. Try starting the sweep again.";
  }
  if (typeof detail?.message === "string" && detail.message.trim())
    return detail.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Camera and microphone access failed. Open the app directly in Chrome or Safari and try again.";
}
