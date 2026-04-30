import {
  isTauri,
  setCaptureProtectionForWindow,
} from "@/lib/tauri";

const CAPTURE_PROTECTED_WINDOW_LABELS = ["main", "overlay"] as const;

function isWindowMissingError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error);

  return message.toLowerCase().includes("window") && message.toLowerCase().includes("not found");
}

export async function applyCaptureProtectionPreference(enabled: boolean): Promise<void> {
  if (!isTauri()) {
    return;
  }

  const results = await Promise.allSettled(
    CAPTURE_PROTECTED_WINDOW_LABELS.map((label) =>
      setCaptureProtectionForWindow(label, enabled),
    ),
  );

  const appliedToAnyWindow = results.some((result) => result.status === "fulfilled");
  const realFailure = results.find(
    (result) =>
      result.status === "rejected" && !isWindowMissingError(result.reason),
  );

  if (realFailure?.status === "rejected") {
    throw realFailure.reason;
  }

  if (!appliedToAnyWindow) {
    throw new Error("No AI Interview windows were available for capture protection.");
  }
}
