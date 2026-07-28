import { useState, useCallback, useRef } from "react";
import {
  Play,
  AlertTriangle,
  Clock,
  Brain,
  Activity,
  TrendingUp,
  Download,
  RefreshCw,
  Eye,
  EyeOff,
  Check,
  Loader2,
  BarChart3,
  KeyRound,
  Cloud,
  Mic,
  Volume2,
  AudioLines,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { InterviewContextCard } from "@/components/dashboard/InterviewContextCard";
import { useAppStore } from "@/stores/app";
import { useHistoryStore } from "@/stores/history";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { refreshCloudReadinessNow, refreshLocalReadinessNow } from "@/hooks/useReadinessMonitor";
import type { SettingsFocusTarget, SettingsTab } from "@/lib/types";
import { getSttPerformanceProfileLabel } from "@/lib/sttProfiles";
import { logError, logInfo, logWarn } from "@/lib/diagnostics";
import { applyCaptureProtectionPreference } from "@/lib/captureProtection";
import { getServiceStatus } from "@/lib/proxy";
import { submitCriticalSupportReport } from "@/lib/supportReporting";
import type { CaptureAudioSampleResult } from "@/lib/tauri";
import { useT } from "@/lib/i18n";

const START_READINESS_TIMEOUT_MS = 8000;
const AUDIO_TEST_COMPLETED_KEY = "ai-interview-audio-test-completed-v1";
const CLIENT_STT_MODEL_INSTALL_ENABLED = false;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: number | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

function toFriendlyStartError(error: unknown): string {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Не удалось запустить интервью";
  const normalized = detail.toLowerCase();

  if (normalized.includes("истекло время") || normalized.includes("timeout")) {
    return "Запуск занял слишком много времени. Проверь сеть и устройства, затем попробуй еще раз.";
  }
  if (normalized.includes("overlay")) {
    return "Не удалось открыть рабочее окно. Попробуйте запустить снова.";
  }

  return detail;
}

export function Dashboard() {
  const t = useT();
  const {
    permissions,
    readiness,
    setInterviewActive,
    sttInstall,
    setView,
    setSettingsTab,
    setSettingsFocus,
    appUpdate,
    setAppUpdate,
    dismissAppUpdate,
  } = useAppStore();
  const { sessions } = useHistoryStore();
  const startSession = useSessionStore((s) => s.startSession);
  const primaryLanguage = useSettingsStore((s) => s.primaryLanguage);
  const primarySttVariant = useSettingsStore((s) => s.primarySttVariant);
  const secondarySttVariant = useSettingsStore((s) => s.secondarySttVariant);
  const protectOverlay = useSettingsStore((s) => s.protectOverlay);
  const setProtectOverlay = useSettingsStore((s) => s.setProtectOverlay);
  const [starting, setStarting] = useState(false);
  const [applyingCaptureProtection, setApplyingCaptureProtection] = useState(false);
  const [captureProtectionError, setCaptureProtectionError] = useState<string | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [runningSystemCheck, setRunningSystemCheck] = useState(false);
  const [lastSystemCheckAt, setLastSystemCheckAt] = useState<number | null>(null);
  const [systemCheckError, setSystemCheckError] = useState<string | null>(null);
  const [proxyStatusDetail, setProxyStatusDetail] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [startReportStatus, setStartReportStatus] = useState<string | null>(null);
  const [sendingStartReport, setSendingStartReport] = useState(false);
  const [audioTestCompleted, setAudioTestCompleted] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem(AUDIO_TEST_COMPLETED_KEY) === "1";
  });
  const audioCheckRef = useRef<HTMLDivElement | null>(null);

  const lastSession = sessions[0] ?? null;

  const installBlocksInterview = CLIENT_STT_MODEL_INSTALL_ENABLED &&
    sttInstall.active &&
    sttInstall.phase !== "background-model" &&
    (sttInstall.phase !== "model" ||
      (sttInstall.language === primaryLanguage &&
        sttInstall.variant === primarySttVariant));

  const allReady =
    readiness.apiKey === "granted" &&
    readiness.model === "granted" &&
    permissions.microphone === "granted" &&
    permissions.systemAudio === "granted" &&
    readiness.vosk === "granted" &&
    !installBlocksInterview;
  const cloudReady = readiness.apiKey === "granted" && readiness.model === "granted";

  const openSettingsTab = useCallback(
    (tab: SettingsTab, focus?: SettingsFocusTarget) => {
      setSettingsTab(tab);
      setSettingsFocus(focus ?? null);
      setView("settings");
    },
    [setSettingsFocus, setSettingsTab, setView],
  );

  const handleStartInterview = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    logInfo("interview.start", "Start interview requested", {
      allReady,
      installBlocksInterview,
    });
    try {
      let readyToStart = allReady;
      if (!readyToStart) {
        const [local, cloud] = await withTimeout(
          Promise.all([refreshLocalReadinessNow(), refreshCloudReadinessNow()]),
          START_READINESS_TIMEOUT_MS,
          t("Истекло время ожидания проверки готовности."),
        );
        readyToStart =
          cloud.apiReady &&
          cloud.modelReady &&
          local.microphone === "granted" &&
          local.systemAudio === "granted" &&
          local.voskReady &&
          !installBlocksInterview;
      }

      if (!readyToStart) {
        logWarn("interview.start", "Readiness check failed, start blocked");
        return;
      }

      startSession();
      setView("interview");
      setInterviewActive(true);
      logInfo("interview.start", "Interview session started successfully");
    } catch (e) {
      console.error("Failed to start interview", e);
      logError("interview.start", "Failed to start interview", e);
      setInterviewActive(false);
      setStartError(toFriendlyStartError(e));
    } finally {
      setStarting(false);
    }
  }, [allReady, installBlocksInterview, setInterviewActive, setView, startSession, t]);

  const missingItems = [
    readiness.apiKey !== "granted" ? t("лицензионный ключ") : null,
    readiness.model !== "granted" ? t("подключение к сервису") : null,
    permissions.microphone !== "granted" ? t("микрофон") : null,
    permissions.systemAudio !== "granted" ? t("системный звук") : null,
    readiness.vosk !== "granted" ? t("распознавание речи") : null,
    installBlocksInterview ? t("идет обязательная установка компонентов распознавания") : null,
  ].filter((item): item is string => Boolean(item));
  const missingItemsText = missingItems.length > 0 ? missingItems.join(", ") : t("нет");
  const safeModeAvailable = cloudReady && !installBlocksInterview;
  const safeModeReason =
    missingItems.length > 0
      ? t("Режим без аудио включен, потому что не готовы: {items}.", { items: missingItems.join(", ") })
      : t("Режим без аудио включен вручную: используйте ручной ввод и ножницы.");

  const handleStartSafeMode = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    logWarn("interview.start", "Без аудио start requested", {
      safeModeAvailable,
      reason: safeModeReason,
    });

    try {
      let readyToStart = safeModeAvailable;
      if (!readyToStart) {
        const [, cloud] = await withTimeout(
          Promise.all([refreshLocalReadinessNow(), refreshCloudReadinessNow()]),
          START_READINESS_TIMEOUT_MS,
          t("Истекло время ожидания проверки готовности."),
        );
        readyToStart = cloud.apiReady && cloud.modelReady && !installBlocksInterview;
      }

      if (!readyToStart) {
        setStartError(
          t("Режим без аудио недоступен: нужна активная лицензия и подключение к сервису."),
        );
        return;
      }

      startSession({ mode: "safe", safeModeReason });
      setView("interview");
      setInterviewActive(true);
      logWarn("interview.start", "Session started without audio capture", {
        reason: safeModeReason,
      });
    } catch (e) {
      console.error("Failed to start audio-free mode", e);
      logError("interview.start", "Failed to start audio-free mode", e);
      setInterviewActive(false);
      setStartError(toFriendlyStartError(e));
    } finally {
      setStarting(false);
    }
  }, [
    installBlocksInterview,
    safeModeAvailable,
    safeModeReason,
    setInterviewActive,
    setView,
    startSession,
    t,
  ]);

  const scrollToAudioCheck = useCallback(() => {
    audioCheckRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const handleAudioCheckCompleted = useCallback((result: CaptureAudioSampleResult) => {
    const microphoneOk = result.microphone.available && Boolean(result.microphone.file_path);
    const systemAudioOk =
      result.system_audio.available && Boolean(result.system_audio.file_path);

    if (!microphoneOk || !systemAudioOk) {
      return;
    }

    setAudioTestCompleted(true);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(AUDIO_TEST_COMPLETED_KEY, "1");
    }
  }, []);

  const handleRunSystemCheck = useCallback(async () => {
    setRunningSystemCheck(true);
    setSystemCheckError(null);
    setProxyStatusDetail(null);
    logInfo("system.check", "Manual readiness check started");

    try {
      const [, , proxyStatus] = await withTimeout(
        Promise.all([
          refreshLocalReadinessNow(),
          refreshCloudReadinessNow(),
          getServiceStatus().catch((error) => {
            logWarn("service.status", "Service status endpoint is not available", error);
            return null;
          }),
        ]),
        START_READINESS_TIMEOUT_MS,
        t("Истекло время ожидания проверки готовности."),
      );
      if (proxyStatus) {
        setProxyStatusDetail(
          proxyStatus.openAiConfigured
            ? t("Сервис доступен.")
            : t("Сервис доступен, но обработка ответов временно не настроена."),
        );
      }
      setLastSystemCheckAt(Date.now());
      logInfo("system.check", "Manual readiness check finished");
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : t("Не удалось выполнить проверку готовности.");
      setSystemCheckError(detail);
      logError("system.check", "Manual readiness check failed", error);
    } finally {
      setRunningSystemCheck(false);
    }
  }, [t]);

  const handleSendStartReport = useCallback(async () => {
    setSendingStartReport(true);
    setStartReportStatus(null);

    try {
      const result = await submitCriticalSupportReport({
        category: "desktop-start",
        title: `Start failed: ${startError ?? "readiness blocked"}`,
        extra: `Missing items: ${missingItemsText}`,
        throttleKey: `desktop-start:${startError ?? missingItemsText}`,
        force: true,
      });

      setStartReportStatus(
        result.sent
          ? t("Отчет отправлен: {id}", { id: result.reportId ?? "" })
          : result.reason === "missing-license"
            ? t("Сначала нужен лицензионный ключ, чтобы привязать обращение к вашему аккаунту.")
            : t("Не удалось отправить сообщение. Можно скопировать его вручную в блоке помощи ниже."),
      );
    } finally {
      setSendingStartReport(false);
    }
  }, [missingItemsText, startError, t]);

  const handleToggleScreenShareVisibility = useCallback(async () => {
    const nextProtectOverlay = !protectOverlay;
    setCaptureProtectionError(null);
    setProtectOverlay(nextProtectOverlay);
    setApplyingCaptureProtection(true);

    try {
      await applyCaptureProtectionPreference(nextProtectOverlay);
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : t("Не удалось переключить видимость при шаринге.");
      setCaptureProtectionError(detail);
      logWarn("capture.protection", "Failed to toggle screen sharing visibility", error);
    } finally {
      setApplyingCaptureProtection(false);
    }
  }, [protectOverlay, setProtectOverlay, t]);

  const sttProfileLabel = getSttPerformanceProfileLabel(
    primarySttVariant,
    secondarySttVariant,
  );
  const currentAppVersion = appUpdate.currentVersion?.trim() || __APP_VERSION__ || t("неизвестно");
  const availableAppVersion = appUpdate.version?.trim() || null;
  const hasPendingUpdate =
    appUpdate.available &&
    availableAppVersion !== null &&
    availableAppVersion !== currentAppVersion;

  const readinessItems = [
    {
      key: "api",
      status: readiness.apiKey,
      label: t("Лицензия"),
      description: readiness.apiKeyDetail,
      actionLabel: readiness.apiKey === "granted" ? undefined : t("Открыть"),
      onAction:
        readiness.apiKey === "granted" ? undefined : () => setView("cabinet"),
    },
    {
      key: "model",
      status: readiness.model,
      label: t("Сервис"),
      description: readiness.modelDetail,
      actionLabel: readiness.model === "granted" ? undefined : t("Открыть"),
      onAction:
        readiness.model === "granted" ? undefined : () => setView("cabinet"),
    },
    {
      key: "mic",
      status: permissions.microphone,
      label: t("Микрофон"),
      description: t("Захват вашего голоса"),
      actionLabel: permissions.microphone === "granted" ? undefined : t("Настроить"),
      onAction:
        permissions.microphone === "granted"
          ? undefined
          : () => openSettingsTab("audio", "audio-devices"),
    },
    {
      key: "audio",
      status: permissions.systemAudio,
      label: t("Системный звук"),
      description: t("Захват голоса собеседника"),
      actionLabel: permissions.systemAudio === "granted" ? undefined : t("Настроить"),
      onAction:
        permissions.systemAudio === "granted"
          ? undefined
          : () => openSettingsTab("audio", "audio-devices"),
    },
    {
      key: "vosk",
      status: readiness.vosk,
      label: t("Распознавание речи"),
      description:
        readiness.vosk === "granted"
          ? t("Серверное распознавание готово к работе")
          : readiness.voskDetail,
      actionLabel: readiness.vosk === "granted" ? undefined : t("Настроить"),
      onAction:
        readiness.vosk === "granted"
          ? undefined
          : () => openSettingsTab("speech", "language-models"),
    },
  ] as const;

  const readyCount = readinessItems.filter((item) => item.status === "granted").length;
  const totalChecks = readinessItems.length;
  const readyPercent = Math.round((readyCount / totalChecks) * 100);

  const shouldShowUpdateCard =
    appUpdate.enabled &&
    appUpdate.available &&
    appUpdate.version !== null &&
    appUpdate.version !== appUpdate.dismissedVersion;

  const handleInstallUpdate = useCallback(async () => {
    setInstallingUpdate(true);
    setAppUpdate({
      installing: true,
      downloadPercent: 0,
      error: null,
    });

    try {
      const { installAppUpdate } = await import("@/lib/tauri");
      await installAppUpdate();
      setAppUpdate({
        installing: false,
        downloadPercent: 100,
      });
    } catch (error) {
      console.error("Failed to install app update", error);
      setAppUpdate({
        installing: false,
        error:
          error instanceof Error
            ? error.message
            : t("Не удалось установить обновление"),
      });
    } finally {
      setInstallingUpdate(false);
    }
  }, [setAppUpdate, t]);

  const lastCheckLabel = lastSystemCheckAt
    ? new Date(lastSystemCheckAt).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8">
      {shouldShowUpdateCard && (
        <div className="rise-in mb-8 flex flex-col gap-3 overflow-hidden rounded-2xl border border-accent/20 bg-accent/[0.06] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl gradient-primary text-white">
              <Download className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-text-primary">
                {t("Доступна новая версия {version}", { version: appUpdate.version ?? "" })}
              </div>
              <div className="mt-0.5 text-xs text-text-muted">
                {appUpdate.installing
                  ? appUpdate.downloadPercent !== null
                    ? t("Скачиваем обновление: {percent}%", { percent: appUpdate.downloadPercent })
                    : t("Устанавливаем обновление...")
                  : appUpdate.error
                    ? appUpdate.error
                    : t("Обновление ставится без переустановки с сайта или диска.")}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              onClick={handleInstallUpdate}
              disabled={installingUpdate || appUpdate.installing}
              icon={
                appUpdate.installing ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )
              }
            >
              {appUpdate.installing ? t("Ставим...") : t("Установить")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => dismissAppUpdate(appUpdate.version)}>
              {t("Позже")}
            </Button>
          </div>
        </div>
      )}

      <div className="mb-6 rise-in">
        <h1 className="font-display text-[1.9rem] font-bold leading-[1.05] tracking-[-0.03em] text-text-primary">
          {t("Обзор")}
        </h1>
        <p className="mt-1.5 text-sm text-text-secondary">
          {t("Готовность, запуск и последняя сессия — на одном экране.")}
        </p>
      </div>

      <div className="rise-in card-elevated relative overflow-hidden rounded-[28px]" style={{ animationDelay: "90ms" }}>
        <div className="grid lg:grid-cols-[1.45fr_1fr]">
          <div className="relative overflow-hidden p-8 sm:p-9">
            <div className="aurora opacity-70" />
            <div className="relative">
              <span
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${
                  allReady
                    ? "border-success/30 bg-success/10 text-success"
                    : "border-warning/30 bg-warning/10 text-warning"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${allReady ? "bg-success animate-glow" : "bg-warning"}`} />
                {allReady ? t("Всё готово") : t("Нужно внимание")}
              </span>

              <h2 className="mt-5 max-w-md font-display text-[2.1rem] font-bold leading-[1.05] tracking-[-0.03em] text-text-primary">
                {allReady ? t("Можно начинать интервью") : t("Почти готово к интервью")}
              </h2>
              <p className="mt-3 max-w-md text-sm leading-6 text-text-secondary">
                {allReady
                  ? t("Лицензия, звук и распознавание подключены. Помощник откроется в отдельном окне поверх экрана.")
                  : t("Подключите оставшиеся пункты — и запускайте помощника поверх экрана.")}
              </p>

              <div className="mt-6 grid max-w-md grid-cols-2 gap-x-6 gap-y-2.5">
                {[
                  { key: "api", icon: KeyRound, label: t("Лицензия"), status: readiness.apiKey },
                  { key: "model", icon: Cloud, label: t("Сервис"), status: readiness.model },
                  { key: "mic", icon: Mic, label: t("Микрофон"), status: permissions.microphone },
                  { key: "audio", icon: Volume2, label: t("Системный звук"), status: permissions.systemAudio },
                  { key: "vosk", icon: AudioLines, label: t("Распознавание"), status: readiness.vosk },
                ].map((item) => (
                  <ChecklistItem
                    key={item.key}
                    icon={item.icon}
                    label={item.label}
                    status={item.status}
                  />
                ))}
              </div>

              <div className="mt-7 flex flex-wrap items-center gap-2.5">
                <span className={`inline-flex rounded-2xl ${allReady && !starting ? "pulse-ring" : ""}`}>
                  <Button
                    size="lg"
                    onClick={handleStartInterview}
                    disabled={!allReady || starting}
                    icon={<Play className="h-5 w-5" />}
                  >
                    {starting ? t("Запуск...") : t("Начать интервью")}
                  </Button>
                </span>
                {!allReady && safeModeAvailable && (
                  <Button size="lg" variant="secondary" onClick={handleStartSafeMode} disabled={starting}>
                    {t("Без аудио")}
                  </Button>
                )}
              </div>

              <div className="mt-5 flex max-w-md items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className={`shrink-0 ${protectOverlay ? "text-accent" : "text-text-muted"}`}>
                    {protectOverlay ? (
                      <EyeOff className="h-[18px] w-[18px]" />
                    ) : (
                      <Eye className="h-[18px] w-[18px]" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium leading-tight text-text-primary">
                      {t("Скрывать при демонстрации экрана")}
                    </div>
                    <div className="mt-0.5 text-xs leading-tight text-text-muted">
                      {protectOverlay ? t("Не попадёт в шаринг и запись") : t("Сейчас окно видно на шаринге")}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={protectOverlay}
                  onClick={() => void handleToggleScreenShareVisibility()}
                  disabled={applyingCaptureProtection}
                  title={protectOverlay ? t("Скрыто при шаринге") : t("Видно при шаринге")}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${
                    protectOverlay ? "bg-accent" : "bg-black/[0.15]"
                  } ${applyingCaptureProtection ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgba(20,22,40,0.3)] transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
                      protectOverlay ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {captureProtectionError && (
                <div className="mt-3 max-w-md rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                  {captureProtectionError}
                </div>
              )}

              {startError && (
                <div className="mt-4 rounded-2xl border border-danger/30 bg-danger/[0.08] p-4">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-text-primary">{t("Запуск не удался")}</div>
                      <p className="mt-0.5 text-xs leading-5 text-text-secondary">{startError}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" onClick={handleStartInterview} icon={<Play className="h-3.5 w-3.5" />}>
                          {t("Повторить")}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={handleRunSystemCheck}>
                          {t("Проверить всё")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={handleSendStartReport}
                          disabled={sendingStartReport}
                        >
                          {sendingStartReport ? t("Отправка...") : t("Сообщить в поддержку")}
                        </Button>
                      </div>
                      {startReportStatus && (
                        <div className="mt-2 text-xs text-text-muted">{startReportStatus}</div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="relative border-t border-black/[0.045] bg-bg-secondary/70 p-7 lg:border-l lg:border-t-0">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">
                {t("Готовность")}
              </span>
              <button
                type="button"
                onClick={() => setView("readiness")}
                className="inline-flex items-center gap-1 text-xs font-semibold text-accent transition-colors hover:text-accent-hover"
              >
                {t("Открыть →")}
              </button>
            </div>

            <div className="mt-5 flex items-center gap-4">
              <ReadinessRing percent={readyPercent} ready={allReady} />
              <div>
                <div className="flex items-baseline gap-1">
                  <span className="font-display text-[2.5rem] font-bold leading-none tracking-[-0.03em] text-text-primary">
                    {readyCount}
                  </span>
                  <span className="text-sm font-medium text-text-muted">/ {totalChecks}</span>
                </div>
                <div className="mt-1.5 text-xs text-text-muted">{t("проверок готово")}</div>
              </div>
            </div>

            <div className="mt-6 overflow-hidden rounded-xl border border-border bg-bg-card">
              <MetaRow label={t("Язык")} value={primaryLanguage} />
              <MetaRow label={t("Профиль")} value={sttProfileLabel} />
              <MetaRow
                label={t("Проблемы")}
                value={missingItems.length.toString()}
                tone={missingItems.length ? "warn" : "ok"}
              />
              <MetaRow
                label={t("Статус")}
                value={allReady ? t("Готов") : t("Не готов")}
                tone={allReady ? "ok" : "warn"}
              />
            </div>

            <button
              type="button"
              onClick={() => setView("readiness")}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-accent/[0.08] px-4 py-2.5 text-[13px] font-semibold text-accent transition-colors hover:bg-accent/[0.13]"
            >
              {t("Все проверки и аудио-тест")}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-6">
        <InterviewContextCard />
      </div>

      <section className="rise-in card-elevated mt-6 rounded-[28px] p-6" style={{ animationDelay: "180ms" }}>
        <div className="flex items-center gap-2.5">
          <span className="h-6 w-1 rounded-full gradient-warm" />
          <h3 className="font-display text-sm font-semibold text-text-primary">{t("Последняя сессия")}</h3>
        </div>
        {!lastSession ? (
          <div className="mt-4 flex items-center gap-4 rounded-2xl border border-dashed border-border bg-bg-secondary/60 px-5 py-5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <BarChart3 className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-text-primary">
                {t("Здесь появится ваша статистика")}
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-text-muted">
                {t("После первого интервью — длительность, число запросов, задержка ответа и доля вашей речи.")}
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              icon={<Clock className="h-4 w-4" />}
              label={t("Длительность")}
              value={formatDuration(lastSession.metrics.durationMs)}
              tone="accent"
            />
            <Stat
              icon={<Brain className="h-4 w-4" />}
              label={t("Запросы")}
              value={lastSession.metrics.llmRequestCount.toString()}
              tone="violet"
            />
            <Stat
              icon={<Activity className="h-4 w-4" />}
              label={t("Задержка")}
              value={`${Math.round(lastSession.metrics.avgFirstTokenLatencyMs)}ms`}
              tone="cyan"
            />
            <Stat
              icon={<TrendingUp className="h-4 w-4" />}
              label={t("Ваша речь")}
              value={`${Math.round(lastSession.metrics.userSpeechRatio * 100)}%`}
              tone="warm"
            />
          </div>
        )}
      </section>
    </div>
  );
}

function LiveWave() {
  const bars = [40, 100, 65, 90, 50];
  return (
    <span className="flex h-3 items-end gap-[2px]" aria-hidden="true">
      {bars.map((h, i) => (
        <span
          key={i}
          className="eq-bar w-[2px] rounded-full gradient-live"
          style={{ height: `${h}%`, animationDelay: `${i * 130}ms` }}
        />
      ))}
    </span>
  );
}

function ChecklistItem({
  icon: Icon,
  label,
  status,
}: {
  icon: typeof KeyRound;
  label: string;
  status: string;
}) {
  const ready = status === "granted" || status === "supported";
  const checking = status === "checking";
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg transition-colors ${
          ready
            ? "bg-success/12 text-success"
            : checking
              ? "bg-black/[0.04] text-text-muted"
              : "bg-warning/14 text-warning"
        }`}
      >
        {ready ? (
          <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
        ) : checking ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Icon className="h-3.5 w-3.5" />
        )}
      </span>
      <span
        className={`truncate text-[13px] ${ready ? "text-text-secondary" : "font-medium text-text-primary"}`}
        title={label}
      >
        {label}
      </span>
    </div>
  );
}

