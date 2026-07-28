import { resolveLlmEndpointConfig } from "@/lib/llm";
import { getCachedAccessToken, validateLicenseKeyDetailed } from "@/lib/proxy";
import type { LlmBaseUrlPreset, ModelInfo, PermissionStatus } from "@/lib/types";
import { useSettingsStore } from "@/stores/settings";
import { useLicenseStore } from "@/stores/license";

/** Snapshot older than this with a live sync error reads as "unknown". */
const LICENSE_SNAPSHOT_STALE_MS = 35 * 60 * 1000;

export interface LocalReadiness {
  microphone: PermissionStatus;
  systemAudio: PermissionStatus;
  screenCapture: PermissionStatus;
  voskStatus: PermissionStatus;
  voskDetail: string;
  voskReady: boolean;
  voskRuntimeLoaded: boolean;
  voskRuntimePath: string | null;
  voskModelLoaded: boolean;
  voskModelPath: string | null;
}

export interface CloudReadiness {
  apiKeyStatus: PermissionStatus;
  apiKeyDetail: string;
  modelStatus: PermissionStatus;
  modelDetail: string;
  apiReady: boolean;
  modelReady: boolean;
}

function toPermissionStatus(value: string): PermissionStatus {
  if (value === "granted" || value === "denied") {
    return value;
  }
  return "unknown";
}

export function toFriendlyVoskDetail(detail: string): string {
  const normalized = detail.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Распознавание речи недоступно.";
  }

  const lowered = normalized.toLowerCase();
  if (lowered.includes("failed to load")) {
    if (lowered.includes("model")) {
      return "Не удалось загрузить русский профиль распознавания. Переустановите его в настройках.";
    }
    return "Не удалось загрузить голосовой модуль. Переустановите его в настройках распознавания.";
  }
  if (lowered.includes("model") && lowered.includes("missing")) {
    return "Не найден русский профиль распознавания. Установите точный профиль Large в настройках.";
  }
  if (
    lowered.includes("runtime") &&
    (lowered.includes("not found") || lowered.includes("missing"))
  ) {
    return "Не найден голосовой модуль. Установите его в настройках распознавания.";
  }

  return normalized.split(/[.;]/)[0] ?? "Распознавание речи недоступно.";
}

export async function checkLocalReadiness(): Promise<LocalReadiness> {
  try {
    const settings = useSettingsStore.getState();
    const microphoneDeviceId = settings.microphoneDeviceId.trim();
    const systemAudioDeviceId = settings.systemAudioDeviceId.trim();
    const { checkPermissions, getSystemAudioStatus, isTauri, listAudioDevices } =
      await import("@/lib/tauri");

    if (!isTauri()) {
      return {
        microphone: "granted",
        systemAudio: "granted",
        screenCapture: "granted",
        voskStatus: "granted",
        voskDetail: "Проверка распознавания доступна только в приложении.",
        voskReady: true,
        voskRuntimeLoaded: true,
        voskRuntimePath: null,
        voskModelLoaded: true,
        voskModelPath: null,
      };
    }

    const [permissions, systemAudioStatus, audioDevices] = await Promise.all([
      checkPermissions({
        microphoneDeviceId: microphoneDeviceId || undefined,
        systemAudioDeviceId: systemAudioDeviceId || undefined,
      }),
      getSystemAudioStatus({
        systemAudioDeviceId: systemAudioDeviceId || undefined,
      }).catch(() => null),
      listAudioDevices().catch(() => []),
    ]);

    const hasAnyMicrophone = audioDevices.some((device) => device.is_input);
    const hasAnySystemOutput = audioDevices.some((device) => !device.is_input);
    const microphoneExists =
      !microphoneDeviceId ||
      audioDevices.some((device) => device.is_input && device.id === microphoneDeviceId) ||
      hasAnyMicrophone;
    const systemAudioExists =
      !systemAudioDeviceId ||
      audioDevices.some((device) => !device.is_input && device.id === systemAudioDeviceId) ||
      hasAnySystemOutput;

    const microphone = microphoneExists
      ? toPermissionStatus(permissions.microphone)
      : "denied";
    const systemAudioPermission = toPermissionStatus(permissions.system_audio);
    const systemAudio =
      !systemAudioExists
        ? "denied"
        : systemAudioStatus && !systemAudioStatus.available
        ? "denied"
        : systemAudioPermission;

    const serverSpeechReady = microphone !== "denied" || systemAudio !== "denied";
    const serverSpeechDetail = serverSpeechReady
      ? "Серверный live STT активен. Локальные модели на устройстве не требуются."
      : "Серверный live STT включен, но доступ к микрофону и системному звуку сейчас недоступен.";

    return {
      microphone,
      systemAudio,
      screenCapture: toPermissionStatus(permissions.screen_capture),
      voskStatus: serverSpeechReady ? "granted" : "denied",
      voskDetail: serverSpeechDetail,
      voskReady: serverSpeechReady,
      voskRuntimeLoaded: true,
      voskRuntimePath: null,
      voskModelLoaded: true,
      voskModelPath: null,
    };
  } catch {
    return {
      microphone: "unknown",
      systemAudio: "unknown",
      screenCapture: "unknown",
      voskStatus: "unknown",
      voskDetail: "Не удалось проверить распознавание речи.",
      voskReady: false,
      voskRuntimeLoaded: false,
      voskRuntimePath: null,
      voskModelLoaded: false,
      voskModelPath: null,
    };
  }
}

