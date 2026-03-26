import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Key,
  Keyboard,
  Languages,
  Volume2,
  Loader2,
  RotateCcw,
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
import { BASE_URL_PRESET_OPTIONS, resolveLlmEndpointConfig } from "@/lib/llm";
import { useApiKeyValidation } from "@/hooks/useApiKeyValidation";
import { APP_LANGUAGE_OPTIONS, getLanguageLabel } from "@/lib/languages";
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
import type {
  HotkeyAction,
  LlmBaseUrlPreset,
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
  { id: "llm", label: "Ключ", icon: Key },
  { id: "audio", label: "Аудио", icon: Volume2 },
  { id: "language", label: "Язык", icon: Languages },
  { id: "hotkeys", label: "Клавиши", icon: Keyboard },
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

  useEffect(() => {
    setTab(settingsTab);
  }, [settingsTab]);

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
    <div className="p-6 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">Настройки</h1>
        <p className="text-sm text-text-muted mt-1">
          Только основные настройки для обычного пользователя.
          {isInterviewActive && (
            <span className="text-warning ml-2">
              Во время собеседования настройки заблокированы.
            </span>
          )}
        </p>
      </div>

      <div className="flex gap-1 mb-6 p-1 bg-bg-secondary rounded-lg border border-border overflow-x-auto">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => {
              setTab(id);
              setSettingsTab(id);
            }}
            className={`
              flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium whitespace-nowrap
              transition-colors cursor-pointer
              ${tab === id ? "bg-bg-tertiary text-text-primary" : "text-text-muted hover:text-text-secondary"}
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
        {tab === "language" && (
          <LanguageSettings disabled={isInterviewActive} focusTarget={activeFocus} />
        )}
        {tab === "hotkeys" && (
          <HotkeySettings disabled={isInterviewActive} focusTarget={activeFocus} />
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
    baseUrlPreset,
    setBaseUrlPreset,
    customBaseUrl,
    setCustomBaseUrl,
    apiKey,
    setApiKey,
    interviewContext,
    setInterviewContext,
  } = useSettingsStore();

  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const endpoint = useMemo(
    () => resolveLlmEndpointConfig(baseUrlPreset, customBaseUrl),
    [baseUrlPreset, customBaseUrl],
  );
  const { validating, valid, detail } = useApiKeyValidation(
    apiKey,
    baseUrlPreset,
    customBaseUrl,
    disabled,
  );

  const hasApiKey = apiKey.trim().length > 0;
  const hasBaseUrl = endpoint.baseUrl.trim().length > 0;

  return (
    <div className="space-y-5">
      <div id="llm-api-key" className={getFocusSectionClass(focusTarget === "llm-api-key")}>
        <Card
          title="Лицензионный ключ"
          description="Пользовательский сценарий: вводите ключ, а подключение к сервису будет происходить через ваш прокси."
        >
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4 text-sm leading-7 text-text-secondary">
            Пользователь не должен выбирать модель, провайдера или base URL.
            В рабочей схеме приложение отправляет лицензионный ключ на ваш сервер,
            а сервер сам возвращает рабочую конфигурацию.
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

          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowAdvanced((value) => !value)}
            >
              {showAdvanced ? "Скрыть служебные настройки" : "Показать служебные настройки"}
            </Button>
          </div>
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
            . Тогда сервис будет понимать, что речь идет о разработке, и осторожнее интерпретировать спорные STT-слова вроде{" "}
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
            Пока нет лицензионного ключа. Для запуска пользователю нужны только ключ и адрес прокси.
          </p>
        </div>
      )}

      {showAdvanced && (
        <Card
          title="Служебные настройки прокси"
          description="Для MVP здесь оставляем только адрес сервера. Модели и провайдеры скрыты от пользователя."
        >
          <div className="space-y-2">
            <label className="block text-xs text-text-muted">Режим адреса</label>
            <Select
              value={baseUrlPreset}
              onChange={(value) => setBaseUrlPreset(value as LlmBaseUrlPreset)}
              options={BASE_URL_PRESET_OPTIONS}
              disabled={disabled}
            />
          </div>

          <div className="space-y-2 mt-4">
            <label className="block text-xs text-text-muted">Адрес прокси</label>
            <input
              type="text"
              value={baseUrlPreset === "custom" ? customBaseUrl : endpoint.baseUrl}
              onChange={(e) => {
                if (baseUrlPreset === "custom") {
                  setCustomBaseUrl(e.target.value);
                }
              }}
              disabled={disabled || baseUrlPreset !== "custom"}
              placeholder="http://localhost:8080"
              className="w-full bg-bg-input border border-border rounded-lg px-3 py-2.5
              text-sm text-text-primary placeholder:text-text-muted
              focus:border-accent focus:outline-none transition-colors
              disabled:opacity-50"
            />
          </div>

          <div className="mt-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4 text-sm leading-7 text-text-secondary">
            Рабочий сценарий: клиент хранит лицензионный ключ, отправляет его в прокси и получает готовые ответы.
            Выбор моделей, токенов и поведения LLM остается на стороне сервера.
          </div>
        </Card>
      )}
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
  return "Не удалось быстро связаться с сервером релизов Vosk. Проверьте интернет, VPN или прокси и повторите попытку.";
}

function isInstallCancelledError(error: unknown): boolean {
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
  const controlsDisabled = disabled || loadingDevices;

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
            Если оставить режим по умолчанию, helper берет текущие устройства Windows по умолчанию.
            Если выбрать конкретные устройства, во время интервью будут использоваться именно они.
          </div>

          <div className="mt-3 rounded-lg border border-border bg-bg-secondary p-3 text-xs text-text-muted leading-relaxed">
            Сейчас Windows по умолчанию использует:
            <div className="mt-2 text-text-secondary">
              Микрофон: {defaultMicrophone?.name ?? "не найден"}
            </div>
            <div className="mt-1 text-text-secondary">
              Системный звук: {defaultSystemAudio?.name ?? "не найден"}
            </div>
          </div>

          <div className="mt-3 rounded-lg border border-border bg-bg-secondary p-3 text-xs text-text-muted leading-relaxed">
            Виртуальные аудиомикшеры вроде SteelSeries Sonar могут показывать каналы `Chat`, `Gaming` или даже `Microphone`.
            Это нормально: главное выбрать тот канал, на котором реально слышно собеседника.
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
}: {
  disabled: boolean;
  focusTarget: SettingsFocusTarget | null;
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
  const [cancelingInstall, setCancelingInstall] = useState(false);
  const [showAdvancedLanguage, setShowAdvancedLanguage] = useState(false);
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

    setLoading(false);
  }, [setReadiness]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installLatestRuntime = useCallback(async () => {
    const { isTauri, installVoskRuntime } = await import("@/lib/tauri");
    if (!isTauri()) {
      return false;
    }

    setRuntimeInstalling(true);
    setRuntimeInstallProgress(0);
    setError(null);
    setSuccess(null);
    setRuntimeNetworkHint(null);
    setSttInstall({
      active: true,
      phase: "runtime",
      percent: 0,
      detail: "Устанавливаем последнюю стабильную версию Vosk runtime...",
      language: null,
      variant: null,
    });

    try {
      await installVoskRuntime(undefined, (progress) => {
        const percent = Math.round(progress.percent);
        setRuntimeInstallProgress(percent);
        setSttInstall({
          active: true,
          phase: "runtime",
          percent,
          detail:
            progress.phase === "downloading"
              ? "Скачиваем последнюю стабильную версию Vosk runtime..."
              : "Распаковываем последнюю стабильную версию Vosk runtime...",
          language: null,
          variant: null,
        });
      });
      setSuccess("Vosk runtime установлен.");
      return true;
    } catch (err: unknown) {
      if (isInstallCancelledError(err)) {
        setSuccess("Установка Vosk отменена.");
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
            : "Не удалось установить последнюю стабильную версию Vosk runtime."),
      );
      return false;
    } finally {
      setRuntimeInstalling(false);
      clearSttInstall();
      await refresh();
    }
  }, [clearSttInstall, refresh, setSttInstall]);

  const installModelVariant = useCallback(
    async (language: PrimaryLanguage, variant: SttModelVariant) => {
      const { isTauri, downloadVoskModel, listVoskModels } = await import("@/lib/tauri");
      if (!isTauri()) {
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
            err instanceof Error ? err.message : "Не удалось обновить список языковых моделей.",
          );
          return false;
        }
      }
      if (!model) {
        setError(
          `${variant === "large" ? "Большая" : "Быстрая"} модель недоступна для языка ${getLanguageLabel(language)}.`,
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
      setSttInstall({
        active: true,
        phase: "model",
        percent: 0,
        detail: `Устанавливаем ${model.name}...`,
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
            setSttInstall({
              active: true,
              phase: "model",
              percent,
              detail:
                progress.phase === "downloading"
                  ? `Скачиваем ${model.name}...`
                  : `Распаковываем ${model.name}...`,
              language,
              variant,
            });
          },
          model.installed_versions.filter((id) => id !== model.id),
        );

        setSuccess(
          `${variant === "large" ? "Большая" : "Быстрая"} модель установлена для языка ${getLanguageLabel(language)}.`,
        );
        return true;
      } catch (err: unknown) {
        if (isInstallCancelledError(err)) {
          setSuccess(`Установка ${variant === "large" ? "большой" : "быстрой"} модели отменена.`);
          setError(null);
          return false;
        }
        setError(
          err instanceof Error
            ? err.message
            : `Не удалось установить ${variant === "large" ? "большую" : "быструю"} модель для языка ${getLanguageLabel(language)}.`,
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
          setPrimarySttVariant("small");
        } else if (language === secondaryLanguage) {
          setSecondarySttVariant("small");
        }
        setSuccess(`Большая модель удалена для языка ${getLanguageLabel(language)}.`);
      } catch (err: unknown) {
        setError(
          err instanceof Error
            ? err.message
            : `Не удалось удалить большую модель для языка ${getLanguageLabel(language)}.`,
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
          `${variant === "large" ? "Большая" : "Быстрая"} модель для языка ${getLanguageLabel(language)} добавлена в очередь.`,
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

  const handleCancelInstall = useCallback(async () => {
    clearSttInstallQueue();
    if (!sttInstall.active) {
      setSuccess("Очередь установки очищена.");
      return;
    }

    setCancelingInstall(true);
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
        err instanceof Error ? err.message : "Не удалось отменить установку Vosk.",
      );
    } finally {
      setCancelingInstall(false);
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
          `${variant === "large" ? "Большая" : "Быстрая"} модель недоступна для языка ${getLanguageLabel(language)}.`,
        );
        return;
      }

      if (!hasInstalledModel(model)) {
        const accepted = await requestModelInstall(language, variant);
        if (!accepted) {
          return;
        }
      }

      setVariant(variant);
      setSuccess(
        `Предпочтительная модель для языка ${getLanguageLabel(language)}: ${variant === "large" ? "большая" : "быстрая"}.`,
      );
    },
    [models, requestModelInstall],
  );

  const handleInstallVosk = useCallback(async () => {
    const targetLanguages: PrimaryLanguage[] =
      secondaryLanguage !== "none"
        ? [primaryLanguage, secondaryLanguage]
        : [primaryLanguage];

    const runtimeInstalledNow = readiness.voskRuntimeLoaded
      ? true
      : await installLatestRuntime();
    if (!runtimeInstalledNow) {
      return;
    }

    for (const language of targetLanguages) {
      const installed = await installModelVariant(language, "small");
      if (!installed) {
        return;
      }
    }

    setSuccess("Vosk runtime и нужные быстрые модели установлены.");
  }, [
    installLatestRuntime,
    primaryLanguage,
    installModelVariant,
    readiness.voskRuntimeLoaded,
    secondaryLanguage,
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
      setPrimarySttVariant("small");
      setSuccess(`Быстрая модель для языка ${getLanguageLabel(value)} будет установлена автоматически.`);
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
      setSecondarySttVariant("small");
      setSuccess(`Быстрая модель для языка ${getLanguageLabel(value)} будет установлена автоматически.`);
    },
    [secondaryLanguage, setSecondaryLanguage, setSecondarySttVariant],
  );

  const primaryModel = useMemo(
    () => ({
      small: getModelByVariant(models, primaryLanguage, "small"),
      large: getModelByVariant(models, primaryLanguage, "large"),
    }),
    [models, primaryLanguage],
  );

  const secondaryPrimaryLanguage =
    secondaryLanguage === "none" ? null : secondaryLanguage;
  const secondaryModel = useMemo(() => {
    if (!secondaryPrimaryLanguage) {
      return null;
    }
    return {
      small: getModelByVariant(models, secondaryPrimaryLanguage, "small"),
      large: getModelByVariant(models, secondaryPrimaryLanguage, "large"),
    };
  }, [models, secondaryPrimaryLanguage]);

  const globalInstallingModelId = useMemo(() => {
    if (
      !sttInstall.active ||
      sttInstall.phase !== "model" ||
      !sttInstall.language ||
      !sttInstall.variant
    ) {
      return null;
    }
    const installingModel = models.find(
      (model) =>
        model.language === sttInstall.language && model.variant === sttInstall.variant,
    );
    return installingModel?.id ?? null;
  }, [
    models,
    sttInstall.active,
    sttInstall.language,
    sttInstall.phase,
    sttInstall.variant,
  ]);

  const queuedTaskKeys = useMemo(
    () => new Set(sttInstallQueue.map((task) => `${task.language}:${task.variant}`)),
    [sttInstallQueue],
  );

  const queuedSmallLanguages = useMemo(() => {
    if (!sttInstall.active || sttInstall.phase !== "model") {
      return new Set<PrimaryLanguage>();
    }
    const targetLanguages: PrimaryLanguage[] = secondaryPrimaryLanguage
      ? [primaryLanguage, secondaryPrimaryLanguage]
      : [primaryLanguage];
    const unresolved = targetLanguages.filter((language) => {
      const small = getModelByVariant(models, language, "small");
      return small !== null && !hasInstalledModel(small);
    });
    const queued = unresolved.filter((language) => {
      const small = getModelByVariant(models, language, "small");
      return small !== null && small.id !== globalInstallingModelId;
    });
    return new Set<PrimaryLanguage>(queued);
  }, [
    globalInstallingModelId,
    models,
    primaryLanguage,
    secondaryPrimaryLanguage,
    sttInstall.active,
    sttInstall.phase,
  ]);

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
  const runtimeFullyReady = runtimeInstalled && readiness.voskModelLoaded;
  const runtimeNeedsInstall = !runtimeInstalled;
  const primarySmallModelInstalled = hasInstalledModel(primaryModel.small ?? null);
  const defaultModelMissing = runtimeInstalled && !primarySmallModelInstalled;
  const runtimeNeedsUpdate =
    runtimeInstalled &&
    runtimeCurrentVersion !== null &&
    runtimeCurrentVersion !== "bundled" &&
    runtimeLatestVersion !== null &&
    compareRuntimeVersions(runtimeCurrentVersion, runtimeLatestVersion) < 0;

  const secondaryModelInstalled = hasInstalledModel(secondaryModel?.small ?? null);

  const voskReady = readiness.vosk === "granted";

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

  return (
    <div className="space-y-5">
      <Card
        title="Язык собеседования"
        description="Основной язык распознавания речи для обычного пользовательского сценария."
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
          Дополнительные языковые режимы и ручное переключение можно включить ниже в служебных настройках.
        </div>

        <div className="mt-4">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowAdvancedLanguage((value) => !value)}
          >
            {showAdvancedLanguage ? "Скрыть служебные языковые настройки" : "Показать служебные языковые настройки"}
          </Button>
        </div>
      </Card>

      <div
        id="language-runtime"
        className={getFocusSectionClass(focusTarget === "language-runtime")}
      >
        <Card
          title="Голосовой движок"
          description="Локальный Vosk runtime и языковые модели проверяются при запуске приложения и при открытии этой вкладки."
        >
          <StatusIndicator
            status={readiness.vosk}
            label="Статус движка"
            description={readiness.voskDetail}
          />

          <div className="mt-3 space-y-1 text-xs text-text-muted">
            <p>Текущий runtime: {runtimeCurrentVersion ?? "не установлен"}</p>
            {showLatestRuntimeVersion && <p>Последняя стабильная версия: {runtimeLatestVersion}</p>}
            {runtimeNetworkHint && <p className="text-warning">{runtimeNetworkHint}</p>}
          </div>

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
                    ? "Установить Vosk"
                    : "Обновить до стабильной версии"}
              </Button>
            ) : (
              <Badge variant={showLatestRuntimeVersion ? "success" : "muted"}>
                {showLatestRuntimeVersion && runtimeFullyReady
                  ? "Уже обновлен"
                  : "Runtime установлен"}
              </Badge>
            )}
            {defaultModelMissing && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void installModelVariant(primaryLanguage, "small");
                }}
                disabled={disabled || runtimeInstalling || sttInstall.active}
              >
                Установить базовую модель ({getLanguageLabel(primaryLanguage)})
              </Button>
            )}
          </div>

          {defaultModelMissing && (
            <div className="mt-3 rounded-lg border border-warning/30 bg-warning-muted p-3 text-xs leading-relaxed text-warning">
              Runtime уже установлен, но базовая языковая модель для{" "}
              <span className="text-text-primary">{getLanguageLabel(primaryLanguage)}</span>{" "}
              еще не скачана. Без нее распознавание речи не запустится.
            </div>
          )}

          {runtimeInstalling && (
            <div className="mt-3 space-y-2">
              <ProgressBar
                label="Устанавливаем последнюю стабильную версию Vosk runtime..."
                percent={runtimeInstallProgress}
              />
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void handleCancelInstall();
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

      {showAdvancedLanguage && (
        <>
          <Card
            title="Дополнительные языки"
            description="Служебный режим: второй язык и ручное переключение во время собеседования."
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

          <div
            id="language-models"
            className={getFocusSectionClass(focusTarget === "language-models")}
          >
            <Card
              title="Модели распознавания"
              description="Служебный режим: ручная установка и выбор моделей Vosk."
            >
              {!voskReady && !sttInstall.active && (
                <div className="mb-4 p-3 rounded-lg border border-warning/30 bg-warning-muted flex items-center justify-between gap-3">
                  <div className="text-xs text-warning leading-relaxed">
                    Vosk еще не полностью готов. Основные компоненты можно установить автоматически.
                  </div>
                  <Button
                    size="sm"
                    onClick={() => {
                      void handleInstallVosk();
                    }}
                    disabled={disabled || runtimeInstalling || sttInstall.active}
                  >
                    Установить Vosk
                  </Button>
                </div>
              )}

              <div className="space-y-3">
                <LanguageModelRow
                  title="Основной"
                  language={primaryLanguage}
                  smallModel={primaryModel.small}
                  largeModel={primaryModel.large}
                  selectedVariant={primarySttVariant}
                  activeOperation={
                    activeModelOperation?.language === primaryLanguage ? activeModelOperation : null
                  }
                  installProgress={sttInstall.percent}
                  onVariantChange={(variant) => {
                    void handleVariantChange(primaryLanguage, variant, setPrimarySttVariant);
                  }}
                  onInstallModel={(variant) => {
                    void requestModelInstall(primaryLanguage, variant, {
                      selectAsPreferred: true,
                    });
                  }}
                  onRemoveLarge={() => {
                    void removeLargeModel(primaryLanguage);
                  }}
                  installPhase={sttInstall.phase}
                  installActive={sttInstall.active}
                  globalInstallingModelId={globalInstallingModelId}
                  smallQueued={
                    queuedSmallLanguages.has(primaryLanguage) ||
                    queuedTaskKeys.has(`${primaryLanguage}:small`)
                  }
                  largeQueued={queuedTaskKeys.has(`${primaryLanguage}:large`)}
                  onCancelInstall={() => {
                    void handleCancelInstall();
                  }}
                  disabled={languageOpsDisabled}
                />

                {secondaryPrimaryLanguage ? (
                  <LanguageModelRow
                    title="Второй"
                    language={secondaryPrimaryLanguage}
                    smallModel={secondaryModel?.small ?? null}
                    largeModel={secondaryModel?.large ?? null}
                    selectedVariant={secondarySttVariant}
                    activeOperation={
                      activeModelOperation?.language === secondaryPrimaryLanguage
                        ? activeModelOperation
                        : null
                    }
                    installProgress={sttInstall.percent}
                    onVariantChange={(variant) => {
                      void handleVariantChange(
                        secondaryPrimaryLanguage,
                        variant,
                        setSecondarySttVariant,
                      );
                    }}
                    onInstallModel={(variant) => {
                      void requestModelInstall(secondaryPrimaryLanguage, variant, {
                        selectAsPreferred: true,
                      });
                    }}
                    onRemoveLarge={() => {
                      void removeLargeModel(secondaryPrimaryLanguage);
                    }}
                    installPhase={sttInstall.phase}
                    installActive={sttInstall.active}
                    globalInstallingModelId={globalInstallingModelId}
                    smallQueued={
                      queuedSmallLanguages.has(secondaryPrimaryLanguage) ||
                      queuedTaskKeys.has(`${secondaryPrimaryLanguage}:small`)
                    }
                    largeQueued={queuedTaskKeys.has(`${secondaryPrimaryLanguage}:large`)}
                    onCancelInstall={() => {
                      void handleCancelInstall();
                    }}
                    disabled={languageOpsDisabled}
                  />
                ) : (
                  <div className="rounded-lg border border-border bg-bg-secondary p-3 text-xs text-text-muted">
                    Второй язык отключен.
                  </div>
                )}
              </div>

              <div className="mt-4 text-xs text-text-muted">
                Активный язык при запуске: <span className="text-text-primary">{getLanguageLabel(primaryLanguage)}</span>
                {secondaryPrimaryLanguage && secondaryModelInstalled && (
                  <span>
                    {" "}• доступно переключение на {getLanguageLabel(secondaryPrimaryLanguage)}
                  </span>
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

function LanguageModelRow({
  title,
  language,
  smallModel,
  largeModel,
  selectedVariant,
  activeOperation,
  installProgress,
  onVariantChange,
  onInstallModel,
  onRemoveLarge,
  installPhase,
  installActive,
  globalInstallingModelId,
  smallQueued,
  largeQueued,
  onCancelInstall,
  disabled,
}: {
  title: string;
  language: PrimaryLanguage;
  smallModel: VoskModelOption | null;
  largeModel: VoskModelOption | null;
  selectedVariant: SttModelVariant;
  activeOperation: ModelOperation | null;
  installProgress: number | null;
  onVariantChange: (variant: SttModelVariant) => void;
  onInstallModel: (variant: SttModelVariant) => void;
  onRemoveLarge: () => void;
  installPhase: string;
  installActive: boolean;
  globalInstallingModelId: string | null;
  smallQueued: boolean;
  largeQueued: boolean;
  onCancelInstall: () => void;
  disabled: boolean;
}) {
  const smallAvailable = smallModel !== null;
  const largeAvailable = largeModel !== null;
  const smallInstalled = hasInstalledModel(smallModel);
  const largeInstalled = hasInstalledModel(largeModel);
  const smallSizeMb = smallModel?.size_mb ?? null;
  const largeSizeMb = largeModel?.size_mb ?? null;
  const isGlobalInstallForModel = (model: VoskModelOption | null) =>
    installActive &&
    installPhase === "model" &&
    model !== null &&
    model.id === globalInstallingModelId;

  const smallInstalling =
    (activeOperation?.variant === "small" && activeOperation?.action === "install") ||
    isGlobalInstallForModel(smallModel);
  const largeInstalling =
    (activeOperation?.variant === "large" && activeOperation?.action === "install") ||
    isGlobalInstallForModel(largeModel);
  const largeRemoving =
    activeOperation?.variant === "large" && activeOperation?.action === "remove";
  const smallStatusVariant = smallInstalling
    ? "warning"
    : smallQueued
      ? "warning"
      : !smallAvailable
      ? "danger"
      : smallInstalled
        ? smallModel?.update_available
          ? "warning"
          : "success"
        : "muted";
  const largeStatusVariant = largeRemoving
    ? "warning"
    : largeInstalling
      ? "warning"
      : largeQueued
        ? "warning"
      : !largeAvailable
        ? "danger"
        : largeInstalled
          ? largeModel?.update_available
            ? "warning"
            : "success"
          : "muted";
  const smallStatusLabel = smallInstalling
    ? "Installing"
    : smallQueued
      ? "Queued"
      : !smallAvailable
      ? "Not available"
      : smallInstalled
        ? smallModel?.update_available
          ? "Installed (update)"
          : "Installed"
        : "Not installed";
  const largeStatusLabel = largeRemoving
    ? "Removing"
    : largeInstalling
      ? "Installing"
      : largeQueued
        ? "Queued"
      : !largeAvailable
        ? "Not available"
        : largeInstalled
          ? largeModel?.update_available
            ? "Installed (update)"
            : "Installed"
          : "Not installed";
  const canSelectSmall = !disabled && !smallInstalling && !largeRemoving && smallAvailable;
  const canSelectLarge = !disabled && !largeInstalling && !largeRemoving && largeAvailable;

  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-3">
      <div className="flex items-center gap-2 mb-2">
        <Badge variant="muted">{title}</Badge>
        <span className="text-sm font-medium text-text-primary">{getLanguageLabel(language)}</span>
      </div>

      <p className="text-xs text-text-muted mb-3">
        Preferred model for this language:
      </p>

      <div className="space-y-3">
        <div
          className={`rounded-lg border p-3 transition-colors ${
            selectedVariant === "small"
              ? "border-accent bg-accent/5"
              : "border-border bg-bg-primary/40"
          } ${
            canSelectSmall ? "cursor-pointer hover:border-border-active" : "cursor-not-allowed"
          }`}
          onClick={() => {
            if (canSelectSmall) {
              onVariantChange("small");
            }
          }}
        >
          <div className="flex items-start gap-3">
            <input
              type="radio"
              name={`model-${title}-${language}`}
              checked={selectedVariant === "small"}
              onChange={() => onVariantChange("small")}
              disabled={!canSelectSmall}
              onClick={(event) => {
                event.stopPropagation();
              }}
              className="mt-0.5 accent-accent"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <Badge variant={smallStatusVariant}>{smallStatusLabel}</Badge>
                  <span className="text-sm font-medium text-text-primary">Small</span>
                </div>
                {smallSizeMb !== null && (
                  <span className="text-xs text-text-muted">{smallSizeMb} MB</span>
                )}
              </div>
              <p className="mt-1 text-xs text-text-muted">
                Faster startup and lower RAM usage.
              </p>
              {smallAvailable && !smallInstalled && !smallInstalling && (
                <div className="mt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      onInstallModel("small");
                    }}
                    disabled={disabled || largeRemoving}
                  >
                    Install{smallSizeMb !== null ? ` (${smallSizeMb} MB)` : ""}
                  </Button>
                </div>
              )}
              {smallQueued && !smallInstalling && (
                <p className="mt-2 text-xs text-warning">Queued for installation...</p>
              )}
              {smallInstalling && (
                <div className="mt-3 space-y-2">
                  <ProgressBar label="Installing small model..." percent={installProgress} />
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCancelInstall();
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div
          className={`rounded-lg border p-3 transition-colors ${
            selectedVariant === "large"
              ? "border-accent bg-accent/5"
              : "border-border bg-bg-primary/40"
          } ${
            canSelectLarge ? "cursor-pointer hover:border-border-active" : "cursor-not-allowed"
          }`}
          onClick={() => {
            if (canSelectLarge) {
              onVariantChange("large");
            }
          }}
        >
          <div className="flex items-start gap-3">
            <input
              type="radio"
              name={`model-${title}-${language}`}
              checked={selectedVariant === "large"}
              onChange={() => onVariantChange("large")}
              disabled={!canSelectLarge}
              onClick={(event) => {
                event.stopPropagation();
              }}
              className="mt-0.5 accent-accent"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <Badge variant={largeStatusVariant}>{largeStatusLabel}</Badge>
                  <span className="text-sm font-medium text-text-primary">Large</span>
                </div>
                {largeSizeMb !== null && (
                  <span className="text-xs text-text-muted">{largeSizeMb} MB</span>
                )}
              </div>
              <p className="mt-1 text-xs text-text-muted leading-relaxed">
                Higher recognition accuracy, but heavier on disk, RAM, and CPU.
                {largeSizeMb !== null ? ` Estimated disk usage: ${largeSizeMb} MB.` : ""}
              </p>
              {largeAvailable && !largeInstalled && !largeInstalling && !largeQueued && (
                <div className="mt-2">
                  <Button
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      onInstallModel("large");
                    }}
                    disabled={disabled || largeRemoving}
                  >
                    Install{largeSizeMb !== null ? ` (${largeSizeMb} MB)` : ""}
                  </Button>
                </div>
              )}
              {largeQueued && !largeInstalling && (
                <p className="mt-2 text-xs text-warning">Queued for installation...</p>
              )}
              {largeInstalled && !largeRemoving && (
                <div className="mt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemoveLarge();
                    }}
                    disabled={disabled || largeInstalling}
                  >
                    Remove Large{largeSizeMb !== null ? ` (${largeSizeMb} MB)` : ""}
                  </Button>
                </div>
              )}
              {(largeInstalling || largeRemoving) && (
                <div className="mt-3 space-y-2">
                  <ProgressBar
                    label={largeRemoving ? "Removing large model..." : "Installing large model..."}
                    percent={largeRemoving ? null : installProgress}
                  />
                  {largeInstalling && (
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          onCancelInstall();
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
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
            Images settings are locked until API key is configured.
          </p>
        </div>
      )}

      <Card
        title="Screenshot Handling"
        description="How screenshots are processed before sending to the LLM."
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
              <div className="text-sm font-medium">OCR → text only</div>
              <div className="text-xs text-text-muted">Private, low cost. Text extracted locally.</div>
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
              <div className="text-sm font-medium">Send full image</div>
              <div className="text-xs text-text-muted">Better for diagrams/code. Requires multimodal model.</div>
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
        title="Capture Protection"
        description="Hide the overlay from screen sharing and recording software."
      >
        <Toggle
          checked={protectOverlay}
          onChange={setProtectOverlay}
          disabled={disabled}
          label="Protect overlay from screen capture"
          description="Uses OS-level window protection. Best-effort: some browsers and recorders may still capture the window."
        />

        <div className="mt-4 space-y-2">
          <div className="text-xs font-medium text-text-muted uppercase tracking-wider">
            Platform Status
          </div>
          <StatusIndicator
            status="supported"
            label="macOS Capture Protection"
            description="Window sharing type exclusion is active."
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
            Для Windows лучше использовать сочетания с <span className="font-medium text-text-secondary">Ctrl</span> или{" "}
            <span className="font-medium text-text-secondary">Shift</span>. Системные комбинации вроде{" "}
            <span className="font-medium text-text-secondary">Alt + Space</span> могут перехватываться браузером или самой Windows.
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

