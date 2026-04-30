import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/stores/app";
import {
  readLegacyPersistedApiKey,
  useSettingsStore,
} from "@/stores/settings";
import { useHistoryStore } from "@/stores/history";
import { MainLayout } from "@/components/layout/MainLayout";
import { Dashboard } from "@/pages/Dashboard";
import { SettingsPage } from "@/pages/SettingsPage";
import { HistoryPage } from "@/pages/HistoryPage";
import { InterviewOverlay } from "@/pages/InterviewOverlay";
import { isTauri } from "@/lib/tauri";
import { ensureSttModelWarm } from "@/lib/sttWarmup";
import { useReadinessMonitor } from "@/hooks/useReadinessMonitor";
import type { PrimaryLanguage, SttModelVariant } from "@/lib/types";
import { resolveLatestStableRuntimeVersion } from "@/lib/runtimeVersion";
import type { AppUpdateProgressEvent } from "@/lib/tauri";
import { logInfo, logWarn } from "@/lib/diagnostics";
import {
  createTransferProgressTracker,
  updateTransferProgressTracker,
} from "@/lib/installProgress";
import { applyCaptureProtectionPreference } from "@/lib/captureProtection";

function resolveInstalledModelId(model: {
  id: string;
  installed: boolean;
  installed_versions: string[];
}): string | null {
  if (model.installed) {
    return model.id;
  }
  if (model.installed_versions.length === 0) {
    return null;
  }
  const sorted = [...model.installed_versions].sort();
  return sorted[sorted.length - 1] ?? null;
}

function needsModelInstall(model: {
  installed: boolean;
  update_available: boolean;
  installed_versions: string[];
}): boolean {
  const hasInstalledVersion = model.installed || model.installed_versions.length > 0;
  return !hasInstalledVersion || model.update_available || model.installed_versions.length > 1;
}

function detectCurrentTauriWindowLabel(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const urlLabel = new URL(window.location.href).searchParams.get("aiWindow");
  if (urlLabel === "main" || urlLabel === "overlay") {
    return urlLabel;
  }

  const internals = window as unknown as {
    __TAURI_INTERNALS__?: {
      metadata?: {
        currentWindow?: {
          label?: string;
        };
      };
    };
  };

  const label = internals.__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
  if (typeof label !== "string" || !label.trim()) {
    return null;
  }
  return label;
}