function buildCloudReadiness(
  apiKeyStatus: PermissionStatus,
  apiKeyDetail: string,
  modelDetail: string,
): CloudReadiness {
  const ready = apiKeyStatus === "granted";
  return {
    apiKeyStatus,
    apiKeyDetail,
    modelStatus: apiKeyStatus,
    modelDetail,
    apiReady: ready,
    modelReady: ready,
  };
}

/**
 * Cloud readiness is derived from the license store (`authStatus` + `snapshot`),
 * which is kept fresh by periodic `revalidate()` calls (see useReadinessMonitor)
 * instead of the old forever-cached `apiKeyCheck`. A revoked/expired license is
 * therefore reflected within ~30 minutes rather than never.
 */
export async function checkCloudReadiness(
  apiKey: string,
  _selectedModel: ModelInfo | null,
  baseUrlPreset: LlmBaseUrlPreset,
  customBaseUrl: string,
): Promise<CloudReadiness> {
  const endpoint = resolveLlmEndpointConfig(baseUrlPreset, customBaseUrl);
  if (!endpoint.baseUrl) {
    return buildCloudReadiness(
      "denied",
      "Сервис временно недоступен",
      "Подключение к сервису временно недоступно",
    );
  }

  const { authStatus, snapshot, lastSyncError } = useLicenseStore.getState();

  // Offline grace: a previously valid license whose refresh is failing and whose
  // snapshot has gone stale reads as "unknown" rather than a hard denial.
  const snapshotStale =
    snapshot !== null &&
    Date.now() - snapshot.syncedAt > LICENSE_SNAPSHOT_STALE_MS &&
    Boolean(lastSyncError);

  // A cached "active" status is only trustworthy while we still hold a credential
  // to back it (the license key or a device token). Without one we cannot actually
  // authenticate — the interview would silently fall back to audio-free mode — so a
  // remembered "active" with no key/token must NOT read as ready.
  const hasCredential = apiKey.trim().length > 0 || Boolean(getCachedAccessToken());

  // Fast path — the store already confirmed an active license (no network needed).
  if (authStatus === "active" && !snapshotStale && hasCredential) {
    const detail = snapshot?.expiresAt
      ? `Лицензия активна до ${new Date(snapshot.expiresAt).toLocaleDateString("ru-RU")}`
      : "Лицензия активна";
    return buildCloudReadiness("granted", detail, "Сервис готов к работе");
  }

  // Server-confirmed hard denials — trust them without another round-trip.
  if (authStatus === "expired") {
    return buildCloudReadiness(
      "denied",
      "Срок действия лицензии истёк. Продлите в «Кабинете»",
      "Сервис недоступен, пока лицензия не продлена",
    );
  }
  if (authStatus === "device_mismatch") {
    return buildCloudReadiness(
      "denied",
      "Ключ привязан к другому устройству",
      "Сервис недоступен на этом устройстве",
    );
  }

  // Unresolved (unactivated / activating / soft-invalid / stale): validate the key
  // directly against the server via the proven path. This works on both the current
  // and the future backend (X-License-Key), so a valid key reads as ready even when
  // the new activation/token flow is unavailable (e.g. backend not yet deployed).
  const key = apiKey.trim();
  if (!key) {
    return buildCloudReadiness(
      "denied",
      "Активируйте лицензионный ключ в «Кабинете»",
      "Сервис станет доступен после активации ключа",
    );
  }
  try {
    const result = await validateLicenseKeyDetailed(key, baseUrlPreset, customBaseUrl);
    if (result.valid) {
      // Sync the license store so the cabinet reflects the same state.
      void useLicenseStore.getState().revalidate({ force: true });
      const detail = result.status?.expiresAt
        ? `Лицензия активна до ${new Date(result.status.expiresAt).toLocaleDateString("ru-RU")}`
        : "Лицензия активна";
      return buildCloudReadiness("granted", detail, "Сервис готов к работе");
    }
    return buildCloudReadiness(
      "denied",
      result.detail || "Ключ недействителен. Проверьте его в «Кабинете»",
      "Сервис недоступен, пока ключ не подтверждён",
    );
  } catch {
    return buildCloudReadiness(
      "unknown",
      "Не удалось проверить лицензию",
      "Проверьте интернет-соединение",
    );
  }
}
