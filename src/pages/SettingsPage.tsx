import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Key,
  Brain,
  Mic,
  Volume2,
  Languages,
  Copy,
  Loader2,
  RotateCcw,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Slider } from "@/components/ui/Slider";
import { Badge } from "@/components/ui/Badge";
import { StatusIndicator } from "@/components/ui/StatusIndicator";
import { AudioQualityCheck } from "@/components/dashboard/AudioQualityCheck";
import {
  AUDIO_HINT_WINDOW_MAX_SECONDS,
  AUDIO_HINT_WINDOW_MIN_SECONDS,
  useSettingsStore,
} from "@/stores/settings";
import { useAppStore } from "@/stores/app";
import { refreshLocalReadinessNow } from "@/hooks/useReadinessMonitor";
import {
  createTransferProgressTracker,
  formatTransferDiagnostics,
  updateTransferProgressTracker,
} from "@/lib/installProgress";
import { APP_LANGUAGE_OPTIONS, getLanguageLabel } from "@/lib/languages";
import { useT } from "@/lib/i18n";
import {
  logInfo,
  logWarn,
} from "@/lib/diagnostics";
import { formatHotkey } from "@/lib/hotkeys";
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
  DictationSource,
  DictationTrigger,
  PrimaryLanguage,
  SettingsFocusTarget,
  SettingsTab,
  SecondaryLanguage,
  SttModelVariant,
} from "@/lib/types";
import type {
  AudioDeviceInfo,
  VoskModelDownloadProgress,
  VoskModelOption,
  VoskRuntimeVersion,
} from "@/lib/tauri";

const TABS: { id: SettingsTab; label: string; icon: typeof Key }[] = [
  { id: "audio", label: "Аудио", icon: Volume2 },
  { id: "language", label: "Язык", icon: Languages },
  { id: "speech", label: "Распознавание", icon: Brain },
];

const STT_MANUAL_PROFILE_OVERRIDE_KEY = "ai-interview-stt-manual-profile-override-v1";

function markManualSttProfileOverride(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STT_MANUAL_PROFILE_OVERRIDE_KEY, "1");
}


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
  const t = useT();
  const tab: SettingsTab = TABS.some((item) => item.id === settingsTab) ? settingsTab : "audio";
  const activeFocus = settingsFocus;
  const appVersionLabel = __APP_VERSION__?.trim() ? __APP_VERSION__.trim() : t("неизвестно");

  useEffect(() => {
    if (tab !== settingsTab) {
      setSettingsTab(tab);
    }
  }, [setSettingsTab, settingsTab, tab]);

  useEffect(() => {
    if (!settingsFocus) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      clearSettingsFocus();
    }, 2600);

    const element = document.getElementById(settingsFocus);
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [clearSettingsFocus, settingsFocus, tab]);

  const tabBarRef = useRef<HTMLDivElement>(null);
  const [tabIndicator, setTabIndicator] = useState({ left: 0, width: 0, ready: false });

  useEffect(() => {
    const measure = () => {
      const el = tabBarRef.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
      if (el) {
        setTabIndicator({ left: el.offsetLeft, width: el.offsetWidth, ready: true });
      }
    };
    measure();
    const settle = window.setTimeout(measure, 150);
    window.addEventListener("resize", measure);
    return () => {
      window.clearTimeout(settle);
      window.removeEventListener("resize", measure);
    };
  }, [tab]);

  return (
    <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8">
      <div className="mb-6">
        <h1 className="font-display text-[1.9rem] font-bold leading-[1.05] tracking-[-0.03em] text-text-primary">
          {t("Настройки")}
        </h1>
        <p className="mt-1.5 text-sm leading-6 text-text-secondary">
          {t("Основные настройки перед запуском интервью.")}
          {isInterviewActive && (
            <span className="ml-2 text-warning">
              {t("Во время собеседования настройки заблокированы.")}
            </span>
          )}
          <span className="ml-2 font-mono text-xs text-text-muted">v{appVersionLabel}</span>
        </p>
      </div>

      <div ref={tabBarRef} className="relative mb-6 flex w-fit gap-1 rounded-2xl bg-bg-tertiary p-1 ring-1 ring-black/[0.05]">
        <span
          className="pointer-events-none absolute top-1 bottom-1 rounded-xl bg-bg-card ring-[1.5px] ring-accent/35 shadow-[0_1px_2px_rgba(20,22,40,0.08),0_5px_16px_-6px_rgba(59,91,219,0.4)] transition-all duration-300 ease-[cubic-bezier(0.34,1.28,0.6,1)]"
          style={{
            left: tabIndicator.left,
            width: tabIndicator.width,
            opacity: tabIndicator.ready ? 1 : 0,
          }}
        />
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              data-tab={id}
              onClick={() => {
                setSettingsTab(id);
              }}
              className={`relative z-10 flex shrink-0 cursor-pointer items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors duration-200 ${
                active ? "text-accent" : "text-text-muted hover:text-text-secondary"
              }`}
            >
              <Icon className={`h-4 w-4 shrink-0 transition-colors ${active ? "text-accent" : ""}`} />
              {t(label)}
            </button>
          );
        })}
      </div>

      <div>
        {tab === "audio" && (
          <div className="space-y-5">
            <AudioSettings disabled={isInterviewActive} focusTarget={activeFocus} />
            <DictationSettings />
          </div>
        )}
        {tab === "language" && (
          <LanguageSettings
            disabled={isInterviewActive}
            focusTarget={activeFocus}
            section="language"
          />
        )}
        {tab === "speech" && <ServerSpeechSettings />}
      </div>
    </div>
  );
}

