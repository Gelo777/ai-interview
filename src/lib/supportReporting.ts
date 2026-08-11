import type { DiagnosticEntry } from "@/lib/diagnostics";
import { buildDiagnosticsReport } from "@/lib/diagnostics";
import {
  submitSupportReport,
  submitTelemetryEvent,
  type TelemetrySeverity,
} from "@/lib/proxy";
import { useDiagnosticsStore } from "@/stores/diagnostics";
import { useSettingsStore } from "@/stores/settings";

const TELEMETRY_THROTTLE_MS = 2 * 60 * 1000;
const SUPPORT_THROTTLE_MS = 15 * 60 * 1000;
const MAX_AUTO_REPORT_ENTRIES = 120;
const MAX_SUPPORT_REPORT_CHARS = 75_000;

const SUPPORT_REPORT_SCOPES = new Set([
  "react.errorBoundary",
  "window.error",
  "window.unhandledrejection",
  "interview.start",
  "speech.setup",
  "speech.recovery",
  "speech.baseline",
]);

const TELEMETRY_WARN_PREFIXES = ["speech.", "updater.", "license.", "service.", "capture."];

export function shouldAutoReportDiagnostic(entry: DiagnosticEntry): boolean {
  if (entry.level === "error") {
    return true;
  }
  return TELEMETRY_WARN_PREFIXES.some((prefix) => entry.scope.startsWith(prefix));
}

export async function submitDiagnosticTelemetry(entry: DiagnosticEntry): Promise<void> {
  const throttleKey = `telemetry:${entry.level}:${entry.scope}:${entry.message}`;
  if (!claimThrottle(throttleKey, TELEMETRY_THROTTLE_MS)) {
    return;
  }

  const licenseKey = useSettingsStore.getState().apiKey;
  const knownSecrets = getKnownSecrets();
  const recentEntries = useDiagnosticsStore.getState().entries.slice(0, MAX_AUTO_REPORT_ENTRIES);
  const report = buildRedactedDiagnosticsReport(recentEntries, knownSecrets);

  try {
    await submitTelemetryEvent({
      licenseKey,
      eventType: entry.scope,
      severity: entry.level as TelemetrySeverity,
      appVersion: __APP_VERSION__,
      message: redactSecrets(entry.message, knownSecrets),
      payload: {
        details: entry.details ? redactSecrets(entry.details, knownSecrets) : null,
        timestamp: entry.timestamp,
        report: report.slice(0, 20_000),
      },
    });
  } catch (error) {
    console.warn("Failed to submit telemetry event:", error);
  }

  if (entry.level === "error" && SUPPORT_REPORT_SCOPES.has(entry.scope)) {
    await submitCriticalSupportReport({
      category: "desktop-auto",
      title: sanitizeReportText(`${entry.scope}: ${entry.message}`),
      throttleKey: `support:${entry.scope}:${entry.message}`,
      extra: entry.details ?? "",
    });
  }
}

export async function submitCriticalSupportReport(params: {
  category: string;
  title: string;
  extra?: string;
  throttleKey?: string;
  force?: boolean;
}): Promise<{ sent: boolean; reportId?: string; reason?: string }> {
  const licenseKey = useSettingsStore.getState().apiKey.trim();
  if (!licenseKey) {
    return { sent: false, reason: "missing-license" };
  }

  const throttleKey = params.throttleKey ?? `support:${params.category}:${params.title}`;
  if (!params.force && !claimThrottle(throttleKey, SUPPORT_THROTTLE_MS)) {
    return { sent: false, reason: "throttled" };
  }

  const report = buildSupportReport(params.title, params.extra);
  try {
    const response = await submitSupportReport({
      licenseKey,
      report,
      appVersion: __APP_VERSION__,
      category: params.category,
    });
    return { sent: true, reportId: response.reportId };
  } catch (error) {
    console.warn("Failed to submit support report:", error);
    return { sent: false, reason: "submit-failed" };
  }
}

export function buildSupportReport(title: string, extra?: string): string {
  const entries = useDiagnosticsStore.getState().entries.slice(0, MAX_AUTO_REPORT_ENTRIES);
  const knownSecrets = getKnownSecrets();
  const report = [
    `Контекст: ${sanitizeReportText(redactSecrets(title, knownSecrets))}`,
    extra
      ? `Подробности: ${sanitizeReportText(redactSecrets(extra, knownSecrets))}`
      : null,
    "",
    buildRedactedDiagnosticsReport(entries, knownSecrets),
  ]
    .filter((line): line is string => line !== null)
    .join("\n")
    .slice(0, MAX_SUPPORT_REPORT_CHARS);

  return report;
}

export function buildRedactedDiagnosticsReport(
  entries: DiagnosticEntry[],
  knownSecrets = getKnownSecrets(),
): string {
  return sanitizeReportText(redactSecrets(buildDiagnosticsReport(entries), knownSecrets));
}

function claimThrottle(key: string, windowMs: number): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  const storageKey = `ai-interview-report-throttle:${hashKey(key)}`;
  const now = Date.now();
  const previous = Number(window.localStorage.getItem(storageKey) ?? "0");
  if (Number.isFinite(previous) && now - previous < windowMs) {
    return false;
  }
  window.localStorage.setItem(storageKey, String(now));
  return true;
}

function hashKey(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function getKnownSecrets(): string[] {
  return [useSettingsStore.getState().apiKey];
}

export function redactSecrets(value: string, knownSecrets = getKnownSecrets()): string {
  let redacted = value;
  const normalizedSecrets = [...new Set(knownSecrets.map((secret) => secret.trim()))]
    .filter((secret) => secret.length >= 8)
    .sort((left, right) => right.length - left.length);

  for (const secret of normalizedSecrets) {
    redacted = redacted.split(secret).join("[секрет скрыт]");
    const encodedSecret = encodeURIComponent(secret);
    if (encodedSecret !== secret) {
      redacted = redacted.split(encodedSecret).join("[секрет скрыт]");
    }
  }

  return redacted
    .replace(
      /([?&](?:licenseKey|ticket)=)[^&\s"'<>]+/gi,
      "$1[секрет скрыт]",
    )
    .replace(
      /((?:Authorization\s*:\s*Bearer|X-License-Key\s*:)\s*)[^\s,}"']+/gi,
      "$1[секрет скрыт]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[секрет скрыт]")
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "[секрет скрыт]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[секрет скрыт]",
    )
    .replace(
      /\b[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/gi,
      "[ключ скрыт]",
    );
}

function sanitizeReportText(value: string): string {
  return value
    .replace(/\bstt\./gi, "speech.")
    .replace(/\bproxy\./gi, "service.")
    .replace(/\bllm\./gi, "assistant.")
    .replace(/\bSTT\b/g, "speech")
    .replace(/\bVosk\s+runtime\b/gi, "speech module")
    .replace(/\bVosk model\b/gi, "speech profile")
    .replace(/\bVosk\b/g, "speech")
    .replace(/\bproxy\b/gi, "service")
    .replace(/\bruntime\b/gi, "module")
    .replace(/\bhelper\b/gi, "assistant");
}
