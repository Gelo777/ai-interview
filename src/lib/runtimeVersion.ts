export function normalizeRuntimeVersion(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.trim().replace(/^v/i, "");
}

export function extractRuntimeVersionFromPath(path: string | null): string | null {
  if (!path) {
    return null;
  }
  const normalized = path.replace(/\\/g, "/").split("/").filter(Boolean).reverse();
  for (const segment of normalized) {
    if (/^v?\d+(?:\.\d+){1,3}$/i.test(segment)) {
      return normalizeRuntimeVersion(segment);
    }
  }
  return null;
}

function parseRuntimeVersionParts(version: string): number[] {
  return normalizeRuntimeVersion(version)
    ?.split(".")
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part) && part >= 0) ?? [];
}

export function compareRuntimeVersions(
  current: string | null | undefined,
  latest: string | null | undefined,
): number {
  const currentParts = parseRuntimeVersionParts(current ?? "");
  const latestParts = parseRuntimeVersionParts(latest ?? "");

  const length = Math.max(currentParts.length, latestParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = currentParts[index] ?? 0;
    const b = latestParts[index] ?? 0;
    if (a > b) {
      return 1;
    }
    if (a < b) {
      return -1;
    }
  }
  return 0;
}

type RuntimeVersionLike = {
  version: string;
  is_latest_stable?: boolean;
  published_at?: string;
};

export function resolveLatestStableRuntimeVersion(
  versions: RuntimeVersionLike[],
): string | null {
  const latestStable = versions.find((version) => version.is_latest_stable);
  const normalizedStable = normalizeRuntimeVersion(latestStable?.version);
  if (normalizedStable) {
    return normalizedStable;
  }

  const sorted = [...versions].sort((a, b) =>
    (b.published_at ?? "").localeCompare(a.published_at ?? ""),
  );
  for (const version of sorted) {
    const normalized = normalizeRuntimeVersion(version.version);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}
