import { invoke } from "@tauri-apps/api/core";

export interface PlatformInfo {
  os: string;
  arch: string;
  capture_protection: string;
}

export interface PermissionCheck {
  microphone: string;
  system_audio: string;
  screen_capture: string;
}

export interface AudioDeviceInfo {
  id: string;
  name: string;
  is_default: boolean;
  is_input: boolean;
  sample_rate: number;
  channels: number;
}

export interface AudioDeviceSelectionRequest {
  microphoneDeviceId?: string;
  systemAudioDeviceId?: string;
}

export interface SystemAudioStatus {
  supported: boolean;
  available: boolean;
  detail: string;
}

export interface SttStatus {
  available: boolean;
  model_loaded: boolean;
  model_path: string | null;
  language: string;
  runtime_library_loaded: boolean;
  runtime_library_path: string | null;
  detail: string;
}

export interface LicenseProxyConfig {
  provider: string | null;
  base_url: string;
  chat_path: string | null;
  models_path: string | null;
  validate_path: string | null;
  default_model: string | null;
  dialect: string | null;
}

export interface LicenseStatus {
  has_license_key: boolean;
  is_activated: boolean;
  status: string;
  proxy_url: string | null;
  license_id: string | null;
  plan_name: string | null;
  customer_label: string | null;
  expires_at: string | null;
  activated_at: string | null;
  last_validated_at: string | null;
  last_error: string | null;
  proxy: LicenseProxyConfig | null;
}

export interface ActivateLicenseRequest {
  license_key: string;
  proxy_url: string;
}

export interface LicenseActivationResult {
  status: LicenseStatus;
}

export interface SttResultEvent {
  text: string;
  is_final: boolean;
  confidence: number;
  source: string; // "mic" | "system"
}

export interface SttDiagnosticEvent {
  code: string;
  level: string;
  message: string;
  source?: string | null;
}

export interface VoskRuntimeVersion {
  version: string;
  tag: string;
  asset_name: string;
  download_url: string;
  published_at: string;
  is_latest_stable: boolean;
}

export interface VoskRuntimeInstallProgress {
  phase: string;
  bytes_downloaded: number;
  content_length: number | null;
  percent: number;
}

export interface VoskRuntimeInstallResult {
  version: string;
  tag: string;
  install_dir: string;
  files: string[];
}

export interface AppUpdateStatus {
  enabled: boolean;
  endpoint: string | null;
  currentVersion: string;
  updateAvailable: boolean;
  version: string | null;
  body: string | null;
  date: string | null;
  error: string | null;
}

export type AppUpdateProgressEvent =
  | {
      event: "Started";
      data: {
        contentLength: number | null;
      };
    }
  | {
      event: "Progress";
      data: {
        chunkLength: number;
      };
    }
  | {
      event: "Finished";
    };

function normalizeAudioDeviceSelection(
  request?: AudioDeviceSelectionRequest,
): { microphone_device_id?: string; system_audio_device_id?: string } | undefined {
  const microphoneDeviceId = request?.microphoneDeviceId?.trim();
  const systemAudioDeviceId = request?.systemAudioDeviceId?.trim();

  if (!microphoneDeviceId && !systemAudioDeviceId) {
    return undefined;
  }

  return {
    microphone_device_id: microphoneDeviceId || undefined,
    system_audio_device_id: systemAudioDeviceId || undefined,
  };
}

export async function getSystemAudioStatus(
  request?: AudioDeviceSelectionRequest,
): Promise<SystemAudioStatus> {
  return invoke("get_system_audio_status", {
    request: normalizeAudioDeviceSelection(request),
  });
}

export async function ocrImage(
  imageBase64: string,
  languageHint?: string | null,
): Promise<string> {
  return invoke("ocr_image", {
    imageBase64,
    languageHint: languageHint ?? undefined,
  });
}

export async function getSecureApiKey(): Promise<string | null> {
  return invoke("get_secure_api_key");
}

export async function setSecureApiKey(apiKey: string): Promise<void> {
  return invoke("set_secure_api_key", { apiKey });
}

export async function getLicenseStatus(): Promise<LicenseStatus> {
  return invoke("get_license_status");
}

export async function activateLicense(
  request: ActivateLicenseRequest,
): Promise<LicenseActivationResult> {
  return invoke("activate_license", { request });
}

export async function clearLicense(): Promise<LicenseStatus> {
  return invoke("clear_license");
}