/**
 * Behaviour of the dictation button in the interview overlay. Unlike device or
 * model settings these stay editable during an interview: they only change how
 * the button reacts, not the capture pipeline.
 */
function DictationSettings() {
  const { dictationTrigger, dictationSource, setDictationTrigger, setDictationSource } =
    useSettingsStore();
  const t = useT();

  const triggerOptions: Array<{ value: DictationTrigger; title: string; hint: string }> = [
    {
      value: "toggle",
      title: t("Нажатие включает и выключает"),
      hint: t("Клик по микрофону начинает запись, повторный клик её завершает."),
    },
    {
      value: "push",
      title: t("Запись, пока кнопка зажата"),
      hint: t("Микрофон пишет, пока держите кнопку, и останавливается, когда отпустите."),
    },
  ];

  const sourceOptions: Array<{ value: DictationSource; title: string; hint: string }> = [
    {
      value: "mic",
      title: t("Только микрофон"),
      hint: t("В строку ввода попадает то, что говорите вы."),
    },
    {
      value: "system",
      title: t("Только звук компьютера"),
      hint: t("Речь из звонка или видео: удобно, чтобы поймать вопрос собеседника."),
    },
    {
      value: "both",
      title: t("Микрофон и звук компьютера"),
      hint: t("Обе дорожки смешиваются в один текст."),
    },
  ];

  return (
    <Card
      title={t("Диктовка")}
      description={t("Кнопка микрофона в интервью: текст появляется в строке ввода по мере речи.")}
    >
      <div className="space-y-4">
        <div className="space-y-3">
          <div className="text-xs font-medium uppercase tracking-[0.08em] text-text-muted">
            {t("Поведение кнопки")}
          </div>
          {triggerOptions.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:border-border-active"
            >
              <input
                type="radio"
                name="dictation-trigger"
                checked={dictationTrigger === option.value}
                onChange={() => setDictationTrigger(option.value)}
                className="accent-accent"
              />
              <div>
                <div className="text-sm font-medium">{option.title}</div>
                <div className="text-xs text-text-muted">{option.hint}</div>
              </div>
            </label>
          ))}
        </div>

        <div className="space-y-3">
          <div className="text-xs font-medium uppercase tracking-[0.08em] text-text-muted">
            {t("Что слушать")}
          </div>
          {sourceOptions.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:border-border-active"
            >
              <input
                type="radio"
                name="dictation-source"
                checked={dictationSource === option.value}
                onChange={() => setDictationSource(option.value)}
                className="accent-accent"
              />
              <div>
                <div className="text-sm font-medium">{option.title}</div>
                <div className="text-xs text-text-muted">{option.hint}</div>
              </div>
            </label>
          ))}
        </div>
      </div>
    </Card>
  );
}

