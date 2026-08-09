import { useCallback, useMemo, useState } from "react";
import { CheckCircle2, Copy, Send, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useAppStore } from "@/stores/app";
import { useDiagnosticsStore } from "@/stores/diagnostics";
import { useSettingsStore } from "@/stores/settings";
import { copyDiagnosticsReportToClipboard } from "@/lib/diagnostics";
import { submitSupportReport } from "@/lib/proxy";
import { buildRedactedDiagnosticsReport } from "@/lib/supportReporting";
import { useT } from "@/lib/i18n";

function maskDevice(value: string): string {
  return value.trim() ? "выбрано вручную" : "по умолчанию";
}

export function SupportReportCard() {
  const t = useT();
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
          : t("Не удалось отправить сообщение."),
      );
    } finally {
      setSending(false);
    }
  }, [apiKey, report, t]);

  return (
    <Card
      title={t("Сообщить о проблеме")}
      description={t("Если приложение работает не так, как ожидалось, отправьте нам отчёт — мы увидим, что случилось, и поможем.")}
    >
      <div className="space-y-4">
        <div className="rounded-2xl border border-border bg-bg-secondary/60 p-4">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-muted text-accent">
              <ShieldCheck className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-text-primary">
                {t("Что попадёт в отчёт")}
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">
                {t("Версия приложения, что готово к работе, настройки микрофона и звука и последние технические ошибки. Лицензионный ключ, пароли и текст интервью ")}
                <span className="font-medium text-text-primary">{t("не отправляются")}</span>.
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <Button onClick={sendReport} disabled={sending} icon={<Send className="h-4 w-4" />}>
            {sending ? t("Отправляем...") : t("Отправить в поддержку")}
          </Button>
          <Button variant="secondary" onClick={copyReport} icon={<Copy className="h-4 w-4" />}>
            {copied ? t("Скопировано") : t("Скопировать отчёт")}
          </Button>
        </div>

        {sentReportId && (
          <div className="flex items-start gap-3 rounded-2xl border border-success/25 bg-success-muted/60 px-4 py-3">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <div className="min-w-0 text-sm text-text-secondary">
              <div className="font-semibold text-text-primary">{t("Отчёт отправлен — спасибо!")}</div>
              <div className="mt-0.5">
                {t("Если продолжите переписку с поддержкой, назовите номер обращения:")}{" "}
                <span className="font-mono font-semibold text-text-primary">{sentReportId}</span>
              </div>
            </div>
          </div>
        )}

        {sendError && (
          <div className="rounded-2xl border border-danger/35 bg-danger/10 px-4 py-3 text-sm leading-relaxed text-danger">
            <div className="font-semibold">{t("Не удалось отправить отчёт")}</div>
            <div className="mt-0.5 text-text-secondary">
              {t("Нажмите «Скопировать отчёт» и пришлите его нам вручную — письмом или в чат.")}
            </div>
            <div className="mt-1 text-xs text-text-muted">{sendError}</div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <span className="text-xs text-text-muted">
            {entries.length === 0
              ? t("Пока всё чисто — ошибок не зафиксировано.")
              : t("Приложение записало {count} технических {records}.", {
                  count: entries.length,
                  records: pluralizeRecords(entries.length),
                })}
          </span>
          <button
            type="button"
            onClick={clearEntries}
            disabled={entries.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:bg-danger-muted hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-muted"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("Очистить историю")}
          </button>
        </div>
      </div>
    </Card>
  );
}

function pluralizeRecords(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return "записей";
  if (mod10 === 1) return "запись";
  if (mod10 >= 2 && mod10 <= 4) return "записи";
  return "записей";
}
