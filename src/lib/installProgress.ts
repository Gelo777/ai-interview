export function formatByteSize(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function formatTransferSize(
  bytesDownloaded: number | null | undefined,
  contentLength: number | null | undefined,
): string | null {
  const downloaded = formatByteSize(bytesDownloaded);
  if (!downloaded) {
    return null;
  }

  const total = formatByteSize(contentLength);
  return total ? `${downloaded} / ${total}` : downloaded;
}

export type TransferProgressTracker = {
  startedAtMs: number;
  lastAtMs: number;
  lastBytesDownloaded: number;
  smoothedBytesPerSecond: number | null;
};

export type TransferProgressMetrics = {
  speedBytesPerSecond: number | null;
  etaSeconds: number | null;
};

export function createTransferProgressTracker(nowMs = Date.now()): TransferProgressTracker {
  return {
    startedAtMs: nowMs,
    lastAtMs: nowMs,
    lastBytesDownloaded: 0,
    smoothedBytesPerSecond: null,
  };
}

export function updateTransferProgressTracker(
  tracker: TransferProgressTracker,
  bytesDownloaded: number | null | undefined,
  contentLength: number | null | undefined,
  nowMs = Date.now(),
): TransferProgressMetrics {
  const downloaded =
    bytesDownloaded !== null && bytesDownloaded !== undefined && Number.isFinite(bytesDownloaded)
      ? Math.max(0, bytesDownloaded)
      : 0;
  const total =
    contentLength !== null && contentLength !== undefined && Number.isFinite(contentLength)
      ? Math.max(0, contentLength)
      : null;

  const deltaBytes = Math.max(0, downloaded - tracker.lastBytesDownloaded);
  const deltaSeconds = Math.max(0.001, (nowMs - tracker.lastAtMs) / 1000);
  const instantSpeed = deltaBytes > 0 ? deltaBytes / deltaSeconds : null;

  if (instantSpeed !== null) {
    tracker.smoothedBytesPerSecond =
      tracker.smoothedBytesPerSecond === null
        ? instantSpeed
        : tracker.smoothedBytesPerSecond * 0.75 + instantSpeed * 0.25;
  } else if (downloaded > 0 && tracker.smoothedBytesPerSecond === null) {
    const elapsedSeconds = Math.max(0.001, (nowMs - tracker.startedAtMs) / 1000);
    tracker.smoothedBytesPerSecond = downloaded / elapsedSeconds;
  }

  tracker.lastAtMs = nowMs;
  tracker.lastBytesDownloaded = downloaded;

  const speed = tracker.smoothedBytesPerSecond;
  const etaSeconds =
    total !== null && total > downloaded && speed !== null && speed > 0
      ? Math.ceil((total - downloaded) / speed)
      : null;

  return {
    speedBytesPerSecond: speed,
    etaSeconds,
  };
}

export function formatTransferSpeed(bytesPerSecond: number | null | undefined): string | null {
  if (
    bytesPerSecond === null ||
    bytesPerSecond === undefined ||
    !Number.isFinite(bytesPerSecond) ||
    bytesPerSecond <= 0
  ) {
    return null;
  }

  const formatted = formatByteSize(bytesPerSecond);
  return formatted ? `${formatted}/s` : null;
}

export function formatEta(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  const rounded = Math.max(1, Math.round(seconds));
  if (rounded < 60) {
    return `${rounded} сек`;
  }

  const minutes = Math.floor(rounded / 60);
  const restSeconds = rounded % 60;
  if (minutes < 60) {
    return restSeconds > 0 ? `${minutes} мин ${restSeconds} сек` : `${minutes} мин`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours} ч ${restMinutes} мин` : `${hours} ч`;
}

export function formatTransferDiagnostics(
  bytesDownloaded: number | null | undefined,
  contentLength: number | null | undefined,
  speedBytesPerSecond: number | null | undefined,
  etaSeconds: number | null | undefined,
): string | null {
  const etaLabel = formatEta(etaSeconds);
  const chunks = [
    formatTransferSize(bytesDownloaded, contentLength),
    formatTransferSpeed(speedBytesPerSecond),
    etaLabel ? `осталось ${etaLabel}` : null,
  ].filter((chunk): chunk is string => Boolean(chunk));

  return chunks.length > 0 ? chunks.join(" · ") : null;
}
