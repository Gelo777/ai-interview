import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  AppView,
  PermissionStatus,
  PermissionsState,
  PrimaryLanguage,
  SettingsFocusTarget,
  SettingsTab,
  SttModelVariant,
} from "@/lib/types";
import { appPersistStorage } from "@/lib/persistStorage";

interface ReadinessState {
  apiKey: PermissionStatus;
  apiKeyDetail: string;
  model: PermissionStatus;
  modelDetail: string;
  vosk: PermissionStatus;
  voskDetail: string;
  voskRuntimeLoaded: boolean;
  voskRuntimePath: string | null;
  voskLatestStableVersion: string | null;
  voskLatestStableKnown: boolean;
  voskModelLoaded: boolean;
  voskModelPath: string | null;
}

interface AppState {
  view: AppView;
  settingsTab: SettingsTab;
  settingsFocus: SettingsFocusTarget | null;
  isInterviewActive: boolean;
  permissions: PermissionsState;
  readiness: ReadinessState;
  sttInstall: {
    active: boolean;
    phase: string;
    percent: number | null;
    detail: string;
    language: PrimaryLanguage | null;
    variant: SttModelVariant | null;
  };
  appUpdate: {
    enabled: boolean;
    checking: boolean;
    available: boolean;
    currentVersion: string | null;
    version: string | null;
    body: string | null;
    date: string | null;
    error: string | null;
    endpoint: string | null;
    installing: boolean;
    downloadPercent: number | null;
    dismissedVersion: string | null;
  };
  sttInstallQueue: Array<{
    language: PrimaryLanguage;
    variant: SttModelVariant;
  }>;

  setView: (view: AppView) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setSettingsFocus: (target: SettingsFocusTarget | null) => void;
  clearSettingsFocus: () => void;
  setInterviewActive: (v: boolean) => void;
  setPermissions: (p: Partial<PermissionsState>) => void;
  setReadiness: (r: Partial<ReadinessState>) => void;
  setSttInstall: (p: Partial<AppState["sttInstall"]>) => void;
  setAppUpdate: (p: Partial<AppState["appUpdate"]>) => void;
  dismissAppUpdate: (version?: string | null) => void;
  clearSttInstall: () => void;
  enqueueSttInstallTask: (task: {
    language: PrimaryLanguage;
    variant: SttModelVariant;
  }) => void;
  removeSttInstallTask: (task: {
    language: PrimaryLanguage;
    variant: SttModelVariant;
  }) => void;
  shiftSttInstallQueue: () => void;
  clearSttInstallQueue: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      view: "dashboard",
      settingsTab: "llm",
      settingsFocus: null,
      isInterviewActive: false,
      permissions: {
        microphone: "unknown",
        systemAudio: "unknown",
        screenCapture: "unknown",
      },
      readiness: {
        apiKey: "checking",
        apiKeyDetail: "Проверяем лицензию...",
        model: "checking",
        modelDetail: "Проверяем подключение к сервису...",
        vosk: "checking",
        voskDetail: "Проверяем Vosk...",
        voskRuntimeLoaded: false,
        voskRuntimePath: null,
        voskLatestStableVersion: null,
        voskLatestStableKnown: false,
        voskModelLoaded: false,
        voskModelPath: null,
      },
      sttInstall: {
        active: false,
        phase: "",
        percent: null,
        detail: "",
        language: null,
        variant: null,
      },
      appUpdate: {
        enabled: false,
        checking: false,
        available: false,
        currentVersion: null,
        version: null,
        body: null,
        date: null,
        error: null,
        endpoint: null,
        installing: false,
        downloadPercent: null,
        dismissedVersion: null,
      },
      sttInstallQueue: [],

      setView: (view) => set({ view }),
      setSettingsTab: (settingsTab) => set({ settingsTab }),
      setSettingsFocus: (settingsFocus) => set({ settingsFocus }),
      clearSettingsFocus: () => set({ settingsFocus: null }),
      setInterviewActive: (v) => set({ isInterviewActive: v }),
      setPermissions: (p) =>
        set((s) => ({ permissions: { ...s.permissions, ...p } })),
      setReadiness: (r) =>
        set((s) => ({ readiness: { ...s.readiness, ...r } })),
      setSttInstall: (p) =>
        set((s) => ({ sttInstall: { ...s.sttInstall, ...p } })),
      setAppUpdate: (p) =>
        set((s) => ({ appUpdate: { ...s.appUpdate, ...p } })),
      dismissAppUpdate: (version) =>
        set((state) => ({
          appUpdate: {
            ...state.appUpdate,
            dismissedVersion: version ?? state.appUpdate.version,
          },
        })),
      clearSttInstall: () =>
        set({
          sttInstall: {
            active: false,
            phase: "",
            percent: null,
            detail: "",
            language: null,
            variant: null,
          },
        }),
      enqueueSttInstallTask: (task) =>
        set((state) => {
          const exists = state.sttInstallQueue.some(
            (entry) =>
              entry.language === task.language && entry.variant === task.variant,
          );
          if (exists) {
            return state;
          }
          return { sttInstallQueue: [...state.sttInstallQueue, task] };
        }),
      removeSttInstallTask: (task) =>
        set((state) => ({
          sttInstallQueue: state.sttInstallQueue.filter(
            (entry) =>
              !(
                entry.language === task.language &&
                entry.variant === task.variant
              ),
          ),
        })),
      shiftSttInstallQueue: () =>
        set((state) => ({
          sttInstallQueue: state.sttInstallQueue.slice(1),
        })),
      clearSttInstallQueue: () => set({ sttInstallQueue: [] }),
    }),
    {
      name: "ai-interview-app",
      storage: appPersistStorage,
      partialize: () => ({}),
    },
  ),
);
