import { useEffect } from "react";
import { checkCloudReadiness, checkLocalReadiness } from "@/lib/readiness";
import { useAppStore } from "@/stores/app";
import { useSettingsStore } from "@/stores/settings";
import { useLicenseStore } from "@/stores/license";

const LOCAL_READINESS_POLL_MS = 5000;
// Cheap re-derivation of cloud readiness from the license store (no network).
const CLOUD_READINESS_POLL_MS = 30000;
// Actual network revalidation of the license against the server.
const LICENSE_REVALIDATE_INTERVAL_MS = 30 * 60 * 1000;
const LICENSE_SNAPSHOT_STALE_MS = 35 * 60 * 1000;

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
        ? installDetail || "Устанавливаем компоненты распознавания..."
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
  const selectedModelId = useSettingsStore((s) => s.selectedModel?.id ?? "");
  const apiKey = useSettingsStore((s) => s.apiKey);
  const licenseAuthStatus = useLicenseStore((s) => s.authStatus);
  const licenseSyncedAt = useLicenseStore((s) => s.snapshot?.syncedAt ?? 0);
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

  // Cloud readiness is derived from the license store; re-derive it whenever the
  // license status/sync time changes (cheap, no network). If the snapshot has
  // gone stale while a sync error is live, trigger a network revalidation.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const license = useLicenseStore.getState();
    if (
      license.snapshot &&
      Date.now() - license.snapshot.syncedAt > LICENSE_SNAPSHOT_STALE_MS &&
      license.lastSyncError
    ) {
      void license.revalidate();
    }
    void refreshCloudReadinessNow();
    const interval = window.setInterval(() => {
      void refreshCloudReadinessNow();
    }, CLOUD_READINESS_POLL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [enabled, selectedModelId, apiKey, licenseAuthStatus, licenseSyncedAt]);

  // Periodic network revalidation of the license (and once on start), only while
  // not in an interview. This replaces the old forever-cached readiness.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    void useLicenseStore.getState().revalidate();
    const interval = window.setInterval(() => {
      void useLicenseStore.getState().revalidate();
    }, LICENSE_REVALIDATE_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [enabled]);
}
