import { useState, useEffect, useRef, useCallback } from "react";
import type { ClipboardEvent as ReactClipboardEvent, ReactNode } from "react";
import {
  Send,
  Scissors,
  Square,
  Mic,
  Volume2,
  Clock,
  ChevronDown,
  Bot,
  Loader2,
  Copy,
  RotateCcw,
  History,
  Paperclip,
  AudioLines,
  AlignLeft,
  X,
} from "lucide-react";
import { planLimitsFor, remainingOf } from "@/lib/plans";
import { Button } from "@/components/ui/Button";
import { useT } from "@/lib/i18n";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useAppStore } from "@/stores/app";
import { useHistoryStore } from "@/stores/history";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import {
  buildLiveSttWebSocketUrl,
  formatProxyHintResponse,
  ProxyApiError,
  PROXY_BASE_URL,
  requestLiveSttTranscribeLatest,
  requestProxyHint,
  submitAiFeedback,
  type AiFeedbackRating,
  type LiveSttTranscribeLatestResponse,
} from "@/lib/proxy";
import { useLicenseStore } from "@/stores/license";
import { getLanguageLabel, getLanguageShortLabel } from "@/lib/languages";
import { isKnownSubtitleCreditNoise } from "@/lib/sttNoise";
import { describeDroppedSelection, repairAudioSelection } from "@/lib/audioSelection";
import { appendUtterance, dictationAcceptsTrack } from "@/lib/speechInput";
import { countHiddenPhrases, selectVisibleMessages } from "@/lib/transcriptWindow";
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
import { blobToBase64Png, cropBase64PngByRect, type CropRect } from "@/lib/imageCrop";
import { buildAssistantContext } from "@/lib/interviewContext";
import type {
  ChatMessage,
  DictationSource,
  LlmResponse,
  PrimaryLanguage,
  SessionRecord,
} from "@/lib/types";
import type {
  AudioDeviceInfo,
  AudioSignalProbeTrack,
  ServerSttChunkTrack,
  SttDiagnosticEvent,
  SttResultEvent,
  WhisperModelOption,
} from "@/lib/tauri";

type PersistStoreLike = {
  persist?: {
    hasHydrated?: () => boolean;
    onFinishHydration?: (callback: () => void) => () => void;
  };
};

const STT_MODEL_LOOKUP_TIMEOUT_MS = 6000;
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
const SETTINGS_HYDRATION_WATCHDOG_MS = 2500;
const STT_AUTOSTART_ENABLED = true;
const STT_STRICT_AUDIO_MODE = true;
/**
 * Recognition runs locally on Whisper: audio never leaves the machine, mixed-language
 * speech works without swapping models, and the request to the backend carries text
 * instead of a WAV — which is what used to trip the 1 MB limit on the upstream proxy.
 *
 * Kept as a constant rather than deleted so the server path stays reachable if the
 * local engine has to be bypassed.
 */
const STT_ENGINE_SERVER_ONLY = true;
const SERVER_STT_OPTIMISTIC_START = true;
const SERVER_STT_STREAM_CHUNK_SECONDS = 1;
const SERVER_STT_LOOP_GAP_MS = 100;
// While dictating we drain the capture runtime far more often so words reach the
// input field close to real time instead of once per second.
const DICTATION_CHUNK_MS = 250;
const DICTATION_FINAL_WAIT_MS = 1800;
const DICTATION_MAX_DURATION_MS = 2 * 60 * 1000;
const SERVER_STT_RETRY_BASE_MS = 1200;
const SERVER_STT_WS_READY_TIMEOUT_MS = 15000;
const SERVER_STT_TRANSCRIBE_WINDOW_SECONDS = 12;
const SERVER_STT_BUFFER_RETAIN_TAIL_SECONDS = 0;
const SERVER_STT_CONTEXT_HINT_MAX_CHARS = 420;
const SERVER_STT_AUTO_TRANSCRIBE_ENABLED = false;
const SERVER_STT_AUTO_TRANSCRIBE_INTERVAL_MS = 3200;
const SERVER_STT_AUTO_TRANSCRIBE_WINDOW_SECONDS = 6;
const SERVER_STT_LOCAL_SIGNAL_RMS_THRESHOLD = 70;
const SERVER_STT_LOCAL_SIGNAL_PEAK_THRESHOLD = 700;
const SERVER_STT_AUDIO_AUTOPROBE_AFTER_SILENT_CHUNKS = 5;
const SERVER_STT_AUDIO_AUTOPROBE_COOLDOWN_MS = 30000;
const TRANSCRIPT_MEMORY_MESSAGE_LIMIT = 16;
const TRANSCRIPT_MEMORY_MAX_AGE_MS = 3 * 60 * 1000;
const TRANSCRIPT_MEMORY_FALLBACK_WITH_SCREENSHOT_ONLY = true;

type TranscriptAssessment = {
  usable: boolean;
  reason?: string;
};

type InterviewOverlayMode = "embedded" | "detached";

type InterviewOverlayProps = {
  mode?: InterviewOverlayMode;
};

type InterviewIntentMode = "LIVE_CODING" | "DEBUG" | "CODE_REVIEW" | "THEORY" | "AUTO";

type InterviewIntent = {
  mode: InterviewIntentMode;
  reason: string;
};

/** Dictation events pushed by the backend over the live audio websocket. */
type DictationServerEvent = {
  type: string;
  dictationId?: string;
  text?: string;
  completed?: boolean;
  code?: string;
  message?: string;
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
  /** Set when a saved device had vanished and was reset to the Windows default. */
  repairNotice: string | null;
};

type CropDialogResult = {
  image: string;
  prompt: string;
};

type SttWarmupUiState = {
  progressPercent: number;
  title: string;
  hint: string;
};

const INTENT_MODE_LABELS: Record<InterviewIntentMode, string> = {
  AUTO: "Авто",
  LIVE_CODING: "Дописать код",
  DEBUG: "Дебаг",
  CODE_REVIEW: "Ревью",
  THEORY: "Теория",
};


const TECHNICAL_SINGLE_TERMS = new Set([
  "acid",
  "api",
  "crud",
  "docker",
  "git",
  "grpc",
  "hibernate",
  "http",
  "https",
  "java",
  "javascript",
  "jpa",
  "json",
  "jwt",
  "k8s",
  "kafka",
  "kotlin",
  "kubernetes",
  "linux",
  "mongodb",
  "mvcc",
  "mysql",
  "nginx",
  "node",
  "oauth",
  "orm",
  "postgres",
  "postgresql",
  "python",
  "react",
  "redis",
  "rest",
  "spring",
  "sql",
  "tcp",
  "tls",
  "typescript",
  "udp",
]);

const SPEECH_TEST_TOKENS = new Set([
  "алло",
  "проверка",
  "раз",
  "тест",
  "cyclic",
  "hello",
  "one",
  "test",
  "testing",
  "three",
  "two",
]);

