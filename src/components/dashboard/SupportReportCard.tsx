import { useCallback, useMemo, useState } from "react";
import { FileText, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useAppStore } from "@/stores/app";
import { useDiagnosticsStore } from "@/stores/diagnostics";
import { useSettingsStore } from "@/stores/settings";
import { buildDiagnosticsReport, copyDiagnosticsReportToClipboard } from "@/lib/diagnostics";

function maskDevice(value: string): string {
  return value.trim() ? "custom selected" : "system default";
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
  const [copied, setCopied] = useState(false);

  const report = useMemo(() => {
    const safeSnapshot = [
      "AI Interview Support Snapshot",
      "=============================",
      `App version: ${__APP_VERSION__}`,
      `Update status: ${appUpdate.available ? `available ${appUpdate.version}` : "up to date or unknown"}`,
      "",
      "Readiness",
      "---------",
      `License: ${readiness.apiKey} (${readiness.apiKeyDetail})`,
      `Proxy/model: ${readiness.model} (${readiness.modelDetail})`,
      `Vosk: ${readiness.vosk} (${readiness.voskDetail})`,
      `Vosk runtime loaded: ${readiness.voskRuntimeLoaded}`,
      `Vosk model loaded: ${readiness.voskModelLoaded}`,
      "",
      "Permissions",
      "-----------",
      `Microphone: ${permissions.microphone}`,
      `System audio: ${permissions.systemAudio}`,
      `Screen capture: ${permissions.screenCapture}`,
      "",
      "Settings without secrets",
      "------------------------",
      `Language: ${primaryLanguage}`,
      `STT profile: ${primarySttVariant}`,
      `Microphone device: ${maskDevice(microphoneDeviceId)}`,
      `System audio device: ${maskDevice(systemAudioDeviceId)}`,
      `Image handling: ${imageHandlingMode}`,
      `Capture protection toggle: ${protectOverlay}`,
      `Chat memory limit: ${chatMemoryLimitMb} MB`,
      "",
    ].join("\n");

    return `${safeSnapshot}\n${buildDiagnosticsReport(entries.slice(0, 120))}`;
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

  return (
    <Card
      title="Отчет поддержки"
      description="Один текстовый отчет без лицензии и без секретов: версия, готовность, аудио, последние ошибки."
    >
      <div className="space-y-4">
        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4 text-sm leading-relaxed text-text-secondary">
          Если у пользователя что-то не работает, попросите нажать эту кнопку и отправить отчет.
          Так будет видно состояние Vosk, аудио, лицензии и последние диагностические события.
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={copyReport} icon={<FileText className="h-4 w-4" />}>
            {copied ? "Отчет скопирован" : "Скопировать отчет"}
          </Button>
          <Button
            variant="secondary"
            onClick={clearEntries}
            icon={<Trash2 className="h-4 w-4" />}
          >
            Очистить логи
          </Button>
        </div>

        <div className="text-xs text-text-muted">
          В журнале сейчас {entries.length} событий. В отчет попадут последние 120.
        </div>
      </div>
    </Card>
  );
}
