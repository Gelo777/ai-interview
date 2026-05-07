import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Key,
  Brain,
  Mic,
  Volume2,
  Copy,
  Loader2,
  RotateCcw,
  Trash2,
  Info,
  Eye,
  EyeOff,
  CheckCircle,
  AlertTriangle,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { Select } from "@/components/ui/Select";
import { Slider } from "@/components/ui/Slider";
import { Badge } from "@/components/ui/Badge";
import { StatusIndicator } from "@/components/ui/StatusIndicator";
import { useSettingsStore } from "@/stores/settings";
import { useAppStore } from "@/stores/app";
import { useHistoryStore } from "@/stores/history";
import { useDiagnosticsStore } from "@/stores/diagnostics";
import { HARDCODED_PROXY_BASE_URL } from "@/lib/proxy";
import { useApiKeyValidation } from "@/hooks/useApiKeyValidation";
import { refreshLocalReadinessNow } from "@/hooks/useReadinessMonitor";
import {
  createTransferProgressTracker,
  formatTransferDiagnostics,
  updateTransferProgressTracker,
} from "@/lib/installProgress";
import { APP_LANGUAGE_OPTIONS, getLanguageLabel } from "@/lib/languages";
import {
  buildDiagnosticsReport,
  copyDiagnosticsReportToClipboard,
  logInfo,
  logWarn,
} from "@/lib/diagnostics";
import {
  formatHotkey,
  HOTKEY_MAX_KEYS,
  normalizeHotkeyKeys,
  normalizeHotkeyToken,
} from "@/lib/hotkeys";
import {
  DEFAULT_HISTORY_RETENTION_DAYS,
  formatHistoryRetentionLabel,
  normalizeHistoryRetentionDays,
} from "@/lib/historyRetention";
import {
  compareRuntimeVersions,
  extractRuntimeVersionFromPath,
  normalizeRuntimeVersion,
  resolveLatestStableRuntimeVersion,
} from "@/lib/runtimeVersion";
import {
  STT_QUALITY_PROFILES,
  getSttQualityProfileById,
  resolveSttQualityProfile,
} from "@/lib/sttProfiles";
import type {
  HotkeyAction,
  PrimaryLanguage,
  SettingsFocusTarget,
  SettingsTab,
  SecondaryLanguage,
  SttModelVariant,
} from "@/lib/types";
import type {
  AudioDebugEndpoint,
  AudioDebugSnapshot,
  AudioDeviceInfo,
  VoskModelDownloadProgress,
  VoskModelOption,
  VoskRuntimeVersion,
} from "@/lib/tauri";

const TABS: { id: SettingsTab; label: string; icon: typeof Key }[] = [
  { id: "llm", label: "Ключ", icon: Key },
  { id: "audio", label: "Аудио", icon: Volume2 },
  { id: "speech", label: "Распознавание", icon: Brain },
];

const STT_MANUAL_PROFILE_OVERRIDE_KEY = "ai-interview-stt-manual-profile-override-v1";

function markManualSttProfileOverride(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STT_MANUAL_PROFILE_OVERRIDE_KEY, "1");
}


const SIMPLE_HOTKEY_PRESET: ReadonlyArray<{
  action: HotkeyAction;
  keys: string[];
}> = [
  { action: "send_to_llm", keys: ["F8"] },
  { action: "send_with_screenshot", keys: ["F9"] },
  { action: "end_interview", keys: ["F10"] },
  { action: "switch_stt_language", keys: ["F11"] },
];

function getFocusSectionClass(isFocused: boolean): string {
  if (!isFocused) {
    return "";
  }
  return "rounded-xl ring-2 ring-accent/80 ring-offset-2 ring-offset-bg-primary bg-accent/5 transition-all";
}


export function SettingsPage() {
  const {
    isInterviewActive,
    settingsTab,
    settingsFocus,
    setSettingsTab,
    clearSettingsFocus,
  } = useAppStore();
  const [tab, setTab] = useState<SettingsTab>(settingsTab);
  const [activeFocus, setActiveFocus] = useState<SettingsFocusTarget | null>(null);
  const appVersionLabel = __APP_VERSION__?.trim() ? __APP_VERSION__.trim() : "неизвестно";

  useEffect(() => {
    const availableTab = TABS.some((item) => item.id === settingsTab) ? settingsTab : "speech";
    setTab(availableTab);
    if (availableTab !== settingsTab) {
      setSettingsTab(availableTab);
    }
  }, [setSettingsTab, settingsTab]);

  useEffect(() => {
    if (!settingsFocus) {
      return;
    }
    setActiveFocus(settingsFocus);
    const target = settingsFocus;
    const timeoutId = window.setTimeout(() => {
      setActiveFocus((current) => (current === target ? null : current));
      clearSettingsFocus();
    }, 2600);

    const element = document.getElementById(target);
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [clearSettingsFocus, settingsFocus, tab]);

  return (
    <div className="max-w-5xl p-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-text-primary">Настройки</h1>
        <p className="mt-2 text-sm leading-7 text-text-muted">
          Основные настройки перед запуском интервью.
          {isInterviewActive && (
            <span className="text-warning ml-2">
              Во время собеседования настройки заблокированы.
            </span>
          )}
        </p>
        <p className="mt-1 text-xs text-text-muted">App version: {appVersionLabel}</p>
      </div>

      <div className="mb-6 flex gap-1.5 overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.04] p-1.5">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => {
              setTab(id);
              setSettingsTab(id);
            }}
            className={`
              flex items-center gap-1.5 whitespace-nowrap rounded-xl px-3.5 py-2 text-xs font-medium
              transition-colors cursor-pointer
              ${tab === id
                ? "border border-white/12 bg-[linear-gradient(135deg,rgba(87,208,255,0.2),rgba(115,183,255,0.14))] text-text-primary"
                : "text-text-muted hover:bg-white/[0.05] hover:text-text-secondary"}
            `}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div>
        {tab === "llm" && <LlmSettings disabled={isInterviewActive} focusTarget={activeFocus} />}
        {tab === "audio" && (
          <AudioSettings disabled={isInterviewActive} focusTarget={activeFocus} />
        )}
        {tab === "speech" && (
          <LanguageSettings
            disabled={isInterviewActive}
            focusTarget={activeFocus}
            section="speech"
          />
        )}
      </div>
    </div>
  );
}

function LlmSettings({
  disabled,
  focusTarget,
}: {
  disabled: boolean;
  focusTarget: SettingsFocusTarget | null;
}) {
  const {
    apiKey,
    setApiKey,
    interviewContext,
    setInterviewContext,
  } = useSettingsStore();

  const [showKey, setShowKey] = useState(false);
  const { validating, valid, detail } = useApiKeyValidation(
    apiKey,
    "custom",
    HARDCODED_PROXY_BASE_URL,
    disabled,
  );

  const hasApiKey = apiKey.trim().length > 0;

  return (
    <div className="space-y-5">
      <div id="llm-api-key" className={getFocusSectionClass(focusTarget === "llm-api-key")}>
        <Card
          title="Лицензионный ключ"
          description="Введите лицензионный ключ из бота. Остальное приложение настроит автоматически."
        >
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4 text-sm leading-7 text-text-secondary">
            Не нужно выбирать провайдера, режим или адрес сервиса.
            Приложение проверит ключ и подключится к рабочей конфигурации.
          </div>

          <div className="relative mt-4">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
              }}
              disabled={disabled}
              placeholder="Введите лицензионный ключ"
              className="w-full bg-bg-input border border-border rounded-lg px-3 py-2.5 pr-20
              text-sm text-text-primary placeholder:text-text-muted
              focus:border-accent focus:outline-none transition-colors
              disabled:opacity-50"
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-secondary"
            >
              {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <div className="flex items-center gap-3 mt-3 min-h-7">
            {validating && (
              <Badge variant="warning">
                <Loader2 className="w-3 h-3 animate-spin" /> Проверяем...
              </Badge>
            )}
            {valid === true && (
              <Badge variant="success">
                <CheckCircle className="w-3 h-3" /> Ключ принят
              </Badge>
            )}
            {valid === false && <Badge variant="danger">Ключ не прошел проверку</Badge>}
          </div>
          {valid === false && detail && (
            <p className="mt-2 text-sm leading-6 text-danger">
              {detail}
            </p>
          )}

        </Card>
      </div>

      <div
        id="llm-interview-context"
        className={getFocusSectionClass(focusTarget === "llm-interview-context")}
      >
        <Card
          title="Технический контекст интервью"
          description="Помогает сервису лучше понимать тему собеседования и исправлять типичные ошибки распознавания речи."
        >
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4 text-sm leading-7 text-text-secondary">
            Полезно заранее указать стек или тему. Например:{" "}
            <span className="text-text-primary">
              Go backend, goroutines, channels, mutex, PostgreSQL, Docker
            </span>
            . Тогда сервис будет понимать, что речь идет о разработке, и осторожнее интерпретировать спорные слова вроде{" "}
            <span className="text-text-primary">Go / goroutine / routine</span>.
          </div>

          <div className="mt-4 space-y-2">
            <label className="block text-xs text-text-muted">Контекст</label>
            <textarea
              value={interviewContext}
              onChange={(e) => setInterviewContext(e.target.value)}
              disabled={disabled}
              rows={4}
              placeholder="Например: Собеседование на Go backend. Темы: goroutine, channels, context, REST API, PostgreSQL, Redis."
              className="w-full resize-y bg-bg-input border border-border rounded-lg px-3 py-2.5
              text-sm text-text-primary placeholder:text-text-muted
              focus:border-accent focus:outline-none transition-colors
              disabled:opacity-50"
            />
          </div>
        </Card>
      </div>

      {!hasApiKey && (
        <div className="flex items-start gap-2.5 p-3 bg-warning-muted rounded-lg border border-warning/30">
          <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
          <p className="text-xs text-warning leading-relaxed">
            Пока нет лицензионного ключа. Для запуска нужен только ключ из бота.
          </p>
        </div>
      )}

    </div>
  );
}

function DiagnosticsSettings({ disabled }: { disabled: boolean }) {
  const entries = useDiagnosticsStore((state) => state.entries);
  const clearEntries = useDiagnosticsStore((state) => state.clearEntries);
  const [copied, setCopied] = useState(false);

  const stats = useMemo(() => {
    let info = 0;
    let warn = 0;
    let error = 0;
    for (const entry of entries) {
      if (entry.level === "error") {
        error += 1;
      } else if (entry.level === "warn") {
        warn += 1;
      } else {
        info += 1;
      }
    }
    return { info, warn, error };
  }, [entries]);

  const reportText = useMemo(() => buildDiagnosticsReport(entries), [entries]);
  const visibleEntries = useMemo(() => entries.slice(0, 120), [entries]);

  const handleCopyReport = useCallback(async () => {
    const ok = await copyDiagnosticsReportToClipboard(reportText);
    if (!ok) {
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }, [reportText]);

  return (
    <div className="space-y-5">
      <Card
        title="Журнал приложения"
        description="Служебные события приложения для разбора ошибок запуска, аудио и обращений к сервису."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="muted">Событий: {entries.length}</Badge>
          <Badge variant="danger">Ошибки: {stats.error}</Badge>
          <Badge variant="warning">Предупреждения: {stats.warn}</Badge>
          <Badge variant="muted">Инфо: {stats.info}</Badge>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void handleCopyReport();
            }}
            icon={<Copy className="w-3.5 h-3.5" />}
          >
            {copied ? "Сообщение скопировано" : "Копировать отчет"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => clearEntries()}
            icon={<Trash2 className="w-3.5 h-3.5" />}
            disabled={disabled || entries.length === 0}
          >
            Очистить журнал
          </Button>
        </div>

        <p className="mt-4 text-xs text-text-muted leading-relaxed">
          После воспроизведения проблемы откройте эту вкладку, нажмите
          "Копировать отчет" и отправьте текст. Так проще найти точный этап
          сбоя и не гадать по симптомам.
        </p>

        <div className="mt-4 max-h-[420px] space-y-2 overflow-y-auto rounded-xl border border-white/10 bg-bg-primary/30 p-2">
          {visibleEntries.length === 0 && (
            <div className="rounded-lg border border-dashed border-white/10 p-3 text-xs text-text-muted">
              Логов пока нет. Выполните действие (например, старт интервью или
              отправка подсказки) и откройте вкладку снова.
            </div>
          )}

          {visibleEntries.map((entry) => (
            <div
              key={entry.id}
              className="rounded-lg border border-white/8 bg-black/20 p-3"
            >
              <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
                <Badge
                  variant={
                    entry.level === "error"
                      ? "danger"
                      : entry.level === "warn"
                        ? "warning"
                        : "muted"
                  }
                >
                  {entry.level.toUpperCase()}
                </Badge>
                <span className="text-text-muted">
                  {new Date(entry.timestamp).toLocaleString("ru-RU")}
                </span>
                <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">
                  {entry.scope}
                </span>
              </div>
              <p className="text-sm text-text-primary">{entry.message}</p>
              {entry.details && (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-[11px] leading-relaxed text-text-muted">
                  {entry.details}
                </pre>
              )}
            </div>
          ))}
        </div>

        {entries.length > visibleEntries.length && (
          <p className="mt-3 text-xs text-text-muted">
            Показаны последние {visibleEntries.length} записей из {entries.length}.
          </p>
        )}
      </Card>
    </div>
  );
}

