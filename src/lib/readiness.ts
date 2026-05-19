import { resolveLlmEndpointConfig } from "@/lib/llm";
import { getLicenseStatus } from "@/lib/proxy";
import type { LlmBaseUrlPreset, ModelInfo, PermissionStatus } from "@/lib/types";
import { useSettingsStore } from "@/stores/settings";

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

    const microphoneExists =
      !microphoneDeviceId ||
      audioDevices.some((device) => device.is_input && device.id === microphoneDeviceId);
    const systemAudioExists =
      !systemAudioDeviceId ||
      audioDevices.some((device) => !device.is_input && device.id === systemAudioDeviceId);

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

export async function checkCloudReadiness(
  apiKey: string,
  _selectedModel: ModelInfo | null,
  baseUrlPreset: LlmBaseUrlPreset,
  customBaseUrl: string,
): Promise<CloudReadiness> {
  const endpoint = resolveLlmEndpointConfig(baseUrlPreset, customBaseUrl);
  if (!endpoint.baseUrl) {
    return {
      apiKeyStatus: "denied",
      apiKeyDetail: "Сервис временно недоступен",
      modelStatus: "denied",
      modelDetail: "Подключение к сервису временно недоступно",
      apiReady: false,
      modelReady: false,
    };
  }

  const trimmedApiKey = apiKey.trim();
  if (!trimmedApiKey) {
    return {
      apiKeyStatus: "denied",
      apiKeyDetail: "Введите лицензионный ключ",
      modelStatus: "denied",
      modelDetail: "Сервис станет доступен после проверки ключа",
      apiReady: false,
      modelReady: false,
    };
  }

  try {
    const status = await getLicenseStatus(trimmedApiKey, baseUrlPreset, customBaseUrl);
    if (status.status?.toUpperCase() !== "ACTIVE") {
      return {
        apiKeyStatus: "denied",
        apiKeyDetail: "Лицензия не активна",
        modelStatus: "denied",
        modelDetail: "Сервис недоступен, пока лицензия не активна",
        apiReady: false,
        modelReady: false,
      };
    }

    return {
      apiKeyStatus: "granted",
      apiKeyDetail: status.expiresAt
        ? `Лицензия активна до ${new Date(status.expiresAt).toLocaleString("ru-RU")}`
        : "Лицензия активна",
      modelStatus: "granted",
      modelDetail: status.plan ? `План: ${status.plan}` : "Сервис готов к работе",
      apiReady: true,
      modelReady: true,
    };
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Сервис лицензий недоступен";
    return {
      apiKeyStatus: "denied",
      apiKeyDetail: detail,
      modelStatus: "denied",
      modelDetail: "Сервис недоступен, пока ключ не подтвержден",
      apiReady: false,
      modelReady: false,
    };
  }
}
