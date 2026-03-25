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
    return "Vosk недоступен.";
  }

  const lowered = normalized.toLowerCase();
  if (lowered.includes("failed to load")) {
    return "Не удалось загрузить Vosk runtime. Переустановите его в языковых настройках.";
  }
  if (lowered.includes("model") && lowered.includes("missing")) {
    return "Не найдена языковая модель Vosk. Установите ее в языковых настройках.";
  }
  if (
    lowered.includes("runtime") &&
    (lowered.includes("not found") || lowered.includes("missing"))
  ) {
    return "Не найден Vosk runtime. Установите его в языковых настройках.";
  }

  return normalized.split(/[.;]/)[0] ?? "Vosk недоступен.";
}

export async function checkLocalReadiness(): Promise<LocalReadiness> {
  try {
    const settings = useSettingsStore.getState();
    const microphoneDeviceId = settings.microphoneDeviceId.trim();
    const systemAudioDeviceId = settings.systemAudioDeviceId.trim();
    const { checkPermissions, getSttStatus, getSystemAudioStatus, isTauri, listAudioDevices } =
      await import("@/lib/tauri");

    if (!isTauri()) {
      return {
        microphone: "granted",
        systemAudio: "granted",
        screenCapture: "granted",
        voskStatus: "granted",
        voskDetail: "Проверка runtime доступна только в режиме Tauri.",
        voskReady: true,
        voskRuntimeLoaded: true,
        voskRuntimePath: null,
        voskModelLoaded: true,
        voskModelPath: null,
      };
    }

    const [permissions, sttStatus, systemAudioStatus, audioDevices] = await Promise.all([
      checkPermissions({
        microphoneDeviceId: microphoneDeviceId || undefined,
        systemAudioDeviceId: systemAudioDeviceId || undefined,
      }),
      getSttStatus(),
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

    const voskReady =
      sttStatus.available &&
      sttStatus.runtime_library_loaded &&
      sttStatus.model_loaded;

    return {
      microphone,
      systemAudio,
      screenCapture: toPermissionStatus(permissions.screen_capture),
      voskStatus: voskReady ? "granted" : "denied",
      voskDetail: toFriendlyVoskDetail(sttStatus.detail),
      voskReady,
      voskRuntimeLoaded: sttStatus.runtime_library_loaded,
      voskRuntimePath: sttStatus.runtime_library_path,
      voskModelLoaded: sttStatus.model_loaded,
      voskModelPath: sttStatus.model_path,
    };
  } catch {
    return {
      microphone: "unknown",
      systemAudio: "unknown",
      screenCapture: "unknown",
      voskStatus: "unknown",
      voskDetail: "Не удалось проверить состояние Vosk.",
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
      apiKeyDetail: "Сначала укажите адрес прокси",
      modelStatus: "denied",
      modelDetail: "Подключение к сервису недоступно, пока не задан адрес прокси",
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
      modelDetail: status.plan ? `План: ${status.plan}` : "Прокси готов к работе",
      apiReady: true,
      modelReady: true,
    };
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Сервер лицензий недоступен";
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
