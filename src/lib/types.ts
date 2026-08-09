export type Provider =
  | "gemini"
  | "claude"
  | "neuroapi"
  | "custom";
export type LlmBaseUrlPreset = Provider;

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
/** UI language of the application itself (localization), distinct from the STT/interview language. */
export type AppLanguage = "ru" | "en";
export type ModelLifecycleStatus = "active" | "deprecated" | "sunset";
export type SttModelVariant = "large";
export type HotkeyAction =
  | "send_to_llm"
  | "send_with_screenshot"
  | "end_interview"
  | "switch_stt_language";
export type SettingsTab =
  | "llm"
  | "audio"
  | "language"
  | "speech"
  | "images"
  | "privacy"
  | "storage"
  | "hotkeys"
  | "diagnostics";

export type SettingsFocusTarget =
  | "llm-api-key"
  | "llm-interview-context"
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
  appLanguage: AppLanguage;
  primarySttVariant: SttModelVariant;
  secondarySttVariant: SttModelVariant;
  microphoneDeviceId: string;
  systemAudioDeviceId: string;
  apiKey: string;
  apiKeyCheck: ApiKeyCheckState | null;
  interviewContext: string;
  contextFiles: ContextFile[];
  selectedModel: ModelInfo | null;
  sendSummary: boolean;
  finalReport: boolean;
  maxResponseTokens: number;
  imageHandlingMode: ImageHandlingMode;
  protectOverlay: boolean;
  chatMemoryLimitMb: number;
  historyRetentionDays: number | null;
  dictationTrigger: DictationTrigger;
  dictationSource: DictationSource;
  /** Окно кнопки «последние N сек» аудио-подсказки, сек (3–15). */
  audioHintWindowSeconds: number;
  hotkeys: HotkeyBinding[];
}

/**
 * How the dictation button behaves: a click starts and stops recording, or the
 * button records only while it is held down.
 */
export type DictationTrigger = "toggle" | "push";

/** Which audio goes into dictation: the user, the PC output, or both. */
export type DictationSource = "mic" | "system" | "both";

export interface ApiKeyCheckState {
  /** Exact trimmed key string this result belongs to. */
  key: string;
  valid: boolean;
  detail: string | null;
  checkedAt: number;
}

export interface ContextFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  content: string;
  addedAt: number;
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

export interface SessionContextFile {
  name: string;
  size: number;
}

export interface SessionRecord {
  id: string;
  startedAt: number;
  endedAt: number;
  model: string;
  provider: Provider;
  mode?: "live" | "safe";
  safeModeReason?: string | null;
  /** Interview topic/context text that was set before the session, if any. */
  interviewContext?: string;
  /** Context files that were attached before the session, if any. */
  contextFiles?: SessionContextFile[];
  metrics: SessionMetrics;
  transcript?: ChatMessage[];
  aiResponses?: LlmResponse[];
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
  | "readiness"
  | "cabinet"
  | "support"
  | "settings"
  | "history"
  | "interview";