export async function checkAppUpdate(): Promise<AppUpdateStatus> {
  return invoke("check_app_update");
}

export async function installAppUpdate(): Promise<void> {
  return invoke("install_app_update");
}

export async function readAppState(key: string): Promise<string | null> {
  return invoke("read_app_state", { key });
}

export async function writeAppState(key: string, value: string): Promise<void> {
  return invoke("write_app_state", { key, value });
}

export async function removeAppState(key: string): Promise<void> {
  return invoke("remove_app_state", { key });
}

export async function getPlatformInfo(): Promise<PlatformInfo> {
  return invoke("get_platform_info");
}

export async function checkPermissions(
  request?: AudioDeviceSelectionRequest,
): Promise<PermissionCheck> {
  return invoke("check_permissions", {
    request: normalizeAudioDeviceSelection(request),
  });
}

export async function listAudioDevices(): Promise<AudioDeviceInfo[]> {
  return invoke("list_audio_devices");
}

export async function getSttStatus(): Promise<SttStatus> {
  return invoke("get_stt_status");
}

export async function startSttSession(
  request?: AudioDeviceSelectionRequest,
): Promise<void> {
  return invoke("start_stt_session", {
    request: normalizeAudioDeviceSelection(request),
  });
}

export async function stopSttSession(): Promise<void> {
  return invoke("stop_stt_session");
}

export async function isSttSessionRunning(): Promise<boolean> {
  return invoke("is_stt_session_running");
}

export async function listVoskRuntimeVersions(): Promise<VoskRuntimeVersion[]> {
  return invoke("list_vosk_runtime_versions");
}

export async function installVoskRuntime(
  version?: string | null,
  onProgress?: (p: VoskRuntimeInstallProgress) => void,
): Promise<VoskRuntimeInstallResult> {
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = onProgress
    ? await listen<VoskRuntimeInstallProgress>("vosk_runtime_install_progress", (e) =>
        onProgress(e.payload),
      )
    : undefined;
  try {
    return await invoke<VoskRuntimeInstallResult>("install_vosk_runtime", {
      version: version ?? undefined,
    });
  } finally {
    unlisten?.();
  }
}

export async function cancelVoskInstall(): Promise<void> {
  return invoke("cancel_vosk_install");
}

export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function createOverlayWindow(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("create_overlay_window");
}

export async function closeMainWindow(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("close_main_window");
}

export async function restoreMainWindow(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("restore_main_window");
}

export async function setCaptureProtectionForWindow(
  windowLabel: string,
  enabled: boolean,
): Promise<void> {
  return invoke("set_capture_protection_for_window", {
    windowLabel,
    enabled,
  });
}

export interface VoskModelDownloadProgress {
  bytes_downloaded: number;
  content_length: number | null;
  percent: number;
  phase: string;
}

export interface VoskModelOption {
  id: string;
  name: string;
  language: string;
  variant: "small" | "large";
  size_mb: number;
  download_url: string;
  installed: boolean;
  active: boolean;
  update_available: boolean;
  installed_versions: string[];
  default_baseline: boolean;
}

export async function downloadVoskModel(
  url: string,
  modelId: string,
  onProgress?: (p: VoskModelDownloadProgress) => void,
  cleanupModelIds?: string[],
): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = onProgress
    ? await listen<VoskModelDownloadProgress>("vosk_model_download_progress", (e) =>
        onProgress(e.payload),
      )
    : undefined;
  try {
    return await invoke<string>("download_vosk_model", {
      url,
      modelId,
      cleanupModelIds: cleanupModelIds && cleanupModelIds.length > 0 ? cleanupModelIds : undefined,
    });
  } finally {
    unlisten?.();
  }
}

export async function listVoskModels(): Promise<VoskModelOption[]> {
  return invoke("list_vosk_models");
}

export async function setActiveVoskModel(modelId: string): Promise<void> {
  return invoke("set_active_vosk_model", { modelId });
}

export async function switchSttModel(modelId: string): Promise<void> {
  return invoke("switch_stt_model", { modelId });
}

export async function preloadSttModel(modelId: string): Promise<void> {
  return invoke("preload_stt_model", { modelId });
}

export async function removeVoskModel(modelId: string): Promise<void> {
  return invoke("remove_vosk_model", { modelId });
}

export async function ensureDefaultSttAssets(
  primaryLanguage: string,
): Promise<void> {
  return invoke("ensure_default_stt_assets", { primaryLanguage });
}
