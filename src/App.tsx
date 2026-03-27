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
import { useReadinessMonitor } from "@/hooks/useReadinessMonitor";
import type { PrimaryLanguage, SttModelVariant } from "@/lib/types";
import { resolveLatestStableRuntimeVersion } from "@/lib/runtimeVersion";
import type { AppUpdateProgressEvent, VoskModelOption } from "@/lib/tauri";

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

export default function App() {
  const { view } = useAppStore();
  const isInterviewActive = useAppStore((s) => s.isInterviewActive);
  const hydrateApiKey = useSettingsStore((s) => s.hydrateApiKey);
  const primaryLanguage = useSettingsStore((s) => s.primaryLanguage);
  const secondaryLanguage = useSettingsStore((s) => s.secondaryLanguage);
  const primarySttVariant = useSettingsStore((s) => s.primarySttVariant);
  const secondarySttVariant = useSettingsStore((s) => s.secondarySttVariant);
  const historyRetentionDays = useSettingsStore((s) => s.historyRetentionDays);
  const setSttInstall = useAppStore((s) => s.setSttInstall);
  const clearSttInstall = useAppStore((s) => s.clearSttInstall);
  const setReadiness = useAppStore((s) => s.setReadiness);
  const setAppUpdate = useAppStore((s) => s.setAppUpdate);
  const cleanup = useHistoryStore((s) => s.cleanup);

  const [isOverlayWindow, setIsOverlayWindow] = useState<boolean | null>(
    () => (typeof window !== "undefined" && isTauri() ? null : false),
  );
  const updateDownloadRef = useRef<{ downloaded: number; total: number | null }>({
    downloaded: 0,
    total: null,
  });
  useReadinessMonitor(isOverlayWindow === false);

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
    import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) => {
      setIsOverlayWindow(getCurrentWebviewWindow().label === "overlay");
    });
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

  const autoBaselineKeyRef = useRef<string>("");
  useEffect(() => {
    if (isOverlayWindow !== false || !isTauri()) {
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
        getSttStatus,
        listVoskRuntimeVersions,
        installVoskRuntime,
        listVoskModels,
        downloadVoskModel,
        removeVoskModel,
        setActiveVoskModel,
      } = await import("@/lib/tauri");

      try {
        const sttStatus = await getSttStatus();
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
          setSttInstall({
            active: true,
            phase: "runtime",
            percent: 0,
            detail: "Устанавливаем Vosk runtime...",
            language: null,
            variant: null,
          });
          await installVoskRuntime(undefined, (progress) => {
            if (cancelled) {
              return;
            }
            setSttInstall({
              active: true,
              phase: "runtime",
              percent: Math.round(progress.percent),
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
          new Set<PrimaryLanguage>(
            secondaryLanguage === "none"
              ? [primaryLanguage]
              : [primaryLanguage, secondaryLanguage],
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
            detail: `Подготавливаем базовую модель ${small.name} (${step}/${total})...`,
            language: small.language as PrimaryLanguage,
            variant: "small",
          });

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
              setSttInstall({
                active: true,
                phase: "model",
                percent: overallPercent,
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

        const backgroundLargePlan = targetLanguages
          .map((language) => {
            const preferredVariant = pickVariantForLanguage(language);
            if (preferredVariant !== "large") {
              return null;
            }

            const preferredModel = models.find(
              (model) => model.language === language && model.variant === preferredVariant,
            );
            if (!preferredModel || !needsModelInstall(preferredModel)) {
              return null;
            }

            return {
              language,
              model: preferredModel,
            };
          })
          .filter(
            (
              entry,
            ): entry is {
              language: PrimaryLanguage;
              model: VoskModelOption;
            } => Boolean(entry),
          );

        for (let index = 0; index < backgroundLargePlan.length; index += 1) {
          if (cancelled) {
            return;
          }

          const { language, model } = backgroundLargePlan[index];
          const step = index + 1;
          const total = backgroundLargePlan.length;

          setSttInstall({
            active: true,
            phase: "background-model",
            percent: Math.round((index / total) * 100),
            detail: `Улучшаем распознавание: подготавливаем ${model.name} (${step}/${total})...`,
            language,
            variant: "large",
          });

          await downloadVoskModel(
            model.download_url,
            model.id,
            (progress) => {
              if (cancelled) {
                return;
              }

              let itemPercent = progress.percent;
              if (
                itemPercent <= 0 &&
                progress.content_length === null &&
                progress.bytes_downloaded > 0 &&
                model.size_mb > 0
              ) {
                itemPercent = Math.min(
                  99,
                  (progress.bytes_downloaded / (model.size_mb * 1024 * 1024)) * 100,
                );
              }

              const overallPercent = Math.round(
                ((index + Math.max(0, Math.min(100, itemPercent)) / 100) / total) * 100,
              );

              setSttInstall({
                active: true,
                phase: "background-model",
                percent: overallPercent,
                detail:
                  progress.phase === "downloading"
                    ? `Улучшаем распознавание: скачиваем ${model.name} (${step}/${total})...`
                    : `Улучшаем распознавание: распаковываем ${model.name} (${step}/${total})...`,
                language,
                variant: "large",
              });
            },
            model.installed_versions.filter((id) => id !== model.id),
          );
          if (cancelled) {
            return;
          }

          models = await listVoskModels();
          if (cancelled) {
            return;
          }
        }

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

        if (activeModelId && !cancelled) {
          await setActiveVoskModel(activeModelId);
        }
      } catch (error) {
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

  useEffect(() => {
    if (!isTauri() || isOverlayWindow !== false || !isInterviewActive) {
      return;
    }

    import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) => {
      const mainWindow = getCurrentWebviewWindow();
      mainWindow.setSkipTaskbar(true).catch(() => {
        // Not supported on every platform/window manager.
      });
      mainWindow.hide().catch(() => {
        // Window may already be hidden.
      });
    });
  }, [isInterviewActive, isOverlayWindow]);

  if (isOverlayWindow === null) {
    return <div className="min-h-screen w-screen bg-transparent" />;
  }

  if (isOverlayWindow) {
    return <InterviewOverlay />;
  }

  return (
    <MainLayout>
      {view === "dashboard" && <Dashboard />}
      {view === "settings" && <SettingsPage />}
      {view === "history" && <HistoryPage />}
    </MainLayout>
  );
}