function ReadinessRing({ percent, ready }: { percent: number; ready: boolean }) {
  const r = 34;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.max(0, Math.min(100, percent)) / 100);
  return (
    <div className="relative h-20 w-20 shrink-0">
      <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
        <circle cx="40" cy="40" r={r} fill="none" stroke="rgba(18,20,32,0.09)" strokeWidth="5.5" />
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          stroke={ready ? "#12934c" : "#3b5bdb"}
          strokeWidth="5.5"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(0.22,1,0.36,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center font-mono text-[13px] font-semibold tabular-nums text-text-primary">
        {percent}%
      </div>
    </div>
  );
}

function MetaRow({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "ok" | "warn";
}) {
  const toneClass =
    tone === "ok" ? "text-success" : tone === "warn" ? "text-warning" : "text-text-primary";
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0">
      <span className="text-[13px] text-text-muted">{label}</span>
      <span className={`truncate text-[13px] font-semibold ${toneClass}`} title={value}>
        {value}
      </span>
    </div>
  );
}

function ReadinessRow({
  status,
  label,
  description,
  actionLabel,
  onAction,
}: {
  status: string;
  label: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const t = useT();
  const ready = status === "granted" || status === "supported";
  const bad = status === "denied" || status === "not_supported";
  const checking = status === "checking";
  const dot = ready
    ? "bg-success"
    : bad
      ? "bg-danger"
      : checking
        ? "bg-text-muted animate-pulse"
        : "bg-warning";
  const stateLabel = ready ? t("Готово") : bad ? t("Недоступно") : checking ? t("Проверка") : t("Внимание");
  const stateColor = ready
    ? "text-success"
    : bad
      ? "text-danger"
      : checking
        ? "text-text-muted"
        : "text-warning";

  return (
    <div className="flex items-center gap-4 px-6 py-3.5 transition-colors hover:bg-bg-tertiary/40">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary">{label}</span>
          <span className={`text-[11px] ${stateColor}`}>· {stateLabel}</span>
        </div>
        {description && <p className="mt-0.5 truncate text-xs text-text-muted">{description}</p>}
      </div>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-text-primary"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  tone = "accent",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "accent" | "violet" | "cyan" | "warm";
}) {
  void tone;
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex items-center gap-2 text-text-muted">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-muted text-accent">
          {icon}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em]">{label}</span>
      </div>
      <div className="mt-3 font-display text-xl font-semibold tracking-[-0.01em] text-text-primary">
        {value}
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