export default function App() {
  const { view } = useAppStore();
  const isInterviewActive = useAppStore((s) => s.isInterviewActive);
  const hydrateApiKey = useSettingsStore((s) => s.hydrateApiKey);
  const primaryLanguage = useSettingsStore((s) => s.primaryLanguage);
  const secondaryLanguage = useSettingsStore((s) => s.secondaryLanguage);
  const primarySttVariant = useSettingsStore((s) => s.primarySttVariant);
  const secondarySttVariant = useSettingsStore((s) => s.secondarySttVariant);
  const historyRetentionDays = useSettingsStore((s) => s.historyRetentionDays);
  const protectOverlay = useSettingsStore((s) => s.protectOverlay);
  const setSttInstall = useAppStore((s) => s.setSttInstall);
  const clearSttInstall = useAppStore((s) => s.clearSttInstall);
  const setReadiness = useAppStore((s) => s.setReadiness);
  const setAppUpdate = useAppStore((s) => s.setAppUpdate);
  const cleanup = useHistoryStore((s) => s.cleanup);

  const [isOverlayWindow, setIsOverlayWindow] = useState<boolean | null>(
    () => {
      if (typeof window === "undefined" || !isTauri()) {
        return false;
      }
      const label = detectCurrentTauriWindowLabel();
      if (label === "overlay") {
        logInfo("window.detect", "Detected overlay window from internals");
        return true;
      }
      if (label === "main") {
        logInfo("window.detect", "Detected main window from internals");
        return false;
      }
      logWarn("window.detect", "Window label was not available on first render, assuming main window");
      return false;
    },
  );
  const updateDownloadRef = useRef<{ downloaded: number; total: number | null }>({
    downloaded: 0,
    total: null,
  });
  useReadinessMonitor(isOverlayWindow === false && !isInterviewActive);

  useEffect(() => {
    cleanup();
  }, [cleanup, historyRetentionDays]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateApiKeyState() {
      const legacyApiKey = readLegacyPersistedApiKey().trim();

      if (!isTauri()) {
        if (!cancelled && legacyApiKey) {
          hydrateApiKey(legacyApiKey);
        }
        return;
      }

      try {
        const { getSecureApiKey, setSecureApiKey } = await import("@/lib/tauri");
        const secureApiKey = ((await getSecureApiKey()) ?? "").trim();
        if (cancelled) {
          return;
        }

        if (secureApiKey) {
          hydrateApiKey(secureApiKey);
          return;
        }

        if (legacyApiKey) {
          await setSecureApiKey(legacyApiKey);
          if (cancelled) {
            return;
          }
          hydrateApiKey(legacyApiKey);
        }
      } catch (error) {
        if (!cancelled && legacyApiKey) {
          hydrateApiKey(legacyApiKey);
        }
        logWarn("settings.apiKey", "Failed to hydrate API key from secure storage", error);
        console.warn("Failed to hydrate API key from secure storage:", error);
      }
    }

    void hydrateApiKeyState();

    return () => {
      cancelled = true;
    };
  }, [hydrateApiKey]);

  useEffect(() => {
    if (!isTauri() || isOverlayWindow !== null) return;
    let cancelled = false;
    const fallbackTimeoutId = window.setTimeout(() => {
      if (cancelled) {
        return;
      }
      logWarn("window.detect", "Window label detection timed out, falling back to main window");
      setIsOverlayWindow(false);
    }, 1200);

    const finish = (value: boolean) => {
      if (cancelled) {
        return;
      }
      window.clearTimeout(fallbackTimeoutId);
      setIsOverlayWindow(value);
    };

    const fromInternals = detectCurrentTauriWindowLabel();
    if (fromInternals) {
      finish(fromInternals === "overlay");
      return;
    }

    import("@tauri-apps/api/webviewWindow")
      .then(({ getCurrentWebviewWindow }) => {
        finish(getCurrentWebviewWindow().label === "overlay");
      })
      .catch((error) => {
        logWarn("window.detect", "Failed to detect current Tauri window label", error);
        console.warn("Failed to detect current Tauri window label:", error);
        finish(false);
      });

    return () => {
      cancelled = true;
      window.clearTimeout(fallbackTimeoutId);
    };
  }, [isOverlayWindow]);

  useEffect(() => {
    if (typeof document === "undefined" || isOverlayWindow === null) {
      return;
    }

    document.body.classList.toggle("overlay-window", isOverlayWindow);
    return () => {
      document.body.classList.remove("overlay-window");
    };
  }, [isOverlayWindow]);

  useEffect(() => {
    if (!isTauri() || isOverlayWindow === null) {
      return;
    }

    applyCaptureProtectionPreference(protectOverlay)
      .then(() => {
        logInfo("capture.protection", "Capture protection preference applied", {
          enabled: protectOverlay,
          windowType: isOverlayWindow ? "overlay" : "main",
        });
      })
      .catch((error) => {
        logWarn("capture.protection", "Failed to apply capture protection preference", error);
        console.warn("Failed to apply capture protection preference:", error);
      });
  }, [isOverlayWindow, protectOverlay]);

  const autoBaselineKeyRef = useRef<string>("");
  useEffect(() => {
    if (isOverlayWindow !== false || !isTauri()) {
      return;
    }
    if (isInterviewActive) {
      void import("@/lib/tauri")
        .then(({ cancelVoskInstall }) => cancelVoskInstall())
        .catch(() => {
          // Best effort: stop any background Vosk install while interview is active.
        });
      return;
    }

    const baselineKey = `${primaryLanguage}|${primarySttVariant}|${secondaryLanguage}|${secondarySttVariant}`;
    if (autoBaselineKeyRef.current === baselineKey) {
      return;
    }
    autoBaselineKeyRef.current = baselineKey;

    let cancelled = false;
    async function ensureBaselineSttAssets() {

      const {
        getVoskSttStatus,
        listVoskRuntimeVersions,
        installVoskRuntime,
        listVoskModels,
        downloadVoskModel,
        removeVoskModel,
        setActiveVoskModel,
      } = await import("@/lib/tauri");

      try {
        const sttStatus = await getVoskSttStatus();
        if (cancelled) {
          return;
        }
        await listVoskRuntimeVersions()
          .then((versions) => {
            const latestStable = resolveLatestStableRuntimeVersion(versions);
            setReadiness({
              voskLatestStableKnown: latestStable !== null,
              voskLatestStableVersion: latestStable,
            });
            return versions;
          })
          .catch(() => {
            setReadiness({
              voskLatestStableKnown: false,
              voskLatestStableVersion: null,
            });
            return [];
          });
        if (cancelled) {
          return;
        }
        const runtimeNeedsInstall = !sttStatus.runtime_library_loaded;

        if (runtimeNeedsInstall) {
          const runtimeProgressTracker = createTransferProgressTracker();
          setSttInstall({
            active: true,
            phase: "runtime",
            percent: 0,
            bytesDownloaded: null,
            contentLength: null,
            speedBytesPerSecond: null,
            etaSeconds: null,
            detail: "Устанавливаем Vosk runtime...",
            language: null,
            variant: null,
          });
          await installVoskRuntime(undefined, (progress) => {
            if (cancelled) {
              return;
            }
            const metrics = updateTransferProgressTracker(
              runtimeProgressTracker,
              progress.bytes_downloaded,
              progress.content_length,
            );
            setSttInstall({
              active: true,
              phase: "runtime",
              percent: Math.round(progress.percent),
              bytesDownloaded: progress.bytes_downloaded,
              contentLength: progress.content_length,
              speedBytesPerSecond: metrics.speedBytesPerSecond,
              etaSeconds: metrics.etaSeconds,
              detail:
                progress.phase === "downloading"
                  ? "Скачиваем Vosk runtime..."
                  : "Распаковываем Vosk runtime...",
              language: null,
              variant: null,
            });
          });
          if (cancelled) {
            return;
          }
        }

        const targetLanguages = Array.from(
          new Set(
            [primaryLanguage, secondaryLanguage].filter(
              (language): language is PrimaryLanguage => language !== "none",
            ),
          ),
        );
        const targetLanguageSet = new Set(targetLanguages);

        let models = await listVoskModels();
        const staleModels = models.filter(
          (model) =>
            !targetLanguageSet.has(model.language as PrimaryLanguage) &&
            model.installed_versions.length > 0,
        );
        for (const model of staleModels) {
          if (cancelled) {
            return;
          }
          for (const versionId of model.installed_versions) {
            await removeVoskModel(versionId);
            if (cancelled) {
              return;
            }
          }
        }
        if (staleModels.length > 0) {
          models = await listVoskModels();
          if (cancelled) {
            return;
          }
        }

        const smallInstallPlan = targetLanguages
          .map((language) =>
            models.find((model) => model.language === language && model.variant === "small"),
          )
          .filter((small): small is NonNullable<typeof small> => Boolean(small))
          .filter((small) => needsModelInstall(small));

        for (let index = 0; index < smallInstallPlan.length; index += 1) {
          if (cancelled) {
            return;
          }
          const small = smallInstallPlan[index];
          const step = index + 1;
          const total = smallInstallPlan.length;

          setSttInstall({
            active: true,
            phase: "model",
            percent: Math.round((index / total) * 100),
            bytesDownloaded: null,
            contentLength: null,
            speedBytesPerSecond: null,
            etaSeconds: null,
            detail: `Подготавливаем базовую модель ${small.name} (${step}/${total})...`,
            language: small.language as PrimaryLanguage,
            variant: "small",
          });

          const modelProgressTracker = createTransferProgressTracker();
          await downloadVoskModel(
            small.download_url,
            small.id,
            (progress) => {
              if (cancelled) {
                return;
              }
              let itemPercent = progress.percent;
              if (
                itemPercent <= 0 &&
                progress.content_length === null &&
                progress.bytes_downloaded > 0 &&
                small.size_mb > 0
              ) {
                itemPercent = Math.min(
                  99,
                  (progress.bytes_downloaded / (small.size_mb * 1024 * 1024)) * 100,
                );
              }
              const overallPercent = Math.round(
                ((index + Math.max(0, Math.min(100, itemPercent)) / 100) / total) * 100,
              );
              const estimatedContentLength =
                progress.content_length ?? (small.size_mb > 0 ? small.size_mb * 1024 * 1024 : null);
              const metrics = updateTransferProgressTracker(
                modelProgressTracker,
                progress.bytes_downloaded,
                estimatedContentLength,
              );
              setSttInstall({
                active: true,
                phase: "model",
                percent: overallPercent,
                bytesDownloaded: progress.bytes_downloaded,
                contentLength: estimatedContentLength,
                speedBytesPerSecond: metrics.speedBytesPerSecond,
                etaSeconds: metrics.etaSeconds,
                detail:
                  progress.phase === "downloading"
                    ? `Скачиваем базовую модель ${small.name} (${step}/${total})...`
                    : `Распаковываем базовую модель ${small.name} (${step}/${total})...`,
                language: small.language as PrimaryLanguage,
                variant: "small",
              });
            },
            small.installed_versions.filter((id) => id !== small.id),
          );
          if (cancelled) {
            return;
          }

          models = await listVoskModels();
          if (cancelled) {
            return;
          }
        }

        const pickVariantForLanguage = (language: PrimaryLanguage): SttModelVariant => {
          if (language === primaryLanguage) {
            return primarySttVariant;
          }
          if (language === secondaryLanguage) {
            return secondarySttVariant;
          }
          return "small";
        };

        // Stability-first baseline:
        // we auto-install only small models here.
        // Large models stay manual in Settings to avoid heavy background load.

        const preferredVariant = pickVariantForLanguage(primaryLanguage);
        const preferredModel = models.find(
          (model) =>
            model.language === primaryLanguage &&
            model.variant === preferredVariant,
        );
        const fallbackSmall = models.find(
          (model) => model.language === primaryLanguage && model.variant === "small",
        );
        const activeModelId =
          resolveInstalledModelId(preferredModel ?? { id: "", installed: false, installed_versions: [] }) ??
          resolveInstalledModelId(fallbackSmall ?? { id: "", installed: false, installed_versions: [] });
        const largeWarmupModelIds = Array.from(
          new Set(
            targetLanguages
              .map((language) => {
                const preferredVariant = pickVariantForLanguage(language);
                if (preferredVariant !== "large") {
                  return null;
                }
                return resolveInstalledModelId(
                  models.find(
                    (model) =>
                      model.language === language && model.variant === preferredVariant,
                  ) ?? { id: "", installed: false, installed_versions: [] },
                );
              })
              .filter((modelId): modelId is string => Boolean(modelId)),
          ),
        );

        const resolvedActiveModelId = activeModelId ?? "";
        if (resolvedActiveModelId.length > 0 && !cancelled) {
          await setActiveVoskModel(resolvedActiveModelId);
        }

        if (!cancelled && largeWarmupModelIds.length > 0) {
          await Promise.allSettled(largeWarmupModelIds.map((modelId) => ensureSttModelWarm(modelId)));
        }
      } catch (error) {
        logWarn("stt.baseline", "Automatic STT setup failed", error);
        console.warn("Automatic STT setup failed:", error);
      } finally {
        clearSttInstall();
      }
    }

    void ensureBaselineSttAssets();
    return () => {
      cancelled = true;
    };
  }, [
    clearSttInstall,
    isInterviewActive,
    isOverlayWindow,
    primaryLanguage,
    primarySttVariant,
    secondaryLanguage,
    secondarySttVariant,
    setSttInstall,
    setReadiness,
  ]);

  useEffect(() => {
    if (!isTauri() || isOverlayWindow !== false) {
      return;
    }

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    async function initUpdates() {
      const { listen } = await import("@tauri-apps/api/event");
      const { checkAppUpdate } = await import("@/lib/tauri");

      unlisten = await listen<AppUpdateProgressEvent>("app_update_progress", (event) => {
        if (cancelled) {
          return;
        }

        if (event.payload.event === "Started") {
          updateDownloadRef.current = {
            downloaded: 0,
            total: event.payload.data.contentLength ?? null,
          };
          setAppUpdate({
            installing: true,
            downloadPercent: event.payload.data.contentLength ? 0 : null,
            error: null,
          });
          return;
        }

        if (event.payload.event === "Progress") {
          updateDownloadRef.current.downloaded += event.payload.data.chunkLength;
          const total = updateDownloadRef.current.total;
          setAppUpdate({
            installing: true,
            downloadPercent:
              total && total > 0
                ? Math.max(
                    0,
                    Math.min(100, Math.round((updateDownloadRef.current.downloaded / total) * 100)),
                  )
                : null,
            error: null,
          });
          return;
        }

        setAppUpdate({
          installing: true,
          downloadPercent: 100,
          error: null,
        });
      });

      setAppUpdate({
        checking: true,
        error: null,
      });

      try {
        const status = await checkAppUpdate();
        if (cancelled) {
          return;
        }
        setAppUpdate({
          enabled: status.enabled,
          checking: false,
          available: status.updateAvailable,
          currentVersion: status.currentVersion,
          version: status.version,
          body: status.body,
          date: status.date,
          error: status.error,
          endpoint: status.endpoint,
          installing: false,
          downloadPercent: null,
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        logWarn("updater.check", "Failed to check app updates", error);
        setAppUpdate({
          enabled: true,
          checking: false,
          available: false,
          error: error instanceof Error ? error.message : "Не удалось проверить обновления",
          installing: false,
          downloadPercent: null,
        });
      }
    }

    void initUpdates();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isOverlayWindow, setAppUpdate]);

  const unlistenInterviewEndedRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!isTauri() || isOverlayWindow !== false) return;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("interview_ended", async () => {
        logInfo("window.main", "Received interview_ended event");
        useAppStore.getState().setInterviewActive(false);
        useAppStore.getState().setView("dashboard");
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const mainWindow = getCurrentWebviewWindow();
        await mainWindow.setSkipTaskbar(false).catch(() => {
          // Not supported on every platform/window manager.
        });
        await mainWindow.show();
        await mainWindow.unminimize().catch(() => {
          // Window may already be restored.
        });
        await mainWindow.setFocus().catch(() => {
          // Focus changes may be blocked by the OS.
        });
      }).then((fn) => {
        unlistenInterviewEndedRef.current = fn;
      });
    });
    return () => {
      unlistenInterviewEndedRef.current?.();
      unlistenInterviewEndedRef.current = null;
    };
  }, [isOverlayWindow]);

  if (isOverlayWindow === null) {
    return <div className="min-h-screen w-screen bg-transparent" />;
  }

  if (isOverlayWindow) {
    return <InterviewOverlay mode="detached" />;
  }

  return (
    <MainLayout>
      {view === "dashboard" && <Dashboard />}
      {view === "settings" && <SettingsPage />}
      {view === "history" && <HistoryPage />}
      {view === "interview" && <InterviewOverlay mode="embedded" />}
    </MainLayout>
  );
}