function ProgressBar({ label, percent }: { label: string; percent: number | null }) {
  const normalizedPercent =
    percent === null ? null : Math.max(0, Math.min(100, percent));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs text-text-muted">
        <span>{label}</span>
        <span>{normalizedPercent === null ? "..." : `${normalizedPercent}%`}</span>
      </div>
      <div className="h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
        <div
          className="h-full bg-accent transition-all duration-200"
          style={{ width: normalizedPercent === null ? "35%" : `${normalizedPercent}%` }}
        />
      </div>
    </div>
  );
}

function getModelByVariant(
  models: VoskModelOption[],
  language: PrimaryLanguage,
  variant: SttModelVariant,
): VoskModelOption | null {
  return (
    models.find(
      (model) => model.language === language && model.variant === variant,
    ) ?? null
  );
}

function getVariantDisplayName(variant: SttModelVariant): string {
  return "точный";
}

function isTimeoutLikeError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return /(timed?\s*out|timeout|deadline exceeded|network timeout)/i.test(message);
}

function toRuntimeNetworkHint(error: unknown): string {
  if (!isTimeoutLikeError(error)) {
    return "";
  }
  return "Не удалось быстро связаться с сервером загрузки. Проверьте интернет, VPN или сеть и повторите попытку.";
}

function isInstallОтменаledError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return /(cancelled|canceled|aborted by user)/i.test(message);
}

function hasInstalledModel(model: VoskModelOption | null): boolean {
  if (!model) {
    return false;
  }
  return model.installed || model.installed_versions.length > 0;
}

type ModelOperation = {
  language: PrimaryLanguage;
  variant: SttModelVariant;
  action: "install" | "remove";
};

type InstallModelOptions = {
  skipRuntimeInstall?: boolean;
};

function isPrimaryLanguage(value: string): value is PrimaryLanguage {
  return APP_LANGUAGE_OPTIONS.some((option) => option.code === value);
}

function formatAudioDeviceOptionLabel(device: AudioDeviceInfo): string {
  return device.name;
}

function buildDefaultAudioLabel(
  devices: AudioDeviceInfo[],
  isInput: boolean,
): string {
  const defaultDevice = devices.find(
    (device) => device.is_input === isInput && device.is_default,
  );
  if (!defaultDevice) {
    return "По умолчанию Windows";
  }

  return `По умолчанию Windows (${defaultDevice.name})`;
}

function buildAudioDeviceOptions(
  devices: AudioDeviceInfo[],
  isInput: boolean,
): Array<{ value: string; label: string }> {
  const filtered = devices.filter((device) => device.is_input === isInput);
  const baseLabels = filtered.map((device) => ({
    device,
    baseLabel: formatAudioDeviceOptionLabel(device),
  }));
  const counts = new Map<string, number>();
  const seen = new Map<string, number>();

  for (const entry of baseLabels) {
    counts.set(entry.baseLabel, (counts.get(entry.baseLabel) ?? 0) + 1);
  }

  return [
    { value: "", label: buildDefaultAudioLabel(devices, isInput) },
    ...baseLabels.map(({ device, baseLabel }) => {
      const hasDuplicates = (counts.get(baseLabel) ?? 0) > 1;
      const duplicateIndex = (seen.get(baseLabel) ?? 0) + 1;
      seen.set(baseLabel, duplicateIndex);
      const suffix = hasDuplicates ? ` • вариант ${duplicateIndex}` : "";

      return {
        value: device.id,
        label: `${baseLabel}${suffix}`,
      };
    }),
  ];
}

function normalizeDeviceNameForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-zа-яё0-9\s\-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function findBrowserMediaDeviceIdByName(
  kind: "audioinput" | "audiooutput",
  preferredName: string | null,
): Promise<string | null> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.enumerateDevices !== "function"
  ) {
    return null;
  }

  const target = normalizeDeviceNameForMatch(preferredName ?? "");
  if (!target) {
    return null;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const candidates = devices.filter((device) => device.kind === kind);
  if (candidates.length === 0) {
    return null;
  }

  const exact = candidates.find(
    (device) => normalizeDeviceNameForMatch(device.label) === target,
  );
  if (exact?.deviceId) {
    return exact.deviceId;
  }

  const partial = candidates.find((device) => {
    const normalizedLabel = normalizeDeviceNameForMatch(device.label);
    return (
      normalizedLabel.includes(target) ||
      target.includes(normalizedLabel)
    );
  });

  return partial?.deviceId ?? null;
}

function toAudioTestErrorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Неизвестная ошибка";
  const normalized = message.toLowerCase();

  if (
    normalized.includes("permission") ||
    normalized.includes("denied") ||
    normalized.includes("notallowederror")
  ) {
    return "Доступ к аудио запрещен. Разрешите микрофон приложению в Windows.";
  }
  if (normalized.includes("notfounderror") || normalized.includes("device")) {
    return "Не удалось найти выбранное устройство. Обновите список и попробуйте снова.";
  }
  if (normalized.includes("webview")) {
    return "Не удалось привязать тест к выбранному устройству. Проверьте доступность устройства и запустите проверку снова.";
  }
  if (normalized.includes("sinkid")) {
    return "Проверка конкретного динамика недоступна в этой среде.";
  }

  return message;
}

interface MicTestDebugInfo {
  requestedDeviceName: string | null;
  preferredBrowserDeviceId: string | null;
  trackLabel: string | null;
  trackSettings: MediaTrackSettings | null;
  resolutionStage: string;
  selectionMatched: boolean;
}

interface SpeakerTestDebugInfo {
  requestedOutputName: string | null;
  preferredSinkId: string | null;
  activeSinkId: string | null;
  setSinkIdSupported: boolean;
  routedToPreferredSink: boolean;
}

