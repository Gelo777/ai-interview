import { useState, useEffect, useRef, useCallback } from "react";
import {
  Send,
  Scissors,
  Square,
  Mic,
  Volume2,
  Languages,
  Clock,
  ChevronDown,
  Bot,
  Loader2,
  Copy,
  Maximize2,
  Minimize2,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useAppStore } from "@/stores/app";
import { useHistoryStore } from "@/stores/history";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import {
  HARDCODED_PROXY_BASE_URL,
  formatProxyHintResponse,
  requestProxyHint,
  submitAiFeedback,
  type AiFeedbackRating,
} from "@/lib/proxy";
import { getLanguageLabel } from "@/lib/languages";
import { logError, logInfo, logWarn } from "@/lib/diagnostics";
import {
  getSttWarmupSnapshot,
  type SttWarmupSnapshot,
} from "@/lib/sttWarmup";
import {
  formatHotkey,
  normalizeHotkeyKeys,
  normalizeHotkeyToken,
} from "@/lib/hotkeys";
import type {
  ChatMessage,
  LlmResponse,
  PrimaryLanguage,
  SessionRecord,
} from "@/lib/types";
import type {
  AudioDeviceInfo,
  SttDiagnosticEvent,
  SttResultEvent,
  VoskModelOption,
} from "@/lib/tauri";

type PersistStoreLike = {
  persist?: {
    hasHydrated?: () => boolean;
    onFinishHydration?: (callback: () => void) => () => void;
  };
};

const VOSK_MODEL_LOOKUP_TIMEOUT_MS = 6000;
const STT_STARTUP_TIMEOUT_MS = 240000;
const STT_START_REQUEST_TIMEOUT_MS = 240000;
const STT_STOP_TIMEOUT_MS = 12000;
const STT_STOP_SETTLE_TIMEOUT_MS = 90000;
const STT_STOP_POLL_INTERVAL_MS = 250;
const END_INTERVIEW_STT_STOP_BUDGET_MS = 5000;
const LARGE_MODEL_WARMUP_TIMEOUT_MS = 240000;
const LARGE_MODEL_WARMUP_ESTIMATE_MS = 150000;
const LIVE_MODEL_LOADING_ESTIMATE_MS = 180000;
const STT_NO_SIGNAL_TIMEOUT_MS = 6000;
const STT_NO_TRANSCRIPT_HINT_TIMEOUT_MS = 18000;
const STT_AUTO_RECOVERY_COOLDOWN_MS = 30000;
const SCREENSHOT_PICKER_TIMEOUT_MS = 12000;
const SCREENSHOT_STREAM_READY_TIMEOUT_MS = 4000;
const STT_AUTOSTART_ENABLED = true;
const STT_STRICT_AUDIO_MODE = true;

type InterviewOverlayMode = "embedded" | "detached";

type InterviewOverlayProps = {
  mode?: InterviewOverlayMode;
};

type InterviewIntentMode = "LIVE_CODING" | "DEBUG" | "CODE_REVIEW" | "THEORY" | "AUTO";

type InterviewIntent = {
  mode: InterviewIntentMode;
  reason: string;
};

type LastHintMeta = {
  hintId: string | null;
  taskType: string | null;
  question: string;
  hadScreenshot: boolean;
  intent: InterviewIntent;
};

type FeedbackUiState = {
  sending: AiFeedbackRating | null;
  sentRating: AiFeedbackRating | null;
  отзываId: string | null;
  error: string | null;
};

type ResolvedSttStartSelection = {
  microphoneDeviceId?: string;
  systemAudioDeviceId?: string;
  microphoneLabel: string;
  systemAudioLabel: string;
  usedWindowsDefaultMic: boolean;
  usedWindowsDefaultSystem: boolean;
};

type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type SttWarmupUiState = {
  progressPercent: number;
  title: string;
  hint: string;
};

const INTERVIEW_INTENT_OPTIONS: Array<{
  mode: InterviewIntentMode;
  label: string;
  shortLabel: string;
  hint: string;
}> = [
  {
    mode: "AUTO",
    label: "Авто",
    shortLabel: "Авто",
    hint: "Режим выберется автоматически по тексту и скриншоту.",
  },
  {
    mode: "LIVE_CODING",
    label: "Дописать код",
    shortLabel: "Код",
    hint: "Писать решение или недостающий фрагмент, а не ревьюить.",
  },
  {
    mode: "DEBUG",
    label: "Дебаг",
    shortLabel: "Дебаг",
    hint: "Найти причину ошибки, stack trace или падающего теста.",
  },
  {
    mode: "CODE_REVIEW",
    label: "Ревью",
    shortLabel: "Ревью",
    hint: "Найти баги, риски и минимальный патч.",
  },
  {
    mode: "THEORY",
    label: "Теория",
    shortLabel: "Теория",
    hint: "Дать короткое объяснение для устного ответа.",
  },
];

function isKnownSubtitleCreditNoise(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("редактор субтитр") ||
    (lower.includes("субтитр") && lower.includes("корректор")) ||
    (lower.includes("subtitles") && lower.includes("editor"))
  );
}

function buildWarmupUiState(snapshot: SttWarmupSnapshot): SttWarmupUiState | null {
  if (snapshot.state === "idle") {
    return null;
  }

  if (snapshot.state === "ready") {
    return {
      progressPercent: 100,
      title: "Точный профиль готов",
      hint: "Переходим к запуску захвата микрофона и системного звука.",
    };
  }

  if (snapshot.state === "failed") {
    return {
      progressPercent: 100,
      title: "Не удалось подготовить точный профиль",
      hint:
        snapshot.errorMessage ??
        "Подготовка завершилась ошибкой. Можно повторить запуск или переустановить точный профиль в настройках.",
    };
  }

  const elapsedMs = snapshot.startedAt ? Math.max(0, Date.now() - snapshot.startedAt) : 0;
  const progressRatio = Math.min(elapsedMs / LARGE_MODEL_WARMUP_ESTIMATE_MS, 1);
  const easedProgress = 10 + Math.round(Math.pow(progressRatio, 0.82) * 82);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  return {
    progressPercent: Math.min(easedProgress, 92),
    title: "Подготавливаем точный профиль",
    hint: `Первый запуск обычно занимает 1-3 минуты. Прошло: ${elapsedSeconds} с.`,
  };
}

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

function toErrorDetail(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Неизвестная ошибка запуска распознавания речи";
}

function isSttStopInProgressDetail(detail: string): boolean {
  return (
    detail.includes("previous stt session is still stopping") ||
    detail.includes("previous stop is still") ||
    detail.includes("still stopping after") ||
    detail.includes("stt stop is still in progress") ||
    detail.includes("timed out while stopping stt session") ||
    detail.includes("предыдущая stt-сессия") ||
    detail.includes("еще завершается") ||
    detail.includes("еще выполняется") ||
    (detail.includes("остановка распознавания") &&
      (detail.includes("выполняется") ||
        detail.includes("завершается") ||
        detail.includes("не завершилась")))
  );
}

function isSttAlreadyStoppedDetail(detail: string): boolean {
  return (
    detail.includes("there is no active session") ||
    detail.includes("session is not running") ||
    detail.includes("already stopped")
  );
}

function isVoskModelStartupDetail(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("vosk failed to load model") ||
    normalized.includes("vosk model is not installed") ||
    (normalized.includes("языков") && normalized.includes("модель") && normalized.includes("vosk"))
  );
}

function isVoskRuntimeStartupDetail(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    (normalized.includes("failed to load") &&
      normalized.includes("vosk") &&
      normalized.includes("runtime")) ||
    (normalized.includes("vosk") && normalized.includes("runtime")) ||
    normalized.includes("libvosk")
  );
}

function isSttStartupTimeoutDetail(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("stt startup timed out") ||
    normalized.includes("timed out while waiting for stt manager startup") ||
    normalized.includes("timed out while starting recognition worker") ||
    normalized.includes("запуск распознавания занял слишком много времени") ||
    normalized.includes("загрузка точного профиля распознавания заняла слишком много времени")
  );
}

