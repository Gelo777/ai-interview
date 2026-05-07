import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  AppSettings,
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
import { HARDCODED_PROXY_BASE_URL } from "@/lib/proxy";
import {
  DEFAULT_HISTORY_RETENTION_DAYS,
  normalizeHistoryRetentionDays,
} from "@/lib/historyRetention";
import { appPersistStorage } from "@/lib/persistStorage";

const SETTINGS_STORAGE_KEY = "ai-interview-settings";
let apiKeyPersistTimer: ReturnType<typeof setTimeout> | null = null;

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
  try {
    const { isTauri, setSecureApiKey } = await import("@/lib/tauri");
    if (!isTauri()) {
      return;
    }
    await setSecureApiKey(apiKey);
  } catch (error) {
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
  setPrimarySttVariant: (v: SttModelVariant) => void;
  setSecondarySttVariant: (v: SttModelVariant) => void;
  setMicrophoneDeviceId: (deviceId: string) => void;
  setSystemAudioDeviceId: (deviceId: string) => void;
  setApiKey: (key: string) => void;
  setInterviewContext: (value: string) => void;
  hydrateApiKey: (key: string) => void;
  setSelectedModel: (m: ModelInfo | null) => void;
  setSendSummary: (v: boolean) => void;
  setFinalReport: (v: boolean) => void;
  setMaxResponseTokens: (v: number) => void;
  setImageHandlingMode: (m: ImageHandlingMode) => void;
  setProtectOverlay: (v: boolean) => void;
  setChatMemoryLimitMb: (v: number) => void;
  setHistoryRetentionDays: (v: number | null) => void;
  setHotkey: (action: HotkeyAction, keys: string[]) => void;
  resetHotkeys: () => void;
}

const defaultPrimaryLanguage: PrimaryLanguage = "ru-RU";

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      provider: "custom",
      baseUrlPreset: "custom",
      customBaseUrl: HARDCODED_PROXY_BASE_URL,
      primaryLanguage: defaultPrimaryLanguage,
      secondaryLanguage: "none",
      primarySttVariant: "large",
      secondarySttVariant: "large",
      microphoneDeviceId: "",
      systemAudioDeviceId: "",
      apiKey: "",
      interviewContext: "",
      selectedModel: null,
      sendSummary: true,
      finalReport: true,
      maxResponseTokens: 4096,
      imageHandlingMode: "ocr_text",
      protectOverlay: true,
      chatMemoryLimitMb: 16,
      historyRetentionDays: DEFAULT_HISTORY_RETENTION_DAYS,
      hotkeys: cloneDefaultHotkeys(),

      setProvider: () =>
        set({
          provider: "custom",
          baseUrlPreset: "custom",
          customBaseUrl: HARDCODED_PROXY_BASE_URL,
          selectedModel: null,
        }),
      setBaseUrlPreset: () =>
        set({
          baseUrlPreset: "custom",
          provider: "custom",
          customBaseUrl: HARDCODED_PROXY_BASE_URL,
          selectedModel: null,
        }),
      setCustomBaseUrl: () =>
        set((state) => ({
          customBaseUrl: HARDCODED_PROXY_BASE_URL,
          selectedModel: state.baseUrlPreset === "custom" ? null : state.selectedModel,
        })),
      setPrimaryLanguage: () => set({ primaryLanguage: defaultPrimaryLanguage }),
      setSecondaryLanguage: () => set({ secondaryLanguage: "none" }),
      setPrimarySttVariant: (primarySttVariant) => set({ primarySttVariant }),
      setSecondarySttVariant: (secondarySttVariant) => set({ secondarySttVariant }),
      setMicrophoneDeviceId: (microphoneDeviceId) => set({ microphoneDeviceId }),
      setSystemAudioDeviceId: (systemAudioDeviceId) => set({ systemAudioDeviceId }),
      setApiKey: (apiKey) => {
        set({ apiKey });
        scheduleApiKeyPersistence(apiKey);
      },
      setInterviewContext: (interviewContext) => set({ interviewContext }),
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
        primarySttVariant: state.primarySttVariant,
        secondarySttVariant: state.secondarySttVariant,
        microphoneDeviceId: state.microphoneDeviceId,
        systemAudioDeviceId: state.systemAudioDeviceId,
        apiKey: state.apiKey,
        interviewContext: state.interviewContext,
        selectedModel: state.selectedModel,
        sendSummary: state.sendSummary,
        finalReport: state.finalReport,
        maxResponseTokens: state.maxResponseTokens,
        imageHandlingMode: state.imageHandlingMode,
        protectOverlay: state.protectOverlay,
        chatMemoryLimitMb: state.chatMemoryLimitMb,
        historyRetentionDays: state.historyRetentionDays,
        hotkeys: state.hotkeys,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) {
          return;
        }

        state.baseUrlPreset = "custom";
        state.provider = "custom";
        state.customBaseUrl = HARDCODED_PROXY_BASE_URL;
        state.primaryLanguage = defaultPrimaryLanguage;
        state.secondaryLanguage = "none";

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
        const rawInterviewContext = (state as unknown as { interviewContext?: unknown })
          .interviewContext;
        state.interviewContext =
          typeof rawInterviewContext === "string" ? rawInterviewContext : "";
        const rawHistoryRetentionDays = (state as unknown as { historyRetentionDays?: unknown })
          .historyRetentionDays;
        state.historyRetentionDays =
          rawHistoryRetentionDays === null
            ? null
            : normalizeHistoryRetentionDays(rawHistoryRetentionDays);
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
