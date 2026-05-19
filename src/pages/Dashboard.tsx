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
  X,
  CheckCircle,
  Circle,
  Eye,
  EyeOff,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { StatusIndicator } from "@/components/ui/StatusIndicator";
import { AudioQualityCheck } from "@/components/dashboard/AudioQualityCheck";
import { ScreenShareProtectionCard } from "@/components/dashboard/ScreenShareProtectionCard";
import { SupportReportCard } from "@/components/dashboard/SupportReportCard";
import { useAppStore } from "@/stores/app";
import { useHistoryStore } from "@/stores/history";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { refreshCloudReadinessNow, refreshLocalReadinessNow } from "@/hooks/useReadinessMonitor";
import type { SettingsFocusTarget, SettingsTab } from "@/lib/types";
import { getSttPerformanceProfileLabel } from "@/lib/sttProfiles";
import { logError, logInfo, logWarn } from "@/lib/diagnostics";
import { formatTransferDiagnostics } from "@/lib/installProgress";
import { applyCaptureProtectionPreference } from "@/lib/captureProtection";
import { getServiceStatus } from "@/lib/proxy";
import { submitCriticalSupportReport } from "@/lib/supportReporting";
import type { CaptureAudioSampleResult } from "@/lib/tauri";

const START_READINESS_TIMEOUT_MS = 8000;
const SETUP_GUIDE_DISMISSED_KEY = "ai-interview-setup-guide-dismissed-v1";
const AUDIO_TEST_COMPLETED_KEY = "ai-interview-audio-test-completed-v1";
const CLIENT_STT_MODEL_INSTALL_ENABLED = false;

