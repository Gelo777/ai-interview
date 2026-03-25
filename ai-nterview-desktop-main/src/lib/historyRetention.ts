export const DEFAULT_HISTORY_RETENTION_DAYS = 30;
export const MIN_HISTORY_RETENTION_DAYS = 1;

export function normalizeHistoryRetentionDays(value: unknown): number | null {
  if (value === null) {
    return null;
  }

  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return DEFAULT_HISTORY_RETENTION_DAYS;
  }

  return Math.max(MIN_HISTORY_RETENTION_DAYS, Math.floor(parsed));
}

export function formatHistoryRetentionLabel(days: number | null): string {
  if (days === null) {
    return "Forever";
  }
  return `${days} day${days === 1 ? "" : "s"}`;
}
