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
