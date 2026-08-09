import { invoke } from "@tauri-apps/api/core";

export interface PlatformInfo {
  os: string;
  arch: string;
  capture_protection: string;
}

export interface HardwareGpuInfo {
  name: string;
  vendor: string | null;
  vram_mb: number | null;
  integrated: boolean | null;
}

export interface HardwareProfile {
  os: string;
  arch: string;
  logical_cpu_cores: number;
  physical_cpu_cores: number | null;
  total_memory_mb: number | null;
  gpus: HardwareGpuInfo[];
  detected_at_unix_ms: number;
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

export interface StartSttSessionRequest extends AudioDeviceSelectionRequest {
  language?: string;
}

export interface AudioDebugEndpoint {
  selected_device_id: string | null;
  selected_device: AudioDeviceInfo | null;
  default_device: AudioDeviceInfo | null;
  effective_device: AudioDeviceInfo | null;
  available: boolean;
  detail: string;
}

export interface AudioDebugSnapshot {
  microphone: AudioDebugEndpoint;
  system_audio: AudioDebugEndpoint;
  system_audio_status: SystemAudioStatus;
  input_devices: AudioDeviceInfo[];
  output_devices: AudioDeviceInfo[];
  notes: string[];
}

export interface CaptureAudioSampleRequest extends AudioDeviceSelectionRequest {
  durationSeconds?: number;
  openOutputDir?: boolean;
}

export interface CapturedAudioTrack {
  source: string;
  requested_device_id: string | null;
  device_name: string | null;
  sample_rate: number | null;
  sample_count: number;
  duration_ms: number;
  peak_abs: number;
  rms: number;
  file_path: string | null;
  available: boolean;
  detail: string;
}

export interface CaptureAudioSampleResult {
  output_dir: string;
  duration_seconds: number;
  microphone: CapturedAudioTrack;
  system_audio: CapturedAudioTrack;
  captured_at_unix_ms: number;
}

export interface ServerSttChunkCaptureRequest extends AudioDeviceSelectionRequest {
  durationSeconds?: number;
  /** Sub-second drain interval for dictation; wins over durationSeconds. */
  durationMs?: number;
}

export interface ServerSttChunkTrack {
  source: string;
  requested_device_id: string | null;
  device_name: string | null;
  sample_rate: number | null;
  duration_ms: number;
  peak_abs: number;
  rms: number;
  wav_base64: string | null;
  available: boolean;
  detail: string;
}

export interface ServerSttChunkCaptureResult {
  duration_seconds: number;
  duration_ms: number;
  microphone: ServerSttChunkTrack;
  system_audio: ServerSttChunkTrack;
  captured_at_unix_ms: number;
}

export interface AudioAutoProbeRequest extends AudioDeviceSelectionRequest {
  durationSeconds?: number;
  probeAllInputDevices?: boolean;
  probeAllOutputDevices?: boolean;
}

export interface AudioSignalProbeTrack {
  source: string;
  device: AudioDeviceInfo | null;
  requested_device_id: string | null;
  device_id: string | null;
  device_name: string | null;
  sample_rate: number | null;
  duration_ms: number;
  peak_abs: number;
  rms: number;
  signal_score: number;
  has_signal: boolean;
  available: boolean;
  detail: string;
}

export interface AudioAutoProbeResult {
  duration_seconds: number;
  microphone_candidates: AudioSignalProbeTrack[];
  system_audio_candidates: AudioSignalProbeTrack[];
  recommended_microphone: AudioSignalProbeTrack | null;
  recommended_system_audio: AudioSignalProbeTrack | null;
  notes: string[];
  probed_at_unix_ms: number;
}

export interface ServerSttCaptureRequest extends AudioDeviceSelectionRequest {
  licenseKey: string;
  baseUrl: string;
  language?: string;
  durationSeconds?: number;
}

export interface ServerSttTrack {
  source: string;
  file_path: string | null;
  text: string;
  available: boolean;
  detail: string;
}

export interface ServerSttCaptureResult {
  capture_dir: string;
  duration_seconds: number;
  language: string;
  microphone: ServerSttTrack;
  system_audio: ServerSttTrack;
  transcribed_at_unix_ms: number;
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

export interface DeviceIdentity {
  fingerprint: string;
  name: string;
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

export interface ProxyLicenseStatusRequest {
  licenseKey: string;
  baseUrl: string;
}

export interface ProxyLicenseStatusResponse {
  status: string;
  plan?: string | null;
  expiresAt?: string | null;
  limits?: Record<string, unknown> | null;
  usageToday?: Record<string, unknown> | null;
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

export async function captureScreenPngBase64(): Promise<string> {
  return invoke("capture_screen_png_base64");
}

export async function getSecureApiKey(): Promise<string | null> {
  return invoke("get_secure_api_key");
}

export async function setSecureApiKey(apiKey: string): Promise<void> {
  return invoke("set_secure_api_key", { apiKey });
}

export async function getDeviceIdentity(): Promise<DeviceIdentity> {
  return invoke("get_device_identity");
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

export async function getLicenseAccessToken(): Promise<string | null> {
  return invoke("get_license_access_token");
}

export async function getLicenseKey(): Promise<string | null> {
  return invoke("get_license_key");
}

export async function getProxyLicenseStatus(
  request: ProxyLicenseStatusRequest,
): Promise<ProxyLicenseStatusResponse> {
  return invoke("get_proxy_license_status", {
    request: {
      license_key: request.licenseKey,
      base_url: request.baseUrl,
    },
  });
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

export async function getHardwareProfile(): Promise<HardwareProfile> {
  return invoke("get_hardware_profile");
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

export async function getAudioDebugSnapshot(
  request?: AudioDeviceSelectionRequest,
): Promise<AudioDebugSnapshot> {
  return invoke("get_audio_debug_snapshot", {
    request: normalizeAudioDeviceSelection(request),
  });
}

export async function captureAudioSample(
  request?: CaptureAudioSampleRequest,
): Promise<CaptureAudioSampleResult> {
  return invoke("capture_audio_sample", {
    request: {
      ...normalizeAudioDeviceSelection(request),
      duration_seconds:
        typeof request?.durationSeconds === "number"
          ? Math.round(request.durationSeconds)
          : undefined,
      open_output_dir:
        typeof request?.openOutputDir === "boolean"
          ? request.openOutputDir
          : undefined,
    },
  });
}

export async function probeAudioDevices(
  request?: AudioAutoProbeRequest,
): Promise<AudioAutoProbeResult> {
  return invoke("probe_audio_devices", {
    request: {
      ...normalizeAudioDeviceSelection(request),
      duration_seconds:
        typeof request?.durationSeconds === "number"
          ? Math.round(request.durationSeconds)
          : undefined,
      probe_all_input_devices:
        typeof request?.probeAllInputDevices === "boolean"
          ? request.probeAllInputDevices
          : undefined,
      probe_all_output_devices:
        typeof request?.probeAllOutputDevices === "boolean"
          ? request.probeAllOutputDevices
          : undefined,
    },
  });
}

export async function captureAndTranscribeServerStt(
  request: ServerSttCaptureRequest,
): Promise<ServerSttCaptureResult> {
  return invoke("capture_and_transcribe_server_stt", {
    request: {
      license_key: request.licenseKey.trim(),
      base_url: request.baseUrl.trim(),
      language: request.language?.trim() || undefined,
      duration_seconds:
        typeof request.durationSeconds === "number"
          ? Math.round(request.durationSeconds)
          : undefined,
      ...normalizeAudioDeviceSelection(request),
    },
  });
}

export async function captureServerSttChunk(
  request?: ServerSttChunkCaptureRequest,
): Promise<ServerSttChunkCaptureResult> {
  return invoke("capture_server_stt_chunk", {
    request: {
      ...normalizeAudioDeviceSelection(request),
      duration_seconds:
        typeof request?.durationSeconds === "number"
          ? Math.round(request.durationSeconds)
          : undefined,
      duration_ms:
        typeof request?.durationMs === "number"
          ? Math.round(request.durationMs)
          : undefined,
    },
  });
}

export async function stopServerSttLiveCapture(): Promise<void> {
  return invoke("stop_server_stt_live_capture");
}

export async function getVoskSttStatus(): Promise<SttStatus> {
  return invoke("get_vosk_stt_status");
}

export async function startVoskSttSession(
  request?: StartSttSessionRequest,
): Promise<void> {
  return invoke("start_vosk_stt_session", {
    request: {
      ...normalizeAudioDeviceSelection(request),
      language: request?.language?.trim() || undefined,
    },
  });
}

export async function stopVoskSttSession(): Promise<void> {
  return invoke("stop_vosk_stt_session");
}

export async function isVoskSttSessionRunning(): Promise<boolean> {
  return invoke("is_vosk_stt_session_running");
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

export async function openExternalUrl(url: string): Promise<void> {
  const { open } = await import("@tauri-apps/plugin-shell");
  await open(url);
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
  variant: "large";
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

export async function pickVoskModelZip(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: false,
    filters: [{ name: "Vosk model ZIP", extensions: ["zip"] }],
  });
  return typeof selected === "string" ? selected : null;
}

export async function installVoskModelFromZip(
  archivePath: string,
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
    return await invoke<string>("install_vosk_model_from_zip", {
      archivePath,
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
