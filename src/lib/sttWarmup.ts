import { logInfo, logWarn } from "@/lib/diagnostics";
import { isTauri, preloadSttModel } from "@/lib/tauri";

const warmModels = new Set<string>();
const inflightWarmups = new Map<string, Promise<void>>();
const warmupSnapshots = new Map<string, SttWarmupSnapshot>();

export type SttWarmupSnapshot = {
  modelId: string;
  state: "idle" | "warming" | "ready" | "failed";
  startedAt: number | null;
  finishedAt: number | null;
  errorMessage: string | null;
};

function setWarmupSnapshot(
  modelId: string,
  patch: Partial<SttWarmupSnapshot>,
): SttWarmupSnapshot {
  const current = warmupSnapshots.get(modelId) ?? {
    modelId,
    state: "idle" as const,
    startedAt: null,
    finishedAt: null,
    errorMessage: null,
  };
  const next = { ...current, ...patch };
  warmupSnapshots.set(modelId, next);
  return next;
}

export function isSttModelWarm(modelId: string | null | undefined): boolean {
  const trimmed = modelId?.trim() ?? "";
  if (!trimmed) {
    return false;
  }

  return warmModels.has(trimmed);
}

export function getSttWarmupSnapshot(
  modelId: string | null | undefined,
): SttWarmupSnapshot | null {
  const trimmed = modelId?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  const snapshot = warmupSnapshots.get(trimmed);
  if (snapshot) {
    return snapshot;
  }

  if (warmModels.has(trimmed)) {
    return {
      modelId: trimmed,
      state: "ready",
      startedAt: null,
      finishedAt: null,
      errorMessage: null,
    };
  }

  return {
    modelId: trimmed,
    state: "idle",
    startedAt: null,
    finishedAt: null,
    errorMessage: null,
  };
}

export async function ensureSttModelWarm(modelId: string): Promise<void> {
  const trimmed = modelId.trim();
  if (!trimmed || !isTauri()) {
    return;
  }

  if (warmModels.has(trimmed)) {
    setWarmupSnapshot(trimmed, {
      state: "ready",
      finishedAt: Date.now(),
      errorMessage: null,
    });
    return;
  }

  const inflight = inflightWarmups.get(trimmed);
  if (inflight) {
    await inflight;
    return;
  }

  const startedAt = Date.now();
  setWarmupSnapshot(trimmed, {
    state: "warming",
    startedAt,
    finishedAt: null,
    errorMessage: null,
  });
  const warmupPromise = preloadSttModel(trimmed)
    .then(() => {
      warmModels.add(trimmed);
      setWarmupSnapshot(trimmed, {
        state: "ready",
        finishedAt: Date.now(),
        errorMessage: null,
      });
      logInfo("stt.preload", "STT model warmup completed", {
        modelId: trimmed,
        durationMs: Date.now() - startedAt,
      });
    })
    .catch((error: unknown) => {
      const errorMessage =
        error instanceof Error ? error.message : "Неизвестная ошибка прогрева модели";
      setWarmupSnapshot(trimmed, {
        state: "failed",
        finishedAt: Date.now(),
        errorMessage,
      });
      logWarn("stt.preload", "STT model warmup failed", {
        modelId: trimmed,
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    })
    .finally(() => {
      inflightWarmups.delete(trimmed);
    });

  inflightWarmups.set(trimmed, warmupPromise);
  logInfo("stt.preload", "STT model warmup started", { modelId: trimmed });
  await warmupPromise;
}