type SetupStep = {
  title: string;
  description: string;
  done: boolean;
  actionLabel?: string;
  onAction?: () => void;
};

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
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [runningSystemCheck, setRunningSystemCheck] = useState(false);
  const [lastSystemCheckAt, setLastSystemCheckAt] = useState<number | null>(null);
  const [systemCheckError, setSystemCheckError] = useState<string | null>(null);
  const [proxyStatusDetail, setProxyStatusDetail] = useState<string | null>(null);
  const [applyingCaptureProtection, setApplyingCaptureProtection] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [startReportStatus, setStartReportStatus] = useState<string | null>(null);
  const [sendingStartReport, setSendingStartReport] = useState(false);
  const [captureProtectionError, setCaptureProtectionError] = useState<string | null>(null);
  const [setupGuideDismissed, setSetupGuideDismissed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem(SETUP_GUIDE_DISMISSED_KEY) === "1";
  });
  const [audioTestCompleted, setAudioTestCompleted] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem(AUDIO_TEST_COMPLETED_KEY) === "1";
  });
  const audioCheckRef = useRef<HTMLDivElement | null>(null);

  const lastSession = sessions[0] ?? null;
  const backgroundModelInstall =
    CLIENT_STT_MODEL_INSTALL_ENABLED && sttInstall.active && sttInstall.phase === "background-model";

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
          "Истекло время ожидания проверки готовности.",
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
  }, [allReady, installBlocksInterview, setInterviewActive, setView, startSession]);

  const missingItems = [
    readiness.apiKey !== "granted" ? "лицензионный ключ" : null,
    readiness.model !== "granted" ? "подключение к сервису" : null,
    permissions.microphone !== "granted" ? "микрофон" : null,
    permissions.systemAudio !== "granted" ? "системный звук" : null,
    readiness.vosk !== "granted" ? "распознавание речи" : null,
    installBlocksInterview ? "идет обязательная установка компонентов распознавания" : null,
  ].filter((item): item is string => Boolean(item));
  const missingItemsText = missingItems.length > 0 ? missingItems.join(", ") : "нет";
  const safeModeAvailable = cloudReady && !installBlocksInterview;
  const safeModeReason =
    missingItems.length > 0
      ? `Режим без аудио включен, потому что не готовы: ${missingItems.join(", ")}.`
      : "Режим без аудио включен вручную: используйте ручной ввод и ножницы.";

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
          "Истекло время ожидания проверки готовности.",
        );
        readyToStart = cloud.apiReady && cloud.modelReady && !installBlocksInterview;
      }

      if (!readyToStart) {
        setStartError(
          "Режим без аудио недоступен: нужна активная лицензия и подключение к сервису.",
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
  ]);

  const dismissSetupGuide = useCallback(() => {
    setSetupGuideDismissed(true);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SETUP_GUIDE_DISMISSED_KEY, "1");
    }
  }, []);

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
        "Истекло время ожидания проверки готовности.",
      );
      if (proxyStatus) {
        setProxyStatusDetail(
          proxyStatus.openAiConfigured
            ? "Сервис доступен."
            : "Сервис доступен, но обработка ответов временно не настроена.",
        );
      }
      setLastSystemCheckAt(Date.now());
      logInfo("system.check", "Manual readiness check finished");
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : "Не удалось выполнить проверку готовности.";
      setSystemCheckError(detail);
      logError("system.check", "Manual readiness check failed", error);
    } finally {
      setRunningSystemCheck(false);
    }
  }, []);

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
          ? `Отчет отправлен: ${result.reportId}`
          : result.reason === "missing-license"
            ? "Сначала нужен лицензионный ключ, чтобы привязать обращение к вашему аккаунту."
            : "Не удалось отправить сообщение. Можно скопировать его вручную в блоке помощи ниже.",
      );
    } finally {
      setSendingStartReport(false);
    }
  }, [missingItemsText, startError]);

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
            : "Не удалось переключить видимость при шаринге.";
      setCaptureProtectionError(detail);
      logWarn("capture.protection", "Failed to toggle screen sharing visibility", error);
    } finally {
      setApplyingCaptureProtection(false);
    }
  }, [protectOverlay, setProtectOverlay]);

  const sttProfileLabel = getSttPerformanceProfileLabel(
    primarySttVariant,
    secondarySttVariant,
  );
  const sttInstallTransferLabel = formatTransferDiagnostics(
    sttInstall.bytesDownloaded,
    sttInstall.contentLength,
    sttInstall.speedBytesPerSecond,
    sttInstall.etaSeconds,
  );
  const currentAppVersion = appUpdate.currentVersion?.trim() || __APP_VERSION__ || "неизвестно";
  const availableAppVersion = appUpdate.version?.trim() || null;
  const hasPendingUpdate =
    appUpdate.available &&
    availableAppVersion !== null &&
    availableAppVersion !== currentAppVersion;

  const readinessItems = [
    {
      key: "api",
      status: readiness.apiKey,
      label: "Лицензия",
      description: readiness.apiKeyDetail,
      actionLabel: readiness.apiKey === "granted" ? undefined : "Открыть",
      onAction:
        readiness.apiKey === "granted"
          ? undefined
          : () => openSettingsTab("llm", "llm-api-key"),
    },
    {
      key: "model",
      status: readiness.model,
      label: "Сервис",
      description: readiness.modelDetail,
      actionLabel: readiness.model === "granted" ? undefined : "Открыть",
      onAction:
        readiness.model === "granted"
          ? undefined
          : () => openSettingsTab("llm", "llm-api-key"),
    },
    {
      key: "mic",
      status: permissions.microphone,
      label: "Микрофон",
      description: "Захват вашего голоса",
      actionLabel: permissions.microphone === "granted" ? undefined : "Настроить",
      onAction:
        permissions.microphone === "granted"
          ? undefined
          : () => openSettingsTab("audio", "audio-devices"),
    },
    {
      key: "audio",
      status: permissions.systemAudio,
      label: "Системный звук",
      description: "Захват голоса собеседника",
      actionLabel: permissions.systemAudio === "granted" ? undefined : "Настроить",
      onAction:
        permissions.systemAudio === "granted"
          ? undefined
          : () => openSettingsTab("audio", "audio-devices"),
    },
    {
      key: "vosk",
      status: readiness.vosk,
      label: "Распознавание речи",
      description:
        readiness.vosk === "granted"
          ? "Серверное распознавание готово к работе"
          : readiness.voskDetail,
      actionLabel: readiness.vosk === "granted" ? undefined : "Настроить",
      onAction:
        readiness.vosk === "granted"
          ? undefined
          : () => openSettingsTab("speech", "language-models"),
    },
  ] as const;

  const setupSteps: SetupStep[] = [
    {
      title: "Лицензия",
      description: readiness.apiKey === "granted" ? "Ключ принят." : "Введите ключ из бота.",
      done: readiness.apiKey === "granted",
      actionLabel: readiness.apiKey === "granted" ? undefined : "Ввести ключ",
      onAction:
        readiness.apiKey === "granted"
          ? undefined
          : () => openSettingsTab("llm", "llm-api-key"),
    },
    {
      title: "Распознавание речи",
      description:
        readiness.vosk === "granted"
          ? "Серверный STT подключен."
          : "Проверьте ключ, сеть и доступ к аудио устройствам.",
      done: readiness.vosk === "granted" && !installBlocksInterview,
      actionLabel: readiness.vosk === "granted" ? undefined : "Настроить",
      onAction:
        readiness.vosk === "granted"
          ? undefined
          : () => openSettingsTab("speech", "language-models"),
    },
    {
      title: "Микрофон",
      description:
        permissions.microphone === "granted"
          ? "Микрофон доступен."
          : "Выберите или проверьте устройство записи.",
      done: permissions.microphone === "granted",
      actionLabel: permissions.microphone === "granted" ? undefined : "Настроить",
      onAction:
        permissions.microphone === "granted"
          ? undefined
          : () => openSettingsTab("audio", "audio-devices"),
    },
    {
      title: "Системный звук",
      description:
        permissions.systemAudio === "granted"
          ? "Loopback захват доступен."
          : "Проверьте устройство вывода и системный звук.",
      done: permissions.systemAudio === "granted",
      actionLabel: permissions.systemAudio === "granted" ? undefined : "Настроить",
      onAction:
        permissions.systemAudio === "granted"
          ? undefined
          : () => openSettingsTab("audio", "audio-devices"),
    },
    {
      title: "Тест качества",
      description: audioTestCompleted
        ? "WAV-файлы уже записывали. При проблемах можно повторить."
        : "Запишите WAV и послушайте микрофон/системный звук.",
      done: audioTestCompleted,
      actionLabel: audioTestCompleted ? undefined : "Записать тест",
      onAction: audioTestCompleted ? undefined : scrollToAudioCheck,
    },
  ];

  const setupComplete = allReady && audioTestCompleted;
  const nextSetupStep = setupSteps.find((step) => !step.done) ?? null;
  const shouldShowSetupGuide = !setupGuideDismissed || !setupComplete;

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
            : "Не удалось установить обновление",
      });
    } finally {
      setInstallingUpdate(false);
    }
  }, [setAppUpdate]);

  const openManualUpdatePage = useCallback(() => {
    window.open(
      "https://github.com/Gelo777/ai-interview/releases/latest",
      "_blank",
      "noopener,noreferrer",
    );
  }, []);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      {shouldShowUpdateCard && (
        <Card className="border-success/30 bg-[linear-gradient(180deg,rgba(56,178,120,0.14),rgba(20,31,47,0.94))] p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-[0.18em] text-success/80">
                Обновление
              </div>
              <div className="text-xl font-semibold text-text-primary">
                Доступна новая версия {appUpdate.version}
              </div>
              <div className="max-w-3xl text-sm leading-7 text-text-secondary">
                {appUpdate.body?.trim() ||
                  "Вышла новая сборка приложения. Ее можно поставить без повторной ручной установки с сайта или диска."}
              </div>
              {appUpdate.installing && (
                <div className="text-sm text-success/90">
                  {appUpdate.downloadPercent !== null
                    ? `Скачиваем обновление: ${appUpdate.downloadPercent}%`
                    : "Скачиваем и устанавливаем обновление..."}
                </div>
              )}
              {appUpdate.error && (
                <div className="text-sm text-danger">
                  {appUpdate.error}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
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
                {appUpdate.installing ? "Устанавливаем..." : "Установить"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => dismissAppUpdate(appUpdate.version)}
                icon={<X className="h-4 w-4" />}
              >
                Позже
              </Button>
              {appUpdate.error && (
                <Button variant="secondary" onClick={openManualUpdatePage}>
                  Скачать вручную
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}

      {shouldShowSetupGuide && (
        <SetupGuideCard
          steps={setupSteps}
          allReady={allReady}
          onDismiss={dismissSetupGuide}
        />
      )}

      <SystemDoctorCard
        allReady={allReady}
        setupComplete={setupComplete}
        nextStep={nextSetupStep}
        running={runningSystemCheck}
        lastCheckedAt={lastSystemCheckAt}
        error={systemCheckError}
        proxyStatusDetail={proxyStatusDetail}
        onRunCheck={handleRunSystemCheck}
      />

      <PreStartCheckCard
        steps={setupSteps}
        allReady={allReady}
        safeModeAvailable={safeModeAvailable}
        safeModeReason={safeModeReason}
        starting={starting}
        checking={runningSystemCheck}
        onStart={handleStartInterview}
        onStartSafeMode={handleStartSafeMode}
        onRunCheck={handleRunSystemCheck}
      />

      {startError && (
        <StartFailureCard
          error={startError}
          missingItems={missingItems}
          safeModeAvailable={safeModeAvailable}
          sendingReport={sendingStartReport}
          reportStatus={startReportStatus}
          onRetry={handleStartInterview}
          onRunCheck={handleRunSystemCheck}
          onStartSafeMode={handleStartSafeMode}
          onSendReport={handleSendStartReport}
        />
      )}

      <section className="grid gap-6 xl:grid-cols-[1.45fr_0.95fr]">
        <Card className="relative overflow-hidden p-7">
          <div className="pointer-events-none absolute right-0 top-0 h-44 w-44 rounded-full bg-accent/15 blur-3xl" />
          <div className="pointer-events-none absolute -left-10 bottom-0 h-32 w-32 rounded-full bg-interviewer/15 blur-3xl" />
          <div className="relative">
            <div className="mb-3 inline-flex rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-text-secondary">
              Помощник собеседования
            </div>
            <h1 className="max-w-2xl text-4xl font-bold leading-tight text-text-primary">
              Открыл, ввел ключ, проверил готовность и начал работать.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-text-secondary">
              Все важное собрано в одном месте: лицензия, готовность, звук, история и запуск помощника.
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                onClick={handleStartInterview}
                disabled={!allReady || starting}
                icon={<Play className="w-5 h-5" />}
              >
                {starting ? "Запуск..." : "Начать"}
              </Button>
              {!allReady && safeModeAvailable && (
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={handleStartSafeMode}
                  disabled={starting}
                >
                  Без аудио
                </Button>
              )}
              <Button
                variant="secondary"
                size="lg"
                onClick={() => openSettingsTab("llm", "llm-api-key")}
              >
                Ввести ключ
              </Button>
              <Button
                variant={protectOverlay ? "secondary" : "primary"}
                size="lg"
                onClick={() => void handleToggleScreenShareVisibility()}
                disabled={applyingCaptureProtection}
                icon={
                  applyingCaptureProtection ? (
                    <RefreshCw className="h-5 w-5 animate-spin" />
                  ) : protectOverlay ? (
                    <Eye className="h-5 w-5" />
                  ) : (
                    <EyeOff className="h-5 w-5" />
                  )
                }
              >
                {protectOverlay ? "Показать при шаринге" : "Скрыть при шаринге"}
              </Button>
            </div>
            {captureProtectionError && (
              <div className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                {captureProtectionError}
              </div>
            )}
          </div>
        </Card>

        <Card className="p-6">
          <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">
            Кратко
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <MetricPanel label="Готовность" value={allReady ? "100%" : `${5 - missingItems.length}/5`} tone={allReady ? "ready" : "warning"} />
            <MetricPanel label="Язык" value={primaryLanguage} tone="neutral" />
            <MetricPanel label="Профиль речи" value={sttProfileLabel} tone="neutral" />
            <MetricPanel label="Проблемы" value={missingItems.length.toString()} tone={missingItems.length === 0 ? "ready" : "warning"} />
          </div>
          <div className="mt-3 rounded-2xl border border-white/8 bg-white/[0.03] p-3">
            <div className="text-[11px] uppercase tracking-[0.16em] text-text-muted">
              Версия приложения
            </div>
            <div className="mt-1.5 text-sm text-text-primary">
              {currentAppVersion}
              {hasPendingUpdate ? ` -> ${availableAppVersion}` : ""}
            </div>
            <div className="mt-1 text-xs text-text-muted">
              {appUpdate.checking
                ? "Проверяем обновления..."
                : hasPendingUpdate
                  ? "Доступно обновление. Можно установить из карточки выше."
                  : "Установлена актуальная версия."}
            </div>
          </div>
        </Card>
      </section>

      {!allReady && (
        <Card className="border-warning/30 bg-[linear-gradient(180deg,rgba(243,178,95,0.13),rgba(20,31,47,0.94))]">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-warning-muted">
              <AlertTriangle className="w-5 h-5 text-warning" />
            </div>
            <div>
              <div className="text-sm font-semibold text-warning">Пока нельзя начать</div>
              <div className="mt-1 text-sm leading-relaxed text-warning/90">
                Не хватает: {missingItems.join(", ")}.
              </div>
              {safeModeAvailable && (
                <div className="mt-2 text-xs leading-relaxed text-warning/80">
                  Можно продолжить в режиме без аудио: ручной вопрос, ножницы и ответ помощника.
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {backgroundModelInstall && (
        <Card className="border-success/20 bg-[linear-gradient(180deg,rgba(56,178,120,0.10),rgba(20,31,47,0.94))]">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-success-muted">
              <Download className="w-5 h-5 text-success" />
            </div>
            <div>
              <div className="text-sm font-semibold text-success">Готовим точный профиль в фоне</div>
              <div className="mt-1 text-sm leading-relaxed text-success/90">
                {sttInstall.detail}
                {sttInstall.percent !== null ? ` ${sttInstall.percent}%` : ""}
              </div>
              {sttInstallTransferLabel && (
                <div className="mt-1 text-xs text-success/80">
                  {sttInstallTransferLabel}
                </div>
              )}
              <div className="mt-2 text-xs text-text-muted">
                Интервью можно запускать уже сейчас. Пока точный профиль загружается, приложение работает на базовом.
              </div>
            </div>
          </div>
        </Card>
      )}

      <Card className="p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">Проверка системы</div>
            <h2 className="mt-1 text-xl font-semibold text-text-primary">Что нужно перед запуском</h2>
          </div>
          <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] uppercase tracking-[0.14em] text-text-secondary">
            {allReady ? "Можно запускать" : "Нужно внимание"}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {readinessItems.map((item) => (
            <StatusIndicator
              key={item.key}
              status={item.status}
              label={item.label}
              description={item.description}
              actionLabel={item.actionLabel}
              onAction={item.onAction}
            />
          ))}
        </div>
      </Card>

      <div className="grid gap-6">
        <div ref={audioCheckRef}>
          <AudioQualityCheck onCompleted={handleAudioCheckCompleted} />
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <ScreenShareProtectionCard />
          <SupportReportCard />
        </div>

        <Card className="p-6">
          <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">Последняя сессия</div>
          {!lastSession ? (
            <div className="mt-3 rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-5 text-sm leading-relaxed text-text-muted">
              Пока нет завершенных сессий. После первого запуска здесь появятся метрики.
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-4">
              <Stat
                icon={<Clock className="w-4 h-4" />}
                label="Длительность"
                value={formatDuration(lastSession.metrics.durationMs)}
              />
              <Stat
                icon={<Brain className="w-4 h-4" />}
                label="Запросы"
                value={lastSession.metrics.llmRequestCount.toString()}
              />
              <Stat
                icon={<Activity className="w-4 h-4" />}
                label="Задержка"
                value={`${Math.round(lastSession.metrics.avgFirstTokenLatencyMs)}ms`}
              />
              <Stat
                icon={<TrendingUp className="w-4 h-4" />}
                label="Речь"
                value={`${Math.round(lastSession.metrics.userSpeechRatio * 100)}% вы`}
              />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function SetupGuideCard({
  steps,
  allReady,
  onDismiss,
}: {
  steps: SetupStep[];
  allReady: boolean;
  onDismiss: () => void;
}) {
  const completedCount = steps.filter((step) => step.done).length;

  return (
    <Card className="border-accent/25 bg-[linear-gradient(180deg,rgba(87,208,255,0.12),rgba(20,31,47,0.94))] p-6">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-accent/80">
            Первый запуск
          </div>
          <h2 className="mt-2 text-2xl font-semibold text-text-primary">
            Подготовим приложение к работе
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-7 text-text-secondary">
            Это короткий чеклист: лицензия, микрофон, системный звук, распознавание и тестовая запись. После него видно, что именно готово.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs text-text-secondary">
            {completedCount}/{steps.length} шагов
          </div>
          {allReady && (
            <Button variant="secondary" size="sm" onClick={onDismiss}>
              Скрыть чеклист
            </Button>
          )}
        </div>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-5">
        {steps.map((step, index) => (
          <div
            key={step.title}
            className={`rounded-2xl border p-4 ${
              step.done
                ? "border-success/25 bg-success-muted/50"
                : "border-white/10 bg-white/[0.035]"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] uppercase tracking-[0.14em] text-text-muted">
                Шаг {index + 1}
              </div>
              {step.done ? (
                <CheckCircle className="h-4 w-4 text-success" />
              ) : (
                <Circle className="h-4 w-4 text-warning" />
              )}
            </div>
            <div className="mt-3 text-sm font-semibold text-text-primary">
              {step.title}
            </div>
            <div className="mt-1 min-h-[42px] text-xs leading-relaxed text-text-muted">
              {step.description}
            </div>
            {step.actionLabel && step.onAction && (
              <button
                type="button"
                onClick={step.onAction}
                className="mt-3 rounded-full border border-white/12 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-text-secondary transition-colors hover:border-accent/40 hover:text-text-primary"
              >
                {step.actionLabel}
              </button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function StartFailureCard({
  error,
  missingItems,
  safeModeAvailable,
  sendingReport,
  reportStatus,
  onRetry,
  onRunCheck,
  onStartSafeMode,
  onSendReport,
}: {
  error: string;
  missingItems: string[];
  safeModeAvailable: boolean;
  sendingReport: boolean;
  reportStatus: string | null;
  onRetry: () => void;
  onRunCheck: () => void;
  onStartSafeMode: () => void;
  onSendReport: () => void;
}) {
  return (
    <Card className="border-danger/30 bg-[linear-gradient(135deg,rgba(255,107,107,0.13),rgba(20,31,47,0.94))] p-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-4">
          <div className="mt-0.5 flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-danger/30 bg-danger/10">
            <AlertTriangle className="h-5 w-5 text-danger" />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-danger/80">
              Запуск не состоялся
            </div>
            <h2 className="mt-1 text-2xl font-semibold text-text-primary">
              Есть понятный путь восстановления
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-7 text-text-secondary">
              {error}
            </p>
            {missingItems.length > 0 && (
              <div className="mt-3 rounded-2xl border border-danger/20 bg-black/15 p-3 text-sm text-text-secondary">
                Не готово: {missingItems.join(", ")}.
              </div>
            )}
            {reportStatus && (
              <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-sm text-text-secondary">
                {reportStatus}
              </div>
            )}
          </div>
        </div>

        <div className="flex min-w-[220px] flex-wrap gap-2 lg:justify-end">
          <Button
            variant="secondary"
            onClick={onRunCheck}
            icon={<RefreshCw className="h-4 w-4" />}
          >
            Проверить всё
          </Button>
          <Button onClick={onRetry} icon={<Play className="h-4 w-4" />}>
            Повторить запуск
          </Button>
          {safeModeAvailable && (
            <Button variant="secondary" onClick={onStartSafeMode}>
              Без аудио
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={onSendReport}
            disabled={sendingReport}
          >
            {sendingReport ? "Отправляем..." : "Отправить сообщение"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PreStartCheckCard({
  steps,
  allReady,
  safeModeAvailable,
  safeModeReason,
  starting,
  checking,
  onStart,
  onStartSafeMode,
  onRunCheck,
}: {
  steps: SetupStep[];
  allReady: boolean;
  safeModeAvailable: boolean;
  safeModeReason: string;
  starting: boolean;
  checking: boolean;
  onStart: () => void;
  onStartSafeMode: () => void;
  onRunCheck: () => void;
}) {
  const completedCount = steps.filter((step) => step.done).length;

  return (
    <Card className="border-white/10 bg-[linear-gradient(135deg,rgba(15,23,42,0.96),rgba(24,48,66,0.92))] p-6">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">
            Предстартовый чек
          </div>
          <h2 className="mt-1 text-2xl font-semibold text-text-primary">
            {allReady ? "Полный режим готов" : "Перед запуском есть незакрытые пункты"}
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-7 text-text-secondary">
            Проверяем не только наличие устройств, но и готовность сценария:
            лицензию, сервис, звук, распознавание и контрольную запись.
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            onClick={onRunCheck}
            disabled={checking || starting}
            variant="secondary"
            icon={<RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />}
          >
            {checking ? "Проверяем..." : "Проверить всё"}
          </Button>
          <Button
            onClick={onStart}
            disabled={!allReady || starting}
            icon={<Play className="h-4 w-4" />}
          >
            {starting ? "Запуск..." : "Полный режим"}
          </Button>
          {!allReady && safeModeAvailable && (
            <Button variant="secondary" onClick={onStartSafeMode} disabled={starting}>
              Без аудио
            </Button>
          )}
        </div>
      </div>

      <div className="mt-5 grid gap-2 md:grid-cols-5">
        {steps.map((step) => (
          <div
            key={step.title}
            className={`rounded-2xl border p-3 ${
              step.done
                ? "border-success/20 bg-success-muted/40"
                : "border-warning/25 bg-warning-muted/20"
            }`}
          >
            <div className="flex items-center gap-2">
              {step.done ? (
                <CheckCircle className="h-4 w-4 text-success" />
              ) : (
                <Circle className="h-4 w-4 text-warning" />
              )}
              <div className="text-sm font-semibold text-text-primary">{step.title}</div>
            </div>
            <div className="mt-2 text-xs leading-relaxed text-text-muted">
              {step.description}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-2 rounded-2xl border border-white/10 bg-black/15 p-3 text-xs leading-relaxed text-text-secondary md:flex-row md:items-center md:justify-between">
        <span>
          Готово {completedCount}/{steps.length}.{" "}
          {allReady
            ? "Можно начинать интервью с распознаванием речи."
            : safeModeAvailable
              ? safeModeReason
              : "Нужна активная лицензия и подключение к сервису, чтобы открыть режим без аудио."}
        </span>
        {!allReady && safeModeAvailable && (
          <span className="text-warning">
            Режим без аудио: ручной ввод + ножницы.
          </span>
        )}
      </div>
    </Card>
  );
}

function SystemDoctorCard({
  allReady,
  setupComplete,
  nextStep,
  running,
  lastCheckedAt,
  error,
  proxyStatusDetail,
  onRunCheck,
}: {
  allReady: boolean;
  setupComplete: boolean;
  nextStep: SetupStep | null;
  running: boolean;
  lastCheckedAt: number | null;
  error: string | null;
  proxyStatusDetail: string | null;
  onRunCheck: () => void;
}) {
  const checkedLabel = lastCheckedAt
    ? new Date(lastCheckedAt).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  const title = running
    ? "Проверяем систему"
    : error
      ? "Проверка не завершилась"
      : setupComplete
        ? "Все готово к интервью"
        : allReady
          ? "Можно запускать, но стоит проверить звук"
          : "Есть следующий шаг";

  const detail = running
    ? "Проверяем лицензию, сервис, микрофон, системный звук и распознавание."
    : error
      ? error
      : setupComplete
        ? "Лицензия, сервис, микрофон, системный звук, распознавание и тестовая запись готовы."
        : allReady
          ? "Основные проверки зелёные. Осталось записать короткий WAV, чтобы убедиться в качестве."
          : "Нажмите проверку или выполните следующий шаг. Так сразу видно, что осталось подготовить.";

  return (
    <Card className="border-accent/20 bg-[linear-gradient(135deg,rgba(87,208,255,0.10),rgba(56,178,120,0.08),rgba(20,31,47,0.94))] p-6">
      <div className="grid gap-5 xl:grid-cols-[1fr_0.7fr] xl:items-center">
        <div className="flex items-start gap-4">
          <div
            className={`mt-0.5 flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border ${
              setupComplete
                ? "border-success/25 bg-success-muted"
                : error
                  ? "border-danger/30 bg-danger/10"
                  : "border-accent/25 bg-accent/10"
            }`}
          >
            {running ? (
              <RefreshCw className="h-5 w-5 animate-spin text-accent" />
            ) : setupComplete ? (
              <CheckCircle className="h-5 w-5 text-success" />
            ) : (
              <AlertTriangle className={error ? "h-5 w-5 text-danger" : "h-5 w-5 text-warning"} />
            )}
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-accent/80">
              Автопроверка
            </div>
            <h2 className="mt-1 text-2xl font-semibold text-text-primary">{title}</h2>
            <p className="mt-2 max-w-3xl text-sm leading-7 text-text-secondary">
              {detail}
            </p>
            {checkedLabel && (
              <div className="mt-2 text-xs text-text-muted">
                Последняя проверка: {checkedLabel}
              </div>
            )}
            {proxyStatusDetail && (
              <div className="mt-2 rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-2 text-xs text-text-secondary">
                {proxyStatusDetail}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-black/15 p-4">
          <div className="text-[11px] uppercase tracking-[0.16em] text-text-muted">
            Дальше
          </div>
          {nextStep ? (
            <>
              <div className="mt-2 text-base font-semibold text-text-primary">
                {nextStep.title}
              </div>
              <div className="mt-1 text-sm leading-relaxed text-text-secondary">
                {nextStep.description}
              </div>
              <div className="mt-4 flex flex-wrap gap-3">
                {nextStep.actionLabel && nextStep.onAction && (
                  <Button variant="secondary" onClick={nextStep.onAction}>
                    {nextStep.actionLabel}
                  </Button>
                )}
                <Button
                  onClick={onRunCheck}
                  disabled={running}
                  icon={<RefreshCw className={`h-4 w-4 ${running ? "animate-spin" : ""}`} />}
                >
                  {running ? "Проверяем..." : "Проверить всё"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="mt-2 text-base font-semibold text-text-primary">
                Можно начинать
              </div>
              <div className="mt-1 text-sm leading-relaxed text-text-secondary">
                Все обязательные шаги закрыты. Можно начинать интервью или повторить проверку перед стартом.
              </div>
              <div className="mt-4">
                <Button
                  variant="secondary"
                  onClick={onRunCheck}
                  disabled={running}
                  icon={<RefreshCw className={`h-4 w-4 ${running ? "animate-spin" : ""}`} />}
                >
                  {running ? "Проверяем..." : "Перепроверить"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

function MetricPanel({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ready" | "warning" | "neutral";
}) {
  const toneClass =
    tone === "ready"
      ? "border-success/25 bg-success-muted/70"
      : tone === "warning"
        ? "border-warning/25 bg-warning-muted/70"
        : "border-white/8 bg-white/[0.03]";

  return (
    <div className={`rounded-2xl border p-4 ${toneClass}`}>
      <div className="text-[11px] uppercase tracking-[0.16em] text-text-muted">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-white/6 bg-white/[0.025] p-4">
      <div className="flex items-center gap-1.5 text-text-muted">
        {icon}
        <span className="text-xs uppercase tracking-[0.16em]">{label}</span>
      </div>
      <div className="mt-3 text-xl font-semibold text-text-primary">{value}</div>
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

