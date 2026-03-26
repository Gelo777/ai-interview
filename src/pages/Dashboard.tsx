import { useState, useCallback } from "react";
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
  Keyboard,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { StatusIndicator } from "@/components/ui/StatusIndicator";
import { useAppStore } from "@/stores/app";
import { useHistoryStore } from "@/stores/history";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { refreshCloudReadinessNow, refreshLocalReadinessNow } from "@/hooks/useReadinessMonitor";
import type { SettingsFocusTarget, SettingsTab } from "@/lib/types";
import { formatHotkey } from "@/lib/hotkeys";

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
  const hotkeys = useSettingsStore((s) => s.hotkeys);
  const [starting, setStarting] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);

  const lastSession = sessions[0] ?? null;

  const installBlocksInterview =
    sttInstall.active &&
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
    try {
      const [local, cloud] = await Promise.all([
        refreshLocalReadinessNow(),
        refreshCloudReadinessNow(),
      ]);

      const readyToStart =
        cloud.apiReady &&
        cloud.modelReady &&
        local.microphone === "granted" &&
        local.systemAudio === "granted" &&
        local.voskReady &&
        !installBlocksInterview;

      if (!readyToStart) {
        return;
      }

      const { createOverlayWindow, setCaptureProtectionForWindow, isTauri } =
        await import("@/lib/tauri");
      if (isTauri()) {
        await createOverlayWindow();
        const protectOverlay = useSettingsStore.getState().protectOverlay;
        await setCaptureProtectionForWindow("overlay", protectOverlay);
        setInterviewActive(true);
      } else {
        useAppStore.getState().setView("interview");
        startSession();
        setInterviewActive(true);
      }
    } catch (e) {
      console.error("Failed to start interview", e);
    } finally {
      setStarting(false);
    }
  }, [installBlocksInterview, setInterviewActive, startSession]);

  const missingItems = [
    readiness.apiKey !== "granted" ? "лицензионный ключ" : null,
    readiness.model !== "granted" ? "подключение к сервису" : null,
    permissions.microphone !== "granted" ? "микрофон" : null,
    permissions.systemAudio !== "granted" ? "системный звук" : null,
    readiness.vosk !== "granted" ? "распознавание речи" : null,
    installBlocksInterview ? "идет обязательная установка компонентов распознавания" : null,
  ].filter((item): item is string => Boolean(item));

  const sendHotkeyLabel = formatHotkey(
    hotkeys.find((item) => item.action === "send_to_llm")?.keys ?? [],
  );
  const screenshotHotkeyLabel = formatHotkey(
    hotkeys.find((item) => item.action === "send_with_screenshot")?.keys ?? [],
  );
  const endHotkeyLabel = formatHotkey(
    hotkeys.find((item) => item.action === "end_interview")?.keys ?? [],
  );

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
          ? "Распознавание речи готово к работе"
          : readiness.voskDetail,
      actionLabel: readiness.vosk === "granted" ? undefined : "Настроить",
      onAction:
        readiness.vosk === "granted"
          ? undefined
          : () => openSettingsTab("language", "language-runtime"),
    },
  ] as const;

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
            </div>
          </div>
        </Card>
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
              Мы постепенно ведем приложение к простому сценарию через лицензию и прокси.
              Пользователь не должен разбираться в моделях, провайдерах и технических настройках.
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
              <Button
                variant="secondary"
                size="lg"
                onClick={() => openSettingsTab("llm", "llm-api-key")}
              >
                Ввести ключ
              </Button>
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">
            Кратко
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <MetricPanel label="Готовность" value={allReady ? "100%" : `${5 - missingItems.length}/5`} tone={allReady ? "ready" : "warning"} />
            <MetricPanel label="Язык" value={primaryLanguage} tone="neutral" />
            <MetricPanel label="STT" value={primarySttVariant} tone="neutral" />
            <MetricPanel label="Проблемы" value={missingItems.length.toString()} tone={missingItems.length === 0 ? "ready" : "warning"} />
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

      <Card className="p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">Управление</div>
            <h2 className="mt-1 text-xl font-semibold text-text-primary">Горячие клавиши</h2>
          </div>
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/8 bg-white/[0.04]">
            <Keyboard className="h-5 w-5 text-text-secondary" />
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <ShortcutPanel
            label="Отправить в помощник"
            value={sendHotkeyLabel}
            hint="Отправляет текущий контекст в сервис без скриншота."
          />
          <ShortcutPanel
            label="Отправить со скриншотом"
            value={screenshotHotkeyLabel}
            hint="Добавляет к запросу текущий экран."
          />
          <ShortcutPanel
            label="Завершить интервью"
            value={endHotkeyLabel}
            hint="Закрывает overlay и завершает текущую сессию."
          />
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <Button
            variant="secondary"
            onClick={() => openSettingsTab("hotkeys", "hotkeys-bindings")}
          >
            Настроить клавиши
          </Button>
        </div>
      </Card>

      <div className="grid gap-6">
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

function ShortcutPanel({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
      <div className="text-[11px] uppercase tracking-[0.16em] text-text-muted">{label}</div>
      <div className="mt-3 inline-flex rounded-xl border border-white/10 bg-black/15 px-3 py-2 font-mono text-sm text-text-primary">
        {value}
      </div>
      <div className="mt-3 text-sm leading-6 text-text-secondary">{hint}</div>
    </div>
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

