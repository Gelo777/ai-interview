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
    return "Бессрочно";
  }
  return `${days} ${pluralizeDays(days)}`;
}

function pluralizeDays(days: number): string {
  const mod100 = days % 100;
  const mod10 = days % 10;
  if (mod100 >= 11 && mod100 <= 14) return "дней";
  if (mod10 === 1) return "день";
  if (mod10 >= 2 && mod10 <= 4) return "дня";
  return "дней";
}