function buildMicrophoneTestConstraints(
  preferredBrowserDeviceId: string | null,
): MediaTrackConstraints {
  return preferredBrowserDeviceId
    ? {
        deviceId: { exact: preferredBrowserDeviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    : {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      };
}

function doesTrackMatchPreferredMicrophone(
  track: MediaStreamTrack | null,
  preferredName: string | null,
  preferredBrowserDeviceId: string | null,
): boolean {
  if (!track || !preferredName) {
    return true;
  }

  const settings =
    typeof track.getSettings === "function" ? track.getSettings() : null;
  if (preferredBrowserDeviceId && settings?.deviceId === preferredBrowserDeviceId) {
    return true;
  }

  const normalizedTrackLabel = normalizeDeviceNameForMatch(track.label ?? "");
  const normalizedPreferredName = normalizeDeviceNameForMatch(preferredName);
  if (!normalizedTrackLabel || !normalizedPreferredName) {
    return false;
  }

  return (
    normalizedTrackLabel.includes(normalizedPreferredName) ||
    normalizedPreferredName.includes(normalizedTrackLabel)
  );
}

async function openPreferredMicrophoneTestStream(
  preferredName: string | null,
  strictSelection: boolean,
): Promise<{
  stream: MediaStream;
  preferredBrowserDeviceId: string | null;
  resolutionStage: string;
  selectionMatched: boolean;
}> {
  let preferredBrowserDeviceId = await findBrowserMediaDeviceIdByName(
    "audioinput",
    preferredName,
  );
  let resolutionStage = preferredBrowserDeviceId ? "preflight-match" : "default-mode";

  if (strictSelection && !preferredBrowserDeviceId) {
    const permissionProbeStream = await navigator.mediaDevices.getUserMedia({
      audio: buildMicrophoneTestConstraints(null),
    });
    permissionProbeStream.getTracks().forEach((track) => track.stop());
    preferredBrowserDeviceId = await findBrowserMediaDeviceIdByName(
      "audioinput",
      preferredName,
    );
    resolutionStage = preferredBrowserDeviceId
      ? "post-permission-match"
      : "selected-device-unresolved";
    if (!preferredBrowserDeviceId) {
      throw new Error("Выбранный микрофон недоступен");
    }
  }

  let stream = await navigator.mediaDevices.getUserMedia({
    audio: buildMicrophoneTestConstraints(preferredBrowserDeviceId),
  });
  let track = stream.getAudioTracks()[0] ?? null;
  let selectionMatched = doesTrackMatchPreferredMicrophone(
    track,
    preferredName,
    preferredBrowserDeviceId,
  );

  if (!preferredName || selectionMatched) {
    return { stream, preferredBrowserDeviceId, resolutionStage, selectionMatched };
  }

  const retriedBrowserDeviceId = await findBrowserMediaDeviceIdByName(
    "audioinput",
    preferredName,
  );
  if (!retriedBrowserDeviceId) {
    if (strictSelection) {
      stream.getTracks().forEach((currentTrack) => currentTrack.stop());
      throw new Error("Выбранный микрофон недоступен");
    }
    return {
      stream,
      preferredBrowserDeviceId,
      resolutionStage: "unresolved-fallback",
      selectionMatched,
    };
  }

  preferredBrowserDeviceId = retriedBrowserDeviceId;
  if (
    doesTrackMatchPreferredMicrophone(track, preferredName, preferredBrowserDeviceId)
  ) {
    return {
      stream,
      preferredBrowserDeviceId,
      resolutionStage: "post-permission-confirmed",
      selectionMatched: true,
    };
  }

  stream.getTracks().forEach((currentTrack) => currentTrack.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    audio: buildMicrophoneTestConstraints(preferredBrowserDeviceId),
  });
  track = stream.getAudioTracks()[0] ?? null;
  selectionMatched = doesTrackMatchPreferredMicrophone(
    track,
    preferredName,
    preferredBrowserDeviceId,
  );

  return {
    stream,
    preferredBrowserDeviceId,
    resolutionStage: strictSelection
      ? "strict-rematch"
      : "post-permission-rematch",
    selectionMatched,
  };
}

function formatAudioDebugDevice(device: AudioDeviceInfo | null | undefined): string {
  if (!device) {
    return "не найдено";
  }

  const defaultLabel = device.is_default ? ", по умолчанию Windows" : "";
  return `${device.name} [${device.id}] (${device.sample_rate} Hz, ${device.channels} ch${defaultLabel})`;
}

function formatAudioDebugSelection(endpoint: AudioDebugEndpoint): string {
  if (endpoint.selected_device) {
    return formatAudioDebugDevice(endpoint.selected_device);
  }
  if (endpoint.selected_device_id) {
    return `не найдено (${endpoint.selected_device_id})`;
  }
  return "режим Windows по умолчанию";
}

function buildAudioRouteSummary(params: {
  endpoint: AudioDebugEndpoint;
  usesWindowsDefault: boolean;
}): { title: string; detail: string; auxiliary: string | null } {
  const { endpoint, usesWindowsDefault } = params;

  if (!usesWindowsDefault) {
    return {
      title: `Выбран: ${formatAudioDebugSelection(endpoint)}`,
      detail: endpoint.detail,
      auxiliary: endpoint.available ? null : "Выбранное устройство сейчас недоступно.",
    };
  }

  return {
    title: "Режим: Windows по умолчанию",
    detail: endpoint.detail,
    auxiliary: endpoint.default_device
      ? `Текущее устройство по умолчанию: ${formatAudioDebugDevice(endpoint.default_device)}`
      : "Устройство Windows по умолчанию не найдено.",
  };
}

function appendAudioDeviceList(
  lines: string[],
  title: string,
  devices: AudioDeviceInfo[],
): void {
  lines.push(title);
  if (devices.length === 0) {
    lines.push("- нет");
    return;
  }

  for (const device of devices) {
    lines.push(`- ${formatAudioDebugDevice(device)}`);
  }
}

function buildAudioDebugReport(params: {
  snapshot: AudioDebugSnapshot | null;
  fetchedAt: number | null;
  micLevel: number;
  micPeakLevel: number;
  micAverageLevel: number;
  micSilentDurationMs: number;
  micTestActive: boolean;
  micTestMessage: string | null;
  micTestDebugInfo: MicTestDebugInfo | null;
  speakerTestRunning: boolean;
  speakerTestMessage: string | null;
  speakerTestDebugInfo: SpeakerTestDebugInfo | null;
}): string {
  const {
    snapshot,
    fetchedAt,
    micLevel,
    micPeakLevel,
    micAverageLevel,
    micSilentDurationMs,
    micTestActive,
    micTestMessage,
    micTestDebugInfo,
    speakerTestRunning,
    speakerTestMessage,
    speakerTestDebugInfo,
  } = params;
  const lines = [
    "Отчет аудио",
    "================================",
    `Сформировано: ${new Date().toISOString()}`,
    `Часовой пояс: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    `Снимок аудио: ${fetchedAt ? new Date(fetchedAt).toISOString() : "еще не собран"}`,
    "",
  ];

  if (!snapshot) {
    lines.push("Снимок аудио пока недоступен.");
  } else {
    lines.push("Снимок");
    lines.push(`- Микрофон выбран: ${formatAudioDebugSelection(snapshot.microphone)}`);
    lines.push(`- Микрофон используется: ${formatAudioDebugDevice(snapshot.microphone.effective_device)}`);
    lines.push(`- Микрофон по умолчанию: ${formatAudioDebugDevice(snapshot.microphone.default_device)}`);
    lines.push(`- Микрофон: ${snapshot.microphone.detail}`);
    lines.push(`- Вывод выбран: ${formatAudioDebugSelection(snapshot.system_audio)}`);
    lines.push(`- Вывод используется: ${formatAudioDebugDevice(snapshot.system_audio.effective_device)}`);
    lines.push(`- Вывод по умолчанию: ${formatAudioDebugDevice(snapshot.system_audio.default_device)}`);
    lines.push(`- Вывод: ${snapshot.system_audio.detail}`);
    lines.push(
      `- Захват системного звука: ${
        snapshot.system_audio_status.available
          ? "доступно"
          : snapshot.system_audio_status.supported
            ? "недоступно"
            : "не поддерживается"
      }`,
    );
    lines.push(`- Системный звук: ${snapshot.system_audio_status.detail}`);
    lines.push("");
    appendAudioDeviceList(lines, "Устройства ввода", snapshot.input_devices);
    lines.push("");
    appendAudioDeviceList(lines, "Устройства вывода", snapshot.output_devices);
    if (snapshot.notes.length > 0) {
      lines.push("");
      lines.push("Заметки");
      for (const note of snapshot.notes) {
        lines.push(`- ${note}`);
      }
    }
  }

  lines.push("");
  lines.push("Проверка микрофона");
  lines.push(`- Активна: ${micTestActive ? "да" : "нет"}`);
  lines.push(`- Текущий уровень: ${Math.round(micLevel * 100)}%`);
  lines.push(`- Пик: ${Math.round(micPeakLevel * 100)}%`);
  lines.push(`- Средний уровень: ${Math.round(micAverageLevel * 100)}%`);
  lines.push(`- Тишина: ${Math.round(micSilentDurationMs / 100) / 10}s`);
  lines.push(`- Сообщение: ${micTestMessage ?? "нет"}`);
  if (micTestDebugInfo) {
    lines.push(`- Запрошенное устройство: ${micTestDebugInfo.requestedDeviceName ?? "по умолчанию Windows"}`);
    lines.push(`- Устройство в окне: ${micTestDebugInfo.preferredBrowserDeviceId ?? "не определено"}`);
    lines.push(`- Активная дорожка: ${micTestDebugInfo.trackLabel ?? "неизвестно"}`);
    lines.push(`- Этап выбора: ${micTestDebugInfo.resolutionStage}`);
    lines.push(`- Выбор совпал: ${micTestDebugInfo.selectionMatched ? "да" : "нет"}`);
    lines.push(
      `- Параметры дорожки: ${
        micTestDebugInfo.trackSettings
          ? JSON.stringify(micTestDebugInfo.trackSettings)
          : "недоступно"
      }`,
    );
  }

  lines.push("");
  lines.push("Проверка динамика");
  lines.push(`- Активна: ${speakerTestRunning ? "да" : "нет"}`);
  lines.push(`- Message: ${speakerTestMessage ?? "none"}`);
  if (speakerTestDebugInfo) {
    lines.push(`- Запрошенный вывод: ${speakerTestDebugInfo.requestedOutputName ?? "по умолчанию Windows"}`);
    lines.push(`- Устройство вывода в окне: ${speakerTestDebugInfo.preferredSinkId ?? "не определено"}`);
    lines.push(`- Выбор динамика поддерживается: ${speakerTestDebugInfo.setSinkIdSupported ? "да" : "нет"}`);
    lines.push(`- Сигнал направлен в выбранный динамик: ${speakerTestDebugInfo.routedToPreferredSink ? "да" : "нет"}`);
    lines.push(`- Активный вывод: ${speakerTestDebugInfo.activeSinkId ?? "неизвестно"}`);
  }

  return lines.join("\n");
}

function AudioSettings({
  disabled,
  focusTarget,
}: {
  disabled: boolean;
  focusTarget: SettingsFocusTarget | null;
}) {
  const {
    microphoneDeviceId,
    systemAudioDeviceId,
    setMicrophoneDeviceId,
    setSystemAudioDeviceId,
  } = useSettingsStore();
  const permissions = useAppStore((state) => state.permissions);
  const [audioDevices, setAudioDevices] = useState<AudioDeviceInfo[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [audioDeviceLoadError, setAudioDeviceLoadError] = useState<string | null>(null);
  const [micTestActive, setMicTestActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micPeakLevel, setMicPeakLevel] = useState(0);
  const [micAverageLevel, setMicAverageLevel] = useState(0);
  const [micSilentDurationMs, setMicSilentDurationMs] = useState(0);
  const [micTestMessage, setMicTestMessage] = useState<string | null>(null);
  const [micTestDebugInfo, setMicTestDebugInfo] = useState<MicTestDebugInfo | null>(null);
  const [speakerTestRunning, setSpeakerTestRunning] = useState(false);
  const [speakerTestMessage, setSpeakerTestMessage] = useState<string | null>(null);
  const [speakerTestDebugInfo, setSpeakerTestDebugInfo] =
    useState<SpeakerTestDebugInfo | null>(null);
  const [audioDebugSnapshot, setAudioDebugSnapshot] = useState<AudioDebugSnapshot | null>(null);
  const [audioDebugLoading, setAudioDebugLoading] = useState(false);
  const [audioDebugMessage, setAudioDebugMessage] = useState<string | null>(null);
  const [audioDebugFetchedAt, setAudioDebugFetchedAt] = useState<number | null>(null);
  const [audioDebugCopied, setAudioDebugCopied] = useState(false);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micAudioContextRef = useRef<AudioContext | null>(null);
  const micAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micRafRef = useRef<number | null>(null);
  const micPeakLevelRef = useRef(0);
  const micLevelSumRef = useRef(0);
  const micLevelSampleCountRef = useRef(0);
  const micSilentSinceRef = useRef<number | null>(null);
  const lastMicrophoneSelectionRef = useRef<string | null | undefined>(undefined);
  const speakerAudioContextRef = useRef<AudioContext | null>(null);
  const speakerAudioRef = useRef<HTMLAudioElement | null>(null);
  const speakerTimerRef = useRef<number | null>(null);
  const lastSystemAudioSelectionRef = useRef<string | null | undefined>(undefined);

  const refreshAudioDevices = useCallback(async () => {
    const { isTauri, listAudioDevices } = await import("@/lib/tauri");
    if (!isTauri()) {
      setAudioDevices([]);
      setAudioDeviceLoadError(null);
      return;
    }

    setLoadingDevices(true);
    try {
      const devices = await listAudioDevices();
      setAudioDevices(devices);
      setAudioDeviceLoadError(null);
    } catch (error) {
      logWarn("audio.devices", "Не удалось загрузить список аудиоустройств", error);
      setAudioDeviceLoadError(
        error instanceof Error
          ? error.message
          : "Не удалось загрузить список аудиоустройств.",
      );
    } finally {
      setLoadingDevices(false);
    }
  }, []);

  useEffect(() => {
    void refreshAudioDevices();
  }, [refreshAudioDevices]);

  const microphoneOptions = useMemo(
    () => buildAudioDeviceOptions(audioDevices, true),
    [audioDevices],
  );
  const systemAudioOptions = useMemo(
    () => buildAudioDeviceOptions(audioDevices, false),
    [audioDevices],
  );
  const defaultMicrophone = useMemo(
    () => audioDevices.find((device) => device.is_input && device.is_default) ?? null,
    [audioDevices],
  );
  const defaultSystemAudio = useMemo(
    () => audioDevices.find((device) => !device.is_input && device.is_default) ?? null,
    [audioDevices],
  );
  const selectedMicrophoneDevice = useMemo(
    () =>
      (microphoneDeviceId
        ? audioDevices.find(
            (device) => device.is_input && device.id === microphoneDeviceId,
          ) ?? null
        : null),
    [audioDevices, microphoneDeviceId],
  );
  const selectedSystemAudioDevice = useMemo(
    () =>
      (systemAudioDeviceId
        ? audioDevices.find(
            (device) => !device.is_input && device.id === systemAudioDeviceId,
          ) ?? null
        : null),
    [audioDevices, systemAudioDeviceId],
  );
  const microphoneUsesWindowsDefault = !microphoneDeviceId;
  const systemAudioUsesWindowsDefault = !systemAudioDeviceId;
  const controlsDisabled = disabled || loadingDevices;
  const micSilenceHint = useMemo(() => {
    if (!micTestActive || micSilentDurationMs < 1800) {
      return null;
    }
    return "Сигнал почти нулевой уже несколько секунд. Проверьте нужный микрофон, mute и уровень входа в Windows.";
  }, [micSilentDurationMs, micTestActive]);

  const refreshAudioDebugSnapshot = useCallback(
    async (reason: "auto" | "manual" = "auto") => {
      const { isTauri, getAudioDebugSnapshot } = await import("@/lib/tauri");
      if (!isTauri()) {
        setAudioDebugSnapshot(null);
        setAudioDebugMessage(null);
        setAudioDebugFetchedAt(null);
        return;
      }

      setAudioDebugLoading(true);
      try {
        const snapshot = await getAudioDebugSnapshot({
          microphoneDeviceId,
          systemAudioDeviceId,
        });
        setAudioDebugSnapshot(snapshot);
        setAudioDebugFetchedAt(Date.now());
        setAudioDebugMessage(null);

        if (reason === "manual") {
          logInfo("audio.debug", "Снимок аудио-диагностики обновлен", {
            microphone: snapshot.microphone,
            systemAudio: snapshot.system_audio,
            systemAudioStatus: snapshot.system_audio_status,
            notes: snapshot.notes,
          });
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Не удалось собрать аудио-диагностику.";
        setAudioDebugMessage(message);
        logWarn("audio.debug", "Не удалось собрать аудио-диагностику", error);
      } finally {
        setAudioDebugLoading(false);
      }
    },
    [microphoneDeviceId, systemAudioDeviceId],
  );

  useEffect(() => {
    if (loadingDevices) {
      return;
    }
    void refreshAudioDebugSnapshot();
  }, [loadingDevices, refreshAudioDebugSnapshot]);

  const audioDebugReport = useMemo(
    () =>
      buildAudioDebugReport({
        snapshot: audioDebugSnapshot,
        fetchedAt: audioDebugFetchedAt,
        micLevel,
        micPeakLevel,
        micAverageLevel,
        micSilentDurationMs,
        micTestActive,
        micTestMessage,
        micTestDebugInfo,
        speakerTestRunning,
        speakerTestMessage,
        speakerTestDebugInfo,
      }),
    [
      audioDebugFetchedAt,
      audioDebugSnapshot,
      micAverageLevel,
      micLevel,
      micPeakLevel,
      micSilentDurationMs,
      micTestActive,
      micTestDebugInfo,
      micTestMessage,
      speakerTestDebugInfo,
      speakerTestMessage,
      speakerTestRunning,
    ],
  );

  const handleCopyAudioDebugReport = useCallback(async () => {
    const ok = await copyDiagnosticsReportToClipboard(audioDebugReport);
    if (!ok) {
      setAudioDebugMessage("Не удалось скопировать аудио-отчет.");
      return;
    }
    setAudioDebugCopied(true);
    setAudioDebugMessage("Аудио-отчет скопирован в буфер обмена.");
    window.setTimeout(() => setAudioDebugCopied(false), 1400);
  }, [audioDebugReport]);

  const stopMicTest = useCallback(() => {
    if (micRafRef.current !== null) {
      window.cancelAnimationFrame(micRafRef.current);
      micRafRef.current = null;
    }
    if (micAudioSourceRef.current) {
      micAudioSourceRef.current.disconnect();
      micAudioSourceRef.current = null;
    }
    if (micStreamRef.current) {
      for (const track of micStreamRef.current.getTracks()) {
        track.stop();
      }
      micStreamRef.current = null;
    }
    if (micAudioContextRef.current) {
      void micAudioContextRef.current.close().catch(() => {
        // Ignore close failures during cleanup.
      });
      micAudioContextRef.current = null;
    }
    micSilentSinceRef.current = null;
    setMicLevel(0);
    setMicSilentDurationMs(0);
    setMicTestActive(false);
  }, []);

  const stopSpeakerTest = useCallback(() => {
    if (speakerTimerRef.current !== null) {
      window.clearTimeout(speakerTimerRef.current);
      speakerTimerRef.current = null;
    }
    if (speakerAudioRef.current) {
      speakerAudioRef.current.pause();
      speakerAudioRef.current.srcObject = null;
      speakerAudioRef.current = null;
    }
    if (speakerAudioContextRef.current) {
      void speakerAudioContextRef.current.close().catch(() => {
        // Ignore close failures during cleanup.
      });
      speakerAudioContextRef.current = null;
    }
    setSpeakerTestRunning(false);
  }, []);

  useEffect(() => {
    return () => {
      stopMicTest();
      stopSpeakerTest();
    };
  }, [stopMicTest, stopSpeakerTest]);

  useEffect(() => {
    const currentSelection = microphoneDeviceId ?? null;
    if (typeof lastMicrophoneSelectionRef.current === "undefined") {
      lastMicrophoneSelectionRef.current = currentSelection;
      return;
    }

    if (lastMicrophoneSelectionRef.current === currentSelection) {
      return;
    }

    lastMicrophoneSelectionRef.current = currentSelection;
    if (micTestActive) {
      stopMicTest();
      logInfo("audio.micTest", "Выбор микрофона изменился, тест остановлен");
    }
    setMicTestDebugInfo(null);
    setMicPeakLevel(0);
    setMicAverageLevel(0);
    setMicSilentDurationMs(0);
    setMicLevel(0);
    setMicTestMessage("Выбрано другое устройство. Запустите проверку микрофона снова.");
  }, [microphoneDeviceId, micTestActive, stopMicTest]);

  useEffect(() => {
    const currentSelection = systemAudioDeviceId ?? null;
    if (typeof lastSystemAudioSelectionRef.current === "undefined") {
      lastSystemAudioSelectionRef.current = currentSelection;
      return;
    }

    if (lastSystemAudioSelectionRef.current === currentSelection) {
      return;
    }

    lastSystemAudioSelectionRef.current = currentSelection;
    if (speakerTestRunning) {
      stopSpeakerTest();
      logInfo("audio.speakerTest", "Выбор устройства вывода изменился, тест остановлен");
    }
    setSpeakerTestDebugInfo(null);
    setSpeakerTestMessage("Выбрано другое устройство. Запустите проверку динамика снова.");
  }, [speakerTestRunning, stopSpeakerTest, systemAudioDeviceId]);

  const startMicTest = useCallback(async () => {
    if (controlsDisabled) {
      return;
    }

    stopMicTest();
    micPeakLevelRef.current = 0;
    micLevelSumRef.current = 0;
    micLevelSampleCountRef.current = 0;
    micSilentSinceRef.current = null;
    setMicPeakLevel(0);
    setMicAverageLevel(0);
    setMicSilentDurationMs(0);
    setMicTestMessage("Запрашиваем доступ к микрофону...");
    setMicTestDebugInfo(null);

    try {
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== "function"
      ) {
        throw new Error("Проверка микрофона недоступна в этой среде");
      }
      if (!microphoneUsesWindowsDefault && !selectedMicrophoneDevice) {
        throw new Error("Выбранный микрофон недоступен");
      }

      const selectedMicrophone =
        selectedMicrophoneDevice?.name ?? (microphoneUsesWindowsDefault ? defaultMicrophone?.name ?? null : null);
      const {
        stream,
        preferredBrowserDeviceId,
        resolutionStage,
        selectionMatched,
      } = await openPreferredMicrophoneTestStream(
        selectedMicrophone,
        !microphoneUsesWindowsDefault,
      );

      const AudioContextCtor =
        window.AudioContext ??
        ((window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext ?? null);
      if (!AudioContextCtor) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("Проверка аудио недоступна в этой среде");
      }

      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);

      const buffer = new Uint8Array(analyser.fftSize);
      const updateLevel = () => {
        analyser.getByteTimeDomainData(buffer);
        let energy = 0;
        for (let index = 0; index < buffer.length; index += 1) {
          const value = (buffer[index] - 128) / 128;
          energy += value * value;
        }
        const rms = Math.sqrt(energy / buffer.length);
        const normalized = Math.max(0, Math.min(1, rms * 3.5));
        const now = performance.now();
        if (normalized < 0.02) {
          if (micSilentSinceRef.current === null) {
            micSilentSinceRef.current = now;
          }
        } else {
          micSilentSinceRef.current = null;
        }
        micLevelSampleCountRef.current += 1;
        micLevelSumRef.current += normalized;
        micPeakLevelRef.current = Math.max(micPeakLevelRef.current, normalized);
        setMicLevel(normalized);
        setMicPeakLevel(micPeakLevelRef.current);
        setMicAverageLevel(
          micLevelSumRef.current / Math.max(1, micLevelSampleCountRef.current),
        );
        setMicSilentDurationMs(
          micSilentSinceRef.current === null ? 0 : Math.round(now - micSilentSinceRef.current),
        );
        micRafRef.current = window.requestAnimationFrame(updateLevel);
      };

      const track = stream.getAudioTracks()[0] ?? null;
      const trackSettings =
        track && typeof track.getSettings === "function" ? track.getSettings() : null;

      micStreamRef.current = stream;
      micAudioContextRef.current = audioContext;
      micAudioSourceRef.current = source;
      micRafRef.current = window.requestAnimationFrame(updateLevel);
      setMicTestActive(true);
      setMicTestDebugInfo({
        requestedDeviceName: selectedMicrophone,
        preferredBrowserDeviceId,
        trackLabel: track?.label ?? null,
        trackSettings,
        resolutionStage,
        selectionMatched,
      });
      logInfo("audio.micTest", "Проверка микрофона запущена", {
        requestedDeviceName: selectedMicrophone,
        preferredBrowserDeviceId,
        trackLabel: track?.label ?? null,
        trackSettings,
        resolutionStage,
        selectionMatched,
      });
      setMicTestMessage(
        !microphoneUsesWindowsDefault && selectedMicrophone && !selectionMatched
          ? `Проверка запущена, но окно приложения использует другое устройство: ${track?.label ?? "неизвестно"}.`
          : selectedMicrophone
          ? `Проверка запущена: ${selectedMicrophone}`
          : "Проверка запущена. Скажите что-нибудь в микрофон.",
      );
      if (!microphoneUsesWindowsDefault && selectedMicrophone && !selectionMatched) {
        logWarn(
          "audio.micTest",
          "Проверка не подключилась к выбранному микрофону",
          {
            requestedDeviceName: selectedMicrophone,
            preferredBrowserDeviceId,
            trackLabel: track?.label ?? null,
            resolutionStage,
          },
        );
      }
    } catch (error) {
      stopMicTest();
      setMicTestMessage(`Ошибка проверки микрофона: ${toAudioTestErrorMessage(error)}`);
      logWarn("audio.micTest", "Проверка микрофона завершилась ошибкой", error);
    }
  }, [
    controlsDisabled,
    defaultMicrophone?.name,
    microphoneUsesWindowsDefault,
    selectedMicrophoneDevice?.name,
    stopMicTest,
  ]);

  const runSpeakerTest = useCallback(async () => {
    if (controlsDisabled) {
      return;
    }
    stopSpeakerTest();
    setSpeakerTestRunning(true);
    setSpeakerTestMessage("Воспроизводим тестовый звук...");
    setSpeakerTestDebugInfo(null);

    try {
      const AudioContextCtor =
        window.AudioContext ??
        ((window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext ?? null);
      if (!AudioContextCtor) {
        throw new Error("Проверка аудио недоступна в этой среде");
      }
      if (!systemAudioUsesWindowsDefault && !selectedSystemAudioDevice) {
        throw new Error("Выбранный динамик недоступен");
      }

      const selectedOutputName =
        selectedSystemAudioDevice?.name ??
        (systemAudioUsesWindowsDefault ? defaultSystemAudio?.name ?? null : null);
      const preferredSinkId = await findBrowserMediaDeviceIdByName(
        "audiooutput",
        selectedOutputName,
      );
      if (!systemAudioUsesWindowsDefault && !preferredSinkId) {
        throw new Error("Выбранный динамик недоступен в окне приложения");
      }

      const context = new AudioContextCtor();
      const mediaDestination = context.createMediaStreamDestination();
      const audioElement = new Audio();
      audioElement.srcObject = mediaDestination.stream;
      audioElement.autoplay = false;

      const withSink = audioElement as HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
        sinkId?: string;
      };
      const setSinkIdSupported = typeof withSink.setSinkId === "function";
      if (!systemAudioUsesWindowsDefault && !setSinkIdSupported) {
        throw new Error("Выбор конкретного динамика недоступен");
      }
      if (preferredSinkId && setSinkIdSupported) {
        await withSink.setSinkId(preferredSinkId);
      }

      await audioElement.play();

      const scheduleBeep = (offsetSeconds: number) => {
        const now = context.currentTime + offsetSeconds;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(880, now);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
        oscillator.connect(gain);
        gain.connect(mediaDestination);
        oscillator.start(now);
        oscillator.stop(now + 0.24);
      };

      scheduleBeep(0.05);
      scheduleBeep(0.40);

      const activeSinkId =
        typeof withSink.sinkId === "string" && withSink.sinkId.trim()
          ? withSink.sinkId
          : null;

      speakerAudioContextRef.current = context;
      speakerAudioRef.current = audioElement;
      setSpeakerTestDebugInfo({
        requestedOutputName: selectedOutputName,
        preferredSinkId,
        activeSinkId,
        setSinkIdSupported,
        routedToPreferredSink:
          systemAudioUsesWindowsDefault || Boolean(preferredSinkId && activeSinkId === preferredSinkId),
      });
      logInfo("audio.speakerTest", "Проверка динамика запущена", {
        requestedOutputName: selectedOutputName,
        preferredSinkId,
        activeSinkId,
        setSinkIdSupported,
      });
      speakerTimerRef.current = window.setTimeout(() => {
        stopSpeakerTest();
        setSpeakerTestMessage(
          selectedOutputName
            ? `Тест завершен: ${selectedOutputName}`
            : "Тест завершен. Если звук не слышен, проверьте громкость и устройство вывода Windows.",
        );
      }, 1100);
    } catch (error) {
      stopSpeakerTest();
      setSpeakerTestMessage(`Ошибка проверки динамика: ${toAudioTestErrorMessage(error)}`);
      logWarn("audio.speakerTest", "Проверка динамика завершилась ошибкой", error);
    }
  }, [
    controlsDisabled,
    defaultSystemAudio?.name,
    selectedSystemAudioDevice?.name,
    systemAudioUsesWindowsDefault,
    stopSpeakerTest,
  ]);

  return (
    <div className="space-y-5">
      <div
        id="audio-devices"
        className={getFocusSectionClass(focusTarget === "audio-devices")}
      >
        <Card
          title="Аудиоустройства"
          description="Здесь выбираются микрофон и устройство вывода, которое приложение слушает как системный звук."
        >
          <div className="grid gap-3 md:grid-cols-2">
            <StatusIndicator
              status={permissions.microphone}
              label="Микрофон"
              description="Запись вашего голоса для локального распознавания."
            />
            <StatusIndicator
              status={permissions.systemAudio}
              label="Системный звук"
              description="Звук собеседника с выбранного устройства вывода."
            />
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <div className="text-xs text-text-muted uppercase tracking-wider">Микрофон</div>
              <Select
                value={microphoneDeviceId}
                onChange={setMicrophoneDeviceId}
                options={microphoneOptions}
                placeholder=""
                disabled={controlsDisabled}
              />
            </div>

            <div className="space-y-1.5">
              <div className="text-xs text-text-muted uppercase tracking-wider">Системный звук</div>
              <Select
                value={systemAudioDeviceId}
                onChange={setSystemAudioDeviceId}
                options={systemAudioOptions}
                placeholder=""
                disabled={controlsDisabled}
              />
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-border bg-bg-secondary p-3 text-xs text-text-muted leading-relaxed">
            Если оставить режим по умолчанию, приложение возьмет текущие устройства Windows.
            Если выбрать конкретные устройства, во время интервью будут использоваться именно они.
          </div>

          <div className="mt-4 rounded-lg border border-border bg-bg-secondary p-3">
            <div className="text-xs text-text-muted uppercase tracking-wider">
              Проверка устройств
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border border-border bg-bg-primary/50 p-3">
                <div className="flex items-center gap-2 text-sm text-text-secondary">
                  <Mic className="h-4 w-4 text-accent" />
                  Микрофон
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg-tertiary">
                  <div
                    className="h-full bg-accent transition-all duration-150"
                    style={{ width: `${Math.round(micLevel * 100)}%` }}
                  />
                </div>
                <div className="mt-1 text-xs text-text-muted">
                  Уровень: {Math.round(micLevel * 100)}%
                </div>
                <div className="mt-1 text-xs text-text-muted">
                  Пик: {Math.round(micPeakLevel * 100)}% · Средний: {Math.round(micAverageLevel * 100)}%
                </div>
                <div className="mt-1 text-xs text-text-muted">
                  Тишина: {Math.round(micSilentDurationMs / 100) / 10} c
                </div>
                {micSilenceHint && (
                  <div className="mt-2 text-xs leading-relaxed text-warning">
                    {micSilenceHint}
                  </div>
                )}
                {micTestMessage && (
                  <div className="mt-2 text-xs leading-relaxed text-text-muted">
                    {micTestMessage}
                  </div>
                )}
                <div className="mt-3">
                  <Button
                    variant={micTestActive ? "ghost" : "secondary"}
                    size="sm"
                    disabled={controlsDisabled}
                    onClick={() => {
                      if (micTestActive) {
                        stopMicTest();
                        setMicTestMessage("Проверка микрофона остановлена.");
                        logInfo("audio.micTest", "Проверка микрофона остановлена вручную");
                        return;
                      }
                      void startMicTest();
                    }}
                  >
                    {micTestActive ? "Остановить проверку" : "Проверить микрофон"}
                  </Button>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-bg-primary/50 p-3">
                <div className="flex items-center gap-2 text-sm text-text-secondary">
                  <Volume2 className="h-4 w-4 text-accent" />
                  Динамик
                </div>
                <div className="mt-2 text-xs leading-relaxed text-text-muted">
                  Нажмите кнопку, и приложение воспроизведет короткий двойной сигнал.
                </div>
                {speakerTestMessage && (
                  <div className="mt-2 text-xs leading-relaxed text-text-muted">
                    {speakerTestMessage}
                  </div>
                )}
                <div className="mt-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={controlsDisabled || speakerTestRunning}
                    onClick={() => {
                      void runSpeakerTest();
                    }}
                  >
                    {speakerTestRunning ? "Тестируем..." : "Проверить динамик"}
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {audioDeviceLoadError && (
            <p className="mt-3 text-xs text-warning leading-relaxed">{audioDeviceLoadError}</p>
          )}
        </Card>
      </div>
    </div>
  );
}

function LanguageSettings({
  disabled,
  focusTarget,
  section,
}: {
  disabled: boolean;
  focusTarget: SettingsFocusTarget | null;
  section: "language" | "speech";
}) {
  const {
    primaryLanguage,
    secondaryLanguage,
    primarySttVariant,
    secondarySttVariant,
    setPrimaryLanguage,
    setSecondaryLanguage,
    setPrimarySttVariant,
    setSecondarySttVariant,
    hotkeys,
  } = useSettingsStore();
  const {
    sttInstall,
    sttInstallQueue,
    setSttInstall,
    clearSttInstall,
    enqueueSttInstallTask,
    shiftSttInstallQueue,
    clearSttInstallQueue,
    readiness,
    setReadiness,
  } = useAppStore();

  const [models, setModels] = useState<VoskModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [runtimeInstalling, setRuntimeInstalling] = useState(false);
  const [runtimeInstallProgress, setRuntimeInstallProgress] = useState<number | null>(null);
  const [runtimeNetworkHint, setRuntimeNetworkHint] = useState<string | null>(null);
  const [activeModelOperation, setActiveModelOperation] = useState<ModelOperation | null>(null);
  const [copiedModelDownloadUrl, setCopiedModelDownloadUrl] = useState<string | null>(null);
  const [cancelingInstall, setОтменаingInstall] = useState(false);
  const [bootstrapInstalling, setBootstrapInstalling] = useState(false);
  const queueWorkerBusyRef = useRef(false);

  const refresh = useCallback(async () => {
    const {
      isTauri,
      listVoskModels,
      listVoskRuntimeVersions,
    } = await import("@/lib/tauri");
    if (!isTauri()) {
      return;
    }

    setLoading(true);
    const [modelsResult, runtimeVersionsResult] = await Promise.allSettled([
      listVoskModels(),
      listVoskRuntimeVersions(),
    ]);

    if (modelsResult.status === "fulfilled") {
      setModels(modelsResult.value);
      setError(null);
    } else {
      setError(
        modelsResult.reason instanceof Error
          ? modelsResult.reason.message
          : "Не удалось загрузить настройки голосового движка.",
      );
    }

    if (runtimeVersionsResult.status === "fulfilled") {
      const latestStableVersion = resolveLatestStableRuntimeVersion(
        runtimeVersionsResult.value as VoskRuntimeVersion[],
      );
      setReadiness({
        voskLatestStableKnown: latestStableVersion !== null,
        voskLatestStableVersion: latestStableVersion,
      });
      setRuntimeNetworkHint(null);
    } else {
      setReadiness({
        voskLatestStableKnown: false,
        voskLatestStableVersion: null,
      });
      const hint = toRuntimeNetworkHint(runtimeVersionsResult.reason);
      setRuntimeNetworkHint(hint || null);
    }

    await refreshLocalReadinessNow().catch(() => null);
    setLoading(false);
  }, [setReadiness]);

  useEffect(() => {
    void refresh();
  }, [refresh]);


  const installLatestRuntime = useCallback(async () => {
    const { isTauri, installVoskRuntime } = await import("@/lib/tauri");
    if (!isTauri()) {
      const detail =
        "Подготовка распознавания доступна только в приложении. Откройте установленную версию, а не вкладку браузера.";
      setError(detail);
      logWarn("speech.install", "Speech module install requested outside desktop app", { detail });
      return false;
    }

    setRuntimeInstalling(true);
    setRuntimeInstallProgress(0);
    setError(null);
    setSuccess(null);
    setRuntimeNetworkHint(null);
    const runtimeProgressTracker = createTransferProgressTracker();
    setSttInstall({
      active: true,
      phase: "runtime",
      percent: 0,
      bytesDownloaded: null,
      contentLength: null,
      speedBytesPerSecond: null,
      etaSeconds: null,
      detail: "Устанавливаем компоненты распознавания...",
      language: null,
      variant: null,
    });

    try {
      await installVoskRuntime(undefined, (progress) => {
        const percent = Math.round(progress.percent);
        const metrics = updateTransferProgressTracker(
          runtimeProgressTracker,
          progress.bytes_downloaded,
          progress.content_length,
        );
        setRuntimeInstallProgress(percent);
        setSttInstall({
          active: true,
          phase: "runtime",
          percent,
          bytesDownloaded: progress.bytes_downloaded,
          contentLength: progress.content_length,
          speedBytesPerSecond: metrics.speedBytesPerSecond,
          etaSeconds: metrics.etaSeconds,
          detail:
            progress.phase === "downloading"
              ? "Скачиваем компоненты распознавания..."
              : "Распаковываем компоненты распознавания...",
          language: null,
          variant: null,
        });
      });
      setSuccess("Компоненты распознавания установлены.");
      await refresh();
      return true;
    } catch (err: unknown) {
      if (isInstallОтменаledError(err)) {
        setSuccess("Подготовка распознавания отменена.");
        setError(null);
        return false;
      }
      const networkHint = toRuntimeNetworkHint(err);
      if (networkHint) {
        setRuntimeNetworkHint(networkHint);
      }
      setError(
        networkHint ||
          (err instanceof Error
            ? err.message
            : "Не удалось установить компоненты распознавания."),
      );
      return false;
    } finally {
      setRuntimeInstalling(false);
      clearSttInstall();
      await refresh();
    }
  }, [clearSttInstall, refresh, setSttInstall]);

  const installModelVariant = useCallback(
    async (
      language: PrimaryLanguage,
      variant: SttModelVariant,
      options: InstallModelOptions = {},
    ) => {
      const { isTauri, downloadVoskModel, listVoskModels } = await import("@/lib/tauri");
      if (!isTauri()) {
        const detail =
          "Установка профиля распознавания доступна только в приложении. Откройте установленную версию, а не вкладку браузера.";
        setError(detail);
        logWarn("speech.install", "Speech profile install requested outside desktop app", {
          language,
          variant,
          detail,
        });
        return false;
      }

      const runtimeMissing = !options.skipRuntimeInstall && !readiness.voskRuntimeLoaded;
      if (runtimeMissing) {
        const runtimeInstalled = await installLatestRuntime();
        if (!runtimeInstalled) {
          return false;
        }
      }

      let model = getModelByVariant(models, language, variant);
      if (!model) {
        try {
          const latestModels = await listVoskModels();
          setModels(latestModels);
          model = getModelByVariant(latestModels, language, variant);
        } catch (err: unknown) {
          setError(
            err instanceof Error ? err.message : "Не удалось обновить список профилей распознавания.",
          );
          return false;
        }
      }
      if (!model) {
        setError(
          `Точный профиль недоступен для языка ${getLanguageLabel(language)}.`,
        );
        return false;
      }

      if (
        hasInstalledModel(model) &&
        !model.update_available &&
        model.installed_versions.length <= 1
      ) {
        return true;
      }

      setActiveModelOperation({ language, variant, action: "install" });
      setError(null);
      setSuccess(null);
      const modelProgressTracker = createTransferProgressTracker();
      setSttInstall({
        active: true,
        phase: "model",
        percent: 0,
        bytesDownloaded: null,
        contentLength: null,
        speedBytesPerSecond: null,
        etaSeconds: null,
        detail: `Устанавливаем ${getVariantDisplayName(variant)} профиль...`,
        language,
        variant,
      });

      try {
        await downloadVoskModel(
          model.download_url,
          model.id,
          (progress: VoskModelDownloadProgress) => {
            let computedPercent = progress.percent;
            if (
              computedPercent <= 0 &&
              progress.content_length === null &&
              progress.bytes_downloaded > 0 &&
              model.size_mb > 0
            ) {
              computedPercent = Math.min(
                99,
                (progress.bytes_downloaded / (model.size_mb * 1024 * 1024)) * 100,
              );
            }
            const percent = Math.round(Math.max(0, Math.min(100, computedPercent)));
            const estimatedContentLength =
              progress.content_length ?? (model.size_mb > 0 ? model.size_mb * 1024 * 1024 : null);
            const metrics = updateTransferProgressTracker(
              modelProgressTracker,
              progress.bytes_downloaded,
              estimatedContentLength,
            );
            setSttInstall({
              active: true,
              phase: "model",
              percent,
              bytesDownloaded: progress.bytes_downloaded,
              contentLength: estimatedContentLength,
              speedBytesPerSecond: metrics.speedBytesPerSecond,
              etaSeconds: metrics.etaSeconds,
              detail:
                progress.phase === "downloading"
                  ? `Скачиваем ${getVariantDisplayName(variant)} профиль...`
                  : `Распаковываем ${getVariantDisplayName(variant)} профиль...`,
              language,
              variant,
            });
          },
          model.installed_versions.filter((id) => id !== model.id),
        );

        setSuccess(
          `Точный профиль установлен для языка ${getLanguageLabel(language)}.`,
        );
        return true;
      } catch (err: unknown) {
        if (isInstallОтменаledError(err)) {
          setSuccess("Установка точного профиля отменена.");
          setError(null);
          return false;
        }
        setError(
          err instanceof Error
            ? err.message
            : `Не удалось установить точный профиль для языка ${getLanguageLabel(language)}.`,
        );
        return false;
      } finally {
        setActiveModelOperation(null);
        clearSttInstall();
        await refresh();
      }
    },
    [
      clearSttInstall,
      installLatestRuntime,
      models,
      readiness.voskRuntimeLoaded,
      refresh,
      setSttInstall,
    ],
  );

  const installModelVariantFromZip = useCallback(
    async (language: PrimaryLanguage, variant: SttModelVariant) => {
      const { isTauri, installVoskModelFromZip, listVoskModels, pickVoskModelZip } =
        await import("@/lib/tauri");
      if (!isTauri()) {
        setError(
          "Установка из ZIP доступна только в приложении. Откройте установленную версию, а не вкладку браузера.",
        );
        return false;
      }

      const runtimeMissing = !readiness.voskRuntimeLoaded;
      if (runtimeMissing) {
        const runtimeInstalled = await installLatestRuntime();
        if (!runtimeInstalled) {
          return false;
        }
      }

      let model = getModelByVariant(models, language, variant);
      if (!model) {
        try {
          const latestModels = await listVoskModels();
          setModels(latestModels);
          model = getModelByVariant(latestModels, language, variant);
        } catch (err: unknown) {
          setError(
            err instanceof Error
              ? err.message
              : "Не удалось обновить список профилей распознавания.",
          );
          return false;
        }
      }
      if (!model) {
        setError(
          `Точный профиль недоступен для языка ${getLanguageLabel(language)}.`,
        );
        return false;
      }

      const archivePath = await pickVoskModelZip();
      if (!archivePath) {
        return false;
      }

      setActiveModelOperation({ language, variant, action: "install" });
      setError(null);
      setSuccess(null);
      const zipProgressTracker = createTransferProgressTracker();
      setSttInstall({
        active: true,
        phase: "model",
        percent: 5,
        bytesDownloaded: null,
        contentLength: model.size_mb > 0 ? model.size_mb * 1024 * 1024 : null,
        speedBytesPerSecond: null,
        etaSeconds: null,
        detail: `Устанавливаем ${getVariantDisplayName(variant)} профиль из ZIP...`,
        language,
        variant,
      });

      try {
        await installVoskModelFromZip(
          archivePath,
          model.id,
          (progress: VoskModelDownloadProgress) => {
            const percent = Math.round(Math.max(0, Math.min(100, progress.percent)));
            const estimatedContentLength =
              progress.content_length ?? (model.size_mb > 0 ? model.size_mb * 1024 * 1024 : null);
            const metrics = updateTransferProgressTracker(
              zipProgressTracker,
              progress.bytes_downloaded,
              estimatedContentLength,
            );
            setSttInstall({
              active: true,
              phase: "model",
              percent,
              bytesDownloaded: progress.bytes_downloaded,
              contentLength: estimatedContentLength,
              speedBytesPerSecond: metrics.speedBytesPerSecond,
              etaSeconds: metrics.etaSeconds,
              detail: `Распаковываем ${getVariantDisplayName(variant)} профиль из выбранного ZIP...`,
              language,
              variant,
            });
          },
          model.installed_versions.filter((id) => id !== model.id),
        );

        setSuccess(
          `Точный профиль установлен из ZIP для языка ${getLanguageLabel(language)}.`,
        );
        return true;
      } catch (err: unknown) {
        if (isInstallОтменаledError(err)) {
          setSuccess("Установка точного профиля отменена.");
          setError(null);
          return false;
        }
        setError(
          err instanceof Error
            ? err.message
            : `Не удалось установить точный профиль из ZIP.`,
        );
        return false;
      } finally {
        setActiveModelOperation(null);
        clearSttInstall();
        await refresh();
      }
    },
    [
      clearSttInstall,
      installLatestRuntime,
      models,
      readiness.voskRuntimeLoaded,
      refresh,
      setSttInstall,
    ],
  );

  const openModelDownloadUrl = useCallback(async (url: string) => {
    setError(null);
    setSuccess(null);
    setCopiedModelDownloadUrl(null);

    try {
      const { isTauri, openExternalUrl } = await import("@/lib/tauri");
      if (isTauri()) {
        await openExternalUrl(url);
      } else {
        const opened = window.open(url, "_blank", "noopener,noreferrer");
        if (!opened) {
          throw new Error(`Браузер заблокировал открытие ссылки: ${url}`);
        }
      }
      setSuccess("Открыли ссылку на ZIP в браузере.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : `Не удалось открыть ссылку: ${url}`);
    }
  }, []);

  const copyModelDownloadUrl = useCallback(async (url: string) => {
    setError(null);
    setSuccess(null);

    try {
      await navigator.clipboard.writeText(url);
      setCopiedModelDownloadUrl(url);
      setSuccess("Ссылка на ZIP скопирована. Ее можно открыть в браузере или менеджере загрузок.");
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Не удалось скопировать ссылку на ZIP.",
      );
    }
  }, []);

  const removeLargeModel = useCallback(
    async (language: PrimaryLanguage) => {
      const { isTauri, removeVoskModel } = await import("@/lib/tauri");
      if (!isTauri()) {
        return;
      }

      const largeModel = getModelByVariant(models, language, "large");
      if (!largeModel || largeModel.installed_versions.length === 0) {
        return;
      }

      setActiveModelOperation({ language, variant: "large", action: "remove" });
      setError(null);
      setSuccess(null);
      try {
        for (const versionId of largeModel.installed_versions) {
          await removeVoskModel(versionId);
        }
        if (language === primaryLanguage) {
          setPrimarySttVariant("large");
        } else if (language === secondaryLanguage) {
          setSecondarySttVariant("large");
        }
        setSuccess(`Точный профиль удален для языка ${getLanguageLabel(language)}.`);
      } catch (err: unknown) {
        setError(
          err instanceof Error
            ? err.message
            : `Не удалось удалить точный профиль для языка ${getLanguageLabel(language)}.`,
        );
      } finally {
        setActiveModelOperation(null);
        await refresh();
      }
    },
    [models, primaryLanguage, refresh, secondaryLanguage, setPrimarySttVariant, setSecondarySttVariant],
  );

  const setPreferredVariantForLanguage = useCallback(
    (language: PrimaryLanguage, variant: SttModelVariant) => {
      if (language === primaryLanguage) {
        setPrimarySttVariant(variant);
        return;
      }
      if (language === secondaryLanguage) {
        setSecondarySttVariant(variant);
      }
    },
    [primaryLanguage, secondaryLanguage, setPrimarySttVariant, setSecondarySttVariant],
  );

  const requestModelInstall = useCallback(
    async (
      language: PrimaryLanguage,
      variant: SttModelVariant,
      options?: { selectAsPreferred?: boolean },
    ): Promise<boolean> => {
      if (options?.selectAsPreferred) {
        setPreferredVariantForLanguage(language, variant);
      }

      const runningSameTask =
        sttInstall.active &&
        sttInstall.phase === "model" &&
        sttInstall.language === language &&
        sttInstall.variant === variant;
      if (runningSameTask) {
        return true;
      }

      const queuedAlready = sttInstallQueue.some(
        (entry) => entry.language === language && entry.variant === variant,
      );
      if (queuedAlready) {
        return true;
      }

      const shouldQueue =
        queueWorkerBusyRef.current ||
        sttInstallQueue.length > 0 ||
        runtimeInstalling ||
        (sttInstall.active && sttInstall.phase === "model");

      if (shouldQueue) {
        enqueueSttInstallTask({ language, variant });
        setSuccess(
          `${variant === "large" ? "Точный" : "Быстрый"} профиль для языка ${getLanguageLabel(language)} добавлен в очередь.`,
        );
        return true;
      }

      return installModelVariant(language, variant);
    },
    [
      enqueueSttInstallTask,
      installModelVariant,
      runtimeInstalling,
      setPreferredVariantForLanguage,
      sttInstall.active,
      sttInstall.language,
      sttInstall.phase,
      sttInstall.variant,
      sttInstallQueue,
    ],
  );

  useEffect(() => {
    if (queueWorkerBusyRef.current) {
      return;
    }
    if (runtimeInstalling || sttInstall.active) {
      return;
    }
    if (sttInstallQueue.length === 0) {
      return;
    }

    const nextTask = sttInstallQueue[0];
    queueWorkerBusyRef.current = true;
    shiftSttInstallQueue();
    void (async () => {
      try {
        await installModelVariant(nextTask.language, nextTask.variant);
      } finally {
        queueWorkerBusyRef.current = false;
      }
    })();
  }, [
    installModelVariant,
    runtimeInstalling,
    shiftSttInstallQueue,
    sttInstall.active,
    sttInstallQueue,
  ]);

  const handleОтменаInstall = useCallback(async () => {
    clearSttInstallQueue();
    if (!sttInstall.active) {
      setSuccess("Очередь установки очищена.");
      return;
    }

    setОтменаingInstall(true);
    setError(null);
    setSuccess(null);
    setSttInstall({
      detail: "Отменяем установку...",
    });

    try {
      const { isTauri, cancelVoskInstall } = await import("@/lib/tauri");
      if (isTauri()) {
        await cancelVoskInstall();
      }
      setSuccess("Запрос на отмену отправлен.");
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Не удалось отменить установку.",
      );
    } finally {
      setОтменаingInstall(false);
    }
  }, [clearSttInstallQueue, sttInstall.active, setSttInstall]);

  const handleVariantChange = useCallback(
    async (
      language: PrimaryLanguage,
      variant: SttModelVariant,
      setVariant: (v: SttModelVariant) => void,
    ) => {
      const model = getModelByVariant(models, language, variant);
      if (!model) {
        setError(
          `Точный профиль недоступен для языка ${getLanguageLabel(language)}.`,
        );
        return;
      }

      if (!hasInstalledModel(model)) {
        const accepted = await requestModelInstall(language, variant);
        if (!accepted) {
          return;
        }
      }

      markManualSttProfileOverride();
      setVariant(variant);
      setSuccess(
        `Профиль для языка ${getLanguageLabel(language)}: ${variant === "large" ? "точный" : "быстрый"}.`,
      );
    },
    [models, requestModelInstall],
  );

  const handleInstallVosk = useCallback(async () => {
    if (bootstrapInstalling || runtimeInstalling || sttInstall.active) {
      return;
    }

    setBootstrapInstalling(true);
    setError(null);
    setSuccess(null);
    setSttInstall({
      active: true,
      phase: readiness.voskRuntimeLoaded ? "model" : "runtime",
      percent: 0,
      bytesDownloaded: null,
      contentLength: null,
      speedBytesPerSecond: null,
      etaSeconds: null,
      detail: readiness.voskRuntimeLoaded
        ? "Проверяем русский пакет распознавания..."
        : "Запускаем установку компонентов распознавания...",
      language: readiness.voskRuntimeLoaded ? primaryLanguage : null,
      variant: readiness.voskRuntimeLoaded ? "large" : null,
    });

    const targetLanguages: PrimaryLanguage[] =
      secondaryLanguage !== "none"
        ? [primaryLanguage, secondaryLanguage]
        : [primaryLanguage];

    try {
      const runtimeInstalledNow = readiness.voskRuntimeLoaded
        ? true
        : await installLatestRuntime();
      if (!runtimeInstalledNow) {
        return;
      }

      for (const language of targetLanguages) {
        const installed = await installModelVariant(language, "large", {
          skipRuntimeInstall: true,
        });
        if (!installed) {
          return;
        }
      }

      await refresh();
      setSuccess("Компоненты распознавания и точный русский профиль установлены.");
    } finally {
      setBootstrapInstalling(false);
      clearSttInstall();
    }
  }, [
    bootstrapInstalling,
    clearSttInstall,
    installLatestRuntime,
    primaryLanguage,
    installModelVariant,
    readiness.voskRuntimeLoaded,
    refresh,
    runtimeInstalling,
    secondaryLanguage,
    setSttInstall,
    sttInstall.active,
  ]);

  const handlePrimaryLanguageChange = useCallback(
    async (value: string) => {
      if (!isPrimaryLanguage(value) || value === primaryLanguage) {
        return;
      }

      setPrimaryLanguage(value);
      if (secondaryLanguage === value) {
        setSecondaryLanguage("none");
      }
      setPrimarySttVariant("large");
      setSuccess(`Точный профиль для языка ${getLanguageLabel(value)} будет установлен автоматически.`);
    },
    [
      primaryLanguage,
      secondaryLanguage,
      setPrimaryLanguage,
      setSecondaryLanguage,
      setPrimarySttVariant,
    ],
  );

  const handleSecondaryLanguageChange = useCallback(
    async (value: string) => {
      if (value === secondaryLanguage) {
        return;
      }

      if (value === "none") {
        setSecondaryLanguage("none");
        return;
      }
      if (!isPrimaryLanguage(value)) {
        return;
      }

      setSecondaryLanguage(value);
      setSecondarySttVariant("large");
      setSuccess(`Точный профиль для языка ${getLanguageLabel(value)} будет установлен автоматически.`);
    },
    [secondaryLanguage, setSecondaryLanguage, setSecondarySttVariant],
  );

  const primaryModel = useMemo(
    () => getModelByVariant(models, primaryLanguage, "large"),
    [models, primaryLanguage],
  );

  const secondaryPrimaryLanguage =
    secondaryLanguage === "none" ? null : secondaryLanguage;
  const secondaryModel = useMemo(() => {
    if (!secondaryPrimaryLanguage) {
      return null;
    }
    return getModelByVariant(models, secondaryPrimaryLanguage, "large");
  }, [models, secondaryPrimaryLanguage]);

  const queuedTaskKeys = useMemo(
    () => new Set(sttInstallQueue.map((task) => `${task.language}:${task.variant}`)),
    [sttInstallQueue],
  );

  const runtimeCurrentVersion = useMemo(() => {
    if (!readiness.voskRuntimeLoaded) {
      return null;
    }
    const fromPath = extractRuntimeVersionFromPath(readiness.voskRuntimePath);
    return fromPath ?? "bundled";
  }, [readiness.voskRuntimeLoaded, readiness.voskRuntimePath]);
  const runtimeLatestVersion = readiness.voskLatestStableKnown
    ? normalizeRuntimeVersion(readiness.voskLatestStableVersion)
    : null;
  const showLatestRuntimeVersion = runtimeLatestVersion !== null;

  const runtimeInstalled = readiness.voskRuntimeLoaded;
  const runtimeNeedsInstall = !runtimeInstalled;
  const selectedPrimaryModel = primaryModel;
  const selectedPrimaryModelInstalled = hasInstalledModel(selectedPrimaryModel);
  const selectedPrimaryModelSizeMb = selectedPrimaryModel?.size_mb ?? null;
  const selectedPrimaryModelLabel = "Large";
  const selectedPrimaryModelMissing =
    runtimeInstalled && selectedPrimaryModel !== null && !selectedPrimaryModelInstalled;
  const runtimeNeedsUpdate =
    runtimeInstalled &&
    runtimeCurrentVersion !== null &&
    runtimeCurrentVersion !== "bundled" &&
    runtimeLatestVersion !== null &&
    compareRuntimeVersions(runtimeCurrentVersion, runtimeLatestVersion) < 0;

  const secondaryModelInstalled = hasInstalledModel(secondaryModel);

  const voskReady = readiness.vosk === "granted";
  const selectedPrimaryModelInstalling =
    sttInstall.active &&
    sttInstall.phase === "model" &&
    sttInstall.language === primaryLanguage &&
    sttInstall.variant === primarySttVariant;
  const selectedPrimaryModelQueued = queuedTaskKeys.has(
    `${primaryLanguage}:${primarySttVariant}`,
  );
  const selectedPrimaryModelStatusVariant =
    selectedPrimaryModelInstalling || selectedPrimaryModelQueued
      ? "warning"
      : selectedPrimaryModelInstalled
        ? "success"
        : selectedPrimaryModel === null
          ? "danger"
          : "muted";
  const selectedPrimaryModelStatusLabel =
    selectedPrimaryModelInstalling
      ? "Устанавливается"
      : selectedPrimaryModelQueued
        ? "В очереди"
        : selectedPrimaryModelInstalled
          ? "Установлена"
          : selectedPrimaryModel === null
            ? "Недоступна"
          : "Нужно установить";
  const activeInstallTransferLabel = formatTransferDiagnostics(
    sttInstall.bytesDownloaded,
    sttInstall.contentLength,
    sttInstall.speedBytesPerSecond,
    sttInstall.etaSeconds,
  );
  const activeInstallTitle =
    sttInstall.phase === "runtime"
      ? "Устанавливаем распознавание"
      : "Скачиваем точный русский профиль";
  const activeInstallHint =
    sttInstall.phase === "model" && sttInstall.variant === "large"
      ? "Источник: e-rd.ru. Точный профиль весит около 1.8 ГБ, поэтому на медленном интернете установка может занять несколько минут."
      : "Источник: e-rd.ru. Если процент пару секунд стоит на 0%, это нормально: соединение и размер архива еще подготавливаются.";
  const voskInstallBusy = bootstrapInstalling || runtimeInstalling || sttInstall.active;
  const voskInstallButtonLabel = voskInstallBusy
    ? "Устанавливаем..."
    : runtimeNeedsInstall
      ? "Установить распознавание"
      : selectedPrimaryModelMissing
        ? `Установить ${selectedPrimaryModelLabel}`
        : "Проверить";
  const voskInstallHint = runtimeNeedsInstall
    ? "Не хватает компонентов распознавания. Точный профиль уже может быть установлен отдельно."
    : selectedPrimaryModelMissing
      ? `Не хватает выбранного профиля ${selectedPrimaryModelLabel}. Без него распознавание не запустится.`
      : "Компоненты на диске есть, но готовность еще не подтверждена. Нажмите, чтобы перепроверить состояние.";
  const voskStatusDetail =
    readiness.vosk === "granted"
      ? "Распознавание готово: микрофон и системный звук можно использовать."
      : "Нужно установить компоненты распознавания и выбранный русский профиль.";
  const currentQualityProfile = useMemo(
    () => resolveSttQualityProfile(primarySttVariant, secondarySttVariant),
    [primarySttVariant, secondarySttVariant],
  );

  const switchHotkeyLabel =
    formatHotkey(
      hotkeys.find((item) => item.action === "switch_stt_language")?.keys ?? [],
    ) ||
    "Не задано";

  const primaryLanguageOptions = APP_LANGUAGE_OPTIONS.map((option) => ({
    value: option.code,
    label: `${option.nativeLabel} (${option.label})`,
  }));

  const secondaryLanguageOptions: { value: SecondaryLanguage; label: string }[] = [
    { value: "none", label: "Без дополнительного языка" },
    ...APP_LANGUAGE_OPTIONS.filter((option) => option.code !== primaryLanguage).map(
      (option) => ({
        value: option.code,
        label: `${option.nativeLabel} (${option.label})`,
      }),
    ),
  ];

  const languageOpsDisabled = disabled || runtimeInstalling;
  const languageSelectorsDisabled = disabled || loading || runtimeInstalling || sttInstall.active;
  const isLanguageSection = section === "language";
  const isSpeechSection = section === "speech";

  const handleQualityProfileChange = useCallback(
    (profileId: "large") => {
      const profile = getSttQualityProfileById(profileId);
      setPrimarySttVariant(profile.primaryVariant);
      setSecondarySttVariant(profile.secondaryVariant);
      markManualSttProfileOverride();

      setSuccess(null);
    },
    [setPrimarySttVariant, setSecondarySttVariant],
  );

  return (
    <div className="space-y-5">
      {isLanguageSection && (
        <>
          <Card
            title="Язык собеседования"
            description="Основной язык распознавания речи."
          >
            <div className="space-y-1.5">
              <div className="text-xs text-text-muted uppercase tracking-wider">Основной язык</div>
              <Select
                value={primaryLanguage}
                onChange={(value) => {
                  void handlePrimaryLanguageChange(value);
                }}
                options={primaryLanguageOptions}
                disabled={languageSelectorsDisabled}
              />
            </div>

            <div className="mt-4 p-3 rounded-lg border border-border bg-bg-secondary text-xs text-text-muted leading-relaxed">
              Собеседование начнется с языка <span className="text-text-primary">{getLanguageLabel(primaryLanguage)}</span>.
              Дополнительные языковые режимы и ручное переключение доступны ниже.
            </div>
          </Card>

          <Card
            title="Дополнительные языки"
            description="Второй язык и ручное переключение во время собеседования."
          >
            <div className="space-y-1.5">
              <div className="text-xs text-text-muted uppercase tracking-wider">Второй язык</div>
              <Select
                value={secondaryLanguage}
                onChange={(value) => {
                  void handleSecondaryLanguageChange(value);
                }}
                options={secondaryLanguageOptions.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                disabled={languageSelectorsDisabled}
              />
            </div>

            <div className="mt-4 p-3 rounded-lg border border-border bg-bg-secondary text-xs text-text-muted leading-relaxed">
              Горячая клавиша переключения языка:{" "}
              <kbd className="mx-1 px-1.5 py-0.5 bg-bg-tertiary border border-border rounded text-[10px] font-mono text-text-primary">
                {switchHotkeyLabel}
              </kbd>
            </div>
          </Card>
        </>
      )}

      {isSpeechSection && (
        <>
          <div
            id="language-runtime"
            className={getFocusSectionClass(focusTarget === "language-runtime")}
          >
            <Card
              title="Распознавание речи"
              description="Локальное распознавание микрофона и системного звука на русском."
            >
              <StatusIndicator
                status={readiness.vosk}
                label="Распознавание"
                description={voskStatusDetail}
              />

              {runtimeNetworkHint && (
                <p className="mt-3 text-xs leading-relaxed text-warning">{runtimeNetworkHint}</p>
              )}

              <div className="mt-4 flex items-center gap-2">
                {runtimeNeedsInstall || runtimeNeedsUpdate ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      void installLatestRuntime();
                    }}
                    disabled={disabled || runtimeInstalling || sttInstall.active}
                    icon={runtimeInstalling ? <Loader2 className="w-4 h-4 animate-spin" /> : undefined}
                  >
                    {runtimeInstalling
                      ? `Устанавливаем${runtimeInstallProgress !== null ? ` ${runtimeInstallProgress}%` : "..."}` 
                      : runtimeNeedsInstall
                        ? "Установить распознавание"
                        : "Обновить до стабильной версии"}
                  </Button>
                ) : (
                  <Badge variant={showLatestRuntimeVersion ? "success" : "muted"}>
                    Компоненты установлены
                  </Badge>
                )}
                {selectedPrimaryModelMissing && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      void requestModelInstall(primaryLanguage, primarySttVariant, {
                        selectAsPreferred: true,
                      });
                    }}
                    disabled={disabled || runtimeInstalling || sttInstall.active}
                  >
                    Установить {selectedPrimaryModelLabel}
                    {selectedPrimaryModelSizeMb !== null ? ` (${selectedPrimaryModelSizeMb} MB)` : ""}
                  </Button>
                )}
              </div>

              {selectedPrimaryModelMissing && (
                <div className="mt-3 rounded-lg border border-warning/30 bg-warning-muted p-3 text-xs leading-relaxed text-warning">
                  Выбранный профиль {selectedPrimaryModelLabel} еще не установлен. Без него распознавание не запустится.
                </div>
              )}

              {runtimeInstalling && (
                <div className="mt-3 space-y-2">
                  <ProgressBar
                    label="Устанавливаем компоненты распознавания..."
                    percent={runtimeInstallProgress}
                  />
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void handleОтменаInstall();
                      }}
                      disabled={cancelingInstall}
                    >
                      {cancelingInstall ? "Отменяем..." : "Отмена"}
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          </div>

          <div
            id="language-models"
            className={getFocusSectionClass(focusTarget === "language-models")}
          >
            <Card
              title="Профиль распознавания"
              description="Русское распознавание работает через точный профиль Large."
              className="mb-4"
            >
              <div className="grid gap-2 sm:grid-cols-2">
                {STT_QUALITY_PROFILES.map((profile) => {
                  const selected = currentQualityProfile?.id === profile.id;
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      onClick={() => {
                        handleQualityProfileChange(profile.id);
                      }}
                      disabled={languageOpsDisabled}
                      className={`rounded-lg border p-3 text-left transition-colors ${
                        selected
                          ? "border-accent bg-accent/8"
                          : "border-border bg-bg-primary/40 hover:border-border-active"
                      } ${languageOpsDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-semibold text-text-primary">{profile.label}</div>
                        <Badge variant={selected ? "success" : "muted"}>
                          {selected ? "Активен" : "Выбрать"}
                        </Badge>
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-text-secondary">
                        Точнее распознает русский голос, но пакет тяжелее и запускается дольше.
                      </p>
                    </button>
                  );
                })}
              </div>
            </Card>

            <Card
              title="Русский пакет"
              description="Для релиза оставляем один точный русский профиль Large."
            >
              {sttInstall.active && (
                <div className="mb-4 rounded-xl border border-accent/30 bg-accent/8 p-4 shadow-[0_0_30px_rgba(87,208,255,0.08)]">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-text-primary">
                        {activeInstallTitle}
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                        {sttInstall.detail || "Подготавливаем распознавание..."}
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
                        {activeInstallHint}
                      </p>
                    </div>
                    <Badge variant="warning">
                      {sttInstall.percent === null
                        ? "..."
                        : `${Math.max(0, Math.min(100, Math.round(sttInstall.percent)))}%`}
                    </Badge>
                  </div>

                  <div className="mt-3">
                    <ProgressBar
                      label={activeInstallTransferLabel ?? "Ожидаем первые данные загрузки..."}
                      percent={sttInstall.percent}
                    />
                  </div>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-muted">
                    <span>
                      {activeInstallTransferLabel
                        ? "Загрузка идет. После скачивания приложение распакует пакет автоматически."
                        : "Кнопку можно не нажимать повторно: установка уже запущена."}
                    </span>
                    {sttInstallQueue.length > 0 && (
                      <span className="text-warning">В очереди: {sttInstallQueue.length}</span>
                    )}
                  </div>

                  <div className="mt-3 flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void handleОтменаInstall();
                      }}
                      disabled={cancelingInstall}
                    >
                      {cancelingInstall ? "Отменяем..." : "Отменить установку"}
                    </Button>
                  </div>
                </div>
              )}

              {!voskReady && !sttInstall.active && (
                <div className="mb-4 p-3 rounded-lg border border-warning/30 bg-warning-muted flex items-center justify-between gap-3">
                  <div className="text-xs text-warning leading-relaxed">
                    <div className="font-semibold">Распознавание еще не полностью готово.</div>
                    <div className="mt-1">{voskInstallHint}</div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => {
                      void handleInstallVosk();
                    }}
                    disabled={disabled || voskInstallBusy}
                    icon={voskInstallBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : undefined}
                  >
                    {voskInstallButtonLabel}
                  </Button>
                </div>
              )}

              <div className="rounded-lg border border-border bg-bg-secondary p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={selectedPrimaryModelStatusVariant}>
                        {selectedPrimaryModelStatusLabel}
                      </Badge>
                      <span className="text-sm font-semibold text-text-primary">
                        {selectedPrimaryModelLabel}
                      </span>
                      {selectedPrimaryModelSizeMb !== null && (
                        <span className="text-xs text-text-muted">
                          {selectedPrimaryModelSizeMb} MB
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-text-muted">
                      Более точное распознавание, пакет тяжелее.
                    </p>
                  </div>

                  {selectedPrimaryModel !== null && !selectedPrimaryModelInstalled && (
                    <Button
                      size="sm"
                      onClick={() => {
                        void requestModelInstall(primaryLanguage, primarySttVariant, {
                          selectAsPreferred: true,
                        });
                      }}
                      disabled={
                        disabled ||
                        runtimeInstalling ||
                        selectedPrimaryModelInstalling ||
                        selectedPrimaryModelQueued
                      }
                    >
                      {selectedPrimaryModelQueued
                        ? "В очереди"
                        : `Установить ${selectedPrimaryModelLabel}${
                            selectedPrimaryModelSizeMb !== null
                              ? ` (${selectedPrimaryModelSizeMb} MB)`
                              : ""
                          }`}
                    </Button>
                  )}
                </div>

                {selectedPrimaryModel !== null && (
                  <div className="mt-3 rounded-lg border border-border/70 bg-bg-primary/35 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          void openModelDownloadUrl(selectedPrimaryModel.download_url);
                        }}
                      >
                        Скачать вручную
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Copy className="h-3.5 w-3.5" />}
                        onClick={() => {
                          void copyModelDownloadUrl(selectedPrimaryModel.download_url);
                        }}
                      >
                        {copiedModelDownloadUrl === selectedPrimaryModel.download_url
                          ? "Ссылка скопирована"
                          : "Скопировать ссылку"}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          void installModelVariantFromZip(primaryLanguage, primarySttVariant);
                        }}
                        disabled={disabled || runtimeInstalling || sttInstall.active}
                      >
                        Установить из файла
                      </Button>
                    </div>
                    <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
                      Если встроенная загрузка идет медленно, скачайте архив браузером или менеджером
                      загрузок, затем выберите этот файл здесь. Распаковывать вручную не нужно.
                    </p>
                    <div className="mt-2 break-all rounded-md border border-border/60 bg-black/20 px-2 py-1.5 text-[10px] leading-relaxed text-text-muted">
                      Файл загрузки: {selectedPrimaryModel.download_url}
                    </div>
                  </div>
                )}

                {selectedPrimaryModel === null && (
                  <p className="mt-3 text-xs leading-relaxed text-warning">
                    Профиль {selectedPrimaryModelLabel} сейчас недоступен для установки.
                  </p>
                )}

                {selectedPrimaryModelInstalling && (
                  <div className="mt-3 space-y-2">
                    <ProgressBar
                      label={sttInstall.detail || `Устанавливаем ${selectedPrimaryModelLabel}...`}
                      percent={sttInstall.percent}
                    />
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          void handleОтменаInstall();
                        }}
                        disabled={cancelingInstall}
                      >
                        {cancelingInstall ? "Отменяем..." : "Отмена"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </Card>
          </div>
        </>
      )}

      {success && <p className="text-xs text-success">{success}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

function ImageSettings({ disabled }: { disabled: boolean }) {
  const { apiKey, imageHandlingMode, setImageHandlingMode } = useSettingsStore();

  const aiLocked = disabled || apiKey.trim().length === 0;

  return (
    <div className="space-y-5">
      {apiKey.trim().length === 0 && (
        <div className="flex items-start gap-2.5 p-3 bg-warning-muted rounded-lg border border-warning/30">
          <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
          <p className="text-xs text-warning leading-relaxed">
            Настройки скриншотов доступны после ввода лицензионного ключа.
          </p>
        </div>
      )}

      <Card
        title="Скриншоты"
        description="Как обрабатывать скриншоты перед отправкой."
      >
        <div
          className={`space-y-3 transition-opacity ${aiLocked ? "opacity-50 pointer-events-none" : "opacity-100"}`}
        >
          <label className={`flex items-center gap-3 p-3 rounded-lg border border-border transition-colors ${aiLocked ? "cursor-not-allowed" : "hover:border-border-active cursor-pointer"}`}>
            <input
              type="radio"
              name="img"
              checked={imageHandlingMode === "ocr_text"}
              onChange={() => setImageHandlingMode("ocr_text")}
              disabled={aiLocked}
              className="accent-accent"
            />
            <div>
              <div className="text-sm font-medium">OCR - только текст</div>
              <div className="text-xs text-text-muted">Локальное извлечение текста перед отправкой.</div>
            </div>
          </label>
          <label className={`flex items-center gap-3 p-3 rounded-lg border border-border transition-colors ${aiLocked ? "cursor-not-allowed" : "hover:border-border-active cursor-pointer"}`}>
            <input
              type="radio"
              name="img"
              checked={imageHandlingMode === "send_image"}
              onChange={() => setImageHandlingMode("send_image")}
              disabled={aiLocked}
              className="accent-accent"
            />
            <div>
              <div className="text-sm font-medium">Отправлять изображение</div>
              <div className="text-xs text-text-muted">Лучше для схем и кода, когда текста недостаточно.</div>
            </div>
          </label>
        </div>
      </Card>
    </div>
  );
}

function PrivacySettings({ disabled }: { disabled: boolean }) {
  const { protectOverlay, setProtectOverlay } = useSettingsStore();

  return (
    <div className="space-y-5">
      <Card
        title="Видимость при шаринге"
        description="Скрывать окно из демонстрации экрана и записи."
      >
        <Toggle
          checked={protectOverlay}
          onChange={setProtectOverlay}
          disabled={disabled}
          label="Скрывать окно при захвате экрана"
          description="Использует системную защиту окна. Перед интервью лучше проверить режим в тестовом звонке."
        />

        <div className="mt-4 space-y-2">
          <div className="text-xs font-medium text-text-muted uppercase tracking-wider">
            Статус платформы
          </div>
          <StatusIndicator
            status="supported"
            label="macOS Видимость при шаринге"
            description="Скрытие окна активно."
          />
        </div>
      </Card>

      <div className="flex items-start gap-2.5 p-3 bg-bg-secondary border border-border rounded-lg">
        <Info className="w-4 h-4 text-text-muted mt-0.5 shrink-0" />
        <p className="text-xs text-text-muted leading-relaxed">
          On macOS 15+ and in browser-based screen sharing (WebRTC), capture
          protection may not work in all scenarios. Verify your setup in a test call before a live interview.
        </p>
      </div>
    </div>
  );
}

function StorageSettings({
  disabled,
  focusTarget,
}: {
  disabled: boolean;
  focusTarget: SettingsFocusTarget | null;
}) {
  const {
    chatMemoryLimitMb,
    setChatMemoryLimitMb,
    historyRetentionDays,
    setHistoryRetentionDays,
  } = useSettingsStore();
  const cleanupHistory = useHistoryStore((s) => s.cleanup);
  const [retentionDraft, setRetentionDraft] = useState<string>(() =>
    historyRetentionDays === null
      ? DEFAULT_HISTORY_RETENTION_DAYS.toString()
      : historyRetentionDays.toString(),
  );
  const keepHistoryForever = historyRetentionDays === null;

  const applyRetentionDraft = useCallback(() => {
    const normalized = normalizeHistoryRetentionDays(retentionDraft);
    if (normalized === null) {
      setRetentionDraft(
        historyRetentionDays === null
          ? DEFAULT_HISTORY_RETENTION_DAYS.toString()
          : historyRetentionDays.toString(),
      );
      return;
    }
    setHistoryRetentionDays(normalized);
    cleanupHistory();
    setRetentionDraft(normalized.toString());
  }, [cleanupHistory, historyRetentionDays, retentionDraft, setHistoryRetentionDays]);

  return (
    <div className="space-y-5">
      <Card
        title="Chat History Buffer"
        description="Controls how much chat history is kept in the overlay during an interview."
      >
        <Slider
          label="Memory Limit"
          value={chatMemoryLimitMb}
          min={1}
          max={256}
          step={1}
          onChange={setChatMemoryLimitMb}
          unit="MB"
          disabled={disabled}
        />
        <p className="text-xs text-text-muted mt-3 leading-relaxed">
          This only affects the visible chat buffer in the overlay. The full
          history page stores interview metrics and optional final report only.
        </p>
      </Card>

      <div
        id="storage-history-retention"
        className={getFocusSectionClass(focusTarget === "storage-history-retention")}
      >
        <Card
          title="History Retention"
          description="Choose how long interview history stays on this device."
        >
          <div className="space-y-4">
            <Toggle
              checked={keepHistoryForever}
              onChange={(nextValue) => {
                if (nextValue) {
                  setHistoryRetentionDays(null);
                  cleanupHistory();
                  return;
                }
                const fallbackDays =
                  normalizeHistoryRetentionDays(retentionDraft) ??
                  DEFAULT_HISTORY_RETENTION_DAYS;
                setHistoryRetentionDays(fallbackDays);
                cleanupHistory();
                setRetentionDraft(fallbackDays.toString());
              }}
              disabled={disabled}
              label="Keep history forever"
              description="Disable auto-deletion and keep interview records indefinitely."
            />

            {!keepHistoryForever && (
              <div className="space-y-2">
                <label htmlFor="history-retention-days" className="text-xs text-text-muted uppercase tracking-wider">
                  Retention Period
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="history-retention-days"
                    type="number"
                    min={1}
                    step={1}
                    value={retentionDraft}
                    onChange={(e) => setRetentionDraft(e.target.value)}
                    onBlur={applyRetentionDraft}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        applyRetentionDraft();
                      }
                    }}
                    disabled={disabled}
                    className="w-32 bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-primary
                    focus:border-accent focus:outline-none transition-colors disabled:opacity-50"
                  />
                  <span className="text-xs text-text-muted">days</span>
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Badge variant="muted">{formatHistoryRetentionLabel(historyRetentionDays)}</Badge>
              <span className="text-xs text-text-muted">
                {historyRetentionDays === null
                  ? "Interview history never expires."
                  : `Sessions older than ${historyRetentionDays} days are automatically deleted.`}
              </span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function HotkeySettings({
  disabled,
  focusTarget,
}: {
  disabled: boolean;
  focusTarget: SettingsFocusTarget | null;
}) {
  const { hotkeys, setHotkey, resetHotkeys } = useSettingsStore();
  const [recording, setRecording] = useState<HotkeyAction | null>(null);
  const [recordingPreview, setRecordingPreview] = useState<string[]>([]);
  const recordingPreviewRef = useRef<string[]>([]);
  const pressedKeysRef = useRef<Set<string>>(new Set());

  function resetRecordingState() {
    pressedKeysRef.current.clear();
    recordingPreviewRef.current = [];
    setRecording(null);
    setRecordingPreview([]);
  }

  function applySimplePreset() {
    resetRecordingState();
    for (const binding of SIMPLE_HOTKEY_PRESET) {
      setHotkey(binding.action, binding.keys);
    }
  }

  function updateRecordingPreview(event: React.KeyboardEvent<HTMLInputElement>): string[] {
    const pressedKeys = pressedKeysRef.current;
    const normalized = normalizeHotkeyToken(event.key);
    if (normalized) {
      pressedKeys.add(normalized);
    }
    if (event.altKey) pressedKeys.add("Alt");
    if (event.ctrlKey) pressedKeys.add("Ctrl");
    if (event.shiftKey) pressedKeys.add("Shift");
    if (event.metaKey) pressedKeys.add("Meta");

    const preview = normalizeHotkeyKeys(Array.from(pressedKeys)).slice(0, HOTKEY_MAX_KEYS);
    recordingPreviewRef.current = preview;
    setRecordingPreview(preview);
    return preview;
  }

  function commitRecording(action: HotkeyAction) {
    const normalized = normalizeHotkeyKeys(recordingPreviewRef.current).slice(0, HOTKEY_MAX_KEYS);
    if (normalized.length > 0) {
      setHotkey(action, normalized);
    }
    resetRecordingState();
  }

  function handleKeyDown(action: HotkeyAction, e: React.KeyboardEvent<HTMLInputElement>) {
    e.preventDefault();
    if (e.key === "Escape") {
      resetRecordingState();
      return;
    }
    updateRecordingPreview(e);
  }

  function handleKeyUp(action: HotkeyAction, e: React.KeyboardEvent<HTMLInputElement>) {
    const key = normalizeHotkeyToken(e.key);
    if (key) {
      pressedKeysRef.current.delete(key);
    }
    if (!e.altKey) pressedKeysRef.current.delete("Alt");
    if (!e.ctrlKey) pressedKeysRef.current.delete("Ctrl");
    if (!e.shiftKey) pressedKeysRef.current.delete("Shift");
    if (!e.metaKey) pressedKeysRef.current.delete("Meta");

    if (pressedKeysRef.current.size === 0 && recordingPreviewRef.current.length > 0) {
      commitRecording(action);
    }
  }

  return (
    <div className="space-y-5">
      <div
        id="hotkeys-bindings"
        className={getFocusSectionClass(focusTarget === "hotkeys-bindings")}
      >
        <Card
          title="Горячие клавиши"
          description="Эти сочетания работают во время интервью. Нажмите на кнопку справа, чтобы назначить свое сочетание."
        >
          <div className="mb-4 rounded-lg border border-border bg-bg-secondary p-3 text-xs leading-relaxed text-text-muted">
            Для простого старта рекомендуем одиночные клавиши{" "}
            <span className="font-medium text-text-secondary">F8, F9, F10 и F11</span>.{" "}
            Они стабильнее работают в Windows, чем системные комбинации вроде{" "}
            <span className="font-medium text-text-secondary">Alt + Space</span>.
          </div>
          <div className="space-y-2">
            {hotkeys.map((hk) => (
              <div
                key={hk.action}
                className="flex items-center justify-between p-3 rounded-lg border border-border"
              >
                <span className="text-sm text-text-secondary">{hk.label}</span>
                {recording === hk.action ? (
                  <input
                    autoFocus
                    readOnly
                    placeholder={`Нажмите до ${HOTKEY_MAX_KEYS} клавиш...`}
                    value={formatHotkey(recordingPreview)}
                    className="px-3 py-1.5 bg-accent/10 border border-accent rounded-md text-xs font-mono text-accent w-52 text-center focus:outline-none"
                    onKeyDown={(e) => handleKeyDown(hk.action, e)}
                    onKeyUp={(e) => handleKeyUp(hk.action, e)}
                    onBlur={resetRecordingState}
                  />
                ) : (
                  <button
                    onClick={() => {
                      if (disabled) {
                        return;
                      }
                      pressedKeysRef.current.clear();
                      recordingPreviewRef.current = [];
                      setRecordingPreview([]);
                      setRecording(hk.action);
                    }}
                    disabled={disabled}
                    className="px-3 py-1.5 bg-bg-tertiary border border-border rounded-md text-xs font-mono text-text-primary
                    hover:border-border-active transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {formatHotkey(hk.keys)}
                  </button>
                )}
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-text-muted">
            Можно использовать до {HOTKEY_MAX_KEYS} клавиш в одном сочетании.
          </p>
          <div className="mt-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={applySimplePreset}
              disabled={disabled}
              className="mr-2"
            >
              Простой набор (F8-F11)
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                resetRecordingState();
                resetHotkeys();
              }}
              disabled={disabled}
              icon={<RotateCcw className="w-3.5 h-3.5" />}
            >
              Сбросить по умолчанию
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

