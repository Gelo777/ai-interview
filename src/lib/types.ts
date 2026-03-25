export type Provider =
  | "gemini"
  | "openai"
  | "claude"
  | "neuroapi"
  | "custom";
export type LlmBaseUrlPreset = Provider;
export type LlmApiDialect = "gemini" | "openai" | "anthropic";

export type CacheSupport = "supported" | "not_supported" | "unknown";
export type MultimodalSupport = "supported" | "not_supported";
export type CaptureProtection = "supported" | "limited" | "unknown";
export type ImageHandlingMode = "ocr_text" | "send_image";
export type PrimaryLanguage =
  | "en-US"
  | "ru-RU"
  | "es-ES"
  | "de-DE"
  | "fr-FR"
  | "it-IT"
  | "pt-BR"
  | "zh-CN"
  | "ja-JP"
  | "ko-KR";
export type SecondaryLanguage = PrimaryLanguage | "none";
export type ModelLifecycleStatus = "active" | "deprecated" | "sunset";
export type SttModelVariant = "small" | "large";
export type HotkeyAction =
  | "send_to_llm"
  | "send_with_screenshot"
  | "end_interview"
  | "switch_stt_language";
export type SettingsTab =
  | "llm"
  | "audio"
  | "language"
  | "images"
  | "privacy"
  | "storage"
  | "hotkeys";

export type SettingsFocusTarget =
  | "llm-api-key"
  | "audio-devices"
  | "llm-model"
  | "language-runtime"
  | "language-models"
  | "storage-history-retention"
  | "hotkeys-bindings";

export interface ModelInfo {
  id: string;
  name: string;
  remoteCaching: CacheSupport;
  multimodalImage: MultimodalSupport;
  lifecycle?: ModelLifecycleStatus;
  replacementModelId?: string | null;
  lifecycleNote?: string | null;
}

export interface HotkeyBinding {
  action: HotkeyAction;
  label: string;
  keys: string[];
  default: string[];
}

export interface AppSettings {
  provider: Provider;
  baseUrlPreset: LlmBaseUrlPreset;
  customBaseUrl: string;
  primaryLanguage: PrimaryLanguage;
  secondaryLanguage: SecondaryLanguage;
  primarySttVariant: SttModelVariant;
  secondarySttVariant: SttModelVariant;
  microphoneDeviceId: string;
  systemAudioDeviceId: string;
  apiKey: string;
  selectedModel: ModelInfo | null;
  sendSummary: boolean;
  finalReport: boolean;
  maxResponseTokens: number;
  imageHandlingMode: ImageHandlingMode;
  protectOverlay: boolean;
  chatMemoryLimitMb: number;
  historyRetentionDays: number | null;
  hotkeys: HotkeyBinding[];
}

export interface ChatMessage {
  id: string;
  timestamp: number;
  source: "interviewer" | "user" | "ai_marker";
  text: string;
  isFinal: boolean;
}

export interface LlmResponse {
  id: string;
  timestamp: number;
  text: string;
  isStreaming: boolean;
  firstTokenLatencyMs?: number;
  totalLatencyMs?: number;
}

export interface SessionMetrics {
  durationMs: number;
  interviewerSpeechRatio: number;
  userSpeechRatio: number;
  llmRequestCount: number;
  avgFirstTokenLatencyMs: number;
  avgTotalLatencyMs: number;
}

export interface SessionRecord {
  id: string;
  startedAt: number;
  endedAt: number;
  model: string;
  provider: Provider;
  metrics: SessionMetrics;
  finalReport?: FinalReport;
}

export interface FinalReport {
  overallScore: number;
  interviewerScore: number;
  interviewerComment: string;
  strengths: string[];
  weaknesses: string[];
  improvements: string[];
}

export type PermissionStatus = "granted" | "denied" | "unknown" | "checking";

export interface PermissionsState {
  microphone: PermissionStatus;
  systemAudio: PermissionStatus;
  screenCapture: PermissionStatus;
}

export type AppView =
  | "dashboard"
  | "settings"
  | "history"
  | "interview";
