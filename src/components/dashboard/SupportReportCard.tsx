import { useCallback, useMemo, useState } from "react";
import { FileText, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useAppStore } from "@/stores/app";
import { useDiagnosticsStore } from "@/stores/diagnostics";
import { useSettingsStore } from "@/stores/settings";
import { copyDiagnosticsReportToClipboard } from "@/lib/diagnostics";
import { submitSupportReport } from "@/lib/proxy";
import { buildRedactedDiagnosticsReport } from "@/lib/supportReporting";

function maskDevice(value: string): string {
  return value.trim() ? "выбрано вручную" : "по умолчанию";
}

export function SupportReportCard() {
  const entries = useDiagnosticsStore((state) => state.entries);
  const clearEntries = useDiagnosticsStore((state) => state.clearEntries);
  const permissions = useAppStore((state) => state.permissions);
  const readiness = useAppStore((state) => state.readiness);
  const appUpdate = useAppStore((state) => state.appUpdate);
  const primaryLanguage = useSettingsStore((state) => state.primaryLanguage);
  const primarySttVariant = useSettingsStore((state) => state.primarySttVariant);
  const microphoneDeviceId = useSettingsStore((state) => state.microphoneDeviceId);
  const systemAudioDeviceId = useSettingsStore((state) => state.systemAudioDeviceId);
  const imageHandlingMode = useSettingsStore((state) => state.imageHandlingMode);
  const protectOverlay = useSettingsStore((state) => state.protectOverlay);
  const chatMemoryLimitMb = useSettingsStore((state) => state.chatMemoryLimitMb);
  const apiKey = useSettingsStore((state) => state.apiKey);
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentReportId, setSentReportId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const report = useMemo(() => {
    const safeSnapshot = [
      "Отчет поддержки AI Interview",
      "============================",
      `Версия приложения: ${__APP_VERSION__}`,
      `Обновление: ${appUpdate.available ? `доступно ${appUpdate.version}` : "актуально или не проверено"}`,
      "",
      "Готовность",
      "----------",
      `Лицензия: ${readiness.apiKey} (${readiness.apiKeyDetail})`,
      `Сервис: ${readiness.model} (${readiness.modelDetail})`,
      `Распознавание: ${readiness.vosk} (${readiness.voskDetail})`,
      `Компоненты распознавания: ${readiness.voskRuntimeLoaded}`,
      `Русский профиль: ${readiness.voskModelLoaded}`,
      "",
      "Доступы",
      "-------",
      `Микрофон: ${permissions.microphone}`,
      `Системный звук: ${permissions.systemAudio}`,
      `Скриншот: ${permissions.screenCapture}`,
      "",
      "Настройки без секретов",
      "---------------------",
      `Язык: ${primaryLanguage}`,
      `Профиль речи: ${primarySttVariant}`,
      `Микрофон: ${maskDevice(microphoneDeviceId)}`,
      `Системный звук: ${maskDevice(systemAudioDeviceId)}`,
      `Скриншоты: ${imageHandlingMode}`,
      `Скрытие при шаринге: ${protectOverlay}`,
      `Лимит истории: ${chatMemoryLimitMb} MB`,
      "",
    ].join("\n");

    return `${safeSnapshot}\n${buildRedactedDiagnosticsReport(entries.slice(0, 120))}`;
  }, [
    appUpdate.available,
    appUpdate.version,
    chatMemoryLimitMb,
    entries,
    imageHandlingMode,
    microphoneDeviceId,
    permissions,
    primaryLanguage,
    primarySttVariant,
    protectOverlay,
    readiness,
    systemAudioDeviceId,
  ]);

  const copyReport = useCallback(async () => {
    const ok = await copyDiagnosticsReportToClipboard(report);
    setCopied(ok);
    if (ok) {
      window.setTimeout(() => setCopied(false), 1800);
    }
  }, [report]);

  const sendReport = useCallback(async () => {
    setSending(true);
    setSentReportId(null);
    setSendError(null);

    try {
      const response = await submitSupportReport({
        licenseKey: apiKey,
        report,
        appVersion: __APP_VERSION__,
        category: "desktop-support-report",
      });
      setSentReportId(response.reportId);
    } catch (error) {
      setSendError(
        error instanceof Error
          ? error.message
          : "Не удалось отправить сообщение.",
      );
    } finally {
      setSending(false);
    }
  }, [apiKey, report]);

  return (
    <Card
      title="Помощь и обращение"
      description="Короткое сообщение для поддержки: версия приложения, готовность, аудио и последние ошибки."
    >
      <div className="space-y-4">
        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4 text-sm leading-relaxed text-text-secondary">
          Если что-то не работает, отправьте сообщение. Оно поможет быстрее понять состояние лицензии, аудио и запуска.
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={sendReport} disabled={sending} icon={<FileText className="h-4 w-4" />}>
            {sending ? "Отправляем..." : "Отправить сообщение"}
          </Button>
          <Button onClick={copyReport} icon={<FileText className="h-4 w-4" />}>
            {copied ? "Сообщение скопировано" : "Скопировать сообщение"}
          </Button>
          <Button
            variant="secondary"
            onClick={clearEntries}
            icon={<Trash2 className="h-4 w-4" />}
          >
            Очистить журнал
          </Button>
        </div>

        {sentReportId && (
          <div className="rounded-2xl border border-success/25 bg-success-muted/60 px-4 py-3 text-sm text-success">
            Сообщение отправлено. ID обращения: {sentReportId}
          </div>
        )}

        {sendError && (
          <div className="rounded-2xl border border-danger/35 bg-danger/10 px-4 py-3 text-sm leading-relaxed text-danger">
            {sendError}
          </div>
        )}

        <div className="text-xs text-text-muted">
          В журнале сейчас {entries.length} событий. В сообщение попадут последние 120.
        </div>
      </div>
    </Card>
  );
}
