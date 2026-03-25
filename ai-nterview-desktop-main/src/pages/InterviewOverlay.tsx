import { useState, useEffect, useRef, useCallback } from "react";
import {
  Send,
  Camera,
  Square,
  Mic,
  Volume2,
  Languages,
  Clock,
  ChevronDown,
  Bot,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useAppStore } from "@/stores/app";
import { useHistoryStore } from "@/stores/history";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { formatProxyHintResponse, requestProxyHint } from "@/lib/proxy";
import { getLanguageLabel } from "@/lib/languages";
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
import type { SttDiagnosticEvent, SttResultEvent } from "@/lib/tauri";

type VoskModelEntry = {
  id: string;
  language: string;
  variant: "small" | "large";
  installed: boolean;
  installed_versions: string[];
};

const VOSK_MODEL_LOOKUP_TIMEOUT_MS = 6000;
const STT_STARTUP_TIMEOUT_MS = 12000;

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

function toFriendlySttStartupError(error: unknown): string {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Неизвестная ошибка запуска распознавания речи";
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
    return "Языковая модель Vosk не установлена. Откройте Настройки -> Язык.";
  }
  if (normalized.includes("failed to load vosk runtime")) {
    return "Не удалось загрузить Vosk runtime. Переустановите его в настройках языка.";
  }
  if (normalized.includes("vosk failed to load model")) {
    return "Не удалось загрузить языковую модель Vosk. Попробуйте переустановить ее.";
  }
  if (normalized.includes("stt session is already running")) {
    return "Сессия распознавания уже запущена.";
  }

  return detail;
}

