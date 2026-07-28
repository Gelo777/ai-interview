import { useCallback, useState } from "react";
import { ListChecks, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { AudioQualityCheck } from "@/components/dashboard/AudioQualityCheck";
import { Button } from "@/components/ui/Button";
import { useAppStore } from "@/stores/app";
import { refreshCloudReadinessNow, refreshLocalReadinessNow } from "@/hooks/useReadinessMonitor";
import { getServiceStatus } from "@/lib/proxy";
import { logError, logInfo, logWarn } from "@/lib/diagnostics";
import type { SettingsFocusTarget, SettingsTab } from "@/lib/types";
import { useT } from "@/lib/i18n";

const CHECK_TIMEOUT_MS = 8000;

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
        timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

export function ReadinessPage() {
  const t = useT();
  const { readiness, permissions, setView, setSettingsTab, setSettingsFocus } = useAppStore();
  const [running, setRunning] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proxyDetail, setProxyDetail] = useState<string | null>(null);

  const openSettingsTab = useCallback(
    (tab: SettingsTab, focus?: SettingsFocusTarget) => {
      setSettingsTab(tab);
      setSettingsFocus(focus ?? null);
      setView("settings");
    },
    [setSettingsFocus, setSettingsTab, setView],
  );

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

  const runCheck = useCallback(async () => {
    setRunning(true);
    setError(null);
    setProxyDetail(null);
    logInfo("system.check", "Manual readiness check started");
    try {
      const [, , proxyStatus] = await withTimeout(
        Promise.all([
          refreshLocalReadinessNow(),
          refreshCloudReadinessNow(),
          getServiceStatus().catch((e) => {
            logWarn("service.status", "Service status endpoint is not available", e);
            return null;
          }),
        ]),
        CHECK_TIMEOUT_MS,
        t("Истекло время ожидания проверки готовности."),
      );
      if (proxyStatus) {
        setProxyDetail(
          proxyStatus.openAiConfigured
            ? t("Сервис доступен.")
            : t("Сервис доступен, но обработка ответов временно не настроена."),
        );
      }
      setLastCheckedAt(Date.now());
      logInfo("system.check", "Manual readiness check finished");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Не удалось выполнить проверку готовности."));
      logError("system.check", "Manual readiness check failed", e);
    } finally {
      setRunning(false);
    }
  }, [t]);

  const lastCheckLabel = lastCheckedAt
    ? new Date(lastCheckedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="mx-auto max-w-4xl px-5 py-8 sm:px-8">
      <PageHeader
        eyebrow={t("Диагностика")}
        title={t("Готовность")}
        subtitle={t("Проверка лицензии, сервиса, микрофона, системного звука и распознавания. Всё зелёное — можно запускать интервью.")}
        icon={ListChecks}
      />

      <div className="rise-in card-elevated overflow-hidden rounded-[28px]">
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="h-6 w-1 rounded-full gradient-aurora" />
            <h2 className="font-display text-sm font-semibold text-text-primary">{t("Проверка системы")}</h2>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                readyCount === totalChecks
                  ? "bg-success/12 text-success"
                  : "bg-warning/12 text-warning"
              }`}
            >
              {readyCount}/{totalChecks} {t("готово")}
            </span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={runCheck}
            disabled={running}
            icon={<RefreshCw className={`h-4 w-4 ${running ? "animate-spin" : ""}`} />}
          >
            {running ? t("Проверяем...") : t("Проверить всё")}
          </Button>
        </div>

        <div className="divide-y divide-border border-t border-border">
          {readinessItems.map((item) => (
            <ReadinessRow
              key={item.key}
              status={item.status}
              label={item.label}
              description={item.description}
              actionLabel={item.actionLabel}
              onAction={item.onAction}
            />
          ))}
        </div>

        {(error || proxyDetail || lastCheckLabel) && (
          <div className="border-t border-border px-6 py-3 text-xs">
            {error ? (
              <span className="text-danger">{error}</span>
            ) : (
              <span className="text-text-muted">
                {proxyDetail ? `${proxyDetail} ` : ""}
                {lastCheckLabel ? t("Последняя проверка: {label}", { label: lastCheckLabel }) : ""}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="mt-6">
        <AudioQualityCheck />
      </div>
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
    <div className="flex items-center gap-4 px-6 py-4 transition-colors hover:bg-white/50">
      <span className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
        {ready && <span className="absolute inline-flex h-full w-full rounded-full bg-success/50 animate-glow" />}
        <span className={`relative h-2.5 w-2.5 rounded-full ${dot}`} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">{label}</span>
          <span className={`text-[11px] ${stateColor}`}>· {stateLabel}</span>
        </div>
        {description && <p className="mt-0.5 truncate text-xs text-text-muted">{description}</p>}
      </div>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="shrink-0 rounded-xl border border-border bg-white/60 px-3 py-1.5 text-xs font-medium text-text-secondary transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:text-text-primary"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