function tokenizeTranscript(text: string): string[] {
  return text.match(/[A-Za-zА-Яа-яЁё0-9+#.]+/g) ?? [];
}

function isTechnicalSingleToken(token: string): boolean {
  const normalized = token.replace(/^[^A-Za-zА-Яа-яЁё0-9+#.]+|[^A-Za-zА-Яа-яЁё0-9+#.]+$/g, "");
  if (!normalized) {
    return false;
  }
  const lower = normalized.toLowerCase();
  if (TECHNICAL_SINGLE_TERMS.has(lower)) {
    return true;
  }
  return /^[A-Z0-9+#.]{2,}$/.test(normalized);
}

function assessLiveTranscriptText(text: string): TranscriptAssessment {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return { usable: false, reason: "пустой текст" };
  }
  if (isKnownSubtitleCreditNoise(normalized)) {
    return { usable: false, reason: "служебная фраза субтитров" };
  }

  const tokens = tokenizeTranscript(normalized);
  if (tokens.length === 0) {
    return { usable: false, reason: "нет слов" };
  }

  const lowerTokens = tokens.map((token) => token.toLowerCase());
  const nonTestTokens = lowerTokens.filter((token) => !SPEECH_TEST_TOKENS.has(token));
  if (nonTestTokens.length === 0 || (normalized.toLowerCase().includes("раз-раз") && tokens.length <= 4)) {
    return { usable: false, reason: "похоже на проверку микрофона" };
  }

  if (tokens.length >= 2) {
    return { usable: true };
  }

  if (isTechnicalSingleToken(tokens[0])) {
    return { usable: true };
  }

  return {
    usable: false,
    reason: "один нетехнический фрагмент, похоже на ошибку распознавания",
  };
}

function getTranscriptMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (message) => message.source !== "ai_marker" && message.text.trim().length > 0,
  );
}

function getRecentTranscriptMemoryMessages(messages: ChatMessage[]): ChatMessage[] {
  const transcriptMessages = getTranscriptMessages(messages);
  if (transcriptMessages.length === 0) {
    return [];
  }

  const now = Date.now();
  const recentMessages = transcriptMessages.filter(
    (message) => now - message.timestamp <= TRANSCRIPT_MEMORY_MAX_AGE_MS,
  );
  const candidates = recentMessages.length > 0 ? recentMessages : transcriptMessages;
  return candidates.slice(Math.max(0, candidates.length - TRANSCRIPT_MEMORY_MESSAGE_LIMIT));
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function toFriendlyLiveTrackDetail(detail: string): string {
  const normalized = detail.trim().toLowerCase();
  if (!normalized || normalized === "ok") {
    return "ok";
  }
  if (normalized.includes("near silence")) {
    return "Сигнал слишком тихий (почти тишина). Скажи громче или подними уровень микрофона.";
  }
  if (normalized.includes("too short")) {
    return "Аудиофрагмент слишком короткий для распознавания.";
  }
  if (normalized.includes("empty transcript")) {
    return "Распознавание прошло, но текст не получен.";
  }
  return detail;
}

function liveTrackHasLocalSignal(track: ServerSttChunkTrack): boolean {
  return (
    track.available &&
    (track.rms >= SERVER_STT_LOCAL_SIGNAL_RMS_THRESHOLD ||
      track.peak_abs >= SERVER_STT_LOCAL_SIGNAL_PEAK_THRESHOLD)
  );
}

function formatLiveTrackDevice(track: ServerSttChunkTrack): string {
  return track.device_name?.trim() || track.requested_device_id?.trim() || "устройство по умолчанию";
}

function formatProbeTrack(track: AudioSignalProbeTrack | null): string {
  if (!track) {
    return "не найдено";
  }
  const name = track.device?.name ?? track.device_name ?? track.device_id ?? "неизвестное устройство";
  return `${name} (rms ${Math.round(track.rms)}, peak ${track.peak_abs})`;
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
  const t = useT();
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
    snipsUsed,
    uploadsUsed,
    audioHintsUsed,
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
    noteSnipUsed,
    noteUploadUsed,
    noteAudioHintUsed,
  } = session;

  // Лимиты тарифа: клиентская матрица (plans.ts) поверх статуса лицензии.
  // Гейты здесь — UX-слой; серверный enforcement добавится своей фазой.
  const licenseAuthStatus = useLicenseStore((s) => s.authStatus);
  const licensePlanRaw = useLicenseStore((s) => s.snapshot?.plan ?? null);
  const planLimits = planLimitsFor(licenseAuthStatus, licensePlanRaw);
  const snipsRemaining = remainingOf(planLimits.scissorsPerInterview, snipsUsed);
  const uploadsRemaining = remainingOf(planLimits.uploadsPerInterview, uploadsUsed);
  const audioHintsRemaining = remainingOf(planLimits.audioHintsPerInterview, audioHintsUsed);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [newMsgCount, setNewMsgCount] = useState(0);
  const [aiPanelAtBottom, setAiPanelAtBottom] = useState(true);
  const [lastLlmError, setLastLlmError] = useState<string | null>(null);
  // Ref flag so we announce "license expired" once per expiry episode instead of
  // spamming a marker on every F8/F9 while the license is expired.
  const licenseExpiredAnnouncedRef = useRef(false);
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
  // Live per-source audio activity, driven from the capture loop, used to animate
  // the MIC/SYS status chips.
  const [audioActivity, setAudioActivity] = useState<{ mic: boolean; system: boolean }>({
    mic: false,
    system: false,
  });
  const [sttWarmupModelId, setSttWarmupModelId] = useState<string | null>(null);
  const [sttWarmupUi, setSttWarmupUi] = useState<SttWarmupUiState | null>(null);
  const [isSttStarting, setIsSttStarting] = useState(false);
  const [sttStartupStartedAt, setSttStartupStartedAt] = useState<number | null>(null);
  const [sttStartupElapsedMs, setSttStartupElapsedMs] = useState(0);
  const [isSttRecovering, setIsSttRecovering] = useState(false);
  const [serverSttRestartNonce, setServerSttRestartNonce] = useState(0);
  const [manualQuestion, setManualQuestion] = useState("");
  const [isDictating, setIsDictating] = useState(false);
  const [dictationHint, setDictationHint] = useState<string | null>(null);
  const [isRecognitionReady, setIsRecognitionReady] = useState(false);
  const [cropDialogImageBase64, setCropDialogImageBase64] = useState<string | null>(
    null,
  );
  const [pastedImageBase64, setPastedImageBase64] = useState<string | null>(null);
  const [cropPrompt, setCropPrompt] = useState("");
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [cropDragging, setCropDragging] = useState(false);
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
  const cropResolverRef = useRef<((result: CropDialogResult | null) => void) | null>(null);
  const cropPromptRef = useRef("");
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
  const serverSttLiveRef = useRef<{ socket: WebSocket | null; streamId: string | null }>({
    socket: null,
    streamId: null,
  });
  // Push-to-talk audio hint: press once to start recording the interviewer, press
  // again to send the buffered audio straight to Gemini (no local STT). The audio
  // stream is already running (STT_ENGINE_SERVER_ONLY), so we only track how long we
  // recorded and the server drains exactly that tail. The socket's message handler
  // lives inside the live-socket effect, so it reaches the latest renderer via a ref.
  const [audioHintRecording, setAudioHintRecording] = useState(false);
  const audioHintStartRef = useRef(0);
  // True between sending hint.audio and getting a hint/error back, so the socket
  // can tell an audio-hint error apart from a background stream error.
  const audioHintPendingRef = useRef(false);
  const audioHintMsgRef = useRef<
    (payload: { type?: string; output?: string; nextSteps?: string[]; message?: string; code?: string }) => void
  >(() => {});
  // "Last N seconds" quick hint: a second button that grabs the trailing window of
  // the already-running audio stream and sends it to Gemini in one click — no manual
  // start/stop like push-to-talk. The window length is the user's own setting
  // (settings.audioHintWindowSeconds, 3–15s), sent as an explicit `seconds`.
  const [audioHintTailSending, setAudioHintTailSending] = useState(false);
  // Dictation: the text the input already had when recording started, so every
  // transcript update can simply be appended to it.
  //
  // `settledText` exists because the local engine reports one utterance at a time
  // rather than the full dictation: finalised utterances accumulate here, and the
  // in-flight partial is rendered on top of them without being committed.
  const dictationRef = useRef<{
    id: string | null;
    baseText: string;
    lastText: string;
    settledText: string;
    /** When the last utterance was committed, so the next one knows if a sentence ended. */
    lastUtteranceAt: number;
    finalResolvers: Array<() => void>;
  }>({
    id: null,
    baseText: "",
    lastText: "",
    settledText: "",
    lastUtteranceAt: 0,
    finalResolvers: [],
  });
  // Two flags on purpose. `dictationActiveRef` means "microphone text is being routed
  // to the input" and stays on through the tail window after the button is released;
  // `dictationRecordingRef` means "the user is holding the button" and drops at once.
  // Guarding start/stop on the first one made every stop block the next dictation for
  // the whole tail delay.
  const dictationActiveRef = useRef(false);
  const dictationRecordingRef = useRef(false);
  // Dictated text is cleared from the input once it has been sent; text the user
  // typed themselves is left alone.
  const dictationProducedTextRef = useRef(false);
  // sendToLlm awaits the dictation tail, so it cannot read the question from a
  // closure captured before that await.
  const manualQuestionRef = useRef("");
  // Mirrors the "Что слушать" setting for handleSttResult, which is memoised with
  // stable deps and would otherwise capture whatever the value was on mount.
  const dictationSourceRef = useRef<DictationSource>(settings.dictationSource);

  useEffect(() => {
    manualQuestionRef.current = manualQuestion;
  }, [manualQuestion]);

  useEffect(() => {
    dictationSourceRef.current = settings.dictationSource;
  }, [settings.dictationSource]);

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
    let finished = false;

    const markHydrated = (source: string) => {
      if (finished) {
        return;
      }
      finished = true;
      logInfo("settings.hydration", "Settings hydration ready", { source });
      setSettingsHydrated(true);
    };

    const hasHydrated = store.persist?.hasHydrated?.() ?? true;
    if (hasHydrated) {
      markHydrated("initial");
      return;
    }

    const unsubscribe = store.persist?.onFinishHydration?.(() => {
      markHydrated("finish");
    });
    const watchdog = window.setTimeout(() => {
      const snapshot = useSettingsStore.getState();
      logWarn("settings.hydration", "Settings hydration event was not received; continuing", {
        hasApiKey: Boolean(snapshot.apiKey.trim()),
        provider: snapshot.provider,
        baseUrlPreset: snapshot.baseUrlPreset,
        elapsedMs: SETTINGS_HYDRATION_WATCHDOG_MS,
      });
      markHydrated("watchdog");
    }, SETTINGS_HYDRATION_WATCHDOG_MS);

    return () => {
      finished = true;
      window.clearTimeout(watchdog);
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

      let trimmedMic = requestedMic?.trim() ?? "";
      let trimmedSystem = requestedSystem?.trim() ?? "";
      let microphoneDeviceId = trimmedMic || undefined;
      let systemAudioDeviceId = trimmedSystem || undefined;
      let microphoneLabel = microphoneDeviceId || "Windows default microphone";
      let systemAudioLabel = systemAudioDeviceId || "Windows default output";
      let usedWindowsDefaultMic = !microphoneDeviceId;
      let usedWindowsDefaultSystem = !systemAudioDeviceId;
      let repairNotice: string | null = null;

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
            repairNotice,
          };
        }

        const devices = await listAudioDevices();

        // A saved endpoint that no longer exists is not a reason to refuse to start.
        // Strict mode is there to stop us from silently recording the wrong device —
        // but an id that resolves to nothing cannot be the wrong device, it is simply
        // gone. Drop it back to the Windows default here, persist that, and let the
        // resolution below run as if the user had never picked it.
        const repair = repairAudioSelection(
          { microphoneDeviceId: trimmedMic, systemAudioDeviceId: trimmedSystem },
          devices,
        );
        if (repair.droppedMicrophoneId || repair.droppedSystemAudioId) {
          logWarn("speech.session", "Dropped audio selection that no longer resolves", {
            droppedMicrophoneId: repair.droppedMicrophoneId,
            droppedSystemAudioId: repair.droppedSystemAudioId,
            outputDevices: devices.filter((device) => !device.is_input).length,
            inputDevices: devices.filter((device) => device.is_input).length,
          });
          // Persisted so the dashboard, the settings page and the next start all agree
          // instead of each rediscovering the dead id on its own.
          if (repair.droppedMicrophoneId) {
            useSettingsStore.getState().setMicrophoneDeviceId("");
          }
          if (repair.droppedSystemAudioId) {
            useSettingsStore.getState().setSystemAudioDeviceId("");
          }
          trimmedMic = repair.microphoneDeviceId;
          trimmedSystem = repair.systemAudioDeviceId;
          microphoneDeviceId = trimmedMic || undefined;
          systemAudioDeviceId = trimmedSystem || undefined;
          usedWindowsDefaultMic = !microphoneDeviceId;
          usedWindowsDefaultSystem = !systemAudioDeviceId;
          repairNotice = describeDroppedSelection(repair);
        }

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
        repairNotice,
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
      const { startSttSession } = await import("@/lib/tauri");
      logInfo("speech.session", "Starting speech session", {
        microphoneDeviceId: resolvedSelection.microphoneDeviceId || "(default)",
        microphoneLabel: resolvedSelection.microphoneLabel,
        systemAudioDeviceId: resolvedSelection.systemAudioDeviceId || "(default)",
        systemAudioLabel: resolvedSelection.systemAudioLabel,
        usedWindowsDefaultMic: resolvedSelection.usedWindowsDefaultMic,
        usedWindowsDefaultSystem: resolvedSelection.usedWindowsDefaultSystem,
        strictAudioMode: STT_STRICT_AUDIO_MODE,
      });
      if (resolvedSelection.repairNotice) {
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: resolvedSelection.repairNotice,
          isFinal: true,
        });
      }
      sttStartupInProgressRef.current = true;
      const startupStartedAt = Date.now();
      setSttStartupStartedAt(startupStartedAt);
      setSttStartupElapsedMs(0);
      setIsSttStarting(true);
      setSttStatusText(
        "Загружаем модель распознавания. Первый запуск может занять до минуты...",
      );
      try {
        await withTimeout(
          startSttSession({
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
      // Drives the dictation button and the send button: both were gated on a flag
      // that only the (now unused) server path ever set, which left them dead.
      setIsRecognitionReady(true);
      logInfo("speech.session", "Speech session started", {
        microphoneLabel: resolvedSelection.microphoneLabel,
        systemAudioLabel: resolvedSelection.systemAudioLabel,
      });
    },
    [addMessage, resolveConcreteAudioSelection],
  );

  const stopSttSessionGracefully = useCallback(
    async (reason: "restart" | "language_switch" | "cleanup") => {
      if (STT_ENGINE_SERVER_ONLY) {
        sttAcceptingResultsRef.current = false;
        const { isTauri, stopServerSttLiveCapture } = await import("@/lib/tauri");
        if (isTauri()) {
          await stopServerSttLiveCapture().catch((error) => {
            logWarn("speech.stop", "Server live audio capture cleanup failed", {
              reason,
              detail: toErrorDetail(error),
            });
          });
        }
        return;
      }

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
        setIsRecognitionReady(false);
        // Recognition is going away, so any dictation riding on it is over too.
        // Without this the button stays stuck in its red recording state, and the
        // only way out was the two-minute safety valve.
        //
        // Inlined rather than calling finishDictationLocally: that helper is declared
        // further down the file, so naming it as a dependency here would hit the
        // temporal dead zone and throw during render.
        if (dictationActiveRef.current) {
          dictationRecordingRef.current = false;
          dictationActiveRef.current = false;
          setIsDictating(false);
          setDictationHint("Распознавание остановлено — диктовка прервана.");
        }
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
      if (STT_ENGINE_SERVER_ONLY) {
        if (sttRecoveryInProgressRef.current) {
          return false;
        }
        sttRecoveryInProgressRef.current = true;
        setIsSttRecovering(true);
        try {
          setSttStatusText("Перезапускаем серверное распознавание...");
          sttSignalSeenRef.current = { mic: false, system: false };
          sttTranscriptSeenRef.current = { mic: false, system: false };
          sttNoSignalNoticeShownRef.current = false;
          sttNoSignalRecoveryAttemptedRef.current = false;
          setServerSttRestartNonce((value) => value + 1);
          if (reason === "manual") {
            addMessage({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              source: "ai_marker",
              text: "Перезапускаем захват и серверный live STT...",
              isFinal: true,
            });
          }
          return true;
        } finally {
          sttRecoveryInProgressRef.current = false;
          setIsSttRecovering(false);
        }
      }

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
        isSttSessionRunning,
        listWhisperModels,
        setActiveWhisperModel,
      } = await import("@/lib/tauri");
      if (!isTauri()) {
        logInfo("speech.language", "Skipping speech profile switch in non-desktop mode", {
          language,
        });
        setActiveSttLanguage(language);
        return true;
      }

      logInfo("speech.language", "Resolving active speech profile", {
        language,
        restartSession,
      });

      // Whisper models are multilingual — one installed model serves every language,
      // so there is nothing to match by language. That is also what makes mixed-language
      // speech work without swapping models mid-interview.
      const models = await withTimeout(
        listWhisperModels(),
        STT_MODEL_LOOKUP_TIMEOUT_MS,
        "Не удалось быстро получить список моделей. Проверьте настройки распознавания.",
      );
      const selectedModel =
        models.find((model: WhisperModelOption) => model.installed && model.active) ??
        models.find((model: WhisperModelOption) => model.installed) ??
        null;

      if (!selectedModel) {
        logWarn("speech.language", "No installed speech model was found", { language });
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: "Модель распознавания не установлена. Откройте настройки и скачайте её.",
          isFinal: true,
        });
        return false;
      }

      if (!selectedModel.active) {
        setSttStatusText("Активируем модель распознавания. Первый старт может быть дольше обычного...");
        await setActiveWhisperModel(selectedModel.id);
      }

      if (restartSession) {
        const running = await isSttSessionRunning().catch(() => false);
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
        profile: selectedModel.profile,
      });
      return true;
    },
    [addMessage, startSttSessionWithRecovery, stopSttSessionGracefully],
  );
  const toggleSttLanguage = useCallback(async () => {
    if (STT_ENGINE_SERVER_ONLY) {
      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: "Серверный live STT сейчас работает только на русском.",
        isFinal: true,
      });
      return;
    }

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

  /**
   * Applies a transcript update to the input. The caller passes the full text of the
   * current dictation, so the input is rebuilt from whatever was there when recording
   * started — no delta stitching here.
   *
   * Declared above handleSttResult on purpose: it is one of its dependencies, and a
   * later declaration would be in the temporal dead zone when the deps array is built.
   */
  const applyDictationText = useCallback((text: string) => {
    const dictation = dictationRef.current;
    dictation.lastText = text;
    dictationProducedTextRef.current = true;
    const base = dictation.baseText;
    const spoken = text.trim();
    const composed = !spoken
      ? base
      : base.trim().length === 0
        ? spoken
        : `${base.replace(/\s+$/, "")} ${spoken}`;
    manualQuestionRef.current = composed;
    setManualQuestion(composed);
  }, []);

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

      // The dictation window is the gate for BOTH tracks. That is the whole point of
      // the button: it is pressed at the moment a question is being asked, so what
      // reaches the input is that question — whoever says it — instead of everything
      // the call has produced since the last send. Which tracks feed the window is the
      // user's "Что слушать" setting, mic / system / both.
      if (
        dictationActiveRef.current &&
        dictationAcceptsTrack(dictationSourceRef.current, sourceKey)
      ) {
        const now = Date.now();
        const combined = appendUtterance({
          settled: dictationRef.current.settledText,
          phrase: text,
          gapMs: now - dictationRef.current.lastUtteranceAt,
        });
        // Only finals are committed: partials rewrite themselves on every decode and
        // the in-flight one is rendered on top of the settled text, not merged into it.
        if (payload.is_final) {
          dictationRef.current.settledText = combined;
          dictationRef.current.lastUtteranceAt = now;
        }
        applyDictationText(combined);
      }

      if (sourceKey === "mic") {
        // Your own voice never enters the interview transcript: it is not what the
        // interviewer said, and silence hallucinations would be recorded as things you
        // said. The dictation window above is the only place it can land.
        return;
      }

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
    [addMessage, applyDictationText, updateMessage],
  );

  const appendLiveSttTranscript = useCallback(
    (latest: LiveSttTranscribeLatestResponse) => {
      const rawSystemText = latest.systemAudio.text.trim();
      const rawMicText = latest.microphone.text.trim();
      const rejectedReasons: string[] = [];
      let systemText = "";
      let micText = "";

      if (rawSystemText) {
        const assessment = assessLiveTranscriptText(rawSystemText);
        if (assessment.usable) {
          systemText = rawSystemText;
        } else {
          rejectedReasons.push(`системный звук: ${assessment.reason ?? "сомнительный фрагмент"}`);
          logWarn("speech.live.transcriptFilter", "Rejected unreliable system transcript", {
            reason: assessment.reason,
            preview: rawSystemText.slice(0, 160),
          });
        }
      }
      if (rawMicText) {
        const assessment = assessLiveTranscriptText(rawMicText);
        if (assessment.usable) {
          micText = rawMicText;
        } else {
          rejectedReasons.push(`микрофон: ${assessment.reason ?? "сомнительный фрагмент"}`);
          logWarn("speech.live.transcriptFilter", "Rejected unreliable microphone transcript", {
            reason: assessment.reason,
            preview: rawMicText.slice(0, 160),
          });
        }
      }

      if (systemText) {
        handleSttResult({
          source: "system",
          text: systemText,
          is_final: true,
          confidence: 1,
        });
      }
      if (micText) {
        handleSttResult({
          source: "mic",
          text: micText,
          is_final: true,
          confidence: 1,
        });
      }

      return { systemText, micText, rejectedReasons };
    },
    [handleSttResult],
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
        // Also drives the MIC/SYS dots in the header. They used to be fed from the
        // server capture loop only, so on the local engine they stayed grey while
        // audio was plainly working — which reads as "no sound" to the user.
        if (payload.source === "system") {
          sttSignalSeenRef.current.system = true;
          setAudioActivity((prev) => (prev.system ? prev : { ...prev, system: true }));
          setSttStatusText(
            "Системный звук получен. Ждем первые распознанные слова собеседника.",
          );
        } else if (payload.source === "mic") {
          sttSignalSeenRef.current.mic = true;
          setAudioActivity((prev) => (prev.mic ? prev : { ...prev, mic: true }));
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
        // Mirror of audio_detected: the dot goes dark again when the stream dries up,
        // so it reports live activity rather than "signal was seen at some point".
        if (payload.source === "system") {
          setAudioActivity((prev) => (prev.system ? { ...prev, system: false } : prev));
          setSttStatusText(
            "Системный звук временно не поступает. Это нормально, если собеседник сейчас молчит.",
          );
          return;
        }
        setAudioActivity((prev) => (prev.mic ? { ...prev, mic: false } : prev));

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

  /**
   * Drops the local dictation state without talking to the server. Used when the
   * socket is already gone or the server told us the session ended.
   */
  const finishDictationLocally = useCallback((hint: string | null) => {
    if (!dictationActiveRef.current && dictationRef.current.finalResolvers.length === 0) {
      return;
    }
    dictationActiveRef.current = false;
    // The id is kept on purpose: a final transcript can still arrive a moment
    // after the stop, and it should land in the input instead of being dropped.
    setIsDictating(false);
    setDictationHint(hint);
    const resolvers = dictationRef.current.finalResolvers;
    dictationRef.current.finalResolvers = [];
    resolvers.forEach((resolve) => resolve());
  }, []);

  const handleDictationEvent = useCallback(
    (payload: DictationServerEvent) => {
      const activeId = dictationRef.current.id;
      if (payload.dictationId && activeId && payload.dictationId !== activeId) {
        // Late event from a dictation the user already ended.
        return;
      }

      switch (payload.type) {
        case "dictation.started":
          setDictationHint(null);
          break;
        case "dictation.text": {
          if (!dictationRef.current.id) {
            // Text from a dictation whose result was already sent.
            return;
          }
          applyDictationText(payload.text ?? "");
          if (payload.completed) {
            const resolvers = dictationRef.current.finalResolvers;
            dictationRef.current.finalResolvers = [];
            resolvers.forEach((resolve) => resolve());
          }
          break;
        }
        case "dictation.error":
          logWarn("speech.dictation", "Dictation reported an error", {
            code: payload.code,
            message: payload.message,
          });
          finishDictationLocally(payload.message || "Диктовка недоступна.");
          break;
        case "dictation.stopped":
          finishDictationLocally(null);
          break;
        default:
          break;
      }
    },
    [applyDictationText, finishDictationLocally],
  );

  /**
   * Dictation reuses the recognition session that is already running for the
   * interview: nothing is started or negotiated, the microphone results are simply
   * routed into the input field while this is active (see handleSttResult).
   */
  const startDictation = useCallback(() => {
    if (dictationRecordingRef.current) {
      return;
    }
    if (!sttAcceptingResultsRef.current) {
      // The button is deliberately live while recognition loads, so this hint is the
      // only place the user learns whether to wait or to go fix something.
      setDictationHint(
        sttStartupInProgressRef.current
          ? "Распознавание ещё загружается — диктовка включится, как только оно будет готово."
          : "Распознавание не запущено. Нажмите «Перезапуск аудио» в шапке или проверьте устройства в настройках.",
      );
      return;
    }

    const dictationId = crypto.randomUUID();
    dictationRef.current = {
      id: dictationId,
      baseText: manualQuestionRef.current,
      lastText: "",
      settledText: "",
      lastUtteranceAt: Date.now(),
      finalResolvers: [],
    };
    dictationActiveRef.current = true;
    dictationRecordingRef.current = true;
    setIsDictating(true);
    setDictationHint(null);
    logInfo("speech.dictation", "Dictation started", { dictationId });
  }, []);

  /**
   * Stops routing and waits briefly for the tail of the phrase, so the last words
   * still land in the input before the user hits send.
   */
  const stopDictation = useCallback(async () => {
    if (!dictationRecordingRef.current) {
      return;
    }
    dictationRecordingRef.current = false;
    // Stop showing the recording state at once, but keep routing microphone results
    // for a moment: the engine finalises the last utterance slightly after the button
    // is released, and those words belong in the input.
    const stoppingId = dictationRef.current.id;
    setIsDictating(false);
    await sleep(DICTATION_FINAL_WAIT_MS);
    // A new dictation may have started during the tail. Finishing here would kill it,
    // so this stop only completes the dictation it was actually issued for.
    if (dictationRef.current.id !== stoppingId) {
      return;
    }
    dictationActiveRef.current = false;
    finishDictationLocally(null);
    logInfo("speech.dictation", "Dictation stopped", {
      chars: dictationRef.current.lastText.length,
    });
  }, [finishDictationLocally]);

  /**
   * Empties the question field and forgets the dictation that filled it, so the next
   * capture window starts clean instead of appending to a discarded question.
   */
  const clearQuestion = useCallback(() => {
    setManualQuestion("");
    manualQuestionRef.current = "";
    dictationRef.current.baseText = "";
    dictationRef.current.settledText = "";
    dictationProducedTextRef.current = false;
  }, []);

  const toggleDictation = useCallback(() => {
    if (dictationActiveRef.current) {
      void stopDictation();
      return;
    }
    startDictation();
  }, [startDictation, stopDictation]);

  // Push-to-talk audio hint. Toggle: first press starts recording, second press
  // drains the recorded audio on the server and sends it to Gemini as one clip.
  // No local Whisper, no transcript text — the interviewer's voice goes to the
  // model directly, which is what keeps stray words out of the buffer.
  const toggleAudioHint = useCallback(() => {
    const live = serverSttLiveRef.current;
    if (!live.socket || live.socket.readyState !== WebSocket.OPEN || !live.streamId) {
      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: "Аудиопоток к серверу ещё не подключён. Подождите пару секунд и попробуйте снова.",
        isFinal: true,
      });
      return;
    }
    if (!audioHintRecording && audioHintsRemaining <= 0) {
      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: `Лимит аудио-подсказок за собес исчерпан (${planLimits.audioHintsPerInterview} на тарифе «${planLimits.title}»).`,
        isFinal: true,
      });
      return;
    }
    if (!audioHintRecording) {
      audioHintStartRef.current = Date.now();
      setAudioHintRecording(true);
      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: "🎙 Записываю вопрос… нажмите ещё раз, чтобы отправить в Gemini.",
        isFinal: true,
      });
      return;
    }
    // Second press: stop and send. The stream ran continuously, so the last
    // `elapsed` seconds are exactly what was recorded between the two presses.
    const elapsedSeconds = Math.max(
      1,
      Math.min(60, Math.ceil((Date.now() - audioHintStartRef.current) / 1000)),
    );
    setAudioHintRecording(false);
    setLastLlmError(null);
    setLlmResponse({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      text: "",
      isStreaming: true,
    });
    audioHintPendingRef.current = true;
    try {
      live.socket.send(
        JSON.stringify({
          type: "hint.audio",
          seconds: elapsedSeconds,
          context: buildAssistantContext({
            topic: settings.interviewContext,
            files: settings.contextFiles,
          }),
        }),
      );
      noteAudioHintUsed();
    } catch (error) {
      audioHintPendingRef.current = false;
      finishLlmResponse(0);
      setLastLlmError("Не удалось отправить запись на сервер.");
      logWarn("audioHint.send", "Failed to send hint.audio", error);
    }
  }, [
    audioHintRecording,
    audioHintsRemaining,
    addMessage,
    noteAudioHintUsed,
    planLimits,
    setLlmResponse,
    finishLlmResponse,
    settings.interviewContext,
    settings.contextFiles,
  ]);

  // "Last N seconds" quick hint: unlike push-to-talk there is no start/stop — one
  // click sends the user's configured trailing window (settings, 3–15s) as an
  // explicit `seconds`, the same protocol push-to-talk uses. Reuses its pending
  // flag, routing and display path.
  const sendQuickAudioHint = useCallback(() => {
    const live = serverSttLiveRef.current;
    if (!live.socket || live.socket.readyState !== WebSocket.OPEN || !live.streamId) {
      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: "Аудиопоток к серверу ещё не подключён. Подождите пару секунд и попробуйте снова.",
        isFinal: true,
      });
      return;
    }
    // Don't overlap with an active push-to-talk recording or an in-flight hint.
    if (audioHintRecording || audioHintPendingRef.current) {
      return;
    }
    if (audioHintsRemaining <= 0) {
      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: `Лимит аудио-подсказок за собес исчерпан (${planLimits.audioHintsPerInterview} на тарифе «${planLimits.title}»).`,
        isFinal: true,
      });
      return;
    }
    setLastLlmError(null);
    setLlmResponse({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      text: "",
      isStreaming: true,
    });
    audioHintPendingRef.current = true;
    setAudioHintTailSending(true);
    try {
      live.socket.send(
        JSON.stringify({
          type: "hint.audio",
          seconds: settings.audioHintWindowSeconds,
          context: buildAssistantContext({
            topic: settings.interviewContext,
            files: settings.contextFiles,
          }),
        }),
      );
      noteAudioHintUsed();
    } catch (error) {
      audioHintPendingRef.current = false;
      setAudioHintTailSending(false);
      finishLlmResponse(0);
      setLastLlmError("Не удалось отправить запись на сервер.");
      logWarn("audioHint.tail.send", "Failed to send hint.audio tail", error);
    }
  }, [
    audioHintRecording,
    audioHintsRemaining,
    addMessage,
    noteAudioHintUsed,
    planLimits,
    setLlmResponse,
    finishLlmResponse,
    settings.audioHintWindowSeconds,
    settings.interviewContext,
    settings.contextFiles,
  ]);

  // The live socket's message handler is created inside an effect; route audio-hint
  // results to the current renderer through a ref so we don't rebuild the socket.
  const handleAudioHintMessage = useCallback(
    (payload: { type?: string; output?: string; nextSteps?: string[]; message?: string }) => {
      audioHintPendingRef.current = false;
      setAudioHintTailSending(false);
      if (payload.type === "hint") {
        const output = (payload.output ?? "").trim();
        appendLlmText(
          output ||
            "Не удалось сформировать ответ по записи. Повторите вопрос короче и нажмите запись ещё раз.",
        );
        finishLlmResponse(0);
        return;
      }
      finishLlmResponse(0);
      setLastLlmError(payload.message || "Сервер не смог обработать запись.");
    },
    [appendLlmText, finishLlmResponse],
  );

  useEffect(() => {
    audioHintMsgRef.current = handleAudioHintMessage;
  }, [handleAudioHintMessage]);

  /**
   * Safety valve for a stuck recording: in hold mode a missed pointerup (lost
   * pointer capture, window focus change) leaves the mic open indefinitely, and
   * in toggle mode the user can simply forget to press stop. Cap one dictation
   * at two minutes; the text recognised so far stays in the input.
   */
  useEffect(() => {
    if (!isDictating) {
      return;
    }
    const timer = window.setTimeout(() => {
      logWarn("speech.dictation", "Dictation auto-stopped on the duration cap", {
        limitMs: DICTATION_MAX_DURATION_MS,
      });
      void stopDictation().then(() => {
        setDictationHint(
          "Запись остановлена автоматически: лимит 2 минуты. Нажмите ещё раз, чтобы продолжить.",
        );
      });
    }, DICTATION_MAX_DURATION_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [isDictating, stopDictation]);

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

    if (STT_ENGINE_SERVER_ONLY) {
      let disposed = false;

      async function setupServerStt() {
        const {
          isTauri,
          captureServerSttChunk,
          getDeviceIdentity,
          probeAudioDevices,
          stopServerSttLiveCapture,
        } = await import("@/lib/tauri");
        if (disposed) {
          return;
        }
        if (!isTauri()) {
          logInfo("speech.setup", "Skipping server speech setup in non-desktop mode");
          return;
        }

        const initialSettings = useSettingsStore.getState();
        const licenseKey = initialSettings.apiKey.trim();
        if (!licenseKey) {
          await activateSafeMode(
            "Лицензионный ключ не найден. Добавьте ключ в настройках, чтобы включить live-распознавание.",
            { stopAudio: false },
          );
          return;
        }

        setActiveSttLanguage(initialSettings.primaryLanguage);
        setSttWarmupModelId(null);
        setSttWarmupUi(null);
        sttAcceptingResultsRef.current = true;
        serverSttLiveRef.current.socket?.close();
        await stopServerSttLiveCapture().catch((error) => {
          logWarn("speech.setup", "Server live audio capture reset failed before setup", {
            detail: toErrorDetail(error),
          });
        });
        serverSttLiveRef.current = { socket: null, streamId: null };
        setIsRecognitionReady(false);
        if (SERVER_STT_OPTIMISTIC_START) {
          setIsSttStarting(false);
          setSttStartupStartedAt(null);
          setSttStartupElapsedMs(0);
          setSttStatusText("Подключаем серверный аудиобуфер...");
          addMessage({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            source: "ai_marker",
            text: "Подключаем аудиобуфер к серверу. Распознавание выполнится только по кнопке «Отправить».",
            isFinal: true,
          });
        } else {
          setSttStatusText(
            "Подключаем серверный аудиобуфер микрофона и системного звука...",
          );
          setSttStartupStartedAt(Date.now());
          setSttStartupElapsedMs(0);
          setIsSttStarting(true);
        }

        const resolveLanguageTag = (value: string) => value.split("-")[0]?.toLowerCase() || "ru";
        const closeLiveSocket = () => {
          const currentSocket = serverSttLiveRef.current.socket;
          if (currentSocket) {
            try {
              currentSocket.close();
            } catch {
              // no-op
            }
          }
          serverSttLiveRef.current = { socket: null, streamId: null };
          setIsRecognitionReady(false);
        };

        const connectLiveSocket = async () => {
          const currentSettings = useSettingsStore.getState();
          const liveLicenseKey = currentSettings.apiKey.trim();
          if (!liveLicenseKey) {
            throw new Error("Лицензионный ключ отсутствует.");
          }
          const effectiveProxyBaseUrl =
            currentSettings.customBaseUrl.trim() || PROXY_BASE_URL;
          const lang = resolveLanguageTag(currentSettings.primaryLanguage || "ru-RU");
          const identity = await getDeviceIdentity().catch(() => null);
          const wsUrl = buildLiveSttWebSocketUrl({
            licenseKey: liveLicenseKey,
            lang,
            deviceFingerprint: identity?.fingerprint,
            deviceName: identity?.name,
            baseUrl: effectiveProxyBaseUrl,
          });

          const connection = await withTimeout(
            new Promise<{ socket: WebSocket; streamId: string }>((resolve, reject) => {
              let settled = false;
              const socket = new WebSocket(wsUrl);

              const fail = (reason: string) => {
                if (settled) {
                  return;
                }
                settled = true;
                try {
                  socket.close();
                } catch {
                  // no-op
                }
                reject(new Error(reason));
              };

              socket.onmessage = (event) => {
                try {
                  const payload = JSON.parse(String(event.data)) as {
                    type?: string;
                    streamId?: string;
                    message?: string;
                  };
                  if (payload.type === "ready" && payload.streamId?.trim()) {
                    if (settled) {
                      return;
                    }
                    settled = true;
                    resolve({ socket, streamId: payload.streamId.trim() });
                    return;
                  }
                  if (payload.type === "error") {
                    fail(payload.message || "Сервер отклонил подключение live STT.");
                  }
                } catch {
                  fail("Сервер вернул некорректный ответ live STT websocket.");
                }
              };
              socket.onerror = () => {
                fail("Не удалось открыть live STT websocket.");
              };
              socket.onclose = (event) => {
                if (!settled) {
                  fail(
                    event.reason ||
                      `Live STT websocket закрыт до инициализации (code=${event.code}).`,
                  );
                }
              };
            }),
            SERVER_STT_WS_READY_TIMEOUT_MS,
            "Серверный live-поток не ответил вовремя.",
          );

          connection.socket.onmessage = (event) => {
            try {
              const payload = JSON.parse(String(event.data)) as {
                type?: string;
                message?: string;
                output?: string;
                nextSteps?: string[];
                code?: string;
              };
              // Push-to-talk answer (or its failure) goes to the audio-hint renderer.
              if (
                payload.type === "hint" ||
                (payload.type === "error" && audioHintPendingRef.current)
              ) {
                audioHintMsgRef.current(payload);
                return;
              }
              if (payload.type?.startsWith("dictation.")) {
                handleDictationEvent(payload as DictationServerEvent);
                return;
              }
              if (payload.type === "error" && payload.message) {
                setSttStatusText(`Live-поток: ${payload.message}`);
              }
            } catch {
              // no-op
            }
          };

          connection.socket.onclose = () => {
            if (!disposed) {
              setIsRecognitionReady(false);
              setSttStatusText("Live-поток аудио отключен. Пытаемся переподключиться...");
            }
            // The dictation session lives on this socket; if it drops mid-phrase the
            // user has to know their words stopped being captured.
            finishDictationLocally("Соединение с распознаванием прервалось.");
          };

          serverSttLiveRef.current = {
            socket: connection.socket,
            streamId: connection.streamId,
          };
          setIsRecognitionReady(true);
          return { lang };
        };

        let firstChunkSettled = false;
        let consecutiveErrors = 0;
        let startupNoticeShown = false;
        let autoTranscribeInFlight = false;
        let lastAutoTranscribeAt = Date.now();
        let lastChunkLevelLogAt = 0;
        let silentMicChunkCount = 0;
        let silentSystemChunkCount = 0;
        let audioAutoProbeInFlight = false;
        let audioAutoProbeNoticeShown = false;
        let lastAudioAutoProbeAt = 0;
        let connectedLanguage = resolveLanguageTag(initialSettings.primaryLanguage || "ru-RU");

        const buildLiveContextHint = () => {
          const liveSettings = useSettingsStore.getState();
          return liveSettings.interviewContext
            .trim()
            .slice(0, SERVER_STT_CONTEXT_HINT_MAX_CHARS);
        };

        const maybeAutoRecoverAudioDevices = (reason: string) => {
          if (audioAutoProbeInFlight) {
            return;
          }
          const now = Date.now();
          if (now - lastAudioAutoProbeAt < SERVER_STT_AUDIO_AUTOPROBE_COOLDOWN_MS) {
            return;
          }

          audioAutoProbeInFlight = true;
          lastAudioAutoProbeAt = now;
          setSttStatusText("Проверяем реальные аудиоустройства. Продолжайте говорить обычным голосом...");
          if (!audioAutoProbeNoticeShown) {
            audioAutoProbeNoticeShown = true;
            addMessage({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              source: "ai_marker",
              text:
                "Сигнал в текущем аудиопотоке почти нулевой. Проверяю все микрофоны native-способом и переключусь на рабочий, если найду голос.",
              isFinal: true,
            });
          }

          const probeSettings = useSettingsStore.getState();
          void probeAudioDevices({
            microphoneDeviceId: probeSettings.microphoneDeviceId || undefined,
            systemAudioDeviceId: probeSettings.systemAudioDeviceId || undefined,
            durationSeconds: 1,
            probeAllInputDevices: true,
            probeAllOutputDevices: true,
          })
            .then((probe) => {
              if (disposed || endingRef.current) {
                return;
              }

              const settingsStore = useSettingsStore.getState();
              const recommendedMic = probe.recommended_microphone;
              const recommendedSystem = probe.recommended_system_audio;
              let changed = false;
              const applied: string[] = [];

              if (
                recommendedMic?.has_signal &&
                recommendedMic.device?.id &&
                recommendedMic.device.id !== settingsStore.microphoneDeviceId
              ) {
                settingsStore.setMicrophoneDeviceId(recommendedMic.device.id);
                changed = true;
                applied.push(`микрофон: ${formatProbeTrack(recommendedMic)}`);
              }

              if (
                recommendedSystem?.has_signal &&
                recommendedSystem.device?.id &&
                recommendedSystem.device.id !== settingsStore.systemAudioDeviceId
              ) {
                settingsStore.setSystemAudioDeviceId(recommendedSystem.device.id);
                changed = true;
                applied.push(`системный звук: ${formatProbeTrack(recommendedSystem)}`);
              }

              logInfo("speech.live.audioAutoProbe", "Native audio auto-probe finished", {
                reason,
                changed,
                recommendedMicrophone: recommendedMic,
                recommendedSystemAudio: recommendedSystem,
                notes: probe.notes,
              });

              if (changed) {
                silentMicChunkCount = 0;
                silentSystemChunkCount = 0;
                setSttStatusText(`Аудиоустройства переключены: ${applied.join("; ")}.`);
                addMessage({
                  id: crypto.randomUUID(),
                  timestamp: Date.now(),
                  source: "ai_marker",
                  text: `Автонастройка аудио применена: ${applied.join("; ")}.`,
                  isFinal: true,
                });
              } else {
                setSttStatusText(
                  `Сигнал пока не найден. Текущий микрофон: ${
                    recommendedMic ? formatProbeTrack(recommendedMic) : "нет уверенного сигнала"
                  }.`,
                );
              }
            })
            .catch((error) => {
              logWarn("speech.live.audioAutoProbe", "Native audio auto-probe failed", {
                reason,
                detail: toErrorDetail(error),
              });
            })
            .finally(() => {
              audioAutoProbeInFlight = false;
            });
        };

        const maybeAutoTranscribeLatest = () => {
          if (!SERVER_STT_AUTO_TRANSCRIBE_ENABLED || autoTranscribeInFlight) {
            return;
          }
          const now = Date.now();
          if (now - lastAutoTranscribeAt < SERVER_STT_AUTO_TRANSCRIBE_INTERVAL_MS) {
            return;
          }

          const streamId = serverSttLiveRef.current.streamId;
          if (!streamId) {
            return;
          }

          const liveSettings = useSettingsStore.getState();
          const liveLicenseKey = liveSettings.apiKey.trim();
          if (!liveLicenseKey) {
            return;
          }

          autoTranscribeInFlight = true;
          lastAutoTranscribeAt = now;
          void requestLiveSttTranscribeLatest({
            licenseKey: liveLicenseKey,
            streamId,
            language: liveSettings.primaryLanguage,
            baseUrl: liveSettings.customBaseUrl.trim() || PROXY_BASE_URL,
            seconds: SERVER_STT_AUTO_TRANSCRIBE_WINDOW_SECONDS,
            saveAudioDebug: false,
            debugTag: "auto",
            consumeAfterRead: true,
            retainTailSeconds: SERVER_STT_BUFFER_RETAIN_TAIL_SECONDS,
            contextHint: buildLiveContextHint() || undefined,
          })
            .then((latest) => {
              if (disposed || !useSessionStore.getState().isActive || endingRef.current) {
                return;
              }

              const { systemText, micText } = appendLiveSttTranscript(latest);
              logInfo("speech.live.autoTranscribe", "Auto-transcribed live STT window", {
                streamId,
                seconds: SERVER_STT_AUTO_TRANSCRIBE_WINDOW_SECONDS,
                transcriptChars: latest.transcript.trim().length,
                micChars: micText.length,
                systemChars: systemText.length,
                micBufferedMs: latest.microphone.bufferedMs,
                systemBufferedMs: latest.systemAudio.bufferedMs,
                micDetail: latest.microphone.detail,
                systemDetail: latest.systemAudio.detail,
              });

              if (systemText || micText) {
                setSttStatusText(
                  "Распознавание активно. Транскрипт сессии обновляется в фоне.",
                );
              }
            })
            .catch((error) => {
              const detail = toErrorDetail(error);
              logWarn("speech.live.autoTranscribe", "Auto-transcribe live STT window failed", {
                streamId,
                detail,
              });
            })
            .finally(() => {
              autoTranscribeInFlight = false;
            });
        };

        await connectLiveSocket().then((connection) => {
          connectedLanguage = connection.lang;
        });

        while (!disposed && useSessionStore.getState().isActive && !endingRef.current) {
          const liveSettings = useSettingsStore.getState();
          const liveLicenseKey = liveSettings.apiKey.trim();
          if (!liveLicenseKey) {
            setSttStatusText("Лицензионный ключ отсутствует. Live-распознавание остановлено.");
            break;
          }

          try {
            const socket = serverSttLiveRef.current.socket;
            if (!socket || socket.readyState !== WebSocket.OPEN || !serverSttLiveRef.current.streamId) {
              throw new Error("Live STT websocket не подключен.");
            }

            const dictating = dictationActiveRef.current;
            const chunk = await captureServerSttChunk({
              durationSeconds: SERVER_STT_STREAM_CHUNK_SECONDS,
              durationMs: dictating ? DICTATION_CHUNK_MS : undefined,
              microphoneDeviceId: liveSettings.microphoneDeviceId || undefined,
              systemAudioDeviceId: liveSettings.systemAudioDeviceId || undefined,
            });

            if (disposed) {
              return;
            }

            if (!firstChunkSettled && !SERVER_STT_OPTIMISTIC_START) {
              firstChunkSettled = true;
              setIsSttStarting(false);
              setSttStartupStartedAt(null);
              setSttStartupElapsedMs(0);
            } else if (!firstChunkSettled) {
              firstChunkSettled = true;
            }

            if (chunk.microphone.available) {
              sttSignalSeenRef.current.mic = true;
            }
            if (chunk.system_audio.available) {
              sttSignalSeenRef.current.system = true;
            }

            const micDetailRaw = chunk.microphone.detail?.trim() || "";
            const systemDetailRaw = chunk.system_audio.detail?.trim() || "";
            const micDetailNormalized = micDetailRaw.toLowerCase();
            const systemDetailNormalized = systemDetailRaw.toLowerCase();
            const micHasLocalSignal = liveTrackHasLocalSignal(chunk.microphone);
            const systemHasLocalSignal = liveTrackHasLocalSignal(chunk.system_audio);

            setAudioActivity((prev) =>
              prev.mic === micHasLocalSignal && prev.system === systemHasLocalSignal
                ? prev
                : { mic: micHasLocalSignal, system: systemHasLocalSignal },
            );

            silentMicChunkCount = micHasLocalSignal ? 0 : silentMicChunkCount + 1;
            silentSystemChunkCount = systemHasLocalSignal ? 0 : silentSystemChunkCount + 1;

            if (
              liveSettings.microphoneDeviceId &&
              micDetailNormalized.includes("selected microphone device is not available")
            ) {
              useSettingsStore.getState().setMicrophoneDeviceId("");
              setSttStatusText(
                "Выбранный микрофон недоступен. Переключились на системный по умолчанию, проверьте список устройств.",
              );
              await sleep(SERVER_STT_LOOP_GAP_MS);
              continue;
            }

            if (
              liveSettings.systemAudioDeviceId &&
              systemDetailNormalized.includes("selected output device is not available")
            ) {
              useSettingsStore.getState().setSystemAudioDeviceId("");
              setSttStatusText(
                "Выбранное устройство системного звука недоступно. Переключились на системное по умолчанию.",
              );
              await sleep(SERVER_STT_LOOP_GAP_MS);
              continue;
            }

            const micPayload = chunk.microphone.wav_base64?.trim() || "";
            const systemPayload = chunk.system_audio.wav_base64?.trim() || "";
            const levelLogNow = Date.now();
            if (levelLogNow - lastChunkLevelLogAt >= 5000) {
              lastChunkLevelLogAt = levelLogNow;
              logInfo("speech.live.chunkCapture", "Captured live audio chunk levels", {
                microphone: {
                  available: chunk.microphone.available,
                  device: formatLiveTrackDevice(chunk.microphone),
                  durationMs: chunk.microphone.duration_ms,
                  sampleRate: chunk.microphone.sample_rate,
                  peakAbs: chunk.microphone.peak_abs,
                  rms: Math.round(chunk.microphone.rms * 100) / 100,
                  hasLocalSignal: micHasLocalSignal,
                  wavBytesApprox: micPayload ? Math.round((micPayload.length * 3) / 4) : 0,
                  detail: chunk.microphone.detail,
                },
                systemAudio: {
                  available: chunk.system_audio.available,
                  device: formatLiveTrackDevice(chunk.system_audio),
                  durationMs: chunk.system_audio.duration_ms,
                  sampleRate: chunk.system_audio.sample_rate,
                  peakAbs: chunk.system_audio.peak_abs,
                  rms: Math.round(chunk.system_audio.rms * 100) / 100,
                  hasLocalSignal: systemHasLocalSignal,
                  wavBytesApprox: systemPayload ? Math.round((systemPayload.length * 3) / 4) : 0,
                  detail: chunk.system_audio.detail,
                },
              });
            }

            if (
              silentMicChunkCount >= SERVER_STT_AUDIO_AUTOPROBE_AFTER_SILENT_CHUNKS &&
              silentSystemChunkCount >= SERVER_STT_AUDIO_AUTOPROBE_AFTER_SILENT_CHUNKS
            ) {
              maybeAutoRecoverAudioDevices("mic and system tracks are locally silent");
            } else if (
              silentMicChunkCount >= SERVER_STT_AUDIO_AUTOPROBE_AFTER_SILENT_CHUNKS
            ) {
              maybeAutoRecoverAudioDevices("microphone track is locally silent");
            }

            if (!micPayload && !systemPayload) {
              const micDetail = toFriendlyLiveTrackDetail(micDetailRaw);
              const systemDetail = toFriendlyLiveTrackDetail(systemDetailRaw);

              const detailParts: string[] = [];
              if (!chunk.microphone.available && micDetail !== "ok") {
                detailParts.push(`микрофон ${formatLiveTrackDevice(chunk.microphone)}: ${micDetail}`);
              }
              if (!chunk.system_audio.available && systemDetail !== "ok") {
                detailParts.push(`системный звук ${formatLiveTrackDevice(chunk.system_audio)}: ${systemDetail}`);
              }

              setSttStatusText(
                detailParts.length > 0
                  ? `Аудио пока не поступает (${detailParts.join(" | ")}).`
                  : "Поток аудио активен, но речь пока не обнаружена.",
              );
              await sleep(SERVER_STT_LOOP_GAP_MS);
              continue;
            }

            socket.send(
              JSON.stringify({
                type: "chunk",
                micWavBase64: micPayload || undefined,
                systemWavBase64: systemPayload || undefined,
                lang: connectedLanguage,
              }),
            );
            maybeAutoTranscribeLatest();

            if (dictating) {
              setSttStatusText("Идёт запись вопроса. Слова появляются в строке ввода.");
            } else if (audioAutoProbeInFlight) {
              setSttStatusText("Проверяем реальные аудиоустройства. Продолжайте говорить...");
            } else if (!micHasLocalSignal && !systemHasLocalSignal) {
              setSttStatusText(
                `Аудиобуфер пишет почти тишину. Микрофон: ${formatLiveTrackDevice(chunk.microphone)}, системный звук: ${formatLiveTrackDevice(chunk.system_audio)}.`,
              );
            } else if (!micHasLocalSignal) {
              setSttStatusText(
                `Системный звук есть, микрофон почти тихий: ${formatLiveTrackDevice(chunk.microphone)}.`,
              );
            } else {
              setSttStatusText(
                `Аудиобуфер активен. Нажмите «Отправить», чтобы распознать последние ${SERVER_STT_TRANSCRIBE_WINDOW_SECONDS} секунд.`,
              );
            }
            if (!startupNoticeShown) {
              startupNoticeShown = true;
              addMessage({
                id: crypto.randomUUID(),
                timestamp: Date.now(),
                source: "ai_marker",
                text:
                  `Аудио пишется в серверный буфер. STT-запрос выполняется только по кнопке «Отправить» и берёт последние ${SERVER_STT_TRANSCRIBE_WINDOW_SECONDS} секунд.`,
                isFinal: true,
              });
            }

            consecutiveErrors = 0;
            // No idle gap while dictating: every pause here is a pause before the
            // next words show up in the input field.
            if (!dictationActiveRef.current) {
              await sleep(SERVER_STT_LOOP_GAP_MS);
            }
          } catch (error) {
            if (disposed) {
              return;
            }

            if (!firstChunkSettled && !SERVER_STT_OPTIMISTIC_START) {
              firstChunkSettled = true;
              setIsSttStarting(false);
              setSttStartupStartedAt(null);
              setSttStartupElapsedMs(0);
            } else if (!firstChunkSettled) {
              firstChunkSettled = true;
            }

            consecutiveErrors += 1;
            const detail = toErrorDetail(error);
            if (!firstChunkSettled) {
              setSttStatusText(`Сервер STT не дал первый ответ: ${detail}`);
            } else {
              setSttStatusText(`Серверное распознавание: ${detail}`);
            }
            if (consecutiveErrors <= 2 || consecutiveErrors % 5 === 0) {
              addMessage({
                id: crypto.randomUUID(),
                timestamp: Date.now(),
                source: "ai_marker",
                text: `Сбой live-потока: ${detail}`,
                isFinal: true,
              });
            }

            closeLiveSocket();
            const retryDelay = Math.min(5000, SERVER_STT_RETRY_BASE_MS * consecutiveErrors);
            await sleep(retryDelay);
            if (disposed || !useSessionStore.getState().isActive || endingRef.current) {
              break;
            }
            await connectLiveSocket().then((connection) => {
              connectedLanguage = connection.lang;
            });
          }
        }

        closeLiveSocket();
        await stopServerSttLiveCapture().catch((error) => {
          logWarn("speech.setup", "Server live audio capture cleanup failed after loop", {
            detail: toErrorDetail(error),
          });
        });
      }

      void setupServerStt();

      return () => {
        disposed = true;
        sttAcceptingResultsRef.current = false;
        serverSttLiveRef.current.socket?.close();
        void import("@/lib/tauri").then(({ stopServerSttLiveCapture }) =>
          stopServerSttLiveCapture().catch((error) => {
            logWarn("speech.setup", "Server live audio capture cleanup failed on dispose", {
              detail: toErrorDetail(error),
            });
          }),
        );
        serverSttLiveRef.current = { socket: null, streamId: null };
        setIsRecognitionReady(false);
        setIsSttStarting(false);
        setSttStartupStartedAt(null);
        setSttStartupElapsedMs(0);
      };
    }

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
      const { isTauri, isSttSessionRunning } = await import("@/lib/tauri");
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
        const alreadyRunning = await isSttSessionRunning().catch(() => false);
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
        // Must be set on both paths. Setting it only inside the start helper left the
        // dictation and send buttons dead whenever the effect re-ran over a session
        // that was still alive.
        setIsRecognitionReady(true);
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
    appendLiveSttTranscript,
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
    serverSttRestartNonce,
    handleDictationEvent,
    finishDictationLocally,
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

  const closeCropDialog = useCallback((image: string | null) => {
    const resolver = cropResolverRef.current;
    cropResolverRef.current = null;
    cropStartRef.current = null;
    setCropDragging(false);
    setCropRect(null);
    setCropDialogImageBase64(null);
    // Read the prompt off the ref: this callback must stay stable across keystrokes.
    resolver?.(image === null ? null : { image, prompt: cropPromptRef.current.trim() });
  }, []);

  const openCropDialog = useCallback(
    (imageBase64: string, initialPrompt: string): Promise<CropDialogResult | null> => {
      // Only one dialog can be on screen, so a second open would orphan the first
      // promise and leave that send awaiting forever. Cancel it explicitly.
      const orphaned = cropResolverRef.current;
      if (orphaned) {
        cropResolverRef.current = null;
        logWarn("llm.screenshot", "Cancelled a pending crop dialog before opening a new one");
        orphaned(null);
      }
      cropStartRef.current = null;
      setCropDragging(false);
      setCropRect(null);
      cropPromptRef.current = initialPrompt;
      setCropPrompt(initialPrompt);
      setCropDialogImageBase64(imageBase64);
      return new Promise<CropDialogResult | null>((resolve) => {
        cropResolverRef.current = resolve;
      });
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (cropResolverRef.current) {
        cropResolverRef.current(null);
        cropResolverRef.current = null;
      }
    };
  }, []);

  const attachImageFromClipboard = useCallback(
    (event: ReactClipboardEvent<HTMLInputElement>) => {
      const imageItem = Array.from(event.clipboardData?.items ?? []).find(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      );
      const file = imageItem?.getAsFile();
      if (!file) {
        return;
      }
      // Keep the paste from also dropping a file path or stray text into the input.
      event.preventDefault();
      if (uploadsRemaining <= 0) {
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: `Лимит загрузок за собес исчерпан (${planLimits.uploadsPerInterview} на тарифе «${planLimits.title}»).`,
          isFinal: true,
        });
        return;
      }
      void (async () => {
        try {
          const base64 = await blobToBase64Png(file);
          setPastedImageBase64(base64);
          logInfo("llm.screenshot", "Image attached from clipboard", {
            base64Length: base64.length,
            type: file.type,
          });
        } catch (error) {
          const detail =
            error instanceof Error ? error.message : "Неизвестная ошибка чтения буфера обмена.";
          logWarn("llm.screenshot", "Failed to read image from clipboard", { detail, error });
          addMessage({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            source: "ai_marker",
            text: `Изображение не приложено: ${detail}`,
            isFinal: true,
          });
        }
      })();
    },
    [addMessage, planLimits, uploadsRemaining],
  );

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
          text: "Лицензионный ключ не задан. Активируйте его в разделе «Кабинет».",
          isFinal: true,
        });
        setLastLlmError("Лицензионный ключ не задан.");
        return;
      }

      setLastLlmError(null);

      // Sending while still dictating: close the phrase and let the tail land in
      // the input, otherwise the last words of the question would be dropped.
      if (dictationActiveRef.current) {
        await stopDictation();
      }

      let contextMessages = contextBuffer;
      const rejectedLiveTranscriptReasons: string[] = [];
      const manualQuestionText = manualQuestionRef.current.trim();
      // The dictated text is deliberately NOT cleared here. This runs before the
      // scissors dialog, and cancelling it returns early — clearing now threw away a
      // question the user had just dictated. The reset happens at the commit point
      // below, once the request is certain to go out.
      const hadDictatedText = dictationProducedTextRef.current;

      let transcriptCandidateMessages = getTranscriptMessages(contextMessages);
      if (!manualQuestionText && transcriptCandidateMessages.length === 0) {
        const canUseTranscriptMemory =
          withScreenshot && TRANSCRIPT_MEMORY_FALLBACK_WITH_SCREENSHOT_ONLY;
        const rememberedMessages = canUseTranscriptMemory
          ? getRecentTranscriptMemoryMessages(useSessionStore.getState().messages)
          : [];
        if (rememberedMessages.length > 0) {
          transcriptCandidateMessages = rememberedMessages;
          contextMessages = rememberedMessages;
          setSttStatusText(
            "Свежий аудио-фрагмент пустой. Используем последние распознанные реплики сессии.",
          );
          logInfo("llm.request", "Using transcript memory after empty live STT window", {
            transcriptMessages: rememberedMessages.length,
            oldestAgeMs: Date.now() - rememberedMessages[0].timestamp,
            newestAgeMs:
              Date.now() - rememberedMessages[rememberedMessages.length - 1].timestamp,
          });
        } else if (rejectedLiveTranscriptReasons.length > 0) {
          logWarn("llm.request", "Skipped transcript memory fallback after rejected live STT", {
            rejectedReasons: rejectedLiveTranscriptReasons,
          });
        } else if (!canUseTranscriptMemory) {
          logInfo("llm.request", "Skipped transcript memory fallback for audio-only request");
        }
      }
      // A clipboard image counts as visual context exactly like the scissors do,
      // so intent detection and the empty-question guard must both see it.
      const clipboardImageBase64 = withScreenshot ? null : pastedImageBase64;
      const willAttachImage = withScreenshot || Boolean(clipboardImageBase64);
      const hasTextQuestion =
        transcriptCandidateMessages.length > 0 || manualQuestionText.length > 0;
      if (!hasTextQuestion && !willAttachImage) {
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
      if (!hasTextQuestion && willAttachImage) {
        logInfo("llm.request", "Proceeding with image-only request", {
          source: withScreenshot ? "screenshot" : "clipboard",
        });
      }

      const resp: LlmResponse = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        text: "",
        isStreaming: true,
      };
      setLlmResponse(resp);
      setLastHintMeta(null);
      setFeedbackUi({
        sending: null,
        sentRating: null,
        отзываId: null,
        error: null,
      });
      /** Unwinds the pending response panel so a send that never happens leaves no trace. */
      const abortBeforeRequest = (markerText: string, reason: string) => {
        logInfo("llm.request", "Send aborted before the request left", { reason });
        useSessionStore.setState((s) => ({
          lastLlmResponse: null,
          llmResponses: s.llmResponses.filter((response) => response.id !== resp.id),
          isLlmLoading: false,
        }));
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: markerText,
          isFinal: true,
        });
      };

      // The scissors dialog carries its own prompt field, so the screenshot has to
      // be taken before the question is assembled — whatever the user types there
      // is the question, and it must reach intent detection too.
      let screenshotBase64: string | null = null;
      let screenshotFailureDetail: string | null = null;
      let questionText = manualQuestionText;

      if (withScreenshot) {
        // Тарифный гейт: закрывает кнопку, F9 и внутриоконный хоткей разом.
        if (snipsRemaining <= 0) {
          abortBeforeRequest(
            planLimits.scissorsPerInterview === 0
              ? `Ножницы недоступны на тарифе «${planLimits.title}».`
              : `Лимит ножниц за собес исчерпан (${planLimits.scissorsPerInterview} на тарифе «${planLimits.title}»).`,
            "snip_limit",
          );
          return;
        }
        logInfo("llm.screenshot", "Starting screenshot capture flow");
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: "Выдели область ножницами и допиши вопрос, если нужно. Отмена отменит и сам запрос.",
          isFinal: true,
        });
        try {
          const fullScreenshotBase64 = await captureScreenshotAsBase64Png();
          const cropResult = await openCropDialog(fullScreenshotBase64, manualQuestionText);
          if (cropResult === null) {
            // Cancel has to unwind the whole send: without the screenshot there is
            // nothing left to ask, and the UI would sit waiting for an answer
            // nobody requested.
            abortBeforeRequest(
              "Ножницы отменены — запрос не отправлен.",
              "crop_cancelled",
            );
            return;
          }
          screenshotBase64 = cropResult.image;
          questionText = cropResult.prompt;
          if (screenshotBase64 !== fullScreenshotBase64) {
            addMessage({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              source: "ai_marker",
              text: "Добавлена выделенная область скриншота.",
              isFinal: true,
            });
          }
        } catch (err: unknown) {
          const detail = toFriendlyScreenshotError(err);
          logWarn("llm.screenshot", "Screenshot capture failed", { detail, error: err });
          if (!hasTextQuestion) {
            // Nothing was captured and there is no question to fall back on, so
            // there is nothing worth asking the service.
            abortBeforeRequest(
              `Скриншот не получен (${detail}), а вопроса нет — запрос не отправлен.`,
              "screenshot_failed_without_question",
            );
            return;
          }
          addMessage({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            source: "ai_marker",
            text: `Скриншот не добавлен: ${detail}`,
            isFinal: true,
          });
          screenshotFailureDetail = detail;
        }
      }

      const intentSourceText =
        questionText || transcriptCandidateMessages.map((message) => message.text).join("\n");
      const requestIntent = resolveRequestIntentMode(
        questionText,
        intentSourceText,
        willAttachImage,
      );
      setLastRequestIntent(requestIntent);

      const effectiveContextMessages = questionText
        ? []
        : transcriptCandidateMessages.slice(Math.max(0, transcriptCandidateMessages.length - 10));

      const transcriptLines = effectiveContextMessages.map(
        (m) => `[${m.source === "interviewer" ? "Интервьюер" : "Вы"}]: ${m.text}`,
      );
      if (questionText) {
        transcriptLines.push(`[Вы]: ${questionText}`);
      }
      if (transcriptLines.length === 0 && willAttachImage) {
        transcriptLines.push(
          "[Вы]: Проанализируй изображение и сначала определи намерение: дописать код, отладить ошибку, сделать ревью или решить задачу.",
        );
      }
      const transcript = transcriptLines.join("\n");

      let requestQuestion = questionText || transcript;
      if (!requestQuestion.trim() && willAttachImage) {
        requestQuestion = "Проанализируй изображение и помоги с ответом на вопрос пользователя.";
      }
      let imageBase64Png: string | undefined;

      const appendToQuestion = (extra: string) => {
        const chunk = extra.trim();
        if (!chunk) {
          return;
        }
        requestQuestion = requestQuestion.trim()
          ? `${requestQuestion.trim()}\n\n${chunk}`
          : chunk;
      };

      logInfo("llm.request", "Prepared request payload", {
        withScreenshot,
        intentMode: requestIntent.mode,
        intentReason: requestIntent.reason,
        transcriptMessages: effectiveContextMessages.length,
        transcriptChars: transcript.length,
        manualQuestionChars: questionText.length,
        questionChars: requestQuestion.length,
        language: settings.primaryLanguage,
      });

      if (screenshotFailureDetail) {
        appendToQuestion(`Скриншот не добавлен: ${screenshotFailureDetail}`);
      }

      if (screenshotBase64) {
        appendToQuestion(
          "Скриншот приложен. Если вопрос относится к коду или ошибке на экране, учитывай это в ответе.",
        );
        imageBase64Png = screenshotBase64;
        noteSnipUsed();
        logInfo("llm.screenshot", "Screenshot attached as image", {
          base64Length: screenshotBase64.length,
          handlingMode: settings.imageHandlingMode,
        });

        if (settings.imageHandlingMode === "ocr_text") {
          const ocrText = await tryExtractOcrText(screenshotBase64);
          if (ocrText) {
            appendToQuestion(`Текст/код со скриншота:\n${ocrText.slice(0, 2500)}`);
            logInfo("llm.screenshot", "OCR text extracted from screenshot", {
              ocrChars: ocrText.length,
            });
          } else {
            appendToQuestion("Скриншот сделан, но OCR не смог извлечь текст.");
            logWarn("llm.screenshot", "Screenshot captured but OCR returned empty text");
          }
        }
      }

      if (clipboardImageBase64) {
        appendToQuestion(
          "К вопросу приложено изображение из буфера обмена. Если на нём код или ошибка, учитывай это в ответе.",
        );
        imageBase64Png = clipboardImageBase64;
        noteUploadUsed();
        logInfo("llm.screenshot", "Clipboard image attached", {
          base64Length: clipboardImageBase64.length,
          handlingMode: settings.imageHandlingMode,
        });

        if (settings.imageHandlingMode === "ocr_text") {
          const ocrText = await tryExtractOcrText(clipboardImageBase64);
          if (ocrText) {
            appendToQuestion(`Текст/код с изображения:\n${ocrText.slice(0, 2500)}`);
            logInfo("llm.screenshot", "OCR text extracted from clipboard image", {
              ocrChars: ocrText.length,
            });
          } else {
            logWarn("llm.screenshot", "Clipboard image attached but OCR returned empty text");
          }
        }
      }

      // Only now is the request certain to go out, so this is the point where the
      // input is consumed. Doing it earlier lost the typed question on cancel.
      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: `Запрос отправлен. Режим: ${getIntentModeLabel(requestIntent.mode)}.`,
        isFinal: true,
      });
      if (questionText) {
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "user",
          text: questionText,
          isFinal: true,
        });
      }
      if (manualQuestionText) {
        setManualQuestion("");
        manualQuestionRef.current = "";
      }
      if (hadDictatedText) {
        // Stop accepting any trailing transcript for the dictation that was just sent.
        dictationProducedTextRef.current = false;
        dictationRef.current.id = null;
        setDictationHint(null);
      }
      if (clipboardImageBase64) {
        setPastedImageBase64(null);
      }
      flushContextBuffer();

      abortRef.current?.abort();
      const requestController = new AbortController();
      abortRef.current = requestController;
      const proxyUiTimeoutMs = withScreenshot ? 45_000 : 30_000;
      const proxyUiTimeoutMessage = `Сервис отвечает слишком долго (>${Math.round(proxyUiTimeoutMs / 1000)} сек). Проверьте сеть и повторите попытку.`;

      try {
        const startedAtMs = performance.now();
        logInfo("assistant.request", "Sending request to service", {
          withScreenshot,
          hasImage: Boolean(imageBase64Png),
          baseUrl: settings.customBaseUrl.trim() || PROXY_BASE_URL,
        });
        const response = await withTimeout(
          requestProxyHint({
            licenseKey: settings.apiKey,
            baseUrlPreset: "custom",
            customBaseUrl: settings.customBaseUrl.trim() || PROXY_BASE_URL,
            question: requestQuestion,
            language: settings.primaryLanguage,
            context: buildAssistantContext({
              topic: settings.interviewContext,
              files: settings.contextFiles,
            }),
            imageBase64Png,
            timeoutMs: proxyUiTimeoutMs,
            signal: requestController.signal,
          }),
          proxyUiTimeoutMs + 1000,
          proxyUiTimeoutMessage,
        );
        // A successful hint after an expiry episode means the license was
        // renewed (e.g. from the phone/bot). Clear the badge and announce once.
        if (licenseExpiredAnnouncedRef.current) {
          licenseExpiredAnnouncedRef.current = false;
          useLicenseStore.getState().noteServerLicenseRecovered();
          addMessage({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            source: "ai_marker",
            text: "Лицензия продлена, подсказки снова доступны.",
            isFinal: true,
          });
        }
        const formatted = formatProxyHintResponse(response, {
          expectedIntentMode: requestIntent.mode,
        });
        const hadEmptyFormatted = !formatted.trim();
        const safeFormatted = hadEmptyFormatted
          ? "Не удалось сформировать содержательный ответ. Повторите вопрос короче и нажмите «Отправить» ещё раз."
          : formatted;
        setLastHintMeta({
          hintId: response.hintId ?? null,
          taskType: response.taskType ?? null,
          question: requestQuestion,
          hadScreenshot: withScreenshot,
          intent: requestIntent,
        });
        const totalMs = performance.now() - startedAtMs;
        logInfo("assistant.request", "Received service response", {
          latencyMs: Math.round(totalMs),
          responseChars: safeFormatted.length,
          hadEmptyFormatted,
        });

        useSessionStore.setState((s) => ({
          lastLlmResponse: s.lastLlmResponse
            ? {
                ...s.lastLlmResponse,
                text: safeFormatted,
                isStreaming: false,
                firstTokenLatencyMs: totalMs,
              }
            : null,
          llmResponses: s.lastLlmResponse
            ? s.llmResponses.map((response) =>
                response.id === s.lastLlmResponse?.id
                  ? {
                      ...response,
                      text: safeFormatted,
                      isStreaming: false,
                      firstTokenLatencyMs: totalMs,
                    }
                  : response,
              )
            : s.llmResponses,
        }));

        if (hadEmptyFormatted) {
          logWarn("llm.request", "Service response was empty after formatting. Fallback text applied.");
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

        // License expired mid-interview: never interrupt the interview. Announce
        // once, keep transcription running, and let the next F8/F9 retry (which
        // will recover automatically if the user renews from their phone).
        if (err instanceof ProxyApiError && err.code === "LICENSE_EXPIRED") {
          useLicenseStore.getState().noteServerLicenseError(err.code);
          logWarn("assistant.request", "License expired during interview", {
            code: err.code,
          });
          setLastLlmError(message);
          if (!licenseExpiredAnnouncedRef.current) {
            licenseExpiredAnnouncedRef.current = true;
            addMessage({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              source: "ai_marker",
              text: "Срок действия лицензии истёк — подсказки приостановлены. Расшифровка продолжается. Продлить можно с телефона в боте или в разделе «Кабинет» после интервью.",
              isFinal: true,
            });
          }
          finishLlmResponse(0);
          return;
        }

        if (
          err instanceof ProxyApiError &&
          (err.code === "AUTH_TOKEN_INVALID" ||
            err.code === "AUTH_TOKEN_REVOKED" ||
            err.code === "AUTH_TOKEN_REQUIRED" ||
            err.code === "TOKEN_INVALID")
        ) {
          useLicenseStore.getState().noteServerLicenseError(err.code);
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
      isLlmLoading,
      noteSnipUsed,
      noteUploadUsed,
      openCropDialog,
      pastedImageBase64,
      planLimits,
      setLlmResponse,
      settings,
      snipsRemaining,
      stopDictation,
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

      const liveSettings = useSettingsStore.getState();
      const trimmedContext = liveSettings.interviewContext.trim();
      const record: SessionRecord = {
        id: crypto.randomUUID(),
        startedAt: startedAtSnapshot,
        endedAt,
        model: settings.selectedModel?.id ?? "proxy",
        provider: "custom",
        mode: snapshot.mode,
        safeModeReason: snapshot.safeModeReason,
        interviewContext: trimmedContext || undefined,
        contextFiles:
          liveSettings.contextFiles.length > 0
            ? liveSettings.contextFiles.map((file) => ({
                name: file.name,
                size: file.size,
              }))
            : undefined,
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
  // Once recognition is running, sending is always allowed: the transcript may fill
  // in between the click and the request, and blocking the button until something has
  // already been recognised just makes the app look frozen.
  const hasQuestionToSend =
    contextBuffer.length > 0 ||
    manualQuestion.trim().length > 0 ||
    Boolean(pastedImageBase64) ||
    isRecognitionReady;
  const dictationTrigger = settings.dictationTrigger;
  const dictationSourceHint =
    settings.dictationSource === "system"
      ? t("Слушаем звук компьютера...")
      : settings.dictationSource === "both"
        ? t("Слушаем микрофон и звук компьютера...")
        : t("Слушаем микрофон...");
  // The button captures whoever the "Что слушать" setting points at, so calling it
  // "record your question by voice" was wrong for two of the three modes.
  const dictationLabel =
    settings.dictationSource === "mic"
      ? t("Записать вопрос голосом")
      : settings.dictationSource === "system"
        ? t("Поймать вопрос собеседника")
        : t("Поймать вопрос: микрофон и звук компьютера");
  const visibleMessages = selectVisibleMessages(messages, { showFullTranscript });
  const hiddenPhraseCount = countHiddenPhrases(messages, visibleMessages);
  const приложениеRootClassName = isEmbeddedMode
    ? "flex h-full min-h-0 w-full flex-col bg-bg-primary text-text-primary"
    : "overlay-surface h-screen w-screen flex flex-col bg-bg-primary/70 text-text-primary backdrop-blur-[2px]";
  const newMessagesButtonClassName = isEmbeddedMode
    ? "absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-bg-card px-3 py-1.5 text-xs font-medium text-text-primary shadow-[0_10px_30px_-14px_rgba(24,28,55,0.4)] transition-colors hover:bg-bg-tertiary/50"
    : "fixed bottom-36 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-bg-card px-3 py-1.5 text-xs font-medium text-text-primary shadow-lg transition-colors hover:bg-bg-tertiary/50";
  const chatAreaClassName =
    "relative flex-1 min-h-0 overflow-y-auto px-4 py-4";
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
    ? STT_ENGINE_SERVER_ONLY
      ? "Подключаем серверное распознавание"
      : "Загружаем модель распознавания"
    : sttWarmupUi?.title ?? "Подготавливаем распознавание";
  const modelLoadingProgressPercent = isSttStarting
    ? startupProgressPercent
    : sttWarmupUi?.progressPercent ?? 0;
  const modelLoadingElapsedLabel = isSttStarting
    ? `Прошло ${formatElapsed(sttStartupElapsedMs)}`
    : null;
  const modelLoadingHint = isSttStarting
    ? STT_ENGINE_SERVER_ONLY
      ? sttStartupElapsedMs > 30000
        ? "Старт затянулся: проверяем резервный endpoint и повторяем сетевой запрос. Обычно это восстанавливается автоматически."
        : "Проверяем аудио и отправляем первые чанки речи на сервер. Обычно это занимает 5-20 секунд."
      : sttStartupElapsedMs > LIVE_MODEL_LOADING_ESTIMATE_MS
        ? "Модель почти загружена или система ещё читает её с диска. Это не зависание: дождитесь статуса готовности."
        : "Модель распознавания загружается в память. Во время загрузки не нажимайте перезапуск аудио."
    : sttWarmupUi?.hint ?? sttStatusText;

  const openAudioSettings = () => {
    setSettingsTab("audio");
    setSettingsFocus("audio-devices");
    setView("settings");
  };

  const sessionModeChip = isSafeMode
    ? {
        label: "Режим без аудио",
        title: t("Распознавание выключено: доступны ручной вопрос и ножницы."),
        className: "border-accent/25 bg-accent-muted text-accent",
        spinner: false,
      }
    : isSttStarting || isSttRecovering
      ? {
          label: "Запускается",
          title: t("Распознавание загружается — диктовка включится следом."),
          className: "border-border bg-bg-secondary/60 text-text-secondary",
          spinner: true,
        }
      : isRecognitionReady
        ? {
            label: "Слушаю",
            title: t("Речь собеседника попадает в поле вопроса."),
            className: "border-success/25 bg-success-muted text-success",
            spinner: false,
          }
        : {
            label: "Звук не идёт",
            title: t("Распознавание не запущено — перезапустите аудио или проверьте устройства."),
            className: "border-warning/25 bg-warning-muted text-warning",
            spinner: false,
          };

  return (
    <div className={приложениеRootClassName}>
      {/* Header */}
      <div className="flex items-center justify-between gap-4 border-b border-border bg-bg-card/80 px-4 py-2.5 shrink-0 backdrop-blur-sm">
        <div className="flex items-center gap-3.5">
          {/* Ambient status: no chrome, so the timer stays the only anchor here */}
          <div className="flex items-center gap-2.5">
            <AudioSignal
              icon={<Mic className="h-[15px] w-[15px]" />}
              label={t("Микрофон")}
              active={audioActivity.mic}
            />
            <AudioSignal
              icon={<Volume2 className="h-[15px] w-[15px]" />}
              label={t("Системный звук")}
              active={audioActivity.system}
            />
            <span
              className="text-[11px] font-medium tracking-[0.06em] text-text-muted"
              title={getLanguageLabel(activeSttLanguage)}
            >
              {getLanguageShortLabel(activeSttLanguage)}
            </span>
          </div>
          {/* The chip used to appear only in audio-free mode, so a live session showed
              nothing at all and there was no way to tell "listening" from "still
              loading" from "dead". Every state names itself now. */}
          <span
            className={`inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[10px] font-semibold uppercase tracking-[0.12em] ${sessionModeChip.className}`}
            title={sessionModeChip.title}
          >
            {sessionModeChip.spinner && <Loader2 className="h-3 w-3 animate-spin" />}
            {t(sessionModeChip.label)}
          </span>
          {/* Служебная капсула счётчиков: таймер + остатки лимитов за собес одной
              группой с разделителями — компактнее и спокойнее, чем ряд отдельных
              пилюль. Ножницы скрыты на фри — там их нет вовсе, «0» читался бы как
              исчерпанный лимит. */}
          <div className="flex h-7 shrink-0 items-center overflow-hidden rounded-full border border-border bg-bg-secondary/60">
            <span className="inline-flex h-full items-center gap-1 px-2">
              <Clock className="h-3.5 w-3.5 text-text-muted" />
              <span className="font-mono text-xs tabular-nums text-text-primary">
                {formatElapsed(elapsedMs)}
              </span>
            </span>
            {planLimits.scissorsPerInterview > 0 && (
              <HeaderLimitSegment
                icon={Scissors}
                remaining={snipsRemaining}
                total={planLimits.scissorsPerInterview}
                title={t("Ножницы: осталось {n} из {total} за собес", {
                  n: snipsRemaining,
                  total: planLimits.scissorsPerInterview,
                })}
              />
            )}
            <HeaderLimitSegment
              icon={Paperclip}
              remaining={uploadsRemaining}
              total={planLimits.uploadsPerInterview}
              title={t("Загрузки: осталось {n} из {total} за собес", {
                n: uploadsRemaining,
                total: planLimits.uploadsPerInterview,
              })}
            />
            <HeaderLimitSegment
              icon={AudioLines}
              remaining={audioHintsRemaining}
              total={planLimits.audioHintsPerInterview}
              title={t("Аудио-подсказки: осталось {n} из {total} за собес", {
                n: audioHintsRemaining,
                total: planLimits.audioHintsPerInterview,
              })}
            />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {/* Узкое окно: подписи кнопок прячутся, остаются иконки с тултипами. */}
          <button
            type="button"
            onClick={() => setShowFullTranscript((current) => !current)}
            title={showFullTranscript ? t("Компактно") : t("Транскрипт")}
            className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent px-2.5 text-xs font-medium text-text-secondary hover:border-border hover:bg-bg-tertiary/60 hover:text-text-primary transition-colors"
          >
            <AlignLeft className="h-3.5 w-3.5 min-[880px]:hidden" />
            <span className="hidden min-[880px]:inline">
              {showFullTranscript ? t("Компактно") : t("Транскрипт")}
            </span>
          </button>
          <Button
            variant="secondary"
            size="xs"
            className="shrink-0 whitespace-nowrap"
            title={
              isSafeMode ? t("Аудио выкл.") : isSttStarting ? t("Загрузка...") : t("Перезапуск аудио")
            }
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
          >
            <span className="hidden min-[880px]:inline">
              {isSafeMode ? t("Аудио выкл.") : isSttStarting ? t("Загрузка...") : t("Перезапуск аудио")}
            </span>
          </Button>
          <Button
            variant="danger"
            size="xs"
            className="shrink-0 whitespace-nowrap"
            title={
              isEndingInterview
                ? t("Завершаем...")
                : t("Завершить интервью ({key})", { key: endHkLabel })
            }
            onClick={endInterview}
            disabled={isEndingInterview}
            icon={
              isEndingInterview ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Square className="w-3 h-3" />
              )
            }
          >
            {isEndingInterview ? (
              <span className="hidden min-[880px]:inline">{t("Завершаем...")}</span>
            ) : (
              <span className="hidden items-center gap-1.5 min-[880px]:flex">
                {t("Завершить")}
                <kbd className="rounded bg-white/20 px-1.5 py-0.5 font-mono text-[10px] leading-none tracking-normal text-white/90">
                  {endHkLabel}
                </kbd>
              </span>
            )}
          </Button>
        </div>
      </div>

      {modelLoadingBannerVisible && (
        <div className="mx-4 mt-3 overflow-hidden rounded-xl border border-accent/20 bg-accent-muted">
          <div className="flex flex-col gap-3 px-3.5 py-3 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-accent/25 bg-bg-card">
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-text-primary">
                    {modelLoadingTitle}
                  </span>
                  <span className="rounded-full border border-accent/20 bg-bg-card px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">
                    {t("Не зависло")}
                  </span>
                  {modelLoadingElapsedLabel && (
                    <span className="font-mono text-[11px] text-text-muted">
                      {modelLoadingElapsedLabel}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                  {modelLoadingHint}
                </p>
              </div>
            </div>

            <div className="w-full shrink-0 md:w-56">
              <div className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.12em] text-text-muted">
                <span>{t("Подготовка")}</span>
                <span className="font-mono tabular-nums text-text-secondary">{modelLoadingProgressPercent}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-bg-card">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
                  style={{ width: `${modelLoadingProgressPercent}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {isSafeMode && (
        <div className="mx-4 mt-3 rounded-xl border border-accent/20 bg-accent-muted px-3.5 py-2.5 text-xs text-text-secondary">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="leading-relaxed">
              {t("Режим без аудио активен: распознавание не запускается. Доступны ручной вопрос, ножницы и ответы помощника.")}
            </div>
            <div className="flex shrink-0 flex-wrap gap-1.5">
              <BannerAction onClick={openAudioSettings}>{t("Настроить звук")}</BannerAction>
              <BannerAction onClick={() => setView("dashboard")}>{t("WAV-тест")}</BannerAction>
              <BannerAction onClick={resumeLiveMode}>{t("Вернуть звук")}</BannerAction>
            </div>
          </div>
        </div>
      )}

      {sttNeedsAttention && (
        <div className="mx-4 mt-3 rounded-xl border border-warning/25 bg-warning-muted px-3.5 py-2.5 text-xs text-text-secondary">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="leading-relaxed">
              {t("Аудио требует внимания: можно перезапустить захват, открыть устройства или перейти на главную и записать WAV-тест.")}
            </div>
            <div className="flex shrink-0 flex-wrap gap-1.5">
              <BannerAction
                onClick={() => void restartSttSession("manual")}
                disabled={isSttRecovering || isSttStarting}
                tone="warning"
              >
                {isSttStarting ? t("Загрузка...") : t("Перезапустить")}
              </BannerAction>
              <BannerAction onClick={openAudioSettings} tone="warning">{t("Устройства")}</BannerAction>
              <BannerAction onClick={() => setView("dashboard")} tone="warning">{t("WAV-тест")}</BannerAction>
              <BannerAction
                onClick={() =>
                  void activateSafeMode(
                    "Распознавание отключено вручную из панели восстановления.",
                  )
                }
                tone="warning"
              >
                {t("Без аудио")}
              </BannerAction>
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
        <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-end">
          {messages.length === 0 && (
            <div className="flex flex-1 items-center justify-center">
              <div className="w-full max-w-md px-4">
                {sttWarmupUi && !modelLoadingBannerVisible && (
                  <div className="mb-4 rounded-xl border border-border bg-bg-card px-4 py-3 shadow-[0_1px_2px_rgba(20,22,40,0.04)]">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="font-medium text-text-primary">{sttWarmupUi.title}</span>
                      <span className="font-mono tabular-nums text-text-muted">
                        {sttWarmupUi.progressPercent}%
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
                      <div
                        className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
                        style={{ width: `${sttWarmupUi.progressPercent}%` }}
                      />
                    </div>
                    <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
                      {sttWarmupUi.hint}
                    </p>
                  </div>
                )}
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-border bg-bg-card text-text-muted">
                  <Mic className="h-4 w-4" />
                </div>
                <p className="mt-3 text-center text-sm text-text-secondary">
                  {sttStatusText}
                </p>
              </div>
            </div>
          )}

          {!showFullTranscript && hiddenPhraseCount > 0 && (
            <div className="pb-3 text-center text-[10px] text-text-muted">
              {t("Скрыто фраз: {count}. Полный транскрипт раскрывается вверху.", { count: hiddenPhraseCount })}
            </div>
          )}

          {visibleMessages.length > 0 && (
            <ol className="space-y-3">
              {visibleMessages.map((msg, index) => {
                const next = visibleMessages[index + 1];
                return (
                  <MessageEntry
                    key={msg.id}
                    message={msg}
                    connectDown={
                      msg.source !== "ai_marker" &&
                      Boolean(next) &&
                      next.source !== "ai_marker"
                    }
                  />
                );
              })}
            </ol>
          )}

          <div ref={chatEndRef} />
        </div>

        {!isAtBottom && newMsgCount > 0 && (
          <button
            onClick={jumpToBottom}
            className={newMessagesButtonClassName}
          >
            <ChevronDown className="w-3.5 h-3.5" />
            {t("{newMsgCount} новых", { newMsgCount })}
          </button>
        )}
      </div>

      {/* AI Response Panel */}
      {lastLlmResponse && (
        <div className="mx-4 mb-3 flex max-h-[48vh] shrink-0 flex-col overflow-hidden rounded-2xl border border-border bg-bg-card shadow-[0_1px_2px_rgba(20,22,40,0.04),0_18px_44px_-28px_rgba(24,28,55,0.24)]">
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-secondary/60 px-3 py-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent shadow-[0_2px_6px_-2px_rgba(59,91,219,0.55)]">
              <Bot className="h-3 w-3 text-white" />
            </span>
            <span className="text-xs font-semibold text-text-primary">{t("Подсказка")}</span>
            {lastRequestIntent && (
              <span
                className="rounded-full border border-accent/20 bg-accent-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-accent"
                title={lastRequestIntent.reason}
              >
                {t(getIntentModeLabel(lastRequestIntent.mode))}
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                void copyLastResponse();
              }}
              className="ml-auto inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-tertiary/60 hover:text-text-primary transition-colors"
              title={t("Копировать")}
            >
              <Copy className="h-3 w-3" />
              {copiedResponse ? t("Скопировано") : t("Копировать")}
            </button>
            {lastLlmResponse.isStreaming && (
              <Loader2 className="w-3 h-3 text-accent animate-spin" />
            )}
            {!lastLlmResponse.isStreaming && lastLlmResponse.totalLatencyMs && (
              <span className="font-mono text-[10px] tabular-nums text-text-muted">
                {(lastLlmResponse.totalLatencyMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
          <div
            ref={aiPanelRef}
            onScroll={handleAiPanelScroll}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
          >
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-primary select-text">
              {lastLlmResponse.text || (
                <span className="text-text-muted">{t("Ждём ответ...")}</span>
              )}
            </p>
            {!lastLlmResponse.isStreaming && (
              <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-border pt-2">
                <FeedbackButton
                  label={t("Хорошо")}
                  active={отзываUi.sentRating === "good"}
                  loading={отзываUi.sending === "good"}
                  onClick={() => void sendAiFeedback("good")}
                />
                <FeedbackButton
                  label={t("Плохо")}
                  active={отзываUi.sentRating === "bad"}
                  loading={отзываUi.sending === "bad"}
                  onClick={() => void sendAiFeedback("bad")}
                />
                <FeedbackButton
                  label={t("Не тот режим")}
                  active={отзываUi.sentRating === "wrong_mode"}
                  loading={отзываUi.sending === "wrong_mode"}
                  onClick={() => void sendAiFeedback("wrong_mode")}
                />
              </div>
            )}
            {отзываUi.отзываId && (
              <div className="mt-2 rounded-lg border border-success/25 bg-success-muted px-2 py-1 text-[10px] text-success">
                {t("Оценка отправлена: {feedbackId}", { feedbackId: отзываUi.отзываId })}
              </div>
            )}
            {отзываUi.error && (
              <div className="mt-2 rounded-lg border border-danger/25 bg-danger-muted px-2 py-1 text-[10px] text-danger">
                {отзываUi.error}
              </div>
            )}
          </div>
        </div>
      )}

      {lastLlmError && (
        <div className="mx-4 mb-3 shrink-0 rounded-xl border border-danger/25 bg-danger-muted px-3 py-2">
          <p className="text-[11px] leading-relaxed text-danger">
            {t("Ошибка сервиса: {error}", { error: lastLlmError })}
          </p>
        </div>
      )}

      {/* Composer: question + actions, visually one block */}
      <div className="shrink-0 border-t border-border bg-bg-secondary/40 px-4 pt-2.5 pb-3">
        {/* p-3 matches the 12px corner radius so controls clear the rounded corners */}
        <div className="space-y-2 rounded-xl border border-border bg-bg-card p-3 transition-colors focus-within:border-border-active focus-within:ring-2 focus-within:ring-accent/15">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={manualQuestion}
              onChange={(event) => {
                dictationProducedTextRef.current = false;
                setManualQuestion(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendToLlm(false);
                }
              }}
              onPaste={attachImageFromClipboard}
              placeholder={
                isDictating
                  ? // "Говорите" is only true when the window listens to your mic; on
                    // the system track it is the interviewer who is being captured.
                    settings.dictationSource === "system"
                    ? t("Ловим вопрос собеседника — текст появится здесь")
                    : t("Говорите — текст появится здесь")
                  : t("Введите вопрос вручную или отправьте ножницы без текста")
              }
              className="h-9 w-full flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted outline-none"
            />
            {manualQuestion.length > 0 && (
              // The field fills itself from the interviewer's speech, so there has to be
              // a one-click way out when it collects something you never meant to send.
              <button
                type="button"
                onClick={clearQuestion}
                title={t("Очистить вопрос")}
                aria-label={t("Очистить вопрос")}
                className="flex h-9 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-tertiary/60 hover:text-text-primary"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              // Push-to-talk audio hint: click to start recording the interviewer,
              // click again to send that clip straight to Gemini. No local dictation.
              onClick={toggleAudioHint}
              disabled={isSafeMode || (!audioHintRecording && audioHintsRemaining <= 0)}
              title={
                isSafeMode
                  ? t("Режим без аудио: запись недоступна")
                  : !audioHintRecording && audioHintsRemaining <= 0
                    ? t("Лимит аудио-подсказок за собес исчерпан")
                    : !isRecognitionReady
                      ? t("Аудиопоток ещё подключается")
                      : audioHintRecording
                        ? t("Остановить и отправить вопрос в Gemini")
                        : t("Записать вопрос голосом для Gemini")
              }
              aria-pressed={audioHintRecording}
              aria-label={t("Голосовой вопрос в Gemini")}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                audioHintRecording
                  ? "border-danger/30 bg-danger-muted text-danger"
                  : isRecognitionReady
                    ? "border-border text-text-secondary hover:bg-bg-tertiary/60 hover:text-text-primary"
                    : "border-border/60 text-text-muted hover:bg-bg-tertiary/60"
              }`}
            >
              {audioHintRecording ? (
                <span className="relative flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger/60" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-danger" />
                </span>
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </button>
            <button
              type="button"
              // "Last N seconds" quick hint: one click sends the trailing window of the
              // live audio stream straight to Gemini. Separate from push-to-talk (Mic) —
              // no start/stop. Window length (3–15s) is the user's setting (speech tab).
              onClick={sendQuickAudioHint}
              disabled={
                isSafeMode ||
                audioHintRecording ||
                audioHintTailSending ||
                audioHintsRemaining <= 0
              }
              title={
                isSafeMode
                  ? t("Режим без аудио: запись недоступна")
                  : audioHintsRemaining <= 0
                    ? t("Лимит аудио-подсказок за собес исчерпан")
                    : !isRecognitionReady
                      ? t("Аудиопоток ещё подключается")
                      : t("Отправить последние {n} сек в Gemini (осталось {r})", {
                          n: settings.audioHintWindowSeconds,
                          r: audioHintsRemaining,
                        })
              }
              aria-label={t("Отправить последние секунды в Gemini")}
              className={`flex h-9 shrink-0 items-center justify-center gap-1 rounded-lg border px-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                isRecognitionReady && !audioHintRecording
                  ? "border-border text-text-secondary hover:bg-bg-tertiary/60 hover:text-text-primary"
                  : "border-border/60 text-text-muted hover:bg-bg-tertiary/60"
              }`}
            >
              {audioHintTailSending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <History className="h-4 w-4" />
              )}
              <span className="tabular-nums">{settings.audioHintWindowSeconds}с</span>
            </button>
          </div>
          {pastedImageBase64 && (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-secondary/60 p-1.5">
              <img
                src={`data:image/png;base64,${pastedImageBase64}`}
                alt={t("Изображение из буфера обмена")}
                className="h-9 w-14 shrink-0 rounded border border-border object-cover"
              />
              <span className="text-[11px] text-text-secondary">
                {t("Изображение приложено к следующему запросу")}
              </span>
              <button
                type="button"
                onClick={() => setPastedImageBase64(null)}
                className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-tertiary/60 hover:text-text-primary"
                title={t("Убрать изображение")}
                aria-label={t("Убрать изображение")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {(isDictating || dictationHint) && (
            <div
              className={`text-[11px] leading-relaxed ${
                dictationHint ? "text-warning" : "text-text-muted"
              }`}
            >
              {dictationHint ?? dictationSourceHint}
            </div>
          )}
          {/* Actions live inside the composer card — one unit instead of a detached bar.
              flex-wrap is a safety net: the pair fits from the 400px minimum overlay
              width upward, and stacks instead of overflowing if it ever gets tighter. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => sendToLlm(false)}
              disabled={isLlmLoading || !hasQuestionToSend}
              icon={
                isLlmLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )
              }
              className="flex-[3]"
            >
              <span className="flex items-center gap-2">
                {t("Отправить")}
                <kbd className="rounded-md bg-white/20 px-1.5 py-1 font-mono text-[10px] leading-none tracking-normal text-white/90">
                  {sendHkLabel}
                </kbd>
              </span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => sendToLlm(true)}
              disabled={isLlmLoading || snipsRemaining <= 0}
              title={
                planLimits.scissorsPerInterview === 0
                  ? t("Ножницы недоступны на тарифе «{plan}»", { plan: planLimits.title })
                  : snipsRemaining <= 0
                    ? t("Лимит ножниц за собес исчерпан")
                    : t("Осталось {n} за собес", { n: snipsRemaining })
              }
              icon={
                isLlmLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Scissors className="h-4 w-4" />
                )
              }
              className="flex-[2]"
            >
              <span className="flex items-center gap-2">
                {t("Ножницы")}
                <kbd className="rounded-md bg-bg-tertiary px-1.5 py-1 font-mono text-[10px] leading-none tracking-normal text-text-secondary">
                  {sendScreenHkLabel}
                </kbd>
              </span>
            </Button>
          </div>
        </div>
      </div>

      {cropDialogImageBase64 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-5xl rounded-2xl border border-border bg-bg-card shadow-[0_30px_60px_-20px_rgba(24,28,55,0.35)]">
            <div className="border-b border-border px-4 py-3">
              <div className="text-sm font-semibold text-text-primary">
                {t("Ножницы: выделите область для отправки")}
              </div>
              <div className="mt-1 text-xs text-text-secondary">
                {t("Зажмите левую кнопку мыши и выделите нужный фрагмент.")}
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
                  alt={t("Скриншот для выделения")}
                  draggable={false}
                  className="max-h-[62vh] max-w-full rounded-md border border-border object-contain"
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

            <div className="space-y-2 border-t border-border px-4 py-3">
              <input
                type="text"
                value={cropPrompt}
                autoFocus
                onChange={(event) => {
                  cropPromptRef.current = event.target.value;
                  setCropPrompt(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey) {
                    return;
                  }
                  event.preventDefault();
                  // Enter sends what is on screen: the selection if one exists,
                  // otherwise the whole screenshot.
                  if (cropRect) {
                    void applyCropSelection();
                  } else {
                    closeCropDialog(cropDialogImageBase64);
                  }
                }}
                placeholder={t("Вопрос к скриншоту — необязательно")}
                className="h-9 w-full rounded-lg border border-border bg-bg-card px-3 text-sm text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-border-active focus:ring-2 focus:ring-accent/15"
              />
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => closeCropDialog(null)}
                >
                  {t("Отмена")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => closeCropDialog(cropDialogImageBase64)}
                >
                  {t("Отправить весь экран")}
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
                  {t("Отправить выделение")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function AudioSignal({
  icon,
  label,
  active,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 transition-colors duration-300 ${
        active ? "text-success" : "text-text-muted"
      }`}
      title={label}
    >
      {icon}
      <span
        className={`h-[5px] w-[5px] rounded-full ${
          active ? "bg-success" : "bg-text-muted/30"
        }`}
        aria-hidden="true"
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function BannerAction({
  onClick,
  disabled,
  tone = "accent",
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  tone?: "accent" | "warning";
  children: ReactNode;
}) {
  const toneClasses =
    tone === "warning"
      ? "border-warning/25 text-warning hover:bg-warning-muted"
      : "border-accent/25 text-accent hover:bg-accent-muted";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border bg-bg-card px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.1em] transition-colors disabled:opacity-50 ${toneClasses}`}
    >
      {children}
    </button>
  );
}

function MessageEntry({
  message,
  connectDown,
}: {
  message: ChatMessage;
  connectDown: boolean;
}) {
  const t = useT();
  if (message.source === "ai_marker") {
    // Notices used to be centred 10.5px text at 80% of an already muted grey — about
    // 2.5:1 against the surface, and a wall of it whenever audio failed to start.
    // Left-aligned in a quiet card instead: readable, and visibly not speech.
    return (
      <li className="relative flex py-0.5">
        <div className="w-full rounded-lg border border-border/70 bg-bg-secondary/70 px-3 py-2 text-xs leading-relaxed text-text-secondary">
          {message.text}
        </div>
      </li>
    );
  }

  const isInterviewer = message.source === "interviewer";
  const timeLabel = formatMessageTime(message.timestamp);

  return (
    <li
      className={`relative grid grid-cols-[76px_1fr] items-start ${
        !message.isFinal ? "opacity-70" : ""
      }`}
    >
      <div className="flex flex-col items-end pr-3">
        <span className="font-mono text-[10px] tracking-[0.06em] text-text-muted tabular-nums">
          {timeLabel}
        </span>
      </div>
      <div className="relative pl-5">
        {/* Rail segment down to the next entry's dot: 12px row gap + 8px dot offset */}
        {connectDown && (
          <span
            className="absolute left-0 top-2 -bottom-5 w-px -translate-x-1/2 bg-border"
            aria-hidden
          />
        )}
        <span
          className={`absolute left-0 top-[3px] h-2.5 w-2.5 -translate-x-1/2 rounded-full ring-4 ring-bg-primary ${
            isInterviewer ? "bg-accent" : "bg-text-primary"
          }`}
          aria-hidden
        />
        <div className="mb-0.5 flex items-baseline gap-2">
          <span
            className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${
              isInterviewer ? "text-accent" : "text-text-primary"
            }`}
          >
            {isInterviewer ? t("Собеседник") : t("Вы")}
          </span>
        </div>
        <p className="select-text whitespace-pre-wrap text-[14px] leading-[1.55] text-text-primary">
          {message.text}
        </p>
      </div>
    </li>
  );
}

function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hh = date.getHours().toString().padStart(2, "0");
  const mm = date.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
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
      className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] transition-colors ${
        active
          ? "border-success/25 bg-success-muted text-success"
          : "border-border text-text-secondary hover:bg-bg-tertiary/60 hover:text-text-primary"
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

/**
 * Сегмент капсулы остатков в шапке: иконка + число. Тихий в обычном состоянии,
 * желтеет на исходе (≤20%) и краснеет в ноль; число делает тот же «поп», что
 * значение слайдера (value-pop), когда остаток меняется.
 */
function HeaderLimitSegment({
  icon: Icon,
  remaining,
  total,
  title,
}: {
  icon: typeof Scissors;
  remaining: number;
  total: number;
  title: string;
}) {
  const tone =
    remaining <= 0
      ? { icon: "text-danger/70", value: "text-danger" }
      : total > 0 && remaining / total <= 0.2
        ? { icon: "text-warning/80", value: "text-warning" }
        : { icon: "text-text-muted", value: "text-text-primary" };
  return (
    <span
      className="inline-flex h-full items-center gap-1 border-l border-border/70 px-2"
      title={title}
    >
      <Icon className={`h-3.5 w-3.5 ${tone.icon}`} />
      <span
        key={remaining}
        className={`value-pop font-mono text-xs font-semibold tabular-nums ${tone.value}`}
      >
        {remaining}
      </span>
    </span>
  );
}

function getIntentModeLabel(mode: InterviewIntentMode): string {
  return INTENT_MODE_LABELS[mode] ?? mode;
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
    /(^|[\s.,:;!?()[\]{}"'«»])(что такое|объясни|расскажи|зачем|как работает|какие|какой|какая|какое|уровни|виды|типы|отличие|разница|принципы|концепц|архитектур)(?=$|[\s.,:;!?()[\]{}"'«»])/.test(
      normalized,
    )
  );
}

function resolveRequestIntentMode(
  manualQuestion: string,
  requestText: string,
  screenshotMode: boolean,
): InterviewIntent {
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
    : "";
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
- "что такое этот подход?" => THEORY.
- "какие бывают режимы работы?" => THEORY.
- "объясни разницу между двумя подходами" => THEORY.`;

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
- если слово распознано неточно, интерпретируй его в пользу технического смысла и контекста разговора;
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