export function InterviewOverlay() {
  const session = useSessionStore();
  const settings = useSettingsStore();
  const { setView, setInterviewActive } = useAppStore();
  const addSessionToHistory = useHistoryStore((s) => s.addSession);
  const {
    isActive,
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
  const [activeSttLanguage, setActiveSttLanguage] = useState<PrimaryLanguage>(
    settings.primaryLanguage,
  );
  const [sttStatusText, setSttStatusText] = useState(
    "Подготавливаем распознавание речи...",
  );
  const aiPanelRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endingRef = useRef(false);
  const pendingMessageIdsRef = useRef<{ mic: string | null; system: string | null }>({
    mic: null,
    system: null,
  });
  const sttSignalSeenRef = useRef<{ mic: boolean; system: boolean }>({
    mic: false,
    system: false,
  });
  const sttNoSignalNoticeShownRef = useRef(false);

  useEffect(() => {
    if (!isActive && !endingRef.current) {
      startSession();
    }
  }, [isActive, startSession]);

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

  const resolveInstalledModelForLanguage = useCallback(
    (models: VoskModelEntry[], language: PrimaryLanguage) => {
      const preferredVariant =
        language === settings.primaryLanguage
          ? settings.primarySttVariant
          : language === settings.secondaryLanguage
            ? settings.secondarySttVariant
            : "small";

      const preferredModel =
        models.find(
          (entry) =>
            entry.language === language && entry.variant === preferredVariant,
        ) ?? null;
      const fallbackSmall =
        models.find(
          (entry) => entry.language === language && entry.variant === "small",
        ) ?? null;
      const selectedModel = preferredModel ?? fallbackSmall;
      if (!selectedModel) {
        return {
          preferredVariant,
          selectedModel: null,
          installedModelId: null,
          usedSmallFallback: false,
        };
      }

      let installedModelId = resolveInstalledModelId(selectedModel);
      let usedSmallFallback = false;
      if (!installedModelId && preferredVariant === "large" && fallbackSmall) {
        installedModelId = resolveInstalledModelId(fallbackSmall);
        usedSmallFallback = installedModelId !== null;
      }

      return {
        preferredVariant,
        selectedModel,
        installedModelId,
        usedSmallFallback,
      };
    },
    [
      settings.primaryLanguage,
      settings.primarySttVariant,
      settings.secondaryLanguage,
      settings.secondarySttVariant,
    ],
  );

  const warmStandbyModel = useCallback(
    async (activeLanguage: PrimaryLanguage, modelsSnapshot?: VoskModelEntry[]) => {
      if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
        return;
      }

      const standbyLanguage =
        activeLanguage === settings.primaryLanguage
          ? settings.secondaryLanguage
          : settings.primaryLanguage;

      if (standbyLanguage === "none" || standbyLanguage === activeLanguage) {
        return;
      }

      const { isTauri, listVoskModels, preloadSttModel } = await import("@/lib/tauri");
      if (!isTauri()) {
        return;
      }

      const models = modelsSnapshot ?? (await listVoskModels());
      const { installedModelId } = resolveInstalledModelForLanguage(
        models,
        standbyLanguage,
      );
      if (!installedModelId) {
        return;
      }

      await preloadSttModel(installedModelId);
    },
    [
      resolveInstalledModelForLanguage,
      settings.primaryLanguage,
      settings.secondaryLanguage,
    ],
  );

  const startConfiguredSttSession = useCallback(async () => {
    const { startSttSession } = await import("@/lib/tauri");
    await startSttSession({
      microphoneDeviceId: settings.microphoneDeviceId,
      systemAudioDeviceId: settings.systemAudioDeviceId,
    });
  }, [settings.microphoneDeviceId, settings.systemAudioDeviceId]);

  const ensureActiveSttLanguage = useCallback(
    async (language: PrimaryLanguage, restartSession: boolean): Promise<boolean> => {
      const {
        isTauri,
        isSttSessionRunning,
        listVoskModels,
        setActiveVoskModel,
        switchSttModel,
        stopSttSession,
      } = await import("@/lib/tauri");
      if (!isTauri()) {
        setActiveSttLanguage(language);
        return true;
      }

      const models = await withTimeout(
        listVoskModels(),
        VOSK_MODEL_LOOKUP_TIMEOUT_MS,
        "Не удалось быстро подготовить языковую модель Vosk. Проверьте локальный runtime и откройте Настройки -> Язык.",
      );
      const {
        selectedModel,
        installedModelId,
        usedSmallFallback,
      } = resolveInstalledModelForLanguage(models, language);

      if (!selectedModel) {
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: `Для языка ${getLanguageLabel(language)} не найдена модель Vosk.`,
          isFinal: true,
        });
        return false;
      }

      if (usedSmallFallback) {
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: `Для языка ${getLanguageLabel(language)} большая модель не установлена. Используем быструю.`,
          isFinal: true,
        });
      }

      if (!installedModelId) {
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: `Модель для языка ${getLanguageLabel(language)} не установлена. Откройте Настройки -> Язык.`,
          isFinal: true,
        });
        return false;
      }

      await setActiveVoskModel(installedModelId);

      if (restartSession) {
        const running = await isSttSessionRunning().catch(() => false);
        if (running) {
          try {
            await switchSttModel(installedModelId);
          } catch (err: unknown) {
            // Fallback path for older runtime if hot-switch fails.
            await stopSttSession().catch(() => {
              // Session may already be stopped.
            });
            await startConfiguredSttSession();
            const detail = toFriendlySttStartupError(err);
            addMessage({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              source: "ai_marker",
              text: `Быстрое переключение STT не сработало, перезапустили распознавание (${detail}).`,
              isFinal: true,
            });
          }
        } else {
          await startConfiguredSttSession();
        }
      }

      setActiveSttLanguage(language);
      void warmStandbyModel(language, models).catch((error: unknown) => {
        console.warn("Failed to preload standby STT model:", error);
      });
      return true;
    },
    [
      addMessage,
      resolveInstalledModelForLanguage,
      startConfiguredSttSession,
      warmStandbyModel,
    ],
  );

  const toggleSttLanguage = useCallback(async () => {
    if (settings.secondaryLanguage === "none") {
      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: "Secondary STT language is not configured.",
        isFinal: true,
      });
      return;
    }

    if (settings.secondaryLanguage === settings.primaryLanguage) {
      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: "Primary and secondary STT languages are identical. Pick a different secondary language in Settings.",
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
      return;
    }

    addMessage({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: "ai_marker",
      text: `STT switched to ${getLanguageLabel(nextLanguage)}.`,
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
      if (payload.source === "system") {
        sttSignalSeenRef.current.system = true;
      } else {
        sttSignalSeenRef.current.mic = true;
      }

      const text = payload.text.trim();
      if (!text) {
        return;
      }

      setSttStatusText("Распознавание активно. Речь успешно поступает в приложение.");

      const sourceKey = payload.source === "system" ? "system" : "mic";
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

      setSttStatusText(payload.message);

      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: payload.message,
        isFinal: true,
      });
    },
    [addMessage],
  );

  useEffect(() => {
    if (!isActive) {
      return;
    }

    pendingMessageIdsRef.current = { mic: null, system: null };
    sttSignalSeenRef.current = { mic: false, system: false };
    sttNoSignalNoticeShownRef.current = false;
    setSttStatusText("Подготавливаем языковую модель...");

    let unlistenResult: (() => void) | null = null;
    let unlistenDiagnostic: (() => void) | null = null;
    let noSignalTimer: number | null = null;

    async function setupStt() {
      const { isTauri } = await import("@/lib/tauri");
      if (!isTauri()) {
        return;
      }

      const { listen } = await import("@tauri-apps/api/event");
      unlistenResult = await listen<SttResultEvent>("stt_result", (event) => {
        handleSttResult(event.payload);
      });
      unlistenDiagnostic = await listen<SttDiagnosticEvent>("stt_diagnostic", (event) => {
        handleSttDiagnostic(event.payload);
      });

      try {
        const ready = await withTimeout(
          ensureActiveSttLanguage(settings.primaryLanguage, false),
          STT_STARTUP_TIMEOUT_MS,
          "Подготовка языковой модели заняла слишком много времени.",
        );
        if (!ready) {
          return;
        }
        setSttStatusText("Запускаем захват микрофона и системного звука...");
        await withTimeout(
          startConfiguredSttSession(),
          STT_STARTUP_TIMEOUT_MS,
          "Запуск распознавания речи занял слишком много времени.",
        );
        setActiveSttLanguage(settings.primaryLanguage);
        setSttStatusText(
          "Распознавание запущено. Говори в микрофон или включи звук собеседника.",
        );
        void warmStandbyModel(settings.primaryLanguage).catch((error: unknown) => {
          console.warn("Failed to preload standby STT model:", error);
        });
        noSignalTimer = window.setTimeout(() => {
          const { mic, system } = sttSignalSeenRef.current;
          if (sttNoSignalNoticeShownRef.current || mic || system) {
            return;
          }

          sttNoSignalNoticeShownRef.current = true;
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
        }, 6000);
      } catch (err: unknown) {
        const detail = toFriendlySttStartupError(err);
        setSttStatusText(`Ошибка запуска: ${detail}`);
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: `Не удалось запустить распознавание речи: ${detail}`,
          isFinal: true,
        });
      }
    }

    void setupStt();

    return () => {
      if (noSignalTimer !== null) {
        window.clearTimeout(noSignalTimer);
      }
      unlistenResult?.();
      unlistenDiagnostic?.();

      void (async () => {
        const { isTauri, stopSttSession } = await import("@/lib/tauri");
        if (!isTauri()) {
          return;
        }
        await stopSttSession().catch(() => {
          // Session might already be stopped.
        });
      })();
    };
  }, [
    addMessage,
    ensureActiveSttLanguage,
    handleSttDiagnostic,
    handleSttResult,
    isActive,
    settings.microphoneDeviceId,
    settings.primaryLanguage,
    settings.systemAudioDeviceId,
    startConfiguredSttSession,
    warmStandbyModel,
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

  const sendToLlm = useCallback(
    async (withScreenshot = false) => {
      if (isLlmLoading) {
        return;
      }
      if (!settings.apiKey) {
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: "Лицензионный ключ не задан. Укажи его в настройках.",
          isFinal: true,
        });
        setLastLlmError("Лицензионный ключ не задан.");
        return;
      }

      setLastLlmError(null);

      const contextMessages = contextBuffer;
      if (contextMessages.length === 0) {
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: "Пока нет расшифровки. Дождись реплик перед отправкой.",
          isFinal: true,
        });
        return;
      }

      if (!settings.customBaseUrl.trim() && settings.baseUrlPreset === "custom") {
        addMessage({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          source: "ai_marker",
          text: "Адрес прокси не задан. Укажи его в настройках.",
          isFinal: true,
        });
        return;
      }

      const resp: LlmResponse = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        text: "",
        isStreaming: true,
      };
      setLlmResponse(resp);
      addMessage({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: "ai_marker",
        text: "Запрос отправлен. Ответ появится ниже.",
        isFinal: true,
      });
      flushContextBuffer();

      const transcript = contextMessages
        .map((m) => `[${m.source === "interviewer" ? "Интервьюер" : "Вы"}]: ${m.text}`)
        .join("\n");

      let userPrompt = `Транскрипт интервью:\n${transcript}\n\nДай краткую и полезную подсказку по текущему контексту.`;
      let imageBase64Png: string | undefined;

      if (withScreenshot) {
        try {
          const screenshotBase64 = await captureScreenshotAsBase64Png();
          if (settings.imageHandlingMode === "send_image") {
            imageBase64Png = screenshotBase64;
            userPrompt += "\n\nК запросу приложен скриншот экрана.";
          } else {
            const ocrText = await tryExtractOcrText(screenshotBase64);
            if (ocrText) {
              userPrompt += `\n\nТекст со скриншота:\n${ocrText}`;
            } else {
              userPrompt += "\n\nСкриншот сделан, но OCR не смог извлечь текст.";
            }
          }
        } catch (err: unknown) {
          const detail =
            err instanceof Error ? err.message : "Неизвестная ошибка скриншота";
          userPrompt += `\n\nНе удалось приложить скриншот: ${detail}`;
        }
      }

      abortRef.current = new AbortController();

      try {
        const startedAtMs = performance.now();
        const response = await requestProxyHint({
          licenseKey: settings.apiKey,
          baseUrlPreset: settings.baseUrlPreset,
          customBaseUrl: settings.customBaseUrl,
          question: userPrompt,
          language: settings.primaryLanguage,
          imageBase64Png,
        });
        const formatted = formatProxyHintResponse(response);
        const totalMs = performance.now() - startedAtMs;

        useSessionStore.setState((s) => ({
          lastLlmResponse: s.lastLlmResponse
            ? {
                ...s.lastLlmResponse,
                text: formatted,
                isStreaming: false,
                firstTokenLatencyMs: totalMs,
              }
            : null,
        }));

        if (!formatted.trim()) {
          const message = "Прокси вернул пустой ответ.";
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
      }
    },
    [
      addMessage,
      appendLlmText,
      contextBuffer,
      finishLlmResponse,
      flushContextBuffer,
      isLlmLoading,
      setLlmResponse,
      settings,
    ],
  );

  const closeOverlayWindow = useCallback(async (): Promise<boolean> => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return false;
    }

    const { restoreMainWindow } = await import("@/lib/tauri");
    const { emit } = await import("@tauri-apps/api/event");
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");

    await emit("interview_ended").catch(() => {
      // Main window may be recreated after overlay close.
    });

    await restoreMainWindow().catch(() => {
      // Main window can already be visible.
    });

    const currentOverlay = getCurrentWebviewWindow();
    if (currentOverlay.label !== "overlay") {
      return false;
    }

    await currentOverlay.close().catch(async () => {
      await currentOverlay.destroy();
    });

    return true;
  }, []);

  const endInterview = useCallback(async () => {
    if (endingRef.current) {
      return;
    }

    endingRef.current = true;
    abortRef.current?.abort();

    try {
      const endedAt = Date.now();
      if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
        const { stopSttSession } = await import("@/lib/tauri");
        await stopSttSession().catch(() => {
          // STT may already be stopped by effect cleanup.
        });
      }

      const startedAtSnapshot = startedAt ?? endedAt;
      const metricsSnapshot = {
        durationMs: Math.max(0, endedAt - startedAtSnapshot),
        interviewerSpeechRatio: interviewerChars / Math.max(interviewerChars + userChars, 1),
        userSpeechRatio: userChars / Math.max(interviewerChars + userChars, 1),
        llmRequestCount,
        avgFirstTokenLatencyMs:
          llmLatencies.length > 0
            ? llmLatencies.reduce((a, l) => a + l.firstToken, 0) / llmLatencies.length
            : 0,
        avgTotalLatencyMs:
          llmLatencies.length > 0
            ? llmLatencies.reduce((a, l) => a + l.total, 0) / llmLatencies.length
            : 0,
      };
      const modelSnapshot = settings.selectedModel?.id ?? "proxy";
      const providerSnapshot = "custom";

      setInterviewActive(false);
      endSession();

      const record: SessionRecord = {
        id: crypto.randomUUID(),
        startedAt: startedAtSnapshot,
        endedAt,
        model: modelSnapshot,
        provider: providerSnapshot,
        metrics: metricsSnapshot,
        finalReport: undefined,
      };

      addSessionToHistory(record);

      const closedOverlay = await closeOverlayWindow().catch((error: unknown) => {
        console.error("Failed to close overlay window:", error);
        return false;
      });
      if (!closedOverlay) {
        setView("dashboard");
      }
    } catch (error) {
      console.error("Failed to end interview cleanly:", error);
      setInterviewActive(false);
      endSession();
      setView("dashboard");
    } finally {
      endingRef.current = false;
    }
  }, [
    addSessionToHistory,
    closeOverlayWindow,
    elapsedMs,
    endSession,
    interviewerChars,
    llmLatencies,
    llmRequestCount,
    settings,
    setInterviewActive,
    setView,
    startedAt,
    userChars,
  ]);

  // Global hotkeys (work outside app focus via Tauri plugin)
  const handleGlobalAction = useCallback(
    (action: string) => {
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
        e.preventDefault();
        sendToLlm(true);
      } else if (matchHotkey(pressed, sendHk?.keys ?? [])) {
        e.preventDefault();
        sendToLlm(false);
      } else if (matchHotkey(pressed, endHk?.keys ?? [])) {
        e.preventDefault();
        endInterview();
      } else if (matchHotkey(pressed, switchLanguageHk?.keys ?? [])) {
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

  return (
    <div className="h-screen w-screen flex flex-col bg-black/35 text-zinc-100 backdrop-blur-[1px]">
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
        </div>

        <div className="flex items-center gap-1.5 text-zinc-300">
          <Clock className="w-3.5 h-3.5" />
          <span className="text-xs font-mono">{formatElapsed(elapsedMs)}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void toggleSttLanguage();
            }}
            icon={<Languages className="w-3 h-3" />}
            className="min-w-[120px]"
          >
            Lang ({switchLanguageHkLabel})
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={endInterview}
            icon={<Square className="w-3 h-3" />}
            className="min-w-[105px]"
          >
            End ({endHkLabel})
          </Button>
        </div>
      </div>

      {/* Chat area */}
      <div
        ref={chatContainerRef}
        onScroll={handleChatScroll}
        className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5 relative"
      >
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-text-muted">
              {sttStatusText}
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        <div ref={chatEndRef} />

        {!isAtBottom && newMsgCount > 0 && (
          <button
            onClick={jumpToBottom}
            className="fixed bottom-36 left-1/2 -translate-x-1/2 z-10
              flex items-center gap-1.5 px-3 py-1.5
              bg-zinc-900/95 text-zinc-100 text-xs font-medium border border-zinc-700
              rounded-full shadow-lg cursor-pointer
              hover:bg-zinc-800 transition-colors"
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
            <span className="text-xs font-medium text-zinc-300">AI Response</span>
            {lastLlmResponse.isStreaming && (
              <Loader2 className="w-3 h-3 text-zinc-300 animate-spin ml-auto" />
            )}
            {!lastLlmResponse.isStreaming && lastLlmResponse.totalLatencyMs && (
              <span className="text-[10px] text-zinc-500 ml-auto">
                {(lastLlmResponse.totalLatencyMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
          <div
            ref={aiPanelRef}
            onScroll={handleAiPanelScroll}
            className="px-3 py-2 max-h-40 overflow-y-auto bg-black/20"
          >
            <p className="text-xs text-zinc-100 whitespace-pre-wrap leading-relaxed select-text">
              {lastLlmResponse.text || (
                <span className="text-zinc-500">Waiting for response...</span>
              )}
            </p>
          </div>
        </div>
      )}

      {lastLlmError && (
        <div className="mx-3 mb-2 rounded-lg border border-red-900/70 bg-black/55 px-3 py-2 shrink-0">
          <p className="text-[11px] text-red-200 leading-relaxed">
            LLM error: {lastLlmError}
          </p>
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-zinc-700/70 bg-black/35 shrink-0">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => sendToLlm(false)}
          disabled={isLlmLoading || contextBuffer.length === 0}
          icon={isLlmLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          className="flex-1"
        >
          Send ({sendHkLabel})
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => sendToLlm(true)}
          disabled={isLlmLoading || contextBuffer.length === 0}
          icon={isLlmLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
          className="flex-1"
        >
          Send + Screenshot ({sendScreenHkLabel})
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

async function captureScreenshotAsBase64Png(): Promise<string> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Screen capture API is not available.");
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 1 },
    audio: false,
  });

  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => {
        video
          .play()
          .then(() => resolve())
          .catch((err) => reject(err));
      };
      video.onerror = () => reject(new Error("Failed to load captured video stream."));
    });

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

function resolveInstalledModelId(model: {
  id: string;
  installed: boolean;
  installed_versions: string[];
}): string | null {
  if (model.installed) {
    return model.id;
  }
  if (model.installed_versions.length === 0) {
    return null;
  }
  const sorted = [...model.installed_versions].sort();
  return sorted[sorted.length - 1] ?? null;
}

