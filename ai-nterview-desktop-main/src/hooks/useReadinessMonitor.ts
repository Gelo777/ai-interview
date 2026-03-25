import { useEffect } from "react";
import { checkCloudReadiness, checkLocalReadiness } from "@/lib/readiness";
import { useAppStore } from "@/stores/app";
import { useSettingsStore } from "@/stores/settings";

const LOCAL_READINESS_POLL_MS = 5000;
const CLOUD_READINESS_POLL_MS = 30000;

export async function refreshLocalReadinessNow() {
  const local = await checkLocalReadiness();
  const appStore = useAppStore.getState();
  const installingVosk = appStore.sttInstall.active;
  const installDetail = appStore.sttInstall.detail.trim();
  appStore.setPermissions({
    microphone: local.microphone,
    systemAudio: local.systemAudio,
    screenCapture: local.screenCapture,
  });
  appStore.setReadiness({
    vosk: local.voskStatus,
    voskDetail:
      installingVosk && local.voskStatus !== "granted"
        ? installDetail || "Устанавливаем компоненты Vosk..."
        : local.voskDetail,
    voskRuntimeLoaded: local.voskRuntimeLoaded,
    voskRuntimePath: local.voskRuntimePath,
    voskModelLoaded: local.voskModelLoaded,
    voskModelPath: local.voskModelPath,
  });
  return local;
}

export async function refreshCloudReadinessNow() {
  const settings = useSettingsStore.getState();
  const cloud = await checkCloudReadiness(
    settings.apiKey,
    settings.selectedModel,
    settings.baseUrlPreset,
    settings.customBaseUrl,
  );
  const appStore = useAppStore.getState();
  appStore.setReadiness({
    apiKey: cloud.apiKeyStatus,
    apiKeyDetail: cloud.apiKeyDetail,
    model: cloud.modelStatus,
    modelDetail: cloud.modelDetail,
  });
  return cloud;
}

export async function refreshReadinessNow() {
  const [local, cloud] = await Promise.all([
    refreshLocalReadinessNow(),
    refreshCloudReadinessNow(),
  ]);
  return { local, cloud };
}

export function useReadinessMonitor(enabled: boolean) {
  const sttInstallActive = useAppStore((s) => s.sttInstall.active);
  const apiKey = useSettingsStore((s) => s.apiKey);
  const selectedModelId = useSettingsStore((s) => s.selectedModel?.id ?? "");
  const baseUrlPreset = useSettingsStore((s) => s.baseUrlPreset);
  const customBaseUrl = useSettingsStore((s) => s.customBaseUrl);
  const microphoneDeviceId = useSettingsStore((s) => s.microphoneDeviceId);
  const systemAudioDeviceId = useSettingsStore((s) => s.systemAudioDeviceId);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void refreshLocalReadinessNow();
    const interval = window.setInterval(() => {
      void refreshLocalReadinessNow();
    }, LOCAL_READINESS_POLL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [enabled, microphoneDeviceId, sttInstallActive, systemAudioDeviceId]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void refreshCloudReadinessNow();
    const interval = window.setInterval(() => {
      void refreshCloudReadinessNow();
    }, CLOUD_READINESS_POLL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [apiKey, baseUrlPreset, customBaseUrl, enabled, selectedModelId]);
}
