import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  ApiKeyCheckState,
  AppLanguage,
  AppSettings,
  ContextFile,
  DictationSource,
  DictationTrigger,
  HotkeyBinding,
  HotkeyAction,
  ImageHandlingMode,
  LlmBaseUrlPreset,
  ModelInfo,
  PrimaryLanguage,
  SecondaryLanguage,
  SttModelVariant,
  Provider,
} from "@/lib/types";
import {
  normalizePrimaryLanguage,
} from "@/lib/languages";
import { normalizeHotkeyKeys } from "@/lib/hotkeys";
import { PROXY_BASE_URL } from "@/lib/proxy";
import {
  DEFAULT_HISTORY_RETENTION_DAYS,
  normalizeHistoryRetentionDays,
} from "@/lib/historyRetention";
import { appPersistStorage } from "@/lib/persistStorage";

const SETTINGS_STORAGE_KEY = "ai-interview-settings";
// Dev/browser fallback slot for the license key. The packaged app keeps the key
// in the OS keychain (Tauri) and never writes it here; outside Tauri there is no
// keychain, so we persist it separately to survive a page reload.
const DEV_API_KEY_STORAGE_KEY = "ai-interview-dev-api-key";
let apiKeyPersistTimer: ReturnType<typeof setTimeout> | null = null;

function isRunningInTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function readDevPersistedApiKey(): string {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return window.localStorage.getItem(DEV_API_KEY_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function writeDevPersistedApiKey(apiKey: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const trimmed = apiKey.trim();
    if (trimmed) {
      window.localStorage.setItem(DEV_API_KEY_STORAGE_KEY, trimmed);
    } else {
      window.localStorage.removeItem(DEV_API_KEY_STORAGE_KEY);
    }
  } catch {
    // localStorage may be unavailable (private mode); the in-memory key still works.
  }
}

function areHotkeyBindingsEqual(a: string[] | undefined, b: string[]): boolean {
  if (!Array.isArray(a)) {
    return false;
  }

  const normalizedA = normalizeHotkeyKeys(a);
  const normalizedB = normalizeHotkeyKeys(b);
  if (normalizedA.length !== normalizedB.length) {
    return false;
  }

  return normalizedA.every((token, index) => token === normalizedB[index]);
}

function cloneHotkeyBinding(binding: HotkeyBinding): HotkeyBinding {
  return {
    ...binding,
    keys: [...binding.keys],
    default: [...binding.default],
  };
}

function cloneDefaultHotkeys(): HotkeyBinding[] {
  return DEFAULT_HOTKEYS.map(cloneHotkeyBinding);
}

type PersistedSettings = {
  state?: {
    apiKey?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function readPersistedSettings(): PersistedSettings | null {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as PersistedSettings;
  } catch {
    return null;
  }
}

export function readLegacyPersistedApiKey(): string {
  const persisted = readPersistedSettings();
  const value = persisted?.state?.apiKey;
  return typeof value === "string" ? value : "";
}

export function stripLegacyPersistedApiKey(): void {
  if (typeof window === "undefined") {
    return;
  }

  const persisted = readPersistedSettings();
  if (!persisted?.state || typeof persisted.state.apiKey === "undefined") {
    return;
  }

  delete persisted.state.apiKey;
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(persisted));
}

function scheduleApiKeyPersistence(apiKey: string): void {
  if (apiKeyPersistTimer) {
    clearTimeout(apiKeyPersistTimer);
  }

  apiKeyPersistTimer = setTimeout(() => {
    void persistApiKeyToSecureStore(apiKey);
  }, 250);
}

async function persistApiKeyToSecureStore(apiKey: string): Promise<void> {
  if (!isRunningInTauri()) {
    // No OS keychain outside the packaged app — keep the key in localStorage so
    // it survives a browser/dev reload instead of vanishing from the cabinet.
    writeDevPersistedApiKey(apiKey);
    return;
  }
  try {
    const { setSecureApiKey, getSecureApiKey } = await import("@/lib/tauri");
    await setSecureApiKey(apiKey);

    // Read back: a keychain that accepts writes but never persists them (e.g. the
    // keyring mock store, compiled when no platform backend feature is enabled)
    // fails completely silently and the key vanishes on the next launch. Verify
    // rather than trust, and make the failure loud.
    const stored = ((await getSecureApiKey()) ?? "").trim();
    const expected = apiKey.trim();
    if (stored !== expected) {
      const { logWarn } = await import("@/lib/diagnostics");
      logWarn("settings.apiKey", "Secure storage did not retain the API key", {
        expectedLength: expected.length,
        storedLength: stored.length,
      });
    }
  } catch (error) {
    const { logWarn } = await import("@/lib/diagnostics");
    logWarn("settings.apiKey", "Failed to persist API key to secure storage", error);
    console.warn("Failed to persist API key to secure storage:", error);
  }
}

function normalizeModelCacheSupport(model: ModelInfo | null): ModelInfo | null {
  if (!model) {
    return null;
  }

  const remoteCaching = model.remoteCaching === "supported" ? "supported" : "not_supported";
  if (model.remoteCaching === remoteCaching) {
    return model;
  }

  return {
    ...model,
    remoteCaching,
  };
}

const DEFAULT_HOTKEYS: HotkeyBinding[] = [
  {
    action: "send_to_llm",
    label: "Отправить в помощник",
    keys: ["F8"],
    default: ["F8"],
  },
  {
    action: "send_with_screenshot",
    label: "Отправить со скриншотом",
    keys: ["F9"],
    default: ["F9"],
  },
  {
    action: "end_interview",
    label: "Завершить интервью",
    keys: ["F10"],
    default: ["F10"],
  },
  {
    action: "switch_stt_language",
    label: "Сменить язык распознавания",
    keys: ["F11"],
    default: ["F11"],
  },
];

const LEGACY_DEFAULT_HOTKEYS: Partial<Record<HotkeyAction, string[][]>> = {
  send_to_llm: [
    ["Alt", "Space"],
    ["Ctrl", "Alt", "Space"],
  ],
  send_with_screenshot: [
    ["Alt", "Shift", "Space"],
    ["Ctrl", "Alt", "Shift", "Space"],
  ],
  end_interview: [["Alt", "E"]],
  switch_stt_language: [["Alt", "L"]],
};

interface SettingsState extends AppSettings {
  setProvider: (p: Provider) => void;
  setBaseUrlPreset: (preset: LlmBaseUrlPreset) => void;
  setCustomBaseUrl: (baseUrl: string) => void;
  setPrimaryLanguage: (l: PrimaryLanguage) => void;
  setSecondaryLanguage: (l: SecondaryLanguage) => void;
  setAppLanguage: (l: AppLanguage) => void;
  setPrimarySttVariant: (v: SttModelVariant) => void;
  setSecondarySttVariant: (v: SttModelVariant) => void;
  setMicrophoneDeviceId: (deviceId: string) => void;
  setSystemAudioDeviceId: (deviceId: string) => void;
  setApiKey: (key: string) => void;
  setApiKeyCheck: (value: ApiKeyCheckState | null) => void;
  setInterviewContext: (value: string) => void;
  addContextFiles: (files: ContextFile[]) => void;
  removeContextFile: (id: string) => void;
  clearContextFiles: () => void;
  hydrateApiKey: (key: string) => void;
  setSelectedModel: (m: ModelInfo | null) => void;
  setSendSummary: (v: boolean) => void;
  setFinalReport: (v: boolean) => void;
  setMaxResponseTokens: (v: number) => void;
  setImageHandlingMode: (m: ImageHandlingMode) => void;
  setProtectOverlay: (v: boolean) => void;
  setChatMemoryLimitMb: (v: number) => void;
  setHistoryRetentionDays: (v: number | null) => void;
  setDictationTrigger: (v: DictationTrigger) => void;
  setDictationSource: (v: DictationSource) => void;
  setAudioHintWindowSeconds: (v: number) => void;
  setHotkey: (action: HotkeyAction, keys: string[]) => void;
  resetHotkeys: () => void;
}

const defaultPrimaryLanguage: PrimaryLanguage = "ru-RU";

// Окно кнопки «последние N сек» аудио-подсказки: пользователь выбирает, сколько
// хвоста серверного аудио-буфера уходит в модель одним кликом.
export const AUDIO_HINT_WINDOW_MIN_SECONDS = 3;
export const AUDIO_HINT_WINDOW_MAX_SECONDS = 15;
export const AUDIO_HINT_WINDOW_DEFAULT_SECONDS = 8;

export function clampAudioHintWindowSeconds(value: number): number {
  if (!Number.isFinite(value)) {
    return AUDIO_HINT_WINDOW_DEFAULT_SECONDS;
  }
  return Math.round(
    Math.max(AUDIO_HINT_WINDOW_MIN_SECONDS, Math.min(AUDIO_HINT_WINDOW_MAX_SECONDS, value)),
  );
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      provider: "custom",
      baseUrlPreset: "custom",
      customBaseUrl: PROXY_BASE_URL,
      primaryLanguage: defaultPrimaryLanguage,
      secondaryLanguage: "none",
      appLanguage: "ru",
      primarySttVariant: "large",
      secondarySttVariant: "large",
      microphoneDeviceId: "",
      systemAudioDeviceId: "",
      apiKey: "",
      apiKeyCheck: null,
      interviewContext: "",
      contextFiles: [],
      selectedModel: null,
      sendSummary: true,
      finalReport: true,
      maxResponseTokens: 4096,
      imageHandlingMode: "ocr_text",
      protectOverlay: true,
      chatMemoryLimitMb: 16,
      historyRetentionDays: DEFAULT_HISTORY_RETENTION_DAYS,
      dictationTrigger: "toggle",
      dictationSource: "both",
      audioHintWindowSeconds: AUDIO_HINT_WINDOW_DEFAULT_SECONDS,
      hotkeys: cloneDefaultHotkeys(),

      setProvider: (provider) =>
        set({
          provider,
          baseUrlPreset: provider === "custom" ? "custom" : provider,
          customBaseUrl: PROXY_BASE_URL,
          selectedModel: null,
        }),
      setBaseUrlPreset: (baseUrlPreset) =>
        set({
          baseUrlPreset,
          provider: baseUrlPreset,
          customBaseUrl: PROXY_BASE_URL,
          selectedModel: null,
        }),
      setCustomBaseUrl: (customBaseUrl) =>
        set((state) => ({
          customBaseUrl: customBaseUrl.trim() || PROXY_BASE_URL,
          selectedModel: state.baseUrlPreset === "custom" ? null : state.selectedModel,
        })),
      setPrimaryLanguage: (primaryLanguage) =>
        set({ primaryLanguage: normalizePrimaryLanguage(primaryLanguage) }),
      setSecondaryLanguage: (secondaryLanguage) => set({ secondaryLanguage }),
      setAppLanguage: (appLanguage) => set({ appLanguage }),
      setPrimarySttVariant: (primarySttVariant) => set({ primarySttVariant }),
      setSecondarySttVariant: (secondarySttVariant) => set({ secondarySttVariant }),
      setMicrophoneDeviceId: (microphoneDeviceId) => set({ microphoneDeviceId }),
      setSystemAudioDeviceId: (systemAudioDeviceId) => set({ systemAudioDeviceId }),
      setApiKey: (apiKey) => {
        set({ apiKey });
        scheduleApiKeyPersistence(apiKey);
      },
      setApiKeyCheck: (apiKeyCheck) => set({ apiKeyCheck }),
      setInterviewContext: (interviewContext) => set({ interviewContext }),
      addContextFiles: (files) =>
        set((state) => {
          const existingNames = new Set(state.contextFiles.map((file) => file.name));
          const additions = files.filter((file) => !existingNames.has(file.name));
          return { contextFiles: [...state.contextFiles, ...additions] };
        }),
      removeContextFile: (id) =>
        set((state) => ({
          contextFiles: state.contextFiles.filter((file) => file.id !== id),
        })),
      clearContextFiles: () => set({ contextFiles: [] }),
      hydrateApiKey: (apiKey) => set({ apiKey }),
      setSelectedModel: (selectedModel) => {
        const normalizedModel = normalizeModelCacheSupport(selectedModel);
        set(() => {
          const updates: Partial<SettingsState> = { selectedModel: normalizedModel };
          if (normalizedModel?.remoteCaching === "supported") {
            updates.sendSummary = false;
          } else if (normalizedModel?.remoteCaching === "not_supported") {
            updates.sendSummary = true;
            updates.finalReport = false;
          }
          return updates;
        });
      },
      setSendSummary: (sendSummary) => set({ sendSummary }),
      setFinalReport: (finalReport) => set({ finalReport }),
      setMaxResponseTokens: (maxResponseTokens) => set({ maxResponseTokens }),
      setImageHandlingMode: (imageHandlingMode) => set({ imageHandlingMode }),
      setProtectOverlay: (protectOverlay) => set({ protectOverlay }),
      setChatMemoryLimitMb: (chatMemoryLimitMb) => set({ chatMemoryLimitMb }),
      setHistoryRetentionDays: (historyRetentionDays) =>
        set({
          historyRetentionDays:
            historyRetentionDays === null
              ? null
              : normalizeHistoryRetentionDays(historyRetentionDays),
        }),
      setDictationTrigger: (dictationTrigger) => set({ dictationTrigger }),
      setDictationSource: (dictationSource) => set({ dictationSource }),
      setAudioHintWindowSeconds: (audioHintWindowSeconds) =>
        set({ audioHintWindowSeconds: clampAudioHintWindowSeconds(audioHintWindowSeconds) }),
      setHotkey: (action, keys) => {
        const normalizedKeys = normalizeHotkeyKeys(keys)
        set((s) => ({
          hotkeys: s.hotkeys.map((h) =>
            h.action === action ? { ...h, keys: normalizedKeys } : h,
          ),
        }))
      },
      resetHotkeys: () => set({ hotkeys: cloneDefaultHotkeys() }),
    }),
    {
      name: "ai-interview-settings",
      storage: appPersistStorage,
      partialize: (state) => ({
        provider: state.provider,
        baseUrlPreset: state.baseUrlPreset,
        customBaseUrl: state.customBaseUrl,
        primaryLanguage: state.primaryLanguage,
        secondaryLanguage: state.secondaryLanguage,
        appLanguage: state.appLanguage,
        primarySttVariant: state.primarySttVariant,
        secondarySttVariant: state.secondarySttVariant,
        microphoneDeviceId: state.microphoneDeviceId,
        systemAudioDeviceId: state.systemAudioDeviceId,
        // apiKey lives canonically in the keychain (hydrated in App.tsx); it is
        // never persisted in the settings blob. apiKeyCheck is deprecated.
        interviewContext: state.interviewContext,
        contextFiles: state.contextFiles,
        selectedModel: state.selectedModel,
        sendSummary: state.sendSummary,
        finalReport: state.finalReport,
        maxResponseTokens: state.maxResponseTokens,
        imageHandlingMode: state.imageHandlingMode,
        protectOverlay: state.protectOverlay,
        chatMemoryLimitMb: state.chatMemoryLimitMb,
        historyRetentionDays: state.historyRetentionDays,
        dictationTrigger: state.dictationTrigger,
        dictationSource: state.dictationSource,
        audioHintWindowSeconds: state.audioHintWindowSeconds,
        hotkeys: state.hotkeys,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) {
          return;
        }

        if (!isRunningInTauri()) {
          // Restore the dev/browser-persisted key (keychain is Tauri-only). In the
          // packaged app the key is hydrated from the keychain in App.tsx instead.
          const devApiKey = readDevPersistedApiKey();
          if (devApiKey) {
            state.apiKey = devApiKey;
          }
        }

        state.baseUrlPreset = "custom";
        state.provider = "custom";
        state.customBaseUrl = PROXY_BASE_URL;
        state.primaryLanguage = defaultPrimaryLanguage;
        state.secondaryLanguage = "none";
        const rawAppLanguage = (state as unknown as { appLanguage?: unknown }).appLanguage;
        state.appLanguage = rawAppLanguage === "en" ? "en" : "ru";

        state.primarySttVariant = "large";
        state.secondarySttVariant = "large";
        const rawMicrophoneDeviceId = (state as unknown as { microphoneDeviceId?: unknown })
          .microphoneDeviceId;
        state.microphoneDeviceId =
          typeof rawMicrophoneDeviceId === "string" ? rawMicrophoneDeviceId : "";
        const rawSystemAudioDeviceId = (state as unknown as { systemAudioDeviceId?: unknown })
          .systemAudioDeviceId;
        state.systemAudioDeviceId =
          typeof rawSystemAudioDeviceId === "string" ? rawSystemAudioDeviceId : "";
        const rawApiKeyCheck = (state as unknown as { apiKeyCheck?: unknown }).apiKeyCheck;
        state.apiKeyCheck =
          rawApiKeyCheck &&
          typeof rawApiKeyCheck === "object" &&
          typeof (rawApiKeyCheck as ApiKeyCheckState).key === "string" &&
          typeof (rawApiKeyCheck as ApiKeyCheckState).valid === "boolean"
            ? (rawApiKeyCheck as ApiKeyCheckState)
            : null;
        const rawInterviewContext = (state as unknown as { interviewContext?: unknown })
          .interviewContext;
        state.interviewContext =
          typeof rawInterviewContext === "string" ? rawInterviewContext : "";
        const rawContextFiles = (state as unknown as { contextFiles?: unknown }).contextFiles;
        state.contextFiles = Array.isArray(rawContextFiles)
          ? rawContextFiles.filter(
              (item): item is ContextFile =>
                !!item &&
                typeof item === "object" &&
                typeof (item as ContextFile).id === "string" &&
                typeof (item as ContextFile).name === "string" &&
                typeof (item as ContextFile).content === "string",
            )
          : [];
        const rawHistoryRetentionDays = (state as unknown as { historyRetentionDays?: unknown })
          .historyRetentionDays;
        state.historyRetentionDays =
          rawHistoryRetentionDays === null
            ? null
            : normalizeHistoryRetentionDays(rawHistoryRetentionDays);
        const rawDictationTrigger = (state as unknown as { dictationTrigger?: unknown })
          .dictationTrigger;
        state.dictationTrigger = rawDictationTrigger === "push" ? "push" : "toggle";
        const rawDictationSource = (state as unknown as { dictationSource?: unknown })
          .dictationSource;
        state.dictationSource =
          rawDictationSource === "mic" || rawDictationSource === "system"
            ? rawDictationSource
            : "both";
        const rawSelectedModel = (state as unknown as { selectedModel?: unknown }).selectedModel;
        state.selectedModel =
          rawSelectedModel && typeof rawSelectedModel === "object"
            ? normalizeModelCacheSupport(rawSelectedModel as ModelInfo)
            : null;

        state.hotkeys = DEFAULT_HOTKEYS.map((fallback) => {
          const fromState = state.hotkeys?.find((hk) => hk.action === fallback.action);
          if (!fromState || !Array.isArray(fromState.keys) || fromState.keys.length === 0) {
            return cloneHotkeyBinding(fallback);
          }

          const legacyDefault = LEGACY_DEFAULT_HOTKEYS[fallback.action];
          const shouldReplaceLegacyDefault =
            Array.isArray(legacyDefault) &&
            legacyDefault.some((legacyKeys) =>
              areHotkeyBindingsEqual(fromState.keys, legacyKeys),
            );
          const keys = shouldReplaceLegacyDefault ? fallback.default : fromState.keys;

          return {
            ...fallback,
            keys: normalizeHotkeyKeys(keys),
          };
        });
      },
    },
  ),
);
