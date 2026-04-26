import { useDiagnosticsStore } from "@/stores/diagnostics";

export type DiagnosticLevel = "info" | "warn" | "error";

export interface DiagnosticEntry {
  id: string;
  timestamp: number;
  level: DiagnosticLevel;
  scope: string;
  message: string;
  details: string | null;
}

function normalizeDiagnosticDetails(details: unknown): string | null {
  if (details === null || typeof details === "undefined") {
    return null;
  }

  if (details instanceof Error) {
    const stack = details.stack ? `\n${details.stack}` : "";
    return `${details.name}: ${details.message}${stack}`.trim();
  }

  if (typeof details === "string") {
    return details.trim() || null;
  }

  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

function writeConsole(level: DiagnosticLevel, scope: string, message: string, details: string | null) {
  const prefix = `[diag:${scope}] ${message}`;
  if (level === "error") {
    console.error(prefix, details ?? "");
    return;
  }
  if (level === "warn") {
    console.warn(prefix, details ?? "");
    return;
  }
  console.info(prefix, details ?? "");
}

export function logDiagnostic(
  level: DiagnosticLevel,
  scope: string,
  message: string,
  details?: unknown,
): void {
  const normalizedDetails = normalizeDiagnosticDetails(details);
  const entry: DiagnosticEntry = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    level,
    scope,
    message,
    details: normalizedDetails,
  };

  useDiagnosticsStore.getState().addEntry(entry);
  writeConsole(level, scope, message, normalizedDetails);
}

export function logInfo(scope: string, message: string, details?: unknown): void {
  logDiagnostic("info", scope, message, details);
}

export function logWarn(scope: string, message: string, details?: unknown): void {
  logDiagnostic("warn", scope, message, details);
}

export function logError(scope: string, message: string, details?: unknown): void {
  logDiagnostic("error", scope, message, details);
}

function buildEnvironmentSection(): string {
  const lines: string[] = [];
  const nowIso = new Date().toISOString();
  lines.push(`Generated at: ${nowIso}`);
  lines.push(`Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  lines.push(`User agent: ${navigator.userAgent}`);
  if (typeof window !== "undefined") {
    lines.push(`Location: ${window.location.href}`);
  }
  return lines.join("\n");
}

export function buildDiagnosticsReport(entries: DiagnosticEntry[]): string {
  const header = [
    "AI Interview Diagnostics Report",
    "================================",
    buildEnvironmentSection(),
    "",
    `Entries: ${entries.length}`,
    "",
  ].join("\n");

  if (entries.length === 0) {
    return `${header}\nNo diagnostic entries recorded yet.`;
  }

  const body = entries
    .map((entry, index) => {
      const date = new Date(entry.timestamp).toISOString();
      const lines = [
        `#${index + 1} ${date} [${entry.level.toUpperCase()}] ${entry.scope}`,
        entry.message,
      ];
      if (entry.details) {
        lines.push(entry.details);
      }
      return lines.join("\n");
    })
    .join("\n\n---\n\n");

  return `${header}${body}`;
}

export async function copyDiagnosticsReportToClipboard(report: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(report);
    return true;
  } catch {
    return false;
  }
}

export function installGlobalErrorDiagnostics(): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const onWindowError = (event: ErrorEvent) => {
    logError("window.error", event.message || "Unhandled window error", {
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      error: event.error ?? null,
    });
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    logError(
      "window.unhandledrejection",
      "Unhandled promise rejection",
      event.reason ?? null,
    );
  };

  window.addEventListener("error", onWindowError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  return () => {
    window.removeEventListener("error", onWindowError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}

