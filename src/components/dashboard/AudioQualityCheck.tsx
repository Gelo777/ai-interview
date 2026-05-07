import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { CheckCircle, Copy, Loader2, Mic, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useSettingsStore } from "@/stores/settings";
import { logError, logInfo } from "@/lib/diagnostics";
import type { CaptureAudioSampleResult, CapturedAudioTrack } from "@/lib/tauri";

interface AudioQualityCheckProps {
  onCompleted?: (result: CaptureAudioSampleResult) => void;
}

function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) {
    return "0.0s";
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTrackSummary(track: CapturedAudioTrack): string {
  if (!track.available || !track.file_path) {
    return track.detail || "Источник недоступен.";
  }

  const sampleRate = track.sample_rate ? `${track.sample_rate} Hz` : "частота не определена";
  return `${formatDuration(track.duration_ms)}, ${sampleRate}, ${track.sample_count} сэмплов`;
}

function AudioTrackResult({
  icon,
  title,
  track,
}: {
  icon: ReactNode;
  title: string;
  track: CapturedAudioTrack;
}) {
  const isOk = track.available && Boolean(track.file_path);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
      <div className="flex items-center gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.06]">
          {icon}
        </div>
        <div>
          <div className="text-sm font-semibold text-text-primary">{title}</div>
          <div className={isOk ? "text-xs text-success" : "text-xs text-warning"}>
            {isOk ? "Записано" : "Нужно проверить"}
          </div>
        </div>
      </div>
      <div className="mt-3 text-xs leading-relaxed text-text-muted">
        {formatTrackSummary(track)}
      </div>
      {track.file_path && (
        <div className="mt-2 break-all rounded-xl bg-black/20 px-3 py-2 text-[11px] text-text-secondary">
          {track.file_path}
        </div>
      )}
      {!isOk && track.detail && (
        <div className="mt-2 rounded-xl border border-warning/20 bg-warning-muted/50 px-3 py-2 text-[11px] leading-relaxed text-warning">
          {track.detail}
        </div>
      )}
    </div>
  );
}

export function AudioQualityCheck({ onCompleted }: AudioQualityCheckProps) {
  const microphoneDeviceId = useSettingsStore((state) => state.microphoneDeviceId);
  const systemAudioDeviceId = useSettingsStore((state) => state.systemAudioDeviceId);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CaptureAudioSampleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const resultPaths = useMemo(() => {
    if (!result) {
      return "";
    }

    return [
      `Папка: ${result.output_dir}`,
      result.microphone.file_path ? `Микрофон: ${result.microphone.file_path}` : null,
      result.system_audio.file_path ? `Системный звук: ${result.system_audio.file_path}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }, [result]);

  const runAudioCheck = useCallback(async () => {
    setRunning(true);
    setError(null);
    setCopied(false);
    logInfo("audio.quality", "Audio quality check started");

    try {
      const { captureAudioSample, isTauri } = await import("@/lib/tauri");
      if (!isTauri()) {
        throw new Error("Проверка аудио доступна только в установленном приложении.");
      }

      const captureResult = await captureAudioSample({
        durationSeconds: 10,
        openOutputDir: true,
        microphoneDeviceId: microphoneDeviceId || undefined,
        systemAudioDeviceId: systemAudioDeviceId || undefined,
      });
      setResult(captureResult);
      onCompleted?.(captureResult);
      logInfo("audio.quality", "Audio quality check finished", {
        outputDir: captureResult.output_dir,
        micAvailable: captureResult.microphone.available,
        systemAvailable: captureResult.system_audio.available,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Не удалось записать тестовый звук.";
      setError(message);
      logError("audio.quality", "Audio quality check failed", err);
    } finally {
      setRunning(false);
    }
  }, [microphoneDeviceId, onCompleted, systemAudioDeviceId]);

  const copyPaths = useCallback(async () => {
    if (!resultPaths) {
      return;
    }

    try {
      await navigator.clipboard.writeText(resultPaths);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }, [resultPaths]);

  return (
    <Card
      title="Проверка аудио"
      description="Запишите 10 секунд микрофона и системного звука, затем послушайте WAV-файлы."
    >
      <div className="space-y-4">
        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4 text-sm leading-relaxed text-text-secondary">
          Перед тестом скажите пару фраз в микрофон и включите любой звук на компьютере.
          После записи папка с WAV откроется автоматически.
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={runAudioCheck}
            disabled={running}
            icon={
              running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle className="h-4 w-4" />
              )
            }
          >
            {running ? "Записываем 10 секунд..." : "Записать тест"}
          </Button>
          {resultPaths && (
            <Button
              variant="secondary"
              onClick={copyPaths}
              icon={<Copy className="h-4 w-4" />}
            >
              {copied ? "Скопировано" : "Скопировать пути"}
            </Button>
          )}
        </div>

        {error && (
          <div className="rounded-2xl border border-danger/35 bg-danger/10 px-4 py-3 text-sm leading-relaxed text-danger">
            {error}
          </div>
        )}

        {result && (
          <div className="grid gap-3 md:grid-cols-2">
            <AudioTrackResult
              icon={<Mic className="h-4 w-4 text-accent" />}
              title="Микрофон"
              track={result.microphone}
            />
            <AudioTrackResult
              icon={<Volume2 className="h-4 w-4 text-interviewer" />}
              title="Системный звук"
              track={result.system_audio}
            />
          </div>
        )}
      </div>
    </Card>
  );
}