function strictStartupActionHint(detail: string): string {
  if (isVoskModelStartupDetail(detail)) {
    return "Откройте Настройки -> Распознавание и переустановите точный русский профиль. Если пакет уже отмечен как установленный, установите его заново из ZIP или через загрузку.";
  }

  if (isVoskRuntimeStartupDetail(detail)) {
    return "Откройте Настройки -> Распознавание и установите голосовой модуль, затем перезапустите аудио.";
  }

  if (isSttStartupTimeoutDetail(detail)) {
    return "Точный профиль Large еще загружается. Подождите окончания первого запуска или перезапустите приложение и не нажимайте перезапуск аудио во время загрузки.";
  }

  return "Исправьте выбранные микрофон и системный звук в настройках.";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function toFriendlySttStartupError(error: unknown): string {
  const detail = toErrorDetail(error);
  const normalized = detail.toLowerCase();

  if (normalized.includes("microphone input device is not available")) {
    return "Микрофон не найден. Проверьте устройство и доступ Windows к микрофону.";
  }
  if (normalized.includes("selected microphone device is not available")) {
    return "Выбранный микрофон недоступен. Откройте настройки и выберите другое устройство.";
  }
  if (normalized.includes("failed to get microphone config")) {
    return "Не удалось получить параметры микрофона. Проверьте устройство записи в Windows.";
  }
  if (normalized.includes("default output device is not available for loopback")) {
    return "Не найдено устройство вывода для захвата системного звука.";
  }
  if (normalized.includes("selected output device is not available")) {
    return "Выбранный динамик или устройство вывода недоступно. Проверьте настройки аудио.";
  }
  if (normalized.includes("vosk model is not installed")) {
    return "Русский пакет распознавания не установлен. Откройте Настройки -> Распознавание и установите точный профиль.";
  }
  if (
    normalized.includes("failed to load") &&
    normalized.includes("vosk") &&
    normalized.includes("runtime")
  ) {
    return "Не удалось загрузить голосовой модуль. Переустановите его в настройках распознавания.";
  }
  if (normalized.includes("vosk failed to load model")) {
    return "Не удалось загрузить русский пакет распознавания. Переустановите его в настройках.";
  }
  if (normalized.includes("stt session is already running")) {
    return "Сессия распознавания уже запущена.";
  }
  if (isSttStopInProgressDetail(normalized)) {
    return "Предыдущий запуск распознавания еще завершается. Подождите несколько секунд и повторите запуск.";
  }
  if (isSttStartupTimeoutDetail(normalized)) {
    return "Загрузка точного профиля заняла слишком много времени. Large тяжелый: первый запуск может длиться несколько минут.";
  }

  return detail;
}

function toFriendlyScreenshotError(error: unknown): string {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Неизвестная ошибка захвата экрана";
  const normalized = detail.toLowerCase();

  if (
    normalized.includes("notallowederror") ||
    normalized.includes("permission denied") ||
    normalized.includes("permission dismissed")
  ) {
    return "Доступ к захвату экрана не выдан или окно выбора было закрыто.";
  }
  if (
    normalized.includes("истекло время") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out")
  ) {
    return "Время выбора окна для скриншота истекло. Отправляем запрос без скриншота.";
  }

  return detail;
}

export function InterviewOverlay({ mode = "detached" }: InterviewOverlayProps) {
  const session = useSessionStore();
  const settings = useSettingsStore();
  const { setView, setInterviewActive, setSettingsTab, setSettingsFocus } = useAppStore();
  const addSessionToHistory = useHistoryStore((s) => s.addSession);
  const {
    isActive,
    mode: sessionMode,
    safeModeReason,
    startedAt,
    elapsedMs,
    messages,
    contextBuffer,
    lastLlmResponse,
    llmRequestCount,
    llmLatencies,
    interviewerChars,
    userChars,
    isLlmLoading,
    startSession,
    setSafeMode,
    setLiveMode,
    tick,
    endSession,
    addMessage,
    updateMessage,
    setLlmResponse,
    appendLlmText,
    finishLlmResponse,
    flushContextBuffer,
    trimMessages,
  } = session;

  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [newMsgCount, setNewMsgCount] = useState(0);
  const [aiPanelAtBottom, setAiPanelAtBottom] = useState(true);
  const [lastLlmError, setLastLlmError] = useState<string | null>(null);
  const [responseExpanded, setResponseExpanded] = useState(false);
  const [showFullTranscript, setShowFullTranscript] = useState(false);
  const [copiedResponse, setCopiedResponse] = useState(false);
  const [isEndingInterview, setIsEndingInterview] = useState(false);
  const [activeSttLanguage, setActiveSttLanguage] = useState<PrimaryLanguage>(
    settings.primaryLanguage,
  );
  const [settingsHydrated, setSettingsHydrated] = useState<boolean>(() => {
    const store = useSettingsStore as unknown as PersistStoreLike;
    return store.persist?.hasHydrated?.() ?? true;
  });
  const [sttStatusText, setSttStatusText] = useState(
    "Подготавливаем распознавание речи...",
  );
  const [sttWarmupModelId, setSttWarmupModelId] = useState<string | null>(null);
  const [sttWarmupUi, setSttWarmupUi] = useState<SttWarmupUiState | null>(null);
  const [isSttStarting, setIsSttStarting] = useState(false);
  const [sttStartupStartedAt, setSttStartupStartedAt] = useState<number | null>(null);
  const [sttStartupElapsedMs, setSttStartupElapsedMs] = useState(0);
  const [isSttRecovering, setIsSttRecovering] = useState(false);
  const [manualQuestion, setManualQuestion] = useState("");
  const [cropDialogImageBase64, setCropDialogImageBase64] = useState<string | null>(
    null,
  );
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [cropDragging, setCropDragging] = useState(false);
  const [intentModeOverride, setIntentModeOverride] =
    useState<InterviewIntentMode>("AUTO");
  const [lastRequestIntent, setLastRequestIntent] = useState<InterviewIntent | null>(null);
  const [lastHintMeta, setLastHintMeta] = useState<LastHintMeta | null>(null);
  const [отзываUi, setFeedbackUi] = useState<FeedbackUiState>({
    sending: null,
    sentRating: null,
    отзываId: null,
    error: null,
  });
  const safeModeNoticeShownRef = useRef(false);
  const aiPanelRef = useRef<HTMLDivElement>(null);
  const cropContainerRef = useRef<HTMLDivElement | null>(null);
  const cropImageRef = useRef<HTMLImageElement | null>(null);
  const cropStartRef = useRef<{ x: number; y: number } | null>(null);
  const cropResolverRef = useRef<((result: string | null) => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endingRef = useRef(false);
  const isEmbeddedMode = mode === "embedded";
  const persistSessionToHistoryRef = useRef<(endedAt: number) => boolean>(() => false);
  const pendingMessageIdsRef = useRef<{ mic: string | null; system: string | null }>({
    mic: null,
    system: null,
  });
  const sttSignalSeenRef = useRef<{ mic: boolean; system: boolean }>({
    mic: false,
    system: false,
  });
  const sttTranscriptSeenRef = useRef<{ mic: boolean; system: boolean }>({
    mic: false,
    system: false,
  });
  const sttNoSignalNoticeShownRef = useRef(false);
  const sttNoSignalRecoveryAttemptedRef = useRef(false);
  const sttLastAutoRecoveryAtRef = useRef(0);
  const sttNoTranscriptHintShownRef = useRef<{ mic: boolean; system: boolean }>({
    mic: false,
    system: false,
  });
  const sttRecoveryInProgressRef = useRef(false);
  const sttStartupInProgressRef = useRef(false);
  const sttStopPromiseRef = useRef<Promise<void> | null>(null);
  const activeSttLanguageRef = useRef<PrimaryLanguage>(activeSttLanguage);
  const sttAcceptingResultsRef = useRef(true);

  useEffect(() => {
    activeSttLanguageRef.current = activeSttLanguage;
  }, [activeSttLanguage]);

  useEffect(() => {
    if (!isActive && !endingRef.current) {
      startSession();
    }
  }, [isActive, startSession]);

  useEffect(() => {
    if (!sttWarmupModelId) {
      setSttWarmupUi(null);
      return;
    }

    const updateWarmupUi = () => {
      const snapshot = getSttWarmupSnapshot(sttWarmupModelId);
      setSttWarmupUi(snapshot ? buildWarmupUiState(snapshot) : null);
    };

    updateWarmupUi();
    const timer = window.setInterval(updateWarmupUi, 250);
    return () => {
      window.clearInterval(timer);
    };
  }, [sttWarmupModelId]);

  useEffect(() => {
    if (!isSttStarting || !sttStartupStartedAt) {
      setSttStartupElapsedMs(0);
      return;
    }

    const updateElapsed = () => {
      setSttStartupElapsedMs(Math.max(0, Date.now() - sttStartupStartedAt));
    };

    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [isSttStarting, sttStartupStartedAt]);

  useEffect(() => {
    const store = useSettingsStore as unknown as PersistStoreLike;
    const hasHydrated = store.persist?.hasHydrated?.() ?? true;
    if (hasHydrated) {
      setSettingsHydrated(true);
      return;
    }

    const unsubscribe = store.persist?.onFinishHydration?.(() => {
      setSettingsHydrated(true);
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => tick(), 1000);
    return () => clearInterval(interval);
  }, [tick]);

  useEffect(() => {
    if (isAtBottom) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
      setNewMsgCount(0);
    } else {
      setNewMsgCount((c) => c + 1);
    }
  }, [messages.length, isAtBottom]);

  useEffect(() => {
    const limitBytes = settings.chatMemoryLimitMb * 1024 * 1024;
    trimMessages(limitBytes);
  }, [messages.length, settings.chatMemoryLimitMb, trimMessages]);

  useEffect(() => {
    if (aiPanelAtBottom) {
      aiPanelRef.current?.scrollTo({ top: aiPanelRef.current.scrollHeight });
    }
  }, [lastLlmResponse?.text, aiPanelAtBottom]);

  const resolveConcreteAudioSelection = useCallback(
    async (request?: {
      microphoneDeviceId?: string | null;
      systemAudioDeviceId?: string | null;
      forceWindowsDefaults?: boolean;
    }): Promise<ResolvedSttStartSelection> => {
      const currentSettings = useSettingsStore.getState();
      const requestedMic = request?.forceWindowsDefaults
        ? ""
        : (request?.microphoneDeviceId ?? currentSettings.microphoneDeviceId);
      const requestedSystem = request?.forceWindowsDefaults
        ? ""
        : (request?.systemAudioDeviceId ?? currentSettings.systemAudioDeviceId);

      const trimmedMic = requestedMic?.trim() ?? "";
      const trimmedSystem = requestedSystem?.trim() ?? "";
      let microphoneDeviceId = trimmedMic || undefined;
      let systemAudioDeviceId = trimmedSystem || undefined;
      let microphoneLabel = microphoneDeviceId || "Windows default microphone";
      let systemAudioLabel = systemAudioDeviceId || "Windows default output";
      let usedWindowsDefaultMic = !microphoneDeviceId;
      let usedWindowsDefaultSystem = !systemAudioDeviceId;

      try {
        const { isTauri, listAudioDevices } = await import("@/lib/tauri");
        if (!isTauri()) {
          return {
            microphoneDeviceId,
            systemAudioDeviceId,
            microphoneLabel,
            systemAudioLabel,
            usedWindowsDefaultMic,
            usedWindowsDefaultSystem,
          };
        }

        const devices = await listAudioDevices();
        const resolveSelectedDevice = (
          isInput: boolean,
          selector?: string,
        ): AudioDeviceInfo | null =>
          selector
            ? devices.find(
                (device) =>
                  device.is_input === isInput &&
                  (device.id === selector || device.name === selector),
              ) ?? null
            : null;
        const resolveDefaultDevice = (isInput: boolean): AudioDeviceInfo | null =>
          devices.find(
            (device) => device.is_input === isInput && device.is_default,
          ) ?? null;

        const selectedMic = resolveSelectedDevice(true, microphoneDeviceId);
        const selectedSystem = resolveSelectedDevice(false, systemAudioDeviceId);
        const defaultMic = resolveDefaultDevice(true);
        const defaultSystem = resolveDefaultDevice(false);

        if (selectedMic) {
          microphoneLabel = selectedMic.name;
          microphoneDeviceId = selectedMic.id;
          usedWindowsDefaultMic = false;
        } else if (trimmedMic) {
          throw new Error(
            `Выбранный микрофон недоступен: ${trimmedMic}. В жёстком режиме fallback отключен — выберите доступный микрофон в настройках.`,
          );
        } else if (defaultMic) {
          microphoneLabel = defaultMic.name;
          if (!microphoneDeviceId) {
            microphoneDeviceId = defaultMic.id;
          }
          usedWindowsDefaultMic = !trimmedMic || request?.forceWindowsDefaults === true;
        } else {
          throw new Error(
            "Не найден Windows default микрофон. В жёстком режиме запуск без валидного устройства запрещён.",
          );
        }

        if (selectedSystem) {
          systemAudioLabel = selectedSystem.name;
          systemAudioDeviceId = selectedSystem.id;
          usedWindowsDefaultSystem = false;
        } else if (trimmedSystem) {
          throw new Error(
            `Выбранный канал системного звука недоступен: ${trimmedSystem}. В жёстком режиме fallback отключен — выберите доступный выход в настройках.`,
          );
        } else if (defaultSystem) {
          systemAudioLabel = defaultSystem.name;
          if (!systemAudioDeviceId) {
            systemAudioDeviceId = defaultSystem.id;
          }
          usedWindowsDefaultSystem = !trimmedSystem || request?.forceWindowsDefaults === true;
        } else {
          throw new Error(
            "Не найден Windows default выход для loopback. В жёстком режиме запуск без валидного устройства запрещён.",
          );
        }
      } catch (error) {
        logWarn("speech.session", "Failed to resolve selected audio devices before speech start", {
          microphoneDeviceId,
          systemAudioDeviceId,
          error,
        });
        if (STT_STRICT_AUDIO_MODE) {
          throw error instanceof Error
            ? error
            : new Error("Не удалось валидировать аудиоустройства в жёстком режиме.");
        }
      }

      return {
        microphoneDeviceId,
        systemAudioDeviceId,
        microphoneLabel,
        systemAudioLabel,
        usedWindowsDefaultMic,
        usedWindowsDefaultSystem,
      };
    },
    [],
  );

  const startConfiguredSttSession = useCallback(
    async (request?: {
      microphoneDeviceId?: string | null;
      systemAudioDeviceId?: string | null;
      forceWindowsDefaults?: boolean;
      language?: PrimaryLanguage;
    }) => {
      const resolvedSelection = await resolveConcreteAudioSelection(request);
      const { startVoskSttSession } = await import("@/lib/tauri");
      logInfo("speech.session", "Starting speech session", {
        microphoneDeviceId: resolvedSelection.microphoneDeviceId || "(default)",
        microphoneLabel: resolvedSelection.microphoneLabel,
        systemAudioDeviceId: resolvedSelection.systemAudioDeviceId || "(default)",
        systemAudioLabel: resolvedSelection.systemAudioLabel,
        usedWindowsDefaultMic: resolvedSelection.usedWindowsDefaultMic,
        usedWindowsDefaultSystem: resolvedSelection.usedWindowsDefaultSystem,
        strictAudioMode: STT_STRICT_AUDIO_MODE,
      });
      sttStartupInProgressRef.current = true;
      const startupStartedAt = Date.now();
      setSttStartupStartedAt(startupStartedAt);
      setSttStartupElapsedMs(0);
      setIsSttStarting(true);
      setSttStatusText(
        "Загружаем точный профиль распознавания. Первый запуск Large может занять 1-3 минуты...",
      );
      try {
        await withTimeout(
          startVoskSttSession({
            microphoneDeviceId: resolvedSelection.microphoneDeviceId,
            systemAudioDeviceId: resolvedSelection.systemAudioDeviceId,
            language: request?.language,
          }),
          STT_START_REQUEST_TIMEOUT_MS,
          "Запуск распознавания занял слишком много времени. Проверьте аудиоустройства и повторите запуск.",
        );
      } finally {
        sttStartupInProgressRef.current = false;
        setIsSttStarting(false);
        setSttStartupStartedAt(null);
        setSttStartupElapsedMs(0);
      }
      sttAcceptingResultsRef.current = true;
      logInfo("speech.session", "Speech session started", {
        microphoneLabel: resolvedSelection.microphoneLabel,
        systemAudioLabel: resolvedSelection.systemAudioLabel,
      });
    },
    [resolveConcreteAudioSelection],
  );

  const stopSttSessionGracefully = useCallback(
    async (reason: "restart" | "language_switch" | "cleanup") => {
      if (sttStopPromiseRef.current) {
        logInfo("speech.stop", "Waiting for already running speech stop", { reason });
        await sttStopPromiseRef.current;
        return;
      }

      const stopPromise = (async () => {
        const { isTauri, stopSttSession, stopVoskSttSession } = await import("@/lib/tauri");
        if (!isTauri()) {
          return;
        }
        sttAcceptingResultsRef.current = false;
        await stopSttSession().catch(() => {
          // Best effort cleanup for the older live path.
        });

        const deadline = Date.now() + STT_STOP_SETTLE_TIMEOUT_MS;
        let attempt = 0;
        let lastError: unknown = null;

        while (Date.now() < deadline) {
          attempt += 1;
          try {
            await withTimeout(
              stopVoskSttSession(),
              STT_STOP_TIMEOUT_MS,
              "Timed out while stopping STT session.",
            );
            if (attempt > 1) {
              logInfo("speech.stop", "Speech stop completed after retry", { reason, attempt });
            }
            return;
          } catch (error) {
            lastError = error;
            const detail = toErrorDetail(error);
            const normalized = detail.toLowerCase();
            if (isSttAlreadyStoppedDetail(normalized)) {
              return;
            }
            if (!isSttStopInProgressDetail(normalized)) {
              throw error;
            }
            if (attempt === 1 || attempt % 5 === 0) {
              logWarn("speech.stop", "Speech stop still in progress; waiting before retry", {
                reason,
                attempt,
                detail,
              });
            }
            await sleep(STT_STOP_POLL_INTERVAL_MS);
          }
        }

        const detail = toFriendlySttStartupError(lastError);
        throw new Error(`Остановка распознавания не завершилась вовремя: ${detail}`);
      })();

      sttStopPromiseRef.current = stopPromise;
      try {
        await stopPromise;
      } finally {
        if (sttStopPromiseRef.current === stopPromise) {
          sttStopPromiseRef.current = null;
        }
      }
    },
    [],
  );

  const startSttSessionWithRecovery = useCallback(async (language?: PrimaryLanguage) => {
    const currentSettings = useSettingsStore.getState();
    const targetLanguage = language ?? currentSettings.primaryLanguage;
    const hasCustomSelection =
      currentSettings.microphoneDeviceId.trim().length > 0 ||
      currentSettings.systemAudioDeviceId.trim().length > 0;

    try {
      await startConfiguredSttSession({ language: targetLanguage });
      return;
    } catch (error) {
      const firstAttemptDetail = toFriendlySttStartupError(error);
      const isStopInProgress = isSttStopInProgressDetail(firstAttemptDetail.toLowerCase());

      if (isStopInProgress) {
        logWarn("speech.session", "Speech startup hit pending stop; waiting and retrying", {
          detail: firstAttemptDetail,
        });
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: "Предыдущий запуск распознавания еще завершается. Ждем и повторяем запуск...",
          isFinal: true,
        });
        await stopSttSessionGracefully("restart");
        await startConfiguredSttSession({ language: targetLanguage });
        setSttStatusText("Распознавание запущено после завершения предыдущей сессии.");
        return;
      }

      if (STT_STRICT_AUDIO_MODE) {
        logWarn("speech.session", "Strict audio mode: startup aborted without fallback", {
          detail: firstAttemptDetail,
          microphoneDeviceId: currentSettings.microphoneDeviceId,
          systemAudioDeviceId: currentSettings.systemAudioDeviceId,
        });
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: `Жёсткий режим аудио: запуск остановлен (${firstAttemptDetail}). ${strictStartupActionHint(firstAttemptDetail)}`,
          isFinal: true,
        });
        setSttStatusText(`Жёсткий режим: ${firstAttemptDetail}`);
        throw error;
      }
      if (hasCustomSelection) {
        logWarn("speech.session", "Speech startup failed with selected devices", {
          detail: firstAttemptDetail,
          microphoneDeviceId: currentSettings.microphoneDeviceId,
          systemAudioDeviceId: currentSettings.systemAudioDeviceId,
        });
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: `Не удалось запустить распознавание на выбранных устройствах: ${firstAttemptDetail}`,
          isFinal: true,
        });
        setSttStatusText(
          `Ошибка запуска на выбранных устройствах: ${firstAttemptDetail}`,
        );
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: "Пробуем переключиться на текущие устройства Windows по умолчанию.",
          isFinal: true,
        });
        try {
          await startConfiguredSttSession({
            forceWindowsDefaults: true,
            language: targetLanguage,
          });
          setSttStatusText(
            "Выбранные устройства не стартовали, переключились на текущие Windows default.",
          );
          logWarn("speech.session", "Recovered speech startup by falling back to Windows defaults");
          return;
        } catch (fallbackError) {
          logError("speech.session", "Fallback to Windows default devices failed", {
            firstAttemptDetail,
            fallbackDetail: toFriendlySttStartupError(fallbackError),
            fallbackError,
          });
        }
      }
      throw error;
    }
  }, [addMessage, startConfiguredSttSession, stopSttSessionGracefully]);

  const activateSafeMode = useCallback(
    async (reason: string, options: { stopAudio?: boolean } = {}) => {
      const normalizedReason =
        reason.trim() ||
        "Распознавание отключено, ручной ввод и ножницы остаются доступны.";

      sttAcceptingResultsRef.current = false;
      safeModeNoticeShownRef.current = true;
      setSttWarmupModelId(null);
      setSttWarmupUi(null);
      setSttStatusText(
        "Режим без аудио: распознавание отключено. Используйте ручной вопрос и ножницы.",
      );
      setSafeMode(normalizedReason);
      logWarn("speech.audio_free", "Session switched to audio-free mode", {
        reason: normalizedReason,
        stopAudio: options.stopAudio !== false,
      });
      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: `${normalizedReason} Ручной ввод, ножницы и ответы помощника остаются доступны.`,
        isFinal: true,
      });

      if (options.stopAudio === false) {
        return;
      }

      await stopSttSessionGracefully("cleanup").catch((error) => {
        logWarn("speech.audio_free", "Audio cleanup failed for audio-free mode", { error });
      });
    },
    [addMessage, setSafeMode, stopSttSessionGracefully],
  );

  const resumeLiveMode = useCallback(() => {
    safeModeNoticeShownRef.current = false;
    sttSignalSeenRef.current = { mic: false, system: false };
    sttTranscriptSeenRef.current = { mic: false, system: false };
    setSttStatusText("Пробуем вернуть распознавание...");
    setLiveMode();
    logInfo("speech.audio_free", "User requested audio capture resume");
    addMessage({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: "ai_marker",
      text: "Пробуем вернуть распознавание без перезапуска сессии.",
      isFinal: true,
    });
  }, [addMessage, setLiveMode]);

  const restartSttSession = useCallback(
    async (reason: "manual" | "no_signal"): Promise<boolean> => {
      if (sttRecoveryInProgressRef.current) {
        return false;
      }
      if (sttStartupInProgressRef.current) {
        setSttStatusText(
          "Точный профиль уже загружается. Дождитесь окончания первого запуска, перезапуск сейчас не нужен.",
        );
        if (reason === "manual") {
          addMessage({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            source: "ai_marker",
            text:
              "Точный профиль уже загружается. Первый запуск Large может занять 1-3 минуты, перезапуск сейчас не нужен.",
            isFinal: true,
          });
        }
        logInfo("speech.recovery", "Ignored restart while speech startup is in progress", {
          reason,
        });
        return false;
      }
      sttRecoveryInProgressRef.current = true;
      setIsSttRecovering(true);

      try {
        const { isTauri } = await import("@/lib/tauri");
        if (!isTauri()) {
          return false;
        }

        logWarn("speech.recovery", "Restarting speech session", { reason });
        setSttStatusText("Перезапускаем распознавание речи...");
        if (reason === "manual") {
          addMessage({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            source: "ai_marker",
            text: "Перезапускаем захват микрофона и системного звука...",
            isFinal: true,
          });
        }

        await stopSttSessionGracefully("restart");

        await startSttSessionWithRecovery();

        sttSignalSeenRef.current = { mic: false, system: false };
        sttNoSignalNoticeShownRef.current = false;
        setSttStatusText("Распознавание перезапущено. Проверяем поступление звука...");
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text:
            reason === "no_signal"
              ? "Автовосстановление выполнено: перезапустили аудиозахват с текущими устройствами."
              : "Перезапуск завершен. Проверьте, что микрофон и системный звук теперь поступают.",
          isFinal: true,
        });
        return true;
      } catch (error) {
        const detail = toFriendlySttStartupError(error);
        logError("speech.recovery", "Failed to restart speech session", { reason, detail, error });
        setSttStatusText(`Перезапуск распознавания не удался: ${detail}`);
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: `Не удалось перезапустить распознавание: ${detail}`,
          isFinal: true,
        });
        await activateSafeMode(
          `Аудиозахват не восстановился после перезапуска: ${detail}. Приложение продолжит работу без распознавания.`,
        );
        return false;
      } finally {
        sttRecoveryInProgressRef.current = false;
        setIsSttRecovering(false);
      }
    },
    [activateSafeMode, addMessage, startSttSessionWithRecovery, stopSttSessionGracefully],
  );

  const ensureActiveSttLanguage = useCallback(
    async (language: PrimaryLanguage, restartSession: boolean): Promise<boolean> => {
      const {
        isTauri,
        isVoskSttSessionRunning,
        listVoskModels,
        setActiveVoskModel,
      } = await import("@/lib/tauri");
      if (!isTauri()) {
        logInfo("speech.language", "Skipping speech profile switch in non-desktop mode", {
          language,
        });
        setActiveSttLanguage(language);
        return true;
      }

      const currentSettings = useSettingsStore.getState();
      const preferredVariant =
        language === currentSettings.primaryLanguage
          ? currentSettings.primarySttVariant
          : currentSettings.secondaryLanguage !== "none" &&
              language === currentSettings.secondaryLanguage
            ? currentSettings.secondarySttVariant
            : currentSettings.primarySttVariant;

      logInfo("speech.language", "Resolving active speech profile", {
        language,
        preferredVariant,
        restartSession,
      });

      const models = await withTimeout(
        listVoskModels(),
        VOSK_MODEL_LOOKUP_TIMEOUT_MS,
        "Не удалось быстро получить список профилей. Проверьте настройки распознавания.",
      );
      const selectedModel =
        models.find(
          (model: VoskModelOption) =>
            model.installed &&
            model.language === language &&
            model.variant === preferredVariant,
        ) ??
        models.find(
          (model: VoskModelOption) =>
            model.installed &&
            model.language === language,
        ) ??
        models.find((model: VoskModelOption) => model.installed) ??
        null;

      if (!selectedModel || !selectedModel.installed) {
        logWarn("speech.language", "No installed speech profile was found", {
          language,
          preferredVariant,
          selectedModelId: selectedModel?.id ?? null,
        });
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: "Не найден точный профиль распознавания. Откройте настройки и установите Large.",
          isFinal: true,
        });
        return false;
      }

      if (selectedModel.variant !== preferredVariant) {
        logWarn("speech.language", "Preferred speech profile is unavailable, using fallback", {
          language,
          preferredVariant,
          selectedModelId: selectedModel.id,
          selectedVariant: selectedModel.variant,
        });
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: `Выбран доступный профиль распознавания, потому что предпочитаемый профиль сейчас недоступен.`,
          isFinal: true,
        });
      }

      if (!selectedModel.active) {
        setSttStatusText("Активируем точный профиль. Первый старт может быть дольше обычного...");
        await setActiveVoskModel(selectedModel.id);
      }

      if (restartSession) {
        const running = await isVoskSttSessionRunning().catch(() => false);
        if (running) {
          await stopSttSessionGracefully("language_switch");
        }
        await startSttSessionWithRecovery(language);
        logInfo("speech.language", "Restarted speech capture with selected profile", {
          language,
          modelId: selectedModel.id,
        });
      }

      setActiveSttLanguage(language);
      logInfo("speech.language", "Speech profile is active", {
        language,
        modelId: selectedModel.id,
        variant: selectedModel.variant,
      });
      return true;
    },
    [addMessage, startSttSessionWithRecovery, stopSttSessionGracefully],
  );
  const toggleSttLanguage = useCallback(async () => {
    if (settings.secondaryLanguage === "none") {
      logWarn("speech.language", "Language switch skipped: secondary language is not configured");
      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: "Дополнительный язык не настроен.",
        isFinal: true,
      });
      return;
    }

    if (settings.secondaryLanguage === settings.primaryLanguage) {
      logWarn(
        "stt.language",
        "Language switch skipped: primary and secondary languages are identical",
      );
      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: "Основной и дополнительный языки совпадают. Выберите другой дополнительный язык в настройках.",
        isFinal: true,
      });
      return;
    }

    const nextLanguage =
      activeSttLanguage === settings.primaryLanguage
        ? settings.secondaryLanguage
        : settings.primaryLanguage;

    const switched = await ensureActiveSttLanguage(nextLanguage, true);
    if (!switched) {
      logWarn("speech.language", "Language switch failed", { nextLanguage });
      return;
    }

    logInfo("speech.language", "Language switched", { nextLanguage });
    addMessage({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: "ai_marker",
      text: `Язык распознавания переключен: ${getLanguageLabel(nextLanguage)}.`,
      isFinal: true,
    });
  }, [
    activeSttLanguage,
    addMessage,
    ensureActiveSttLanguage,
    settings.primaryLanguage,
    settings.secondaryLanguage,
  ]);

  const handleSttResult = useCallback(
    (payload: SttResultEvent) => {
      const sessionActive = useSessionStore.getState().isActive;
      if (!sessionActive || endingRef.current) {
        return;
      }
      if (!sttAcceptingResultsRef.current) {
        // Recovery path: keep rendering live transcripts if the guard flag lags behind
        // while the session is still active.
        sttAcceptingResultsRef.current = true;
        logWarn("speech.result", "Recovered speech result processing guard during active session");
      }
      const sourceKey = payload.source === "system" ? "system" : "mic";
      const firstSignal = !sttSignalSeenRef.current[sourceKey];
      sttSignalSeenRef.current[sourceKey] = true;
      if (firstSignal) {
        logInfo("speech.audio", "First live audio signal received", {
          source: sourceKey,
          isFinal: payload.is_final,
        });
      }

      const text = payload.text.trim();
      if (!text) {
        return;
      }
      if (isKnownSubtitleCreditNoise(text)) {
        logWarn("speech.result", "Filtered known subtitle-credit phrase", {
          source: sourceKey,
        });
        return;
      }

      sttTranscriptSeenRef.current[sourceKey] = true;
      setSttStatusText("Распознавание активно. Речь успешно поступает в приложение.");

      const source = sourceKey === "system" ? "interviewer" : "user";
      const pendingId = pendingMessageIdsRef.current[sourceKey];

      if (payload.is_final) {
        if (pendingId) {
          updateMessage(pendingId, { text, isFinal: true });
          pendingMessageIdsRef.current[sourceKey] = null;
        } else {
          addMessage({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            source,
            text,
            isFinal: true,
          });
        }
        return;
      }

      if (pendingId) {
        updateMessage(pendingId, { text, isFinal: false });
      } else {
        const id = crypto.randomUUID();
        pendingMessageIdsRef.current[sourceKey] = id;
        addMessage({
          id,
          timestamp: Date.now(),
          source,
          text,
          isFinal: false,
        });
      }
    },
    [addMessage, updateMessage],
  );

  const handleSttDiagnostic = useCallback(
    (payload: SttDiagnosticEvent) => {
      const source = payload.source ?? "general";
      const scope = `stt.diagnostic.${source}`;
      const isWorkerStopNoise = payload.code === "worker_error" && endingRef.current;
      if (payload.level === "error" && !isWorkerStopNoise) {
        logError(scope, payload.message, payload);
      } else if (payload.level === "warn" || isWorkerStopNoise) {
        logWarn(scope, payload.message, payload);
      } else {
        logInfo(scope, payload.message, payload);
      }

      if (payload.code === "audio_detected") {
        if (payload.source === "system") {
          sttSignalSeenRef.current.system = true;
          setSttStatusText(
            "Системный звук получен. Ждем первые распознанные слова собеседника.",
          );
        } else if (payload.source === "mic") {
          sttSignalSeenRef.current.mic = true;
          setSttStatusText(
            "Сигнал с микрофона получен. Ждем первые распознанные слова.",
          );
        }
        return;
      }

      if (payload.code === "worker_ready") {
        setSttStatusText(
          payload.source === "system"
            ? "Захват системного звука подключен. Ожидаем реальный звук."
            : payload.source === "mic"
              ? "Микрофон подключен. Скажи что-нибудь вслух."
              : "Движок распознавания запущен. Ожидаем аудиосигнал.",
        );
        return;
      }

      if (payload.code === "audio_resumed") {
        setSttStatusText(
          payload.source === "mic"
            ? "Поток микрофона восстановлен."
            : payload.source === "system"
              ? "Поток системного звука восстановлен."
              : payload.message,
        );
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: payload.message,
          isFinal: true,
        });
        return;
      }

      if (payload.code === "audio_stalled") {
        if (payload.source === "system") {
          setSttStatusText(
            "Системный звук временно не поступает. Это нормально, если собеседник сейчас молчит.",
          );
          return;
        }

        setSttStatusText(payload.message);
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: payload.message,
          isFinal: true,
        });

        const now = Date.now();
        const canAutoRecover =
          now - sttLastAutoRecoveryAtRef.current >= STT_AUTO_RECOVERY_COOLDOWN_MS &&
          !sttRecoveryInProgressRef.current;
        if (canAutoRecover) {
          sttLastAutoRecoveryAtRef.current = now;
          addMessage({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            source: "ai_marker",
            text: "Пробуем автоматический перезапуск аудиозахвата...",
            isFinal: true,
          });
          void restartSttSession("no_signal");
        }
        return;
      }

      setSttStatusText(payload.message);

      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: payload.message,
        isFinal: true,
      });
    },
    [addMessage, restartSttSession],
  );

  useEffect(() => {
      if (!isActive) {
        return;
      }
      if (sessionMode === "safe") {
        sttAcceptingResultsRef.current = false;
      setSttWarmupModelId(null);
      setSttWarmupUi(null);
      setSttStatusText(
        "Режим без аудио: распознавание отключено. Используйте ручной вопрос и ножницы.",
      );
      if (!safeModeNoticeShownRef.current) {
        safeModeNoticeShownRef.current = true;
        logWarn("speech.setup", "Skipping speech startup because session is audio-free", {
          reason: safeModeReason,
        });
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text:
            safeModeReason ||
            "Режим без аудио включен: приложение работает без распознавания, но ручной ввод и отправка скриншота доступны.",
          isFinal: true,
        });
      }
      return;
    }
    if (!settingsHydrated) {
      logInfo("speech.setup", "Waiting for settings hydration before speech startup");
      setSttStatusText("Подготавливаем настройки перед запуском распознавания...");
      return;
    }


    if (!STT_AUTOSTART_ENABLED) {
      logWarn(
        "stt.setup",
        "STT autostart is disabled. Running overlay in stable manual mode.",
      );
      setSttStatusText(
        "Ручной режим: введите вопрос внизу и отправьте. Распознавание временно отключено.",
      );
      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: "Ручной режим включен: автозапуск распознавания отключен, используйте ручной ввод и скриншот.",
        isFinal: true,
      });
      return;
    }

    pendingMessageIdsRef.current = { mic: null, system: null };
    sttSignalSeenRef.current = { mic: false, system: false };
    sttTranscriptSeenRef.current = { mic: false, system: false };
    sttNoSignalNoticeShownRef.current = false;
    sttNoSignalRecoveryAttemptedRef.current = false;
    sttLastAutoRecoveryAtRef.current = 0;
    sttNoTranscriptHintShownRef.current = { mic: false, system: false };
    setSttStatusText("Подготавливаем распознавание...");

    let unlistenResult: (() => void) | null = null;
    let unlistenDiagnostic: (() => void) | null = null;
    let noSignalTimer: number | null = null;
    let noTranscriptTimer: number | null = null;
    let disposed = false;

    async function setupStt() {
      const activeSettings = useSettingsStore.getState();
      const primaryLanguage = activeSettings.primaryLanguage;
      logInfo("speech.setup", "Speech setup started", {
        primaryLanguage,
        microphoneDeviceId: activeSettings.microphoneDeviceId || "(default)",
        systemAudioDeviceId: activeSettings.systemAudioDeviceId || "(default)",
      });
      const { isTauri, isVoskSttSessionRunning } = await import("@/lib/tauri");
      if (disposed) {
        return;
      }
      if (!isTauri()) {
        logInfo("speech.setup", "Skipping speech setup in non-desktop mode");
        return;
      }

      const { listen } = await import("@tauri-apps/api/event");
      if (disposed) {
        return;
      }
      unlistenResult = await listen<SttResultEvent>("stt_result", (event) => {
        handleSttResult(event.payload);
      });
      unlistenDiagnostic = await listen<SttDiagnosticEvent>("stt_diagnostic", (event) => {
        handleSttDiagnostic(event.payload);
      });
      if (disposed) {
        unlistenResult?.();
        unlistenDiagnostic?.();
        return;
      }
      logInfo("speech.setup", "Speech event listeners attached");

      try {
        const ready = await withTimeout(
          ensureActiveSttLanguage(primaryLanguage, false),
          STT_STARTUP_TIMEOUT_MS,
          "Подготовка распознавания заняла слишком много времени.",
        );
        if (disposed) {
          return;
        }
        if (!ready) {
          logWarn("speech.setup", "Speech setup stopped: language was not prepared");
          return;
        }
        setSttStatusText("Запускаем захват микрофона и системного звука...");
        const alreadyRunning = await isVoskSttSessionRunning().catch(() => false);
        if (disposed) {
          return;
        }
        if (!alreadyRunning) {
          await startSttSessionWithRecovery();
          if (disposed) {
            return;
          }
        } else {
          logWarn("speech.setup", "Speech session already running, reusing existing session");
        }
        sttAcceptingResultsRef.current = true;
        setActiveSttLanguage(primaryLanguage);
        logInfo("speech.setup", "Speech capture pipeline started", {
          language: primaryLanguage,
        });
        setSttWarmupModelId(null);
        setSttStatusText(
          "Распознавание запущено. Говори в микрофон или включи звук собеседника.",
        );
        noSignalTimer = window.setTimeout(() => {
          if (disposed) {
            return;
          }
          const { mic, system } = sttSignalSeenRef.current;
          if (sttNoSignalNoticeShownRef.current || mic || system) {
            return;
          }

          sttNoSignalNoticeShownRef.current = true;
          logWarn("speech.audio", "No live audio detected after speech startup", {
            timeoutMs: 6000,
          });
          setSttStatusText(
            "Распознавание запущено, но живой аудиосигнал пока не поступает. Проверь доступ к микрофону и выбранные устройства.",
          );
          addMessage({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            source: "ai_marker",
            text:
              "Распознавание запущено, но аудиосигнал пока не поступает. Зеленые статусы выше означают, что устройства найдены, но не гарантируют живой звук. Проверьте доступ Windows к микрофону, выбранный микрофон и наличие реального системного звука.",
            isFinal: true,
          });
          if (!sttNoSignalRecoveryAttemptedRef.current) {
            sttNoSignalRecoveryAttemptedRef.current = true;
            addMessage({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              source: "ai_marker",
              text:
                "Пробуем автоперезапуск аудиозахвата с текущими устройствами...",
              isFinal: true,
            });
            void restartSttSession("no_signal");
          }
        }, STT_NO_SIGNAL_TIMEOUT_MS);

        noTranscriptTimer = window.setTimeout(() => {
          if (disposed) {
            return;
          }

          const { mic: micSignalSeen, system: systemSignalSeen } = sttSignalSeenRef.current;
          const { mic: micTranscriptSeen, system: systemTranscriptSeen } =
            sttTranscriptSeenRef.current;

          if (micSignalSeen && !micTranscriptSeen && !sttNoTranscriptHintShownRef.current.mic) {
            sttNoTranscriptHintShownRef.current.mic = true;
            addMessage({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              source: "ai_marker",
              text:
                "Микрофон слышит сигнал, но пока не распознает слова. Частые причины: неверный язык распознавания, слишком тихий голос или не тот активный микрофон.",
              isFinal: true,
            });
            logWarn("speech.audio", "Microphone has signal but no transcript yet", {
              activeLanguage: activeSttLanguageRef.current,
            });
          }

          if (
            systemSignalSeen &&
            !systemTranscriptSeen &&
            !sttNoTranscriptHintShownRef.current.system
          ) {
            sttNoTranscriptHintShownRef.current.system = true;
            addMessage({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              source: "ai_marker",
              text:
                "Системный звук слышен, но текст пока не появился. Проверьте язык распознавания и что речь реально идет в выбранный канал вывода.",
              isFinal: true,
            });
            logWarn("speech.audio", "System audio has signal but no transcript yet", {
              activeLanguage: activeSttLanguageRef.current,
            });
          }
        }, STT_NO_TRANSCRIPT_HINT_TIMEOUT_MS);
      } catch (err: unknown) {
        if (disposed) {
          return;
        }
        setSttWarmupModelId(null);
        const detail = toFriendlySttStartupError(err);
        logError("speech.setup", "Speech setup failed", { detail, error: err });
        setSttStatusText(`Ошибка запуска: ${detail}`);
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: `Не удалось запустить распознавание речи: ${detail}`,
          isFinal: true,
        });
        await activateSafeMode(
          `Распознавание не запустилось: ${detail}. Приложение переведено в Режим без аудио, чтобы не зависать на аудио.`,
        );
      }
    }

    void setupStt();

    return () => {
      disposed = true;
      sttAcceptingResultsRef.current = false;
      logInfo("speech.setup", "Cleaning up speech listeners/session");
      if (noSignalTimer !== null) {
        window.clearTimeout(noSignalTimer);
      }
      if (noTranscriptTimer !== null) {
        window.clearTimeout(noTranscriptTimer);
      }
      unlistenResult?.();
      unlistenDiagnostic?.();

      void (async () => {
        if (!STT_AUTOSTART_ENABLED) {
          return;
        }
        if (endingRef.current) {
          logInfo("speech.setup", "Skipping cleanup stop while explicit interview shutdown is running");
          return;
        }
        const { isTauri } = await import("@/lib/tauri");
        if (!isTauri()) {
          return;
        }
        await stopSttSessionGracefully("cleanup").catch(() => {
          // Session might already be stopped or app is closing.
        });
      })();
    };
  }, [
    addMessage,
    activateSafeMode,
    ensureActiveSttLanguage,
    handleSttDiagnostic,
    handleSttResult,
    isActive,
    settingsHydrated,
    sessionMode,
    safeModeReason,
    stopSttSessionGracefully,
    startSttSessionWithRecovery,
    restartSttSession,
  ]);

  const handleChatScroll = useCallback(() => {
    const el = chatContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setIsAtBottom(atBottom);
    if (atBottom) setNewMsgCount(0);
  }, []);

  const handleAiPanelScroll = useCallback(() => {
    const el = aiPanelRef.current;
    if (!el) return;
    setAiPanelAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 50);
  }, []);

  const jumpToBottom = useCallback(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setIsAtBottom(true);
    setNewMsgCount(0);
  }, []);

  const copyLastResponse = useCallback(async () => {
    const text = lastLlmResponse?.text?.trim();
    if (!text) {
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setCopiedResponse(true);
      window.setTimeout(() => setCopiedResponse(false), 1200);
    } catch (error) {
      logWarn("overlay.response", "Failed to copy AI response to clipboard", error);
      console.warn("Failed to copy AI response:", error);
    }
  }, [lastLlmResponse?.text]);

  const closeCropDialog = useCallback((result: string | null) => {
    const resolver = cropResolverRef.current;
    cropResolverRef.current = null;
    cropStartRef.current = null;
    setCropDragging(false);
    setCropRect(null);
    setCropDialogImageBase64(null);
    resolver?.(result);
  }, []);

  const openCropDialog = useCallback((imageBase64: string): Promise<string | null> => {
    cropStartRef.current = null;
    setCropDragging(false);
    setCropRect(null);
    setCropDialogImageBase64(imageBase64);
    return new Promise<string | null>((resolve) => {
      cropResolverRef.current = resolve;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (cropResolverRef.current) {
        cropResolverRef.current(null);
        cropResolverRef.current = null;
      }
    };
  }, []);

  const applyCropSelection = useCallback(async () => {
    if (!cropDialogImageBase64 || !cropRect) {
      return;
    }
    const imageElement = cropImageRef.current;
    if (!imageElement) {
      closeCropDialog(cropDialogImageBase64);
      return;
    }
    try {
      const cropped = await cropBase64PngByRect(
        cropDialogImageBase64,
        cropRect,
        imageElement,
      );
      closeCropDialog(cropped);
    } catch (error) {
      logWarn("llm.screenshot", "Failed to crop screenshot region, using full screenshot", error);
      closeCropDialog(cropDialogImageBase64);
    }
  }, [closeCropDialog, cropDialogImageBase64, cropRect]);

  const sendToLlm = useCallback(
    async (withScreenshot = false) => {
      if (isLlmLoading) {
        logWarn("llm.request", "Skipped send request: previous request still loading");
        return;
      }
      if (!settings.apiKey) {
        logWarn("llm.request", "Skipped send request: license key is missing");
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: "Лицензионный ключ не задан. Укажите его в настройках.",
          isFinal: true,
        });
        setLastLlmError("Лицензионный ключ не задан.");
        return;
      }

      setLastLlmError(null);

      const contextMessages = contextBuffer;
      const manualQuestionText = manualQuestion.trim();
      const intentSourceText =
        manualQuestionText || contextMessages.map((message) => message.text).join("\n");
      const requestIntent = resolveRequestIntentMode(
        manualQuestionText,
        intentSourceText,
        withScreenshot,
        intentModeOverride,
      );
      const hasTextQuestion = contextMessages.length > 0 || manualQuestionText.length > 0;
      if (!hasTextQuestion && !withScreenshot) {
        logWarn(
          "llm.request",
          "Skipped send request: both transcript buffer and manual question are empty",
        );
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: "Введите вопрос вручную или дождитесь расшифровки перед отправкой.",
          isFinal: true,
        });
        return;
      }
      if (!hasTextQuestion && withScreenshot) {
        logInfo("llm.request", "Proceeding with screenshot-only request");
      }

      const resp: LlmResponse = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        text: "",
        isStreaming: true,
      };
      setLlmResponse(resp);
      setLastRequestIntent(requestIntent);
      setLastHintMeta(null);
      setFeedbackUi({
        sending: null,
        sentRating: null,
        отзываId: null,
        error: null,
      });
      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: `Запрос отправлен. Режим: ${getIntentModeLabel(requestIntent.mode)}.`,
        isFinal: true,
      });
      if (manualQuestionText) {
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "user",
          text: manualQuestionText,
          isFinal: true,
        });
        setManualQuestion("");
      }
      flushContextBuffer();

      const transcriptLines = contextMessages.map(
        (m) => `[${m.source === "interviewer" ? "Интервьюер" : "Вы"}]: ${m.text}`,
      );
      if (manualQuestionText) {
        transcriptLines.push(`[Вы]: ${manualQuestionText}`);
      }
      if (transcriptLines.length === 0 && withScreenshot) {
        transcriptLines.push(
          "[Вы]: Проанализируй скриншот и сначала определи намерение: дописать код, отладить ошибку, сделать ревью или решить задачу.",
        );
      }
      const transcript = transcriptLines.join("\n");

      let userPrompt = buildInterviewPrompt({
        transcript,
        interviewContext: settings.interviewContext,
        screenshotMode: withScreenshot,
        manualQuestion: manualQuestionText,
        forcedIntent: requestIntent.mode !== "AUTO" ? requestIntent : undefined,
      });
      let imageBase64Png: string | undefined;

      logInfo("llm.request", "Prepared request payload", {
        withScreenshot,
        intentMode: requestIntent.mode,
        intentReason: requestIntent.reason,
        transcriptMessages: contextMessages.length,
        transcriptChars: transcript.length,
        manualQuestionChars: manualQuestionText.length,
        promptChars: userPrompt.length,
        language: settings.primaryLanguage,
      });

      if (withScreenshot) {
        logInfo("llm.screenshot", "Starting screenshot capture flow");
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: "Выдели нужную область ножницами. Если отменить, отправим только текстовый запрос.",
          isFinal: true,
        });
        try {
          const fullScreenshotBase64 = await captureScreenshotAsBase64Png();
          const screenshotBase64 = await openCropDialog(fullScreenshotBase64);
          if (screenshotBase64 === null) {
            addMessage({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              source: "ai_marker",
              text: "Выделение скриншота отменено. Отправляем только текстовый запрос.",
              isFinal: true,
            });
          } else if (screenshotBase64 !== fullScreenshotBase64) {
            addMessage({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              source: "ai_marker",
              text: "Добавлена выделенная область скриншота.",
              isFinal: true,
            });
          }

          if (screenshotBase64 !== null) {
            userPrompt +=
              "\n\nЗадача по скриншоту: обязательно выполни routing перед ответом. Ручная просьба важнее OCR/изображения. Если в ручном вопросе или на скриншоте просят дописать/implement/complete/solve/fix/написать функцию/реализовать метод - режим LIVE_CODING, не CODE_REVIEW. Если виден stack trace, failing test или ошибка - DEBUG. Если только код без явной задачи - CODE_REVIEW. Если это не код - THEORY.";
            if (settings.imageHandlingMode === "send_image") {
              imageBase64Png = screenshotBase64;
              userPrompt += "\n\nК запросу приложен скриншот экрана с кодом или задачей.";
              logInfo("llm.screenshot", "Screenshot attached as image", {
                base64Length: screenshotBase64.length,
              });
            } else {
              const ocrText = await tryExtractOcrText(screenshotBase64);
              if (ocrText) {
                userPrompt += `\n\nТекст/код со скриншота:\n${ocrText}`;
                logInfo("llm.screenshot", "OCR text extracted from screenshot", {
                  ocrChars: ocrText.length,
                });
              } else {
                userPrompt += "\n\nСкриншот сделан, но OCR не смог извлечь текст.";
                logWarn("llm.screenshot", "Screenshot captured but OCR returned empty text");
              }
            }
          }
        } catch (err: unknown) {
          const detail = toFriendlyScreenshotError(err);
          logWarn("llm.screenshot", "Screenshot capture failed", { detail, error: err });
          addMessage({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            source: "ai_marker",
            text: `Скриншот не добавлен: ${detail}`,
            isFinal: true,
          });
          userPrompt += `\n\nНе удалось приложить скриншот: ${detail}`;
        }
      }

      abortRef.current?.abort();
      const requestController = new AbortController();
      abortRef.current = requestController;
      const proxyUiTimeoutMs = withScreenshot ? 25_000 : 15_000;
      const proxyUiTimeoutMessage = `Сервис отвечает слишком долго (>${Math.round(proxyUiTimeoutMs / 1000)} сек). Проверьте сеть и повторите попытку.`;

      try {
        const startedAtMs = performance.now();
        logInfo("assistant.request", "Sending request to service", {
          withScreenshot,
          hasImage: Boolean(imageBase64Png),
          baseUrl: HARDCODED_PROXY_BASE_URL,
        });
        const response = await withTimeout(
          requestProxyHint({
            licenseKey: settings.apiKey,
            baseUrlPreset: "custom",
            customBaseUrl: HARDCODED_PROXY_BASE_URL,
            question: userPrompt,
            language: settings.primaryLanguage,
            imageBase64Png,
            timeoutMs: proxyUiTimeoutMs,
            signal: requestController.signal,
          }),
          proxyUiTimeoutMs + 1000,
          proxyUiTimeoutMessage,
        );
        const formatted = formatProxyHintResponse(response, {
          expectedIntentMode: requestIntent.mode,
        });
        setLastHintMeta({
          hintId: response.hintId ?? null,
          taskType: response.taskType ?? null,
          question: userPrompt,
          hadScreenshot: withScreenshot,
          intent: requestIntent,
        });
        const totalMs = performance.now() - startedAtMs;
        logInfo("assistant.request", "Received service response", {
          latencyMs: Math.round(totalMs),
          responseChars: formatted.length,
        });

        useSessionStore.setState((s) => ({
          lastLlmResponse: s.lastLlmResponse
            ? {
                ...s.lastLlmResponse,
                text: formatted,
                isStreaming: false,
                firstTokenLatencyMs: totalMs,
              }
            : null,
          llmResponses: s.lastLlmResponse
            ? s.llmResponses.map((response) =>
                response.id === s.lastLlmResponse?.id
                  ? {
                      ...response,
                      text: formatted,
                      isStreaming: false,
                      firstTokenLatencyMs: totalMs,
                    }
                  : response,
              )
            : s.llmResponses,
        }));

        if (!formatted.trim()) {
          const message = "Сервис вернул пустой ответ.";
          logWarn("llm.request", message);
          setLastLlmError(message);
          addMessage({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            source: "ai_marker",
            text: `Ошибка сервиса: ${message}`,
            isFinal: true,
          });
        }

        finishLlmResponse(totalMs);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Неизвестная ошибка сервиса";
        if (message === proxyUiTimeoutMessage) {
          requestController.abort();
        }
        if (message === "Запрос был отменен." && endingRef.current) {
          logInfo("llm.request", "Request was canceled during interview ending");
          finishLlmResponse(0);
          return;
        }
        logError("assistant.request", "Service request failed", { message, error: err });
        setLastLlmError(message);
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: `Ошибка сервиса: ${message}`,
          isFinal: true,
        });
        appendLlmText(`\n\n[Ошибка: ${message}]`);
        finishLlmResponse(0);
      } finally {
        if (abortRef.current === requestController) {
          abortRef.current = null;
        }
      }
    },
    [
      addMessage,
      appendLlmText,
      contextBuffer,
      finishLlmResponse,
      flushContextBuffer,
      intentModeOverride,
      isLlmLoading,
      manualQuestion,
      openCropDialog,
      setLlmResponse,
      settings,
    ],
  );

  const sendAiFeedback = useCallback(
    async (rating: AiFeedbackRating) => {
      if (!lastLlmResponse || !lastHintMeta) {
        setFeedbackUi({
          sending: null,
          sentRating: null,
          отзываId: null,
          error: "Сначала дождитесь ответа.",
        });
        return;
      }

      setFeedbackUi({
        sending: rating,
        sentRating: null,
        отзываId: null,
        error: null,
      });

      try {
        const response = await submitAiFeedback({
          licenseKey: settings.apiKey,
          rating,
          reason:
            rating === "wrong_mode"
              ? "Отмечен неверный режим ответа."
              : undefined,
          hintId: lastHintMeta.hintId,
          intentMode: lastHintMeta.intent.mode,
          taskType: lastHintMeta.taskType,
          hadScreenshot: lastHintMeta.hadScreenshot,
          question: lastHintMeta.question,
          response: lastLlmResponse.text,
          appVersion: __APP_VERSION__,
        });

        setFeedbackUi({
          sending: null,
          sentRating: rating,
          отзываId: response.отзываId,
          error: null,
        });
        logInfo("llm.отзыва", "AI отзыва sent", {
          rating,
          отзываId: response.отзываId,
          hintId: lastHintMeta.hintId,
        });
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "Не удалось отправить отзыва.";
        setFeedbackUi({
          sending: null,
          sentRating: null,
          отзываId: null,
          error: detail,
        });
        logWarn("llm.отзыва", "Failed to send AI отзыва", { rating, error });
      }
    },
    [lastHintMeta, lastLlmResponse, settings.apiKey],
  );

  const persistSessionToHistory = useCallback(
    (endedAt: number): boolean => {
      const snapshot = useSessionStore.getState();
      if (!snapshot.startedAt) {
        return false;
      }

      const startedAtSnapshot = snapshot.startedAt;
      const durationMs = Math.max(0, endedAt - startedAtSnapshot);
      const hasConversation = snapshot.messages.some(
        (message) =>
          message.source === "user" || message.source === "interviewer",
      );
      const hasMeaningfulActivity =
        hasConversation ||
        snapshot.llmRequestCount > 0 ||
        snapshot.interviewerChars > 0 ||
        snapshot.userChars > 0;

      // Ignore accidental instant opens/closes without actual interview activity.
      if (!hasMeaningfulActivity && durationMs < 15_000) {
        return false;
      }

      const totalChars = snapshot.interviewerChars + snapshot.userChars;
      const metricsSnapshot = {
        durationMs,
        interviewerSpeechRatio:
          snapshot.interviewerChars / Math.max(totalChars, 1),
        userSpeechRatio: snapshot.userChars / Math.max(totalChars, 1),
        llmRequestCount: snapshot.llmRequestCount,
        avgFirstTokenLatencyMs:
          snapshot.llmLatencies.length > 0
            ? snapshot.llmLatencies.reduce((a, latency) => a + latency.firstToken, 0) /
              snapshot.llmLatencies.length
            : 0,
        avgTotalLatencyMs:
          snapshot.llmLatencies.length > 0
            ? snapshot.llmLatencies.reduce((a, latency) => a + latency.total, 0) /
              snapshot.llmLatencies.length
            : 0,
      };

      const record: SessionRecord = {
        id: crypto.randomUUID(),
        startedAt: startedAtSnapshot,
        endedAt,
        model: settings.selectedModel?.id ?? "proxy",
        provider: "custom",
        mode: snapshot.mode,
        safeModeReason: snapshot.safeModeReason,
        metrics: metricsSnapshot,
        transcript: snapshot.messages.slice(-120),
        aiResponses: snapshot.llmResponses.slice(-30),
        finalReport: undefined,
      };

      addSessionToHistory(record);
      return true;
    },
    [addSessionToHistory, settings.selectedModel?.id],
  );

  useEffect(() => {
    persistSessionToHistoryRef.current = persistSessionToHistory;
  }, [persistSessionToHistory]);

  const closeOverlayWindow = useCallback(async (): Promise<boolean> => {
    if (isEmbeddedMode) {
      logInfo("приложение.window", "Embedded приложение close handled by returning to dashboard");
      return false;
    }
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      logInfo("overlay.window", "Overlay close skipped in non-Tauri mode");
      return false;
    }

    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");

    const currentOverlay = getCurrentWebviewWindow();
    if (currentOverlay.label !== "overlay") {
      logWarn("overlay.window", "Current window is not overlay during close", {
        label: currentOverlay.label,
      });
      return false;
    }

    await currentOverlay.close().catch(async () => {
      logWarn("overlay.window", "Overlay close failed, trying destroy");
      await currentOverlay.destroy();
    });

    logInfo("overlay.window", "Overlay window closed");
    return true;
  }, [isEmbeddedMode]);

  const endInterview = useCallback(async () => {
    if (endingRef.current) {
      logInfo("interview.end", "End interview request ignored: already ending");
      return;
    }

    endingRef.current = true;
    sttAcceptingResultsRef.current = false;
    setIsEndingInterview(true);
    logInfo("interview.end", "Ending interview");
    abortRef.current?.abort();
    let приложениеDismissed = false;
    const endWatchdogId = window.setTimeout(() => {
      logWarn("interview.end", "End interview is taking longer than expected");
      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: "Завершение занимает дольше обычного. Приложение продолжит закрытие в безопасном режиме.",
        isFinal: true,
      });
    }, 3500);

    try {
      const endedAt = Date.now();
      persistSessionToHistory(endedAt);
      setInterviewActive(false);
      endSession();

      if (
        STT_AUTOSTART_ENABLED &&
        typeof window !== "undefined" &&
        "__TAURI_INTERNALS__" in window
      ) {
        void withTimeout(
          stopSttSessionGracefully("cleanup"),
          END_INTERVIEW_STT_STOP_BUDGET_MS,
          "Timed out while stopping STT during interview shutdown.",
        ).catch((error: unknown) => {
          logWarn(
            "interview.end",
            "STT stop did not finish in the background after interview teardown",
            error,
          );
        });
      }

      if (isEmbeddedMode) {
        приложениеDismissed = true;
        setView("dashboard");
        logInfo("interview.end", "Embedded приложение returned to dashboard");
      } else {
        const closedOverlay = await withTimeout(
          closeOverlayWindow(),
          2500,
          "Окно overlay закрывается слишком долго.",
        ).catch((error: unknown) => {
          logError("interview.end", "Failed to close overlay window", error);
          console.error("Failed to close overlay window:", error);
          return false;
        });
        if (closedOverlay) {
          приложениеDismissed = true;
        } else {
          logWarn("interview.end", "Overlay stayed open, returning to dashboard view");
          setView("dashboard");
        }
      }
      logInfo("interview.end", "Interview finished");
    } catch (error) {
      logError("interview.end", "Failed to end interview cleanly", error);
      console.error("Failed to end interview cleanly:", error);
      setInterviewActive(false);
      endSession();
      setView("dashboard");
      if (isEmbeddedMode) {
        приложениеDismissed = true;
      }
    } finally {
      window.clearTimeout(endWatchdogId);
      if (!приложениеDismissed) {
        endingRef.current = false;
        setIsEndingInterview(false);
      }
    }
  }, [
    closeOverlayWindow,
    endSession,
    isEmbeddedMode,
    persistSessionToHistory,
    addMessage,
    setInterviewActive,
    setIsEndingInterview,
    setView,
    stopSttSessionGracefully,
  ]);

  useEffect(() => {
    return () => {
      if (endingRef.current) {
        return;
      }
      const endedAt = Date.now();
      const saved = persistSessionToHistoryRef.current(endedAt);
      if (saved) {
        useSessionStore.getState().endSession();
      }
    };
  }, []);

  // Global hotkeys (work outside app focus via Tauri plugin)
  const handleGlobalAction = useCallback(
    (action: string) => {
      logInfo("shortcuts.trigger", "Global shortcut action triggered", { action });
      switch (action) {
        case "send_to_llm":
          sendToLlm(false);
          break;
        case "send_with_screenshot":
          sendToLlm(true);
          break;
        case "end_interview":
          endInterview();
          break;
        case "switch_stt_language":
          void toggleSttLanguage();
          break;
      }
    },
    [endInterview, sendToLlm, toggleSttLanguage],
  );
  useGlobalShortcuts(handleGlobalAction, isActive);

  // In-window keyboard shortcuts (fallback when global not available)
  useEffect(() => {
    const pressedKeys = new Set<string>();

    const syncModifier = (token: string, active: boolean) => {
      if (active) {
        pressedKeys.add(token);
      } else {
        pressedKeys.delete(token);
      }
    };

    const syncModifierState = (event: KeyboardEvent) => {
      syncModifier("Alt", event.altKey);
      syncModifier("Ctrl", event.ctrlKey);
      syncModifier("Shift", event.shiftKey);
      syncModifier("Meta", event.metaKey);
    };

    const resolvePressedKeys = (event: KeyboardEvent): string[] => {
      syncModifierState(event);
      return normalizeHotkeyKeys(Array.from(pressedKeys));
    };

    const resolveEventHotkeyToken = (event: KeyboardEvent): string => {
      if (/^Key[A-Z]$/.test(event.code)) {
        return event.code.slice(3);
      }
      if (/^Digit[0-9]$/.test(event.code)) {
        return event.code.slice(5);
      }
      if (/^Numpad[0-9]$/.test(event.code)) {
        return event.code.slice(6);
      }
      return normalizeHotkeyToken(event.key);
    };

    function handleKeyDown(e: KeyboardEvent) {
      const pressedToken = resolveEventHotkeyToken(e);
      if (pressedToken) {
        pressedKeys.add(pressedToken);
      }

      const hotkeys = settings.hotkeys;
      const sendHk = hotkeys.find((h) => h.action === "send_to_llm");
      const sendScreenHk = hotkeys.find((h) => h.action === "send_with_screenshot");
      const endHk = hotkeys.find((h) => h.action === "end_interview");
      const switchLanguageHk = hotkeys.find((h) => h.action === "switch_stt_language");

      if (e.repeat) {
        return;
      }

      const pressed = resolvePressedKeys(e);

      if (matchHotkey(pressed, sendScreenHk?.keys ?? [])) {
        logInfo("shortcuts.trigger", "Window shortcut action triggered", { action: "send_with_screenshot" });
        e.preventDefault();
        sendToLlm(true);
      } else if (matchHotkey(pressed, sendHk?.keys ?? [])) {
        logInfo("shortcuts.trigger", "Window shortcut action triggered", { action: "send_to_llm" });
        e.preventDefault();
        sendToLlm(false);
      } else if (matchHotkey(pressed, endHk?.keys ?? [])) {
        logInfo("shortcuts.trigger", "Window shortcut action triggered", { action: "end_interview" });
        e.preventDefault();
        endInterview();
      } else if (matchHotkey(pressed, switchLanguageHk?.keys ?? [])) {
    logInfo("shortcuts.trigger", "Window shortcut action triggered", {
      action: "switch_speech_language",
    });
        e.preventDefault();
        void toggleSttLanguage();
      }
    }

    function handleKeyUp(e: KeyboardEvent) {
      const token = resolveEventHotkeyToken(e);
      if (token) {
        pressedKeys.delete(token);
      }
      syncModifierState(e);
    }

    function handleBlur() {
      pressedKeys.clear();
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [endInterview, sendToLlm, settings.hotkeys, toggleSttLanguage]);

  const sendHkLabel = formatHotkey(
    settings.hotkeys.find((h) => h.action === "send_to_llm")?.keys ?? [],
  );
  const sendScreenHkLabel = formatHotkey(
    settings.hotkeys.find((h) => h.action === "send_with_screenshot")?.keys ?? [],
  );
  const endHkLabel = formatHotkey(
    settings.hotkeys.find((h) => h.action === "end_interview")?.keys ?? [],
  );
  const switchLanguageHkLabel = formatHotkey(
    settings.hotkeys.find((h) => h.action === "switch_stt_language")?.keys ?? [],
  );
  const hasQuestionToSend =
    contextBuffer.length > 0 || manualQuestion.trim().length > 0;
  const visibleMessages = showFullTranscript ? messages : messages.slice(-4);
  const приложениеRootClassName = isEmbeddedMode
    ? "flex h-full min-h-0 w-full flex-col bg-black/20 text-zinc-100"
    : "h-screen w-screen flex flex-col bg-black/35 text-zinc-100 backdrop-blur-[1px]";
  const newMessagesButtonClassName = isEmbeddedMode
    ? "absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/95 px-3 py-1.5 text-xs font-medium text-zinc-100 shadow-lg transition-colors hover:bg-zinc-800"
    : "fixed bottom-36 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/95 px-3 py-1.5 text-xs font-medium text-zinc-100 shadow-lg transition-colors hover:bg-zinc-800";
  const chatAreaClassName =
    lastLlmResponse && !showFullTranscript
      ? "max-h-36 overflow-y-auto px-3 py-2 space-y-2 relative shrink-0 border-b border-zinc-800/70 bg-black/10"
      : "flex-1 overflow-y-auto px-3 py-3 space-y-2.5 relative";
  const isSafeMode = sessionMode === "safe";
  const sttNeedsAttention =
    !isSafeMode &&
    /ошибка|не поступает|не удалось|жёсткий|аудиосигнал пока|перезапуск stt не удался/i.test(
      sttStatusText,
    );
  const startupProgressRatio = Math.min(
    sttStartupElapsedMs / LIVE_MODEL_LOADING_ESTIMATE_MS,
    1,
  );
  const startupProgressPercent = isSttStarting
    ? Math.min(96, 8 + Math.round(startupProgressRatio * 86))
    : 0;
  const modelLoadingBannerVisible = !isSafeMode && (isSttStarting || Boolean(sttWarmupUi));
  const modelLoadingTitle = isSttStarting
    ? "Загружаем точный профиль распознавания"
    : sttWarmupUi?.title ?? "Подготавливаем распознавание";
  const modelLoadingProgressPercent = isSttStarting
    ? startupProgressPercent
    : sttWarmupUi?.progressPercent ?? 0;
  const modelLoadingElapsedLabel = isSttStarting
    ? `Прошло ${formatElapsed(sttStartupElapsedMs)}`
    : null;
  const modelLoadingHint = isSttStarting
    ? sttStartupElapsedMs > LIVE_MODEL_LOADING_ESTIMATE_MS
      ? "Large почти загружен или Windows продолжает читать большой языковой граф. Это не зависание: дождитесь статуса готовности."
      : "Large весит около 3.5 ГБ и загружается в память. Во время загрузки не нажимайте перезапуск аудио."
    : sttWarmupUi?.hint ?? sttStatusText;

  const openAudioSettings = () => {
    setSettingsTab("audio");
    setSettingsFocus("audio-devices");
    setView("settings");
  };

  return (
    <div className={приложениеRootClassName}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 border-b border-zinc-700/60 bg-black/35 shrink-0"
      >
        <div className="flex items-center gap-3 text-zinc-300">
          <div className="flex items-center gap-1.5">
            <Mic className="w-3.5 h-3.5" />
            <span className="text-[10px] text-zinc-400">MIC</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Volume2 className="w-3.5 h-3.5" />
            <span className="text-[10px] text-zinc-400">SYS</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Languages className="w-3.5 h-3.5" />
            <span className="text-[10px] text-zinc-400">
              {getLanguageLabel(activeSttLanguage)}
            </span>
          </div>
          {isSafeMode && (
            <span className="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-cyan-100">
              Режим без аудио
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-zinc-300">
          <Clock className="w-3.5 h-3.5" />
          <span className="text-xs font-mono">{formatElapsed(elapsedMs)}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowFullTranscript((current) => !current)}
          >
            {showFullTranscript ? "Компактно" : "Транскрипт"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void restartSttSession("manual");
            }}
            disabled={
              isSafeMode || !STT_AUTOSTART_ENABLED || isSttRecovering || isSttStarting
            }
            icon={
              isSttRecovering || isSttStarting ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RotateCcw className="w-3 h-3" />
              )
            }
            className="min-w-[135px]"
          >
            {isSafeMode ? "Аудио выкл." : isSttStarting ? "Загрузка..." : "Перезапуск аудио"}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={endInterview}
            disabled={isEndingInterview}
            icon={
              isEndingInterview ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Square className="w-3 h-3" />
              )
            }
            className="min-w-[105px]"
          >
            {isEndingInterview ? "Завершаем..." : `Завершить (${endHkLabel})`}
          </Button>
        </div>
      </div>

      {modelLoadingBannerVisible && (
        <div className="mx-3 mt-2 overflow-hidden rounded-xl border border-cyan-300/30 bg-cyan-950/45 shadow-[0_0_30px_rgba(34,211,238,0.12)]">
          <div className="flex flex-col gap-3 px-3 py-3 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-cyan-300/30 bg-cyan-300/10">
                <Loader2 className="h-4 w-4 animate-spin text-cyan-100" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-cyan-50">
                    {modelLoadingTitle}
                  </span>
                  <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-cyan-100">
                    Не зависло
                  </span>
                  {modelLoadingElapsedLabel && (
                    <span className="font-mono text-[11px] text-cyan-200/80">
                      {modelLoadingElapsedLabel}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-cyan-100/80">
                  {modelLoadingHint}
                </p>
              </div>
            </div>

            <div className="w-full shrink-0 md:w-64">
              <div className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.12em] text-cyan-100/75">
                <span>Подготовка</span>
                <span>{modelLoadingProgressPercent}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-cyan-950">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-300 via-sky-300 to-emerald-300 transition-[width] duration-500 ease-out"
                  style={{ width: `${modelLoadingProgressPercent}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {isSafeMode && (
        <div className="mx-3 mt-2 rounded-lg border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-xs text-cyan-50">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="leading-relaxed">
              Режим без аудио активен: распознавание не запускается.
              Доступны ручной вопрос, ножницы и ответы помощника.
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                onClick={openAudioSettings}
                className="rounded-md border border-cyan-300/25 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-cyan-50 hover:bg-cyan-300/10"
              >
                Настроить звук
              </button>
              <button
                type="button"
                onClick={() => setView("dashboard")}
                className="rounded-md border border-cyan-300/25 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-cyan-50 hover:bg-cyan-300/10"
              >
                WAV-тест
              </button>
              <button
                type="button"
                onClick={resumeLiveMode}
                className="rounded-md border border-cyan-300/25 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-cyan-50 hover:bg-cyan-300/10"
              >
                Вернуть звук
              </button>
            </div>
          </div>
        </div>
      )}

      {sttNeedsAttention && (
        <div className="mx-3 mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="leading-relaxed">
              Аудио требует внимания: можно перезапустить захват, открыть устройства или перейти
              на главную и записать WAV-тест.
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void restartSttSession("manual")}
                disabled={isSttRecovering || isSttStarting}
                className="rounded-md border border-amber-400/25 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-amber-50 hover:bg-amber-400/10 disabled:opacity-50"
              >
                {isSttStarting ? "Загрузка..." : "Перезапустить"}
              </button>
              <button
                type="button"
                onClick={openAudioSettings}
                className="rounded-md border border-amber-400/25 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-amber-50 hover:bg-amber-400/10"
              >
                Устройства
              </button>
              <button
                type="button"
                onClick={() => setView("dashboard")}
                className="rounded-md border border-amber-400/25 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-amber-50 hover:bg-amber-400/10"
              >
                WAV-тест
              </button>
              <button
                type="button"
                onClick={() =>
                  void activateSafeMode(
                    "Распознавание отключено вручную из панели восстановления.",
                  )
                }
                className="rounded-md border border-amber-400/25 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-amber-50 hover:bg-amber-400/10"
              >
                Без аудио
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chat area */}
      <div
        ref={chatContainerRef}
        onScroll={handleChatScroll}
        className={chatAreaClassName}
      >
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="w-full max-w-xl px-4">
              {sttWarmupUi && !modelLoadingBannerVisible && (
                <div className="mb-4 rounded-md border border-zinc-700/70 bg-zinc-950/80 px-4 py-3">
                  <div className="flex items-center justify-between gap-3 text-xs text-zinc-300">
                    <span className="font-medium text-zinc-100">{sttWarmupUi.title}</span>
                    <span className="font-mono text-zinc-400">
                      {sttWarmupUi.progressPercent}%
                    </span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-cyan-500 transition-[width] duration-300 ease-out"
                      style={{ width: `${sttWarmupUi.progressPercent}%` }}
                    />
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
                    {sttWarmupUi.hint}
                  </p>
                </div>
              )}
              <p className="text-center text-sm text-text-muted">
                {sttStatusText}
              </p>
            </div>
          </div>
        )}

        {!showFullTranscript && messages.length > visibleMessages.length && (
          <div className="text-center text-[10px] text-zinc-500">
            Показаны последние {visibleMessages.length} фразы. Полный транскрипт раскрывается вверху.
          </div>
        )}

        {visibleMessages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        <div ref={chatEndRef} />

        {!isAtBottom && newMsgCount > 0 && (
          <button
            onClick={jumpToBottom}
            className={newMessagesButtonClassName}
          >
            <ChevronDown className="w-3.5 h-3.5" />
            {newMsgCount} new message{newMsgCount > 1 ? "s" : ""}
          </button>
        )}
      </div>

      {/* AI Response Panel */}
      {lastLlmResponse && (
        <div className="mx-3 mb-2 bg-black/50 border border-zinc-700/80 rounded-lg overflow-hidden shrink-0">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-700/70 bg-zinc-900/55">
            <Bot className="w-3.5 h-3.5 text-zinc-200" />
            <span className="text-xs font-medium text-zinc-300">Подсказка</span>
            {lastRequestIntent && (
              <span
                className="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-cyan-100"
                title={lastRequestIntent.reason}
              >
                {getIntentModeLabel(lastRequestIntent.mode)}
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                setResponseExpanded((current) => !current);
              }}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-800/70"
              title={responseExpanded ? "Свернуть" : "Развернуть"}
            >
              {responseExpanded ? (
                <Minimize2 className="h-3 w-3" />
              ) : (
                <Maximize2 className="h-3 w-3" />
              )}
              {responseExpanded ? "Свернуть" : "Развернуть"}
            </button>
            <button
              type="button"
              onClick={() => {
                void copyLastResponse();
              }}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-800/70"
              title="Копировать"
            >
              <Copy className="h-3 w-3" />
              {copiedResponse ? "Скопировано" : "Копировать"}
            </button>
            {!lastLlmResponse.isStreaming && (
              <div className="flex items-center gap-1">
                <FeedbackButton
                  label="Хорошо"
                  active={отзываUi.sentRating === "good"}
                  loading={отзываUi.sending === "good"}
                  onClick={() => void sendAiFeedback("good")}
                />
                <FeedbackButton
                  label="Плохо"
                  active={отзываUi.sentRating === "bad"}
                  loading={отзываUi.sending === "bad"}
                  onClick={() => void sendAiFeedback("bad")}
                />
                <FeedbackButton
                  label="Не тот режим"
                  active={отзываUi.sentRating === "wrong_mode"}
                  loading={отзываUi.sending === "wrong_mode"}
                  onClick={() => void sendAiFeedback("wrong_mode")}
                />
              </div>
            )}
            {lastLlmResponse.isStreaming && (
              <Loader2 className="w-3 h-3 text-zinc-300 animate-spin" />
            )}
            {!lastLlmResponse.isStreaming && lastLlmResponse.totalLatencyMs && (
              <span className="text-[10px] text-zinc-500">
                {(lastLlmResponse.totalLatencyMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
          <div
            ref={aiPanelRef}
            onScroll={handleAiPanelScroll}
            className={`px-3 py-2 overflow-y-auto bg-black/20 ${responseExpanded ? "max-h-[62vh]" : "max-h-[46vh]"}`}
          >
            <p className="text-xs text-zinc-100 whitespace-pre-wrap leading-relaxed select-text">
              {lastLlmResponse.text || (
                <span className="text-zinc-500">Ждем ответ...</span>
              )}
            </p>
            {отзываUi.отзываId && (
              <div className="mt-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-100">
                Оценка отправлена: {отзываUi.отзываId}
              </div>
            )}
            {отзываUi.error && (
              <div className="mt-2 rounded-md border border-red-500/25 bg-red-500/10 px-2 py-1 text-[10px] text-red-100">
                {отзываUi.error}
              </div>
            )}
          </div>
        </div>
      )}

      {lastLlmError && (
        <div className="mx-3 mb-2 rounded-lg border border-red-900/70 bg-black/55 px-3 py-2 shrink-0">
          <p className="text-[11px] text-red-200 leading-relaxed">
            Ошибка сервиса: {lastLlmError}
          </p>
        </div>
      )}

      {/* Manual question input */}
      <div className="px-3 pb-2 shrink-0">
        <div className="mb-1.5 flex items-center gap-1 overflow-x-auto rounded-lg border border-zinc-800/70 bg-black/25 px-1.5 py-1">
          {INTERVIEW_INTENT_OPTIONS.map((option) => {
            const active = intentModeOverride === option.mode;
            return (
              <button
                key={option.mode}
                type="button"
                onClick={() => setIntentModeOverride(option.mode)}
                title={option.hint}
                className={`shrink-0 rounded-md px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] transition-colors ${
                  active
                    ? "border border-cyan-400/35 bg-cyan-400/15 text-cyan-100"
                    : "border border-transparent text-zinc-500 hover:border-zinc-700 hover:text-zinc-200"
                }`}
              >
                {option.shortLabel}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-zinc-700/70 bg-black/40 px-2 py-1.5">
          <input
            type="text"
            value={manualQuestion}
            onChange={(event) => setManualQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendToLlm(false);
              }
            }}
            placeholder="Введите вопрос вручную или отправьте ножницы без текста"
            className="h-8 w-full bg-transparent px-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none"
          />
        </div>
      </div>

      {cropDialogImageBase64 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-5xl rounded-2xl border border-zinc-600/70 bg-zinc-950/95 shadow-2xl">
            <div className="border-b border-zinc-700/70 px-4 py-3">
              <div className="text-sm font-semibold text-zinc-100">
                Ножницы: выделите область для отправки
              </div>
              <div className="mt-1 text-xs text-zinc-400">
                Зажмите левую кнопку мыши и выделите нужный фрагмент.
              </div>
            </div>

            <div className="max-h-[68vh] overflow-auto p-4">
              <div
                ref={cropContainerRef}
                className="relative mx-auto w-fit select-none"
                onPointerDown={(event) => {
                  const container = cropContainerRef.current;
                  if (!container) {
                    return;
                  }
                  const bounds = container.getBoundingClientRect();
                  const startX = clamp(event.clientX - bounds.left, 0, bounds.width);
                  const startY = clamp(event.clientY - bounds.top, 0, bounds.height);
                  cropStartRef.current = { x: startX, y: startY };
                  setCropRect({
                    x: startX,
                    y: startY,
                    width: 0,
                    height: 0,
                  });
                  setCropDragging(true);
                  container.setPointerCapture?.(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (!cropDragging || !cropStartRef.current) {
                    return;
                  }
                  const container = cropContainerRef.current;
                  if (!container) {
                    return;
                  }
                  const bounds = container.getBoundingClientRect();
                  const currentX = clamp(event.clientX - bounds.left, 0, bounds.width);
                  const currentY = clamp(event.clientY - bounds.top, 0, bounds.height);
                  const start = cropStartRef.current;
                  const x = Math.min(start.x, currentX);
                  const y = Math.min(start.y, currentY);
                  const width = Math.abs(currentX - start.x);
                  const height = Math.abs(currentY - start.y);
                  setCropRect({ x, y, width, height });
                }}
                onPointerUp={(event) => {
                  const container = cropContainerRef.current;
                  if (container) {
                    container.releasePointerCapture?.(event.pointerId);
                  }
                  cropStartRef.current = null;
                  setCropDragging(false);
                  setCropRect((current) => {
                    if (!current || current.width < 6 || current.height < 6) {
                      return null;
                    }
                    return current;
                  });
                }}
                onPointerLeave={() => {
                  if (!cropDragging) {
                    return;
                  }
                  cropStartRef.current = null;
                  setCropDragging(false);
                }}
              >
                <img
                  ref={cropImageRef}
                  src={`data:image/png;base64,${cropDialogImageBase64}`}
                  alt="Скриншот для выделения"
                  draggable={false}
                  className="max-h-[62vh] max-w-full rounded-md border border-zinc-700/70 object-contain"
                />
                {cropRect && (
                  <div
                    className="pointer-events-none absolute border-2 border-accent bg-accent/20"
                    style={{
                      left: `${cropRect.x}px`,
                      top: `${cropRect.y}px`,
                      width: `${cropRect.width}px`,
                      height: `${cropRect.height}px`,
                    }}
                  />
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-zinc-700/70 px-4 py-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => closeCropDialog(null)}
              >
                Отмена
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => closeCropDialog(cropDialogImageBase64)}
              >
                Отправить весь экран
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  void applyCropSelection();
                }}
                disabled={!cropRect}
                icon={<Scissors className="h-4 w-4" />}
              >
                Отправить выделение
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-zinc-700/70 bg-black/35 shrink-0">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => sendToLlm(false)}
          disabled={isLlmLoading || !hasQuestionToSend}
          icon={isLlmLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          className="flex-1"
        >
          Отправить ({sendHkLabel})
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => sendToLlm(true)}
          disabled={isLlmLoading}
          icon={isLlmLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scissors className="w-4 h-4" />}
          className="flex-1"
        >
          Ножницы: вырезать и отправить ({sendScreenHkLabel})
        </Button>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.source === "ai_marker") {
    return (
      <div className="flex justify-center">
        <span className="text-[10px] text-zinc-200 bg-zinc-900/80 border border-zinc-700 px-2 py-0.5 rounded-full">
          {message.text}
        </span>
      </div>
    );
  }

  const isInterviewer = message.source === "interviewer";

  return (
    <div className={`flex ${isInterviewer ? "justify-start" : "justify-end"}`}>
      <div
        className={`
          max-w-[75%] px-3 py-2 rounded-xl text-xs leading-relaxed select-text
          ${
            isInterviewer
              ? "bg-zinc-800/70 text-zinc-100 border border-zinc-700/80 rounded-bl-sm"
              : "bg-zinc-700/70 text-zinc-100 border border-zinc-600/80 rounded-br-sm"
          }
          ${!message.isFinal ? "opacity-60 italic" : ""}
        `}
      >
        <div className="text-[10px] text-zinc-400 mb-0.5 font-medium">
          {isInterviewer ? "Interviewer" : "You"}
        </div>
        {message.text}
      </div>
    </div>
  );
}

function FeedbackButton({
  label,
  active,
  loading,
  onClick,
}: {
  label: string;
  active: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] transition-colors ${
        active
          ? "border-emerald-500/35 bg-emerald-500/15 text-emerald-100"
          : "border-zinc-700 text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200"
      } disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {loading && <Loader2 className="h-3 w-3 animate-spin" />}
      {label}
    </button>
  );
}

function matchHotkey(pressedKeys: string[], keys: string[]): boolean {
  if (keys.length === 0) return false;
  const pressed = new Set(normalizeHotkeyKeys(pressedKeys));
  const normalizedKeys = normalizeHotkeyKeys(keys);
  if (pressed.size !== normalizedKeys.length) return false;
  return normalizedKeys.every((token) => pressed.has(token));
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function getIntentModeLabel(mode: InterviewIntentMode): string {
  return (
    INTERVIEW_INTENT_OPTIONS.find((option) => option.mode === mode)?.label ?? mode
  );
}

function inferManualIntentMode(text: string): InterviewIntent {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return { mode: "AUTO", reason: "ручной вопрос не задан" };
  }

  if (
    /\b(review|code review)\b|ревью|проверь|проверить|найди баг|найти баг|найди ошибки|найти ошибки|оцени код/.test(
      normalized,
    )
  ) {
    return { mode: "CODE_REVIEW", reason: "ручная просьба просит проверить код" };
  }

  if (
    /допиш|напиши код|напиши функцию|написать функцию|реализу|реализовать|реши|решить|добавь|добавить|\b(implement|complete|solve|fix)\b/.test(
      normalized,
    )
  ) {
    return { mode: "LIVE_CODING", reason: "ручная просьба просит написать или дописать код" };
  }

  if (
    /не работает|не запускается|падает|ошибк|stack|trace|exception|traceback|debug|отлад|failing test|compiler error|runtime error|crash|краш|сломал|сломалось|почему.{0,48}(не работает|падает|ошибк|краш|слом)/.test(
      normalized,
    )
  ) {
    return { mode: "DEBUG", reason: "ручная просьба описывает ошибку или поломку" };
  }

  return { mode: "AUTO", reason: "явного режима в ручном вопросе нет" };
}

function inferTextOnlyIntentMode(text: string): InterviewIntent {
  const explicitIntent = inferManualIntentMode(text);
  if (explicitIntent.mode !== "AUTO") {
    return explicitIntent;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return { mode: "AUTO", reason: "текст вопроса не задан" };
  }

  if (looksLikeCodeOrStackTrace(trimmed)) {
    return {
      mode: "CODE_REVIEW",
      reason: "текст похож на фрагмент кода без явной задачи",
    };
  }

  return {
    mode: "THEORY",
    reason: "текстовый вопрос без кода и скриншота",
  };
}

function looksLikeCodeOrStackTrace(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  const codePatterns = [
    /```/,
    /^\s*(import|export|function|class|interface|type|enum|const|let|var|public|private|protected|static|def|async|await)\b/im,
    /\b(return|throw|try|catch|finally|extends|implements|lambda)\b/i,
    /=>|===|!==|==|!=|;\s*$/m,
    /[{}]\s*$/m,
    /<\/?[a-z][\w-]*(\s+[^>]*)?>/i,
    /^\s*(select|insert|update|delete|with)\b[\s\S]+\b(from|set|values|where|join)\b/im,
    /\bat\s+[\w.$]+\([^)]*:\d+:\d+\)/i,
    /\b(nullpointerexception|syntaxerror|typeerror|referenceerror|traceback|stack trace)\b/i,
  ];

  return codePatterns.some((pattern) => pattern.test(normalized));
}

function looksLikeTheoryQuestion(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized || looksLikeCodeOrStackTrace(normalized)) {
    return false;
  }

  return (
    /\?$/.test(normalized) ||
    /(^|[\s.,:;!?()[\]{}"'«»])(что такое|объясни|расскажи|зачем|как работает|какие|какой|какая|какое|уровни|виды|типы|отличие|разница|принципы|концепц|архитектур|транзакц|изоляц|индекс|postgres|postgresql|постгрес|постгрей|пас грей|пасгрей|база данных|бд)(?=$|[\s.,:;!?()[\]{}"'«»])/.test(
      normalized,
    )
  );
}

function resolveRequestIntentMode(
  manualQuestion: string,
  requestText: string,
  screenshotMode: boolean,
  overrideMode: InterviewIntentMode,
): InterviewIntent {
  if (overrideMode !== "AUTO") {
    return {
      mode: overrideMode,
      reason: `режим выбран вручную: ${getIntentModeLabel(overrideMode)}`,
    };
  }

  const manualIntent = inferManualIntentMode(manualQuestion);
  if (manualIntent.mode !== "AUTO") {
    return manualIntent;
  }

  if (manualQuestion.trim() && screenshotMode && looksLikeTheoryQuestion(manualQuestion)) {
    return {
      mode: "THEORY",
      reason: "ручной вопрос выглядит как устная теория без кода",
    };
  }

  if (screenshotMode) {
    return {
      mode: "AUTO",
      reason: "режим будет выбран по скриншоту/OCR",
    };
  }

  return inferTextOnlyIntentMode(requestText);
}

function buildInterviewPrompt({
  transcript,
  interviewContext,
  screenshotMode = false,
  manualQuestion = "",
  forcedIntent,
}: {
  transcript: string;
  interviewContext: string;
  screenshotMode?: boolean;
  manualQuestion?: string;
  forcedIntent?: InterviewIntent;
}): string {
  const normalizedContext = interviewContext.trim();
  const contextBlock = normalizedContext
    ? `Контекст интервью:\n${normalizedContext}\n\n`
    : "Контекст интервью:\nТехническое собеседование по разработке программного обеспечения.\n\n";
  const manualIntent = inferManualIntentMode(manualQuestion);
  const manualBlock = manualQuestion.trim()
    ? `Ручная просьба:\n${manualQuestion.trim()}\n\nПредварительный routing по ручной просьбе: ${manualIntent.mode} (${manualIntent.reason}). Если это не AUTO, считай его приоритетнее OCR и изображения.\n\n`
    : "";
  const forcedIntentBlock =
    forcedIntent && forcedIntent.mode !== "AUTO"
      ? `Режим уже определен приложением: ${forcedIntent.mode} (${forcedIntent.reason}). Это жесткое указание. Не меняй режим на другой, даже если вокруг есть слова про routing, патч или ревью.\n\n`
      : "";

  const intentRules = `Routing перед ответом:
1. Сначала выбери ровно один режим: LIVE_CODING, DEBUG, CODE_REVIEW или THEORY.
2. Приоритет источников: ручная просьба > явная формулировка на скриншоте/OCR > ошибка/stack trace > просто видимый код > общий разговор.
3. LIVE_CODING: пользователь просит написать, дописать, implement, complete, solve, fix, реализовать метод, добавить фрагмент, решить алгоритмическую задачу. В этом режиме не делай ревью, сразу дай решение.
4. DEBUG: виден stack trace, exception, failing test, compiler/runtime error, "почему не работает", "падает", "разберись с ошибкой". Дай причину и конкретную правку.
5. CODE_REVIEW: пользователь просит ревью/проверку/найти баги или на скриншоте только код без явной задачи и без ошибки. Дай риски и минимальный патч.
6. THEORY: вопрос без кода: концепция, архитектура, технология, trade-offs, устная формулировка. Если запрос текстовый и в нем нет кода/stack trace/скриншота, это THEORY, а не CODE_REVIEW.
7. Если на скриншоте есть код и слова "implement/complete/solve/fix/дописать/написать функцию", это LIVE_CODING даже если код выглядит как кандидат для ревью.
8. Если ручная просьба противоречит скриншоту, выполняй ручную просьбу.

Примеры routing:
- "допиши функцию twoSum" + код => LIVE_CODING.
- "почему падает этот тест?" + stack trace => DEBUG.
- "проверь этот код" + код => CODE_REVIEW.
- только код без задачи => CODE_REVIEW.
- "что такое индексы в БД?" => THEORY.
- "уровни изоляции транзакций в PostgreSQL" => THEORY.
- "уровни изоляции транзакций в пас грейся" => THEORY, распознай как PostgreSQL.`;

  const screenshotBlock = screenshotMode
    ? `Режим скриншота:
- Используй изображение/OCR как главный источник задачи.
- Не делай code review, если на скриншоте или в ручном вопросе просят дописать, исправить или решить.
- Если OCR и изображение расходятся, доверься смыслу видимого интерфейса и формулировке на экране.
- Если задача неоднозначна, назови выбранный режим в первой строке и дай самое полезное действие.\n\n`
    : "";
  const finalIntentReminder =
    forcedIntent && forcedIntent.mode !== "AUTO"
      ? `\n\nФинальное обязательное решение routing для этого запроса: ${forcedIntent.mode}. Ответь именно в этом режиме. Не выводи одно только название режима; дай полезный ответ по сути.`
      : !screenshotMode
        ? "\n\nФинальное правило для текстового запроса: если в транскрипте нет кода, stack trace или явной просьбы о ревью, выбери THEORY и дай устный ответ по теме."
        : "";

  return `${contextBlock}${manualBlock}${forcedIntentBlock}Важно:
- в расшифровке могут быть ошибки STT, особенно в названиях языков, библиотек, технологий и терминов;
- если слово распознано неточно, интерпретируй его в пользу технического смысла: например "пас грейся", "постгрей" или "постгрес" = PostgreSQL;
- не пиши академические определения и длинные теоретические абзацы;
- ответ должен быть прикладным и пригодным для устного ответа на собеседовании;
- отвечай кратко, но с конкретикой: код, причина, патч или готовая формулировка.\n\n${intentRules}\n\n${screenshotBlock}Формат ответа строго:
1) Режим: LIVE_CODING / DEBUG / CODE_REVIEW / THEORY.
2) Суть: 1-2 короткие фразы.
3) Что сказать вслух: готовая формулировка до 2 предложений.
4) Если LIVE_CODING: минимальное решение или недостающий фрагмент кода.
5) Если DEBUG: причина ошибки и конкретная правка.
6) Если CODE_REVIEW: баги/риски и минимальный патч.
7) Если THEORY: короткое объяснение и практический пример. Не предлагай патч, code review или "следующие шаги".\n\nТранскрипт интервью:\n${transcript}${finalIntentReminder}\n\nДай ответ по выбранному режиму.`;
}

async function captureScreenshotAsBase64Png(): Promise<string> {
  const { isTauri, captureScreenPngBase64 } = await import("@/lib/tauri");
  if (isTauri()) {
    return withTimeout(
      captureScreenPngBase64(),
      SCREENSHOT_PICKER_TIMEOUT_MS,
      "Не удалось быстро получить снимок экрана.",
    );
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Screen capture API is not available.");
  }

  const stream = await withTimeout(
    navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1 },
      audio: false,
    }),
    SCREENSHOT_PICKER_TIMEOUT_MS,
    "Истекло время ожидания выбора окна для скриншота.",
  );

  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => {
          video
            .play()
            .then(() => resolve())
            .catch((err) => reject(err));
        };
        video.onerror = () => reject(new Error("Failed to load captured video stream."));
      }),
      SCREENSHOT_STREAM_READY_TIMEOUT_MS,
      "Не удалось получить кадр с выбранного экрана.",
    );

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      throw new Error("Captured frame has invalid dimensions.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to create canvas context for screenshot.");
    }
    ctx.drawImage(video, 0, 0, width, height);
    video.pause();

    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.split(",")[1];
    if (!base64) {
      throw new Error("Failed to encode screenshot as base64.");
    }
    return base64;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function cropBase64PngByRect(
  imageBase64: string,
  rect: CropRect,
  imageElement: HTMLImageElement,
): Promise<string> {
  const displayWidth = imageElement.clientWidth;
  const displayHeight = imageElement.clientHeight;
  const naturalWidth = imageElement.naturalWidth;
  const naturalHeight = imageElement.naturalHeight;

  if (!displayWidth || !displayHeight || !naturalWidth || !naturalHeight) {
    return imageBase64;
  }

  const scaleX = naturalWidth / displayWidth;
  const scaleY = naturalHeight / displayHeight;

  const sourceX = clamp(Math.round(rect.x * scaleX), 0, naturalWidth - 1);
  const sourceY = clamp(Math.round(rect.y * scaleY), 0, naturalHeight - 1);
  const sourceWidth = clamp(
    Math.round(rect.width * scaleX),
    1,
    naturalWidth - sourceX,
  );
  const sourceHeight = clamp(
    Math.round(rect.height * scaleY),
    1,
    naturalHeight - sourceY,
  );

  const image = await loadBase64Png(imageBase64);
  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return imageBase64;
  }
  ctx.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );
  const croppedDataUrl = canvas.toDataURL("image/png");
  const croppedBase64 = croppedDataUrl.split(",")[1];
  return croppedBase64 || imageBase64;
}

async function loadBase64Png(imageBase64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load screenshot image for crop."));
    image.src = `data:image/png;base64,${imageBase64}`;
  });
}

async function tryExtractOcrText(
  imageBase64: string,
): Promise<string | null> {
  const { isTauri, ocrImage } = await import("@/lib/tauri");
  if (!isTauri()) {
    return null;
  }

  try {
    const text = await ocrImage(imageBase64);
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}