function ServerSpeechSettings() {
  const t = useT();
  const audioHintWindowSeconds = useSettingsStore((s) => s.audioHintWindowSeconds);
  const setAudioHintWindowSeconds = useSettingsStore((s) => s.setAudioHintWindowSeconds);
  return (
    <div className="space-y-5">
      <Card
        title={t("Аудио-подсказка «последние секунды»")}
        description={t(
          "Кнопка в оверлее отправляет в помощник хвост записи выбранной длины — сколько последних секунд обрезать.",
        )}
      >
        <Slider
          label={t("Окно обрезки")}
          value={audioHintWindowSeconds}
          min={AUDIO_HINT_WINDOW_MIN_SECONDS}
          max={AUDIO_HINT_WINDOW_MAX_SECONDS}
          step={1}
          onChange={setAudioHintWindowSeconds}
          unit={t("сек")}
        />
        <p className="mt-3 text-xs leading-relaxed text-text-muted">
          {t("Действует сразу, менять можно прямо во время интервью.")}
        </p>
      </Card>
      <AudioQualityCheck />
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

function normalizeDeviceNameForLookup(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}0-9\s-]/gu, " ")
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

  const target = normalizeDeviceNameForLookup(preferredName ?? "");
  if (!target) {
    return null;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const candidates = devices.filter((device) => device.kind === kind);
  if (candidates.length === 0) {
    return null;
  }

  const exact = candidates.find(
    (device) => normalizeDeviceNameForLookup(device.label) === target,
  );
  if (exact?.deviceId) {
    return exact.deviceId;
  }

  const partial = candidates.find((device) => {
    const normalizedLabel = normalizeDeviceNameForLookup(device.label);
    return normalizedLabel.includes(target);
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
  if (!track) {
    return true;
  }

  if (!preferredName) {
    return true;
  }

  const settings =
    typeof track.getSettings === "function" ? track.getSettings() : null;
  const normalizedTrackLabel = normalizeDeviceNameForLookup(track.label ?? "");
  const normalizedPreferredName = normalizeDeviceNameForLookup(preferredName);
  if (!normalizedTrackLabel || !normalizedPreferredName) {
    return false;
  }

  const labelMatched =
    normalizedTrackLabel.includes(normalizedPreferredName) ||
    normalizedPreferredName.includes(normalizedTrackLabel);

  if (preferredBrowserDeviceId && settings?.deviceId === preferredBrowserDeviceId) {
    // Browser IDs can map to stale virtual devices after graph changes;
    // require label agreement to avoid silent false-positive selection.
    return labelMatched;
  }

  return labelMatched;
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

function describeAudioPermission(status: string): { dot: string; text: string; chip: string } {
  switch (status) {
    case "granted":
      return { dot: "bg-success", text: "готово", chip: "border-success/30 bg-success-muted text-success" };
    case "denied":
      return { dot: "bg-danger", text: "нет доступа", chip: "border-danger/35 bg-danger-muted text-danger" };
    case "checking":
      return { dot: "bg-text-muted animate-pulse", text: "проверка", chip: "border-border bg-bg-tertiary text-text-muted" };
    default:
      return { dot: "bg-warning", text: "не проверено", chip: "border-warning/35 bg-warning-muted text-warning" };
  }
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
  const t = useT();
  const [audioDevices, setAudioDevices] = useState<AudioDeviceInfo[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [audioDeviceLoadError, setAudioDeviceLoadError] = useState<string | null>(null);
  const [micTestActive, setMicTestActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micPeakLevel, setMicPeakLevel] = useState(0);
  const [micAverageLevel, setMicAverageLevel] = useState(0);
  const [micSilentDurationMs, setMicSilentDurationMs] = useState(0);
  const [micTestMessage, setMicTestMessage] = useState<string | null>(null);
  const [speakerTestRunning, setSpeakerTestRunning] = useState(false);
  const [speakerTestMessage, setSpeakerTestMessage] = useState<string | null>(null);
  const [autoProbeRunning, setAutoProbeRunning] = useState(false);
  const [autoProbeMessage, setAutoProbeMessage] = useState<string | null>(null);
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
          : t("Не удалось загрузить список аудиоустройств."),
      );
    } finally {
      setLoadingDevices(false);
    }
  }, [t]);

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
    return t("Сигнал почти нулевой уже несколько секунд. Проверьте нужный микрофон, mute и уровень входа в Windows.");
  }, [micSilentDurationMs, micTestActive, t]);

  const refreshAudioDebugSnapshot = useCallback(
    async (reason: "auto" | "manual" = "auto") => {
      const { isTauri, getAudioDebugSnapshot } = await import("@/lib/tauri");
      if (!isTauri()) {
        return;
      }

      try {
        const snapshot = await getAudioDebugSnapshot({
          microphoneDeviceId,
          systemAudioDeviceId,
        });
        if (reason === "manual") {
          logInfo("audio.debug", "Снимок аудио-диагностики обновлен", {
            microphone: snapshot.microphone,
            systemAudio: snapshot.system_audio,
            systemAudioStatus: snapshot.system_audio_status,
            notes: snapshot.notes,
          });
        }
      } catch (error) {
        logWarn("audio.debug", "Не удалось собрать аудио-диагностику", error);
      }
    },
    [microphoneDeviceId, systemAudioDeviceId],
  );

  const handleAutoProbeAudio = useCallback(async () => {
    if (controlsDisabled || autoProbeRunning) {
      return;
    }

    setAutoProbeRunning(true);
    setAutoProbeMessage(
      t("Говорите обычную фразу 2-3 секунды. Если нужно проверить системный звук, включите звук встречи или видео."),
    );

    try {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      const { isTauri, probeAudioDevices } = await import("@/lib/tauri");
      if (!isTauri()) {
        throw new Error(t("Автонастройка доступна только в desktop-приложении."));
      }

      const result = await probeAudioDevices({
        microphoneDeviceId,
        systemAudioDeviceId,
        durationSeconds: 2,
        probeAllInputDevices: true,
        probeAllOutputDevices: true,
      });

      const applied: string[] = [];
      const recommendedMic = result.recommended_microphone;
      const recommendedSystem = result.recommended_system_audio;

      if (recommendedMic?.has_signal && recommendedMic.device?.id) {
        setMicrophoneDeviceId(recommendedMic.device.id);
        applied.push(
          t("микрофон: {name} (rms {rms}, peak {peak})", {
            name: recommendedMic.device.name,
            rms: Math.round(recommendedMic.rms),
            peak: recommendedMic.peak_abs,
          }),
        );
      }

      if (recommendedSystem?.has_signal && recommendedSystem.device?.id) {
        setSystemAudioDeviceId(recommendedSystem.device.id);
        applied.push(
          t("системный звук: {name} (rms {rms}, peak {peak})", {
            name: recommendedSystem.device.name,
            rms: Math.round(recommendedSystem.rms),
            peak: recommendedSystem.peak_abs,
          }),
        );
      }

      logInfo("audio.autoProbe", "Native audio auto-probe completed", {
        recommendedMicrophone: recommendedMic,
        recommendedSystemAudio: recommendedSystem,
        notes: result.notes,
      });

      if (applied.length > 0) {
        setAutoProbeMessage(t("Автонастройка применена: {items}.", { items: applied.join("; ") }));
      } else {
        const bestMic = result.microphone_candidates
          .filter((candidate) => candidate.available)
          .sort((left, right) => right.signal_score - left.signal_score)[0];
        setAutoProbeMessage(
          bestMic
            ? t("Голос не найден. Самый сильный микрофон: {name} (rms {rms}, peak {peak}). Проверьте mute или повторите, говоря в нужный микрофон.", {
                name: bestMic.device_name ?? bestMic.device?.name ?? t("неизвестно"),
                rms: Math.round(bestMic.rms),
                peak: bestMic.peak_abs,
              })
            : t("Голос не найден ни на одном микрофоне. Проверьте доступ Windows к микрофону и mute."),
        );
      }

      window.setTimeout(() => {
        void refreshAudioDevices();
        void refreshAudioDebugSnapshot("manual");
      }, 250);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("Не удалось выполнить автонастройку аудио.");
      setAutoProbeMessage(message);
      logWarn("audio.autoProbe", "Native audio auto-probe failed", error);
    } finally {
      setAutoProbeRunning(false);
    }
  }, [autoProbeRunning, controlsDisabled, microphoneDeviceId, refreshAudioDebugSnapshot, refreshAudioDevices, setMicrophoneDeviceId, setSystemAudioDeviceId, systemAudioDeviceId, t]);

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
    setMicPeakLevel(0);
    setMicAverageLevel(0);
    setMicSilentDurationMs(0);
    setMicLevel(0);
    setMicTestMessage(t("Выбрано другое устройство. Запустите проверку микрофона снова."));
  }, [microphoneDeviceId, micTestActive, stopMicTest, t]);

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
    setSpeakerTestMessage(t("Выбрано другое устройство. Запустите проверку динамика снова."));
  }, [speakerTestRunning, stopSpeakerTest, systemAudioDeviceId, t]);

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
    setMicTestMessage(t("Запрашиваем доступ к микрофону..."));

    try {
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== "function"
      ) {
        throw new Error(t("Проверка микрофона недоступна в этой среде"));
      }
      if (!microphoneUsesWindowsDefault && !selectedMicrophoneDevice) {
        throw new Error(t("Выбранный микрофон недоступен"));
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
        throw new Error(t("Проверка аудио недоступна в этой среде"));
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
          ? t("Проверка запущена, но окно приложения использует другое устройство: {device}.", {
              device: track?.label ?? t("неизвестно"),
            })
          : selectedMicrophone
          ? t("Проверка запущена: {device}", { device: selectedMicrophone })
          : t("Проверка запущена. Скажите что-нибудь в микрофон."),
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
      setMicTestMessage(t("Ошибка проверки микрофона: {error}", { error: toAudioTestErrorMessage(error) }));
      logWarn("audio.micTest", "Проверка микрофона завершилась ошибкой", error);
    }
  }, [controlsDisabled, defaultMicrophone?.name, microphoneUsesWindowsDefault, selectedMicrophoneDevice, stopMicTest, t]);

  const runSpeakerTest = useCallback(async () => {
    if (controlsDisabled) {
      return;
    }
    stopSpeakerTest();
    setSpeakerTestRunning(true);
    setSpeakerTestMessage(t("Воспроизводим тестовый звук..."));

    try {
      const AudioContextCtor =
        window.AudioContext ??
        ((window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext ?? null);
      if (!AudioContextCtor) {
        throw new Error(t("Проверка аудио недоступна в этой среде"));
      }
      if (!systemAudioUsesWindowsDefault && !selectedSystemAudioDevice) {
        throw new Error(t("Выбранный динамик недоступен"));
      }

      const selectedOutputName =
        selectedSystemAudioDevice?.name ??
        (systemAudioUsesWindowsDefault ? defaultSystemAudio?.name ?? null : null);
      const preferredSinkId = await findBrowserMediaDeviceIdByName(
        "audiooutput",
        selectedOutputName,
      );
      if (!systemAudioUsesWindowsDefault && !preferredSinkId) {
        throw new Error(t("Выбранный динамик недоступен в окне приложения"));
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
        throw new Error(t("Выбор конкретного динамика недоступен"));
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
            ? t("Тест завершен: {device}", { device: selectedOutputName })
            : t("Тест завершен. Если звук не слышен, проверьте громкость и устройство вывода Windows."),
        );
      }, 1100);
    } catch (error) {
      stopSpeakerTest();
      setSpeakerTestMessage(t("Ошибка проверки динамика: {error}", { error: toAudioTestErrorMessage(error) }));
      logWarn("audio.speakerTest", "Проверка динамика завершилась ошибкой", error);
    }
  }, [controlsDisabled, defaultSystemAudio?.name, selectedSystemAudioDevice, systemAudioUsesWindowsDefault, stopSpeakerTest, t]);

  const micStatus = describeAudioPermission(permissions.microphone);
  const sysStatus = describeAudioPermission(permissions.systemAudio);

  return (
    <div className="space-y-5">
      <div
        id="audio-devices"
        className={getFocusSectionClass(focusTarget === "audio-devices")}
      >
        <Card
          title={t("Аудиоустройства")}
          description={t("Микрофон и устройство вывода, которое приложение слушает как системный звук.")}
        >
          {/* Device selection with inline status */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-wider text-text-muted">{t("Микрофон")}</span>
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${micStatus.chip}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${micStatus.dot}`} />
                  {t(micStatus.text)}
                </span>
              </div>
              <Select
                value={microphoneDeviceId}
                onChange={setMicrophoneDeviceId}
                options={microphoneOptions}
                placeholder=""
                disabled={controlsDisabled}
              />
              <p className="text-[11px] leading-relaxed text-text-muted">{t("Записывает ваш голос.")}</p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-wider text-text-muted">{t("Системный звук")}</span>
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${sysStatus.chip}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${sysStatus.dot}`} />
                  {t(sysStatus.text)}
                </span>
              </div>
              <Select
                value={systemAudioDeviceId}
                onChange={setSystemAudioDeviceId}
                options={systemAudioOptions}
                placeholder=""
                disabled={controlsDisabled}
              />
              <p className="text-[11px] leading-relaxed text-text-muted">{t("Слышит голос собеседника.")}</p>
            </div>
          </div>

          <p className="mt-4 text-xs leading-relaxed text-text-muted">
            {t("По умолчанию берутся текущие устройства Windows. Выберите конкретные — и на интервью будут использоваться именно они.")}
          </p>

          {/* Testing */}
          <div className="mt-5 border-t border-border pt-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">
                {t("Проверка")}
              </h4>
              <Button
                variant="ghost"
                size="sm"
                disabled={controlsDisabled || autoProbeRunning}
                onClick={() => {
                  void handleAutoProbeAudio();
                }}
                title={t("Проверяет реальные устройства, которые используются во время интервью.")}
                icon={
                  autoProbeRunning ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )
                }
              >
                {autoProbeRunning ? t("Проверяем...") : t("Автонастройка")}
              </Button>
            </div>

            {autoProbeMessage && (
              <div className="mb-3 rounded-lg border border-border bg-bg-secondary/60 px-3 py-2 text-xs leading-relaxed text-text-secondary">
                {autoProbeMessage}
              </div>
            )}

            <div className="grid gap-3 md:grid-cols-2">
              {/* Mic test */}
              <div className="rounded-xl border border-border bg-bg-secondary/50 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <Mic className="h-4 w-4 text-accent" />
                  {t("Микрофон")}
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg-tertiary">
                  <div
                    className="h-full rounded-full bg-accent transition-all duration-150"
                    style={{ width: `${Math.round(micLevel * 100)}%` }}
                  />
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-text-muted">
                  <span className="font-medium text-text-secondary">
                    {t("Уровень {percent}%", { percent: Math.round(micLevel * 100) })}
                  </span>
                  <span className="tabular-nums">
                    {t("пик {peak}% · сред {avg}% · тишина {silence}c", {
                      peak: Math.round(micPeakLevel * 100),
                      avg: Math.round(micAverageLevel * 100),
                      silence: Math.round(micSilentDurationMs / 100) / 10,
                    })}
                  </span>
                </div>
                {micSilenceHint && (
                  <div className="mt-2 text-[11px] leading-relaxed text-warning">{micSilenceHint}</div>
                )}
                {micTestMessage && (
                  <div className="mt-2 text-[11px] leading-relaxed text-text-muted">{micTestMessage}</div>
                )}
                <div className="mt-3">
                  <Button
                    variant={micTestActive ? "ghost" : "secondary"}
                    size="sm"
                    disabled={controlsDisabled}
                    onClick={() => {
                      if (micTestActive) {
                        stopMicTest();
                        setMicTestMessage(t("Проверка микрофона остановлена."));
                        logInfo("audio.micTest", "Проверка микрофона остановлена вручную");
                        return;
                      }
                      void startMicTest();
                    }}
                  >
                    {micTestActive ? t("Остановить") : t("Проверить микрофон")}
                  </Button>
                </div>
              </div>

              {/* Speaker test */}
              <div className="rounded-xl border border-border bg-bg-secondary/50 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <Volume2 className="h-4 w-4 text-accent" />
                  {t("Динамик")}
                </div>
                <div className="mt-2 text-[11px] leading-relaxed text-text-muted">
                  {t("Воспроизведёт короткий двойной сигнал на выбранном устройстве.")}
                </div>
                {speakerTestMessage && (
                  <div className="mt-2 text-[11px] leading-relaxed text-text-muted">
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
                    {speakerTestRunning ? t("Тестируем...") : t("Проверить динамик")}
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {audioDeviceLoadError && (
            <p className="mt-3 text-xs leading-relaxed text-warning">{audioDeviceLoadError}</p>
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
    appLanguage,
    primarySttVariant,
    secondarySttVariant,
    setPrimaryLanguage,
    setSecondaryLanguage,
    setAppLanguage,
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
  const t = useT();

  const [models, setModels] = useState<VoskModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [runtimeInstalling, setRuntimeInstalling] = useState(false);
  const [runtimeInstallProgress, setRuntimeInstallProgress] = useState<number | null>(null);
  const [runtimeNetworkHint, setRuntimeNetworkHint] = useState<string | null>(null);
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
          : t("Не удалось загрузить настройки голосового движка."),
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
  }, [setReadiness, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);


  const installLatestRuntime = useCallback(async () => {
    const { isTauri, installVoskRuntime } = await import("@/lib/tauri");
    if (!isTauri()) {
      const detail =
        "Подготовка распознавания доступна только в приложении. Откройте установленную версию, а не вкладку браузера.";
      setError(t(detail));
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
      detail: t("Устанавливаем компоненты распознавания..."),
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
              ? t("Скачиваем компоненты распознавания...")
              : t("Распаковываем компоненты распознавания..."),
          language: null,
          variant: null,
        });
      });
      setSuccess(t("Компоненты распознавания установлены."));
      await refresh();
      return true;
    } catch (err: unknown) {
      if (isInstallОтменаledError(err)) {
        setSuccess(t("Подготовка распознавания отменена."));
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
            : t("Не удалось установить компоненты распознавания.")),
      );
      return false;
    } finally {
      setRuntimeInstalling(false);
      clearSttInstall();
      await refresh();
    }
  }, [clearSttInstall, refresh, setSttInstall, t]);

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
        setError(t(detail));
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
            err instanceof Error ? err.message : t("Не удалось обновить список профилей распознавания."),
          );
          return false;
        }
      }
      if (!model) {
        setError(
          t("Точный профиль недоступен для языка {lang}.", { lang: getLanguageLabel(language) }),
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
        detail: t("Устанавливаем точный профиль..."),
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
                  ? t("Скачиваем точный профиль...")
                  : t("Распаковываем точный профиль..."),
              language,
              variant,
            });
          },
          model.installed_versions.filter((id) => id !== model.id),
        );

        setSuccess(
          t("Точный профиль установлен для языка {lang}.", { lang: getLanguageLabel(language) }),
        );
        return true;
      } catch (err: unknown) {
        if (isInstallОтменаledError(err)) {
          setSuccess(t("Установка точного профиля отменена."));
          setError(null);
          return false;
        }
        setError(
          err instanceof Error
            ? err.message
            : t("Не удалось установить точный профиль для языка {lang}.", { lang: getLanguageLabel(language) }),
        );
        return false;
      } finally {
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
      t,
    ],
  );

  const installModelVariantFromZip = useCallback(
    async (language: PrimaryLanguage, variant: SttModelVariant) => {
      const { isTauri, installVoskModelFromZip, listVoskModels, pickVoskModelZip } =
        await import("@/lib/tauri");
      if (!isTauri()) {
        setError(
          t("Установка из ZIP доступна только в приложении. Откройте установленную версию, а не вкладку браузера."),
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
              : t("Не удалось обновить список профилей распознавания."),
          );
          return false;
        }
      }
      if (!model) {
        setError(
          t("Точный профиль недоступен для языка {lang}.", { lang: getLanguageLabel(language) }),
        );
        return false;
      }

      const archivePath = await pickVoskModelZip();
      if (!archivePath) {
        return false;
      }
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
        detail: t("Устанавливаем точный профиль из ZIP..."),
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
              detail: t("Распаковываем точный профиль из выбранного ZIP..."),
              language,
              variant,
            });
          },
          model.installed_versions.filter((id) => id !== model.id),
        );

        setSuccess(
          t("Точный профиль установлен из ZIP для языка {lang}.", { lang: getLanguageLabel(language) }),
        );
        return true;
      } catch (err: unknown) {
        if (isInstallОтменаledError(err)) {
          setSuccess(t("Установка точного профиля отменена."));
          setError(null);
          return false;
        }
        setError(
          err instanceof Error
            ? err.message
            : t("Не удалось установить точный профиль из ZIP."),
        );
        return false;
      } finally {
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
      t,
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
          throw new Error(t("Браузер заблокировал открытие ссылки: {url}", { url }));
        }
      }
      setSuccess(t("Открыли ссылку на ZIP в браузере."));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("Не удалось открыть ссылку: {url}", { url }));
    }
  }, [t]);

  const copyModelDownloadUrl = useCallback(async (url: string) => {
    setError(null);
    setSuccess(null);

    try {
      await navigator.clipboard.writeText(url);
      setCopiedModelDownloadUrl(url);
      setSuccess(t("Ссылка на ZIP скопирована. Ее можно открыть в браузере или менеджере загрузок."));
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : t("Не удалось скопировать ссылку на ZIP."),
      );
    }
  }, [t]);


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
          t("{quality} профиль для языка {lang} добавлен в очередь.", {
            quality: variant === "large" ? t("Точный") : t("Быстрый"),
            lang: getLanguageLabel(language),
          }),
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
      t,
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
  }, [installModelVariant, runtimeInstalling, shiftSttInstallQueue, sttInstall.active, sttInstallQueue, t]);

  const handleОтменаInstall = useCallback(async () => {
    clearSttInstallQueue();
    if (!sttInstall.active) {
      setSuccess(t("Очередь установки очищена."));
      return;
    }

    setОтменаingInstall(true);
    setError(null);
    setSuccess(null);
    setSttInstall({
      detail: t("Отменяем установку..."),
    });

    try {
      const { isTauri, cancelVoskInstall } = await import("@/lib/tauri");
      if (isTauri()) {
        await cancelVoskInstall();
      }
      setSuccess(t("Запрос на отмену отправлен."));
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : t("Не удалось отменить установку."),
      );
    } finally {
      setОтменаingInstall(false);
    }
  }, [clearSttInstallQueue, sttInstall.active, setSttInstall, t]);


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
        ? t("Проверяем русский пакет распознавания...")
        : t("Запускаем установку компонентов распознавания..."),
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
      setSuccess(t("Компоненты распознавания и точный русский профиль установлены."));
    } finally {
      setBootstrapInstalling(false);
      clearSttInstall();
    }
  }, [bootstrapInstalling, clearSttInstall, installLatestRuntime, primaryLanguage, installModelVariant, readiness.voskRuntimeLoaded, refresh, runtimeInstalling, secondaryLanguage, setSttInstall, sttInstall.active, t]);

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
      setSuccess(t("Точный профиль для языка {lang} будет установлен автоматически.", { lang: getLanguageLabel(value) }));
    },
    [
      primaryLanguage,
      secondaryLanguage,
      setPrimaryLanguage,
      setSecondaryLanguage,
      setPrimarySttVariant,
      t,
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
      setSuccess(t("Точный профиль для языка {lang} будет установлен автоматически.", { lang: getLanguageLabel(value) }));
    },
    [secondaryLanguage, setSecondaryLanguage, setSecondarySttVariant, t],
  );

  const primaryModel = useMemo(
    () => getModelByVariant(models, primaryLanguage, "large"),
    [models, primaryLanguage],
  );

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
      ? t("Устанавливается")
      : selectedPrimaryModelQueued
        ? t("В очереди")
        : selectedPrimaryModelInstalled
          ? t("Установлена")
          : selectedPrimaryModel === null
            ? t("Недоступна")
          : t("Нужно установить");
  const activeInstallTransferLabel = formatTransferDiagnostics(
    sttInstall.bytesDownloaded,
    sttInstall.contentLength,
    sttInstall.speedBytesPerSecond,
    sttInstall.etaSeconds,
  );
  const activeInstallTitle =
    sttInstall.phase === "runtime"
      ? t("Устанавливаем распознавание")
      : t("Скачиваем точный русский профиль");
  const activeInstallHint =
    sttInstall.phase === "model" && sttInstall.variant === "large"
      ? t("Источник: e-rd.ru. Точный профиль весит около 1.8 ГБ, поэтому на медленном интернете установка может занять несколько минут.")
      : t("Источник: e-rd.ru. Если процент пару секунд стоит на 0%, это нормально: соединение и размер архива еще подготавливаются.");
  const voskInstallBusy = bootstrapInstalling || runtimeInstalling || sttInstall.active;
  const voskInstallButtonLabel = voskInstallBusy
    ? t("Устанавливаем...")
    : runtimeNeedsInstall
      ? t("Установить распознавание")
      : selectedPrimaryModelMissing
        ? t("Установить {label}", { label: selectedPrimaryModelLabel })
        : t("Проверить");
  const voskInstallHint = runtimeNeedsInstall
    ? t("Не хватает компонентов распознавания. Точный профиль уже может быть установлен отдельно.")
    : selectedPrimaryModelMissing
      ? t("Не хватает выбранного профиля {label}. Без него распознавание не запустится.", { label: selectedPrimaryModelLabel })
      : t("Компоненты на диске есть, но готовность еще не подтверждена. Нажмите, чтобы перепроверить состояние.");
  const voskStatusDetail =
    readiness.vosk === "granted"
      ? t("Распознавание готово: микрофон и системный звук можно использовать.")
      : t("Нужно установить компоненты распознавания и выбранный русский профиль.");
  const currentQualityProfile = useMemo(
    () => resolveSttQualityProfile(primarySttVariant, secondarySttVariant),
    [primarySttVariant, secondarySttVariant],
  );

  const switchHotkeyLabel =
    formatHotkey(
      hotkeys.find((item) => item.action === "switch_stt_language")?.keys ?? [],
    ) ||
    t("Не задано");

  const primaryLanguageOptions = APP_LANGUAGE_OPTIONS.map((option) => ({
    value: option.code,
    label: `${option.nativeLabel} (${option.label})`,
  }));

  const secondaryLanguageOptions: { value: SecondaryLanguage; label: string }[] = [
    { value: "none", label: t("Без дополнительного языка") },
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
            title={t("Язык приложения")}
            description={t("Язык интерфейса приложения. Язык собеседования настраивается отдельно ниже.")}
          >
            <div className="space-y-1.5">
              <div className="text-xs text-text-muted uppercase tracking-wider">{t("Язык интерфейса")}</div>
              <Select
                value={appLanguage}
                onChange={(value) => setAppLanguage(value === "en" ? "en" : "ru")}
                options={[
                  { value: "ru", label: t("Русский") },
                  { value: "en", label: "English" },
                ]}
              />
            </div>
          </Card>

          <Card
            title={t("Язык собеседования")}
            description={t("Основной язык распознавания речи.")}
          >
            <div className="space-y-1.5">
              <div className="text-xs text-text-muted uppercase tracking-wider">{t("Основной язык")}</div>
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
              {t("Собеседование начнется с языка")} <span className="text-text-primary">{getLanguageLabel(primaryLanguage)}</span>{t(". Дополнительные языковые режимы и ручное переключение доступны ниже.")}
            </div>
          </Card>

          <Card
            title={t("Дополнительные языки")}
            description={t("Второй язык и ручное переключение во время собеседования.")}
          >
            <div className="space-y-1.5">
              <div className="text-xs text-text-muted uppercase tracking-wider">{t("Второй язык")}</div>
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
              {t("Горячая клавиша переключения языка:")}{" "}
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
              title={t("Распознавание речи")}
              description={t("Локальное распознавание микрофона и системного звука на русском.")}
            >
              <StatusIndicator
                status={readiness.vosk}
                label={t("Распознавание")}
                description={voskStatusDetail}
              />

              {runtimeNetworkHint && (
                <p className="mt-3 text-xs leading-relaxed text-warning">{t(runtimeNetworkHint)}</p>
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
                      ? runtimeInstallProgress !== null
                        ? t("Устанавливаем {percent}%", { percent: runtimeInstallProgress })
                        : t("Устанавливаем...")
                      : runtimeNeedsInstall
                        ? t("Установить распознавание")
                        : t("Обновить до стабильной версии")}
                  </Button>
                ) : (
                  <Badge variant={showLatestRuntimeVersion ? "success" : "muted"}>
                    {t("Компоненты установлены")}
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
                    {t("Установить {label}", { label: selectedPrimaryModelLabel })}
                    {selectedPrimaryModelSizeMb !== null ? ` (${selectedPrimaryModelSizeMb} MB)` : ""}
                  </Button>
                )}
              </div>

              {selectedPrimaryModelMissing && (
                <div className="mt-3 rounded-lg border border-warning/30 bg-warning-muted p-3 text-xs leading-relaxed text-warning">
                  {t("Выбранный профиль {label} еще не установлен. Без него распознавание не запустится.", { label: selectedPrimaryModelLabel })}
                </div>
              )}

              {runtimeInstalling && (
                <div className="mt-3 space-y-2">
                  <ProgressBar
                    label={t("Устанавливаем компоненты распознавания...")}
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
                      {cancelingInstall ? t("Отменяем...") : t("Отмена")}
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
              title={t("Профиль распознавания")}
              description={t("Русское распознавание работает через точный профиль Large.")}
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
                          {selected ? t("Активен") : t("Выбрать")}
                        </Badge>
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-text-secondary">
                        {t("Точнее распознает русский голос, но пакет тяжелее и запускается дольше.")}
                      </p>
                    </button>
                  );
                })}
              </div>
            </Card>

            <Card
              title={t("Русский пакет")}
              description={t("Для релиза оставляем один точный русский профиль Large.")}
            >
              {sttInstall.active && (
                <div className="mb-4 rounded-xl border border-accent/30 bg-accent/8 p-4 shadow-[0_0_30px_rgba(0,108,250,0.1)]">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-text-primary">
                        {activeInstallTitle}
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                        {sttInstall.detail || t("Подготавливаем распознавание...")}
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
                      label={activeInstallTransferLabel ?? t("Ожидаем первые данные загрузки...")}
                      percent={sttInstall.percent}
                    />
                  </div>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-muted">
                    <span>
                      {activeInstallTransferLabel
                        ? t("Загрузка идет. После скачивания приложение распакует пакет автоматически.")
                        : t("Кнопку можно не нажимать повторно: установка уже запущена.")}
                    </span>
                    {sttInstallQueue.length > 0 && (
                      <span className="text-warning">{t("В очереди: {count}", { count: sttInstallQueue.length })}</span>
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
                      {cancelingInstall ? t("Отменяем...") : t("Отменить установку")}
                    </Button>
                  </div>
                </div>
              )}

              {!voskReady && !sttInstall.active && (
                <div className="mb-4 p-3 rounded-lg border border-warning/30 bg-warning-muted flex items-center justify-between gap-3">
                  <div className="text-xs text-warning leading-relaxed">
                    <div className="font-semibold">{t("Распознавание еще не полностью готово.")}</div>
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
                      {t("Более точное распознавание, пакет тяжелее.")}
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
                        ? t("В очереди")
                        : `${t("Установить {label}", { label: selectedPrimaryModelLabel })}${
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
                        {t("Скачать вручную")}
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
                          ? t("Ссылка скопирована")
                          : t("Скопировать ссылку")}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          void installModelVariantFromZip(primaryLanguage, primarySttVariant);
                        }}
                        disabled={disabled || runtimeInstalling || sttInstall.active}
                      >
                        {t("Установить из файла")}
                      </Button>
                    </div>
                    <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
                      {t("Если встроенная загрузка идет медленно, скачайте архив браузером или менеджером загрузок, затем выберите этот файл здесь. Распаковывать вручную не нужно.")}
                    </p>
                    <div className="mt-2 break-all rounded-md border border-border/60 bg-black/20 px-2 py-1.5 text-[10px] leading-relaxed text-text-muted">
                      {t("Файл загрузки:")} {selectedPrimaryModel.download_url}
                    </div>
                  </div>
                )}

                {selectedPrimaryModel === null && (
                  <p className="mt-3 text-xs leading-relaxed text-warning">
                    {t("Профиль {label} сейчас недоступен для установки.", { label: selectedPrimaryModelLabel })}
                  </p>
                )}

                {selectedPrimaryModelInstalling && (
                  <div className="mt-3 space-y-2">
                    <ProgressBar
                      label={sttInstall.detail || t("Устанавливаем {label}...", { label: selectedPrimaryModelLabel })}
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
                        {cancelingInstall ? t("Отменяем...") : t("Отмена")}
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
