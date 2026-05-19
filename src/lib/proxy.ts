import type { LlmBaseUrlPreset, PrimaryLanguage } from "@/lib/types";
import { logInfo, logWarn } from "@/lib/diagnostics";

export interface ProxyLicenseStatus {
  status: string;
  plan?: string | null;
  expiresAt?: string | null;
  limits?: Record<string, unknown> | null;
}

export interface ProxyHintResponse {
  hintId: string;
  taskType: "TEXT" | "VISION" | string;
  question: string;
  output: string;
  code?: string | null;
  checklist?: string[] | null;
  questions?: string[] | null;
  nextSteps?: string[] | null;
}

export interface LiveSttTrackResponse {
  source: string;
  available: boolean;
  text: string;
  detail: string;
  bufferedMs: number;
}

export interface LiveSttTranscribeLatestResponse {
  streamId: string;
  lang: string;
  seconds: number;
  transcript: string;
  microphone: LiveSttTrackResponse;
  systemAudio: LiveSttTrackResponse;
  debugMicPath?: string | null;
  debugSystemPath?: string | null;
}

export interface LicenseValidationResult {
  valid: boolean;
  detail: string | null;
  status: ProxyLicenseStatus | null;
}

export interface SupportReportResponse {
  reportId: string;
  createdAt: string;
}

export type AiFeedbackRating = "good" | "bad" | "wrong_mode";

export interface AiFeedbackResponse {
  отзываId: string;
  createdAt: string;
}

export interface ProxyServiceStatus {
  status: string;
  generatedAt: string;
  backendVersion?: string | null;
  openAiConfigured?: boolean;
  chatModel?: string | null;
  sttModel?: string | null;
}

export type TelemetrySeverity = "info" | "warn" | "error";

export interface TelemetryEventResponse {
  eventId: string;
  createdAt: string;
}

const MAX_OUTPUT_CHARS = 1600;
const MAX_LIST_ITEMS = 2;
const MAX_LIST_ITEM_CHARS = 260;
const MAX_CODE_LINES = 48;
const MAX_CODE_CHARS = 2800;
export const HARDCODED_PROXY_BASE_URL = "https://leonovcare.ru";
export const PROXY_BASE_URL =
  import.meta.env.VITE_PROXY_BASE_URL?.trim() || HARDCODED_PROXY_BASE_URL;

function joinBaseUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function toLiveSttWebSocketUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v2/stt/live/ws";
  url.search = "";
  return url;
}

function getProxyBaseUrl(
  baseUrlPreset: LlmBaseUrlPreset,
  customBaseUrl: string,
): string {
  void baseUrlPreset;
  void customBaseUrl;
  return PROXY_BASE_URL;
}

async function getDeviceHeaders(): Promise<Record<string, string>> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return {};
  }

  try {
    const { getDeviceIdentity } = await import("@/lib/tauri");
    const identity = await getDeviceIdentity();
    if (!identity.fingerprint.trim()) {
      return {};
    }

    return {
      "X-Device-Fingerprint": identity.fingerprint,
      "X-Device-Name": identity.name,
    };
  } catch (error) {
    logWarn("license.deviceIdentity", "Failed to resolve device identity", error);
    return {};
  }
}

export async function getLicenseStatus(
  licenseKey: string,
  baseUrlPreset: LlmBaseUrlPreset,
  customBaseUrl: string,
): Promise<ProxyLicenseStatus> {
  const trimmedKey = licenseKey.trim();
  const baseUrl = getProxyBaseUrl(baseUrlPreset, customBaseUrl);

  if (!trimmedKey) {
    throw new Error("Введите лицензионный ключ.");
  }
  if (!baseUrl) {
    throw new Error("Не указан адрес сервиса.");
  }

  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { getProxyLicenseStatus } = await import("@/lib/tauri");
    return getProxyLicenseStatus({
      licenseKey: trimmedKey,
      baseUrl,
    });
  }
  const response = await fetch(joinBaseUrl(baseUrl, "/api/v1/license/status"), {
    headers: {
      "X-License-Key": trimmedKey,
      ...(await getDeviceHeaders()),
    },
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as ProxyLicenseStatus;
}

export async function validateLicenseKey(
  licenseKey: string,
  baseUrlPreset: LlmBaseUrlPreset,
  customBaseUrl: string,
): Promise<boolean> {
  const result = await validateLicenseKeyDetailed(
    licenseKey,
    baseUrlPreset,
    customBaseUrl,
  );
  return result.valid;
}

export async function validateLicenseKeyDetailed(
  licenseKey: string,
  baseUrlPreset: LlmBaseUrlPreset,
  customBaseUrl: string,
): Promise<LicenseValidationResult> {
  try {
    const status = await getLicenseStatus(licenseKey, baseUrlPreset, customBaseUrl);
    if (status.status?.toUpperCase() === "ACTIVE") {
      return {
        valid: true,
        detail: status.expiresAt
          ? `Лицензия активна до ${new Date(status.expiresAt).toLocaleString("ru-RU")}`
          : "Лицензия активна.",
        status,
      };
    }

    return {
      valid: false,
      detail: `Сервер вернул статус лицензии: ${status.status ?? "UNKNOWN"}`,
      status,
    };
  } catch (error) {
    const detail = normalizeValidationError(error);
    logWarn("license.validation", "License validation failed", { detail, error });
    console.warn("License validation failed:", detail, error);
    return {
      valid: false,
      detail,
      status: null,
    };
  }
}

export async function requestProxyHint(params: {
  licenseKey: string;
  baseUrlPreset: LlmBaseUrlPreset;
  customBaseUrl: string;
  question: string;
  language: PrimaryLanguage;
  imageBase64Png?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ProxyHintResponse> {
  const {
    licenseKey,
    baseUrlPreset,
    customBaseUrl,
    question,
    language,
    imageBase64Png,
    timeoutMs,
    signal,
  } = params;
  const trimmedKey = licenseKey.trim();
  const baseUrl = getProxyBaseUrl(baseUrlPreset, customBaseUrl);

  if (!trimmedKey) {
    throw new Error("Введите лицензионный ключ.");
  }
  if (!baseUrl) {
    throw new Error("Не указан адрес сервиса.");
  }
  if (!question.trim()) {
    throw new Error("Нет текста для отправки.");
  }

  const formData = new FormData();
  formData.set("question", question.trim());
  formData.set("meta", JSON.stringify({ lang: toProxyLanguage(language) }));

  if (imageBase64Png) {
    formData.set("image", base64ToBlob(imageBase64Png, "image/png"), "screenshot.png");
  }

  const effectiveTimeoutMs = Math.max(5_000, timeoutMs ?? 30_000);
  const requestController = new AbortController();
  let timeoutTriggered = false;
  const timeoutId = globalThis.setTimeout(() => {
    timeoutTriggered = true;
    requestController.abort();
  }, effectiveTimeoutMs);

  const forwardAbort = () => {
    requestController.abort();
  };

  if (signal) {
    if (signal.aborted) {
      requestController.abort();
    } else {
      signal.addEventListener("abort", forwardAbort, { once: true });
    }
  }

  let response: Response;
  try {
    logInfo("service.hint", "Sending assistant request", {
      baseUrl,
      language,
      hasImage: Boolean(imageBase64Png),
      timeoutMs: effectiveTimeoutMs,
    });
    response = await fetch(joinBaseUrl(baseUrl, "/api/v1/hint"), {
      method: "POST",
      headers: {
        "X-License-Key": trimmedKey,
        ...(await getDeviceHeaders()),
      },
      body: formData,
      signal: requestController.signal,
    });
  } catch (error) {
    if (timeoutTriggered) {
      logWarn("service.hint", "Assistant request timed out", {
        timeoutMs: effectiveTimeoutMs,
      });
      throw new Error(
        `Сервис не ответил за ${Math.round(effectiveTimeoutMs / 1000)} сек. Попробуйте еще раз.`,
      );
    }
    if (signal?.aborted) {
      logInfo("service.hint", "Assistant request aborted by signal");
      throw new Error("Запрос был отменен.");
    }
    logWarn("service.hint", "Assistant request failed with network error", error);
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
    signal?.removeEventListener("abort", forwardAbort);
  }

  if (!response.ok) {
    const detail = await readErrorMessage(response);
    logWarn("service.hint", "Assistant request failed with HTTP status", {
      status: response.status,
      detail,
    });
    throw new Error(detail);
  }

  logInfo("service.hint", "Assistant request completed successfully", {
    status: response.status,
  });
  return (await response.json()) as ProxyHintResponse;
}

export function buildLiveSttWebSocketUrl(params: {
  licenseKey: string;
  lang: string;
  deviceFingerprint?: string;
  deviceName?: string;
  baseUrl?: string;
}): string {
  const wsUrl = toLiveSttWebSocketUrl(params.baseUrl?.trim() || PROXY_BASE_URL);
  wsUrl.searchParams.set("licenseKey", params.licenseKey.trim());
  wsUrl.searchParams.set("lang", (params.lang || "ru").trim().toLowerCase());
  if (params.deviceFingerprint?.trim()) {
    wsUrl.searchParams.set("deviceFingerprint", params.deviceFingerprint.trim());
  }
  if (params.deviceName?.trim()) {
    wsUrl.searchParams.set("deviceName", params.deviceName.trim());
  }
  return wsUrl.toString();
}

export async function requestLiveSttTranscribeLatest(params: {
  licenseKey: string;
  streamId: string;
  language: PrimaryLanguage;
  seconds?: number;
  saveAudioDebug?: boolean;
  debugTag?: string;
}): Promise<LiveSttTranscribeLatestResponse> {
  const trimmedKey = params.licenseKey.trim();
  if (!trimmedKey) {
    throw new Error("Введите лицензионный ключ.");
  }
  const streamId = params.streamId.trim();
  if (!streamId) {
    throw new Error("Live STT stream не инициализирован.");
  }

  const response = await fetch(joinBaseUrl(PROXY_BASE_URL, "/api/v2/stt/live/transcribe-latest"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-License-Key": trimmedKey,
      ...(await getDeviceHeaders()),
    },
    body: JSON.stringify({
      streamId,
      lang: toProxyLanguage(params.language),
      seconds: typeof params.seconds === "number" ? Math.max(1, Math.round(params.seconds)) : 30,
      saveAudioDebug: Boolean(params.saveAudioDebug),
      debugTag: params.debugTag?.trim() || undefined,
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as LiveSttTranscribeLatestResponse;
}

export async function submitSupportReport(params: {
  licenseKey: string;
  report: string;
  appVersion: string;
  category?: string;
}): Promise<SupportReportResponse> {
  const trimmedKey = params.licenseKey.trim();
  if (!trimmedKey) {
    throw new Error("Введите лицензионный ключ перед отправкой отчета.");
  }
  if (!params.report.trim()) {
    throw new Error("Отчет пустой.");
  }

  const response = await fetch(joinBaseUrl(PROXY_BASE_URL, "/api/v2/support/reports"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-License-Key": trimmedKey,
      ...(await getDeviceHeaders()),
    },
    body: JSON.stringify({
      appVersion: params.appVersion,
      category: params.category ?? "desktop",
      report: params.report,
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as SupportReportResponse;
}

export async function submitAiFeedback(params: {
  licenseKey: string;
  rating: AiFeedbackRating;
  reason?: string;
  hintId?: string | null;
  intentMode?: string | null;
  taskType?: string | null;
  hadScreenshot?: boolean;
  question?: string;
  response?: string;
  appVersion: string;
}): Promise<AiFeedbackResponse> {
  const trimmedKey = params.licenseKey.trim();
  if (!trimmedKey) {
    throw new Error("Введите лицензионный ключ перед отправкой отзыва.");
  }

  const response = await fetch(joinBaseUrl(PROXY_BASE_URL, "/api/v2/support/отзыва"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-License-Key": trimmedKey,
      ...(await getDeviceHeaders()),
    },
    body: JSON.stringify({
      hintId: params.hintId ?? null,
      rating: params.rating,
      reason: params.reason ?? null,
      intentMode: params.intentMode ?? null,
      taskType: params.taskType ?? null,
      hadScreenshot: params.hadScreenshot ?? false,
      question: params.question ?? "",
      response: params.response ?? "",
      appVersion: params.appVersion,
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as AiFeedbackResponse;
}

export async function getServiceStatus(): Promise<ProxyServiceStatus> {
  const response = await fetch(joinBaseUrl(PROXY_BASE_URL, "/api/v2/status"));

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as ProxyServiceStatus;
}

export async function submitTelemetryEvent(params: {
  licenseKey?: string;
  eventType: string;
  severity: TelemetrySeverity;
  appVersion: string;
  os?: string;
  deviceName?: string;
  message?: string;
  payload?: string | Record<string, unknown> | null;
}): Promise<TelemetryEventResponse> {
  const trimmedKey = params.licenseKey?.trim() ?? "";
  const payload =
    typeof params.payload === "string"
      ? params.payload
      : params.payload
        ? JSON.stringify(params.payload)
        : null;

  const response = await fetch(joinBaseUrl(PROXY_BASE_URL, "/api/v2/telemetry/events"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(trimmedKey ? { "X-License-Key": trimmedKey } : {}),
      ...(await getDeviceHeaders()),
    },
    body: JSON.stringify({
      eventType: params.eventType,
      severity: params.severity,
      appVersion: params.appVersion,
      os: params.os ?? getClientOsLabel(),
      deviceName: params.deviceName ?? null,
      message: params.message ?? null,
      payload,
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as TelemetryEventResponse;
}

export function formatProxyHintResponse(
  response: ProxyHintResponse,
  options: { expectedIntentMode?: string | null } = {},
): string {
  const compactOutput = truncateText(response.output?.trim() ?? "", MAX_OUTPUT_CHARS);
  const compactCode = truncateCode(response.code ?? "");
  const shouldHideNextSteps = options.expectedIntentMode === "THEORY";

  const sections = [
    compactOutput,
    formatNamedList("Код", compactCode ? [compactCode] : []),
    formatNamedList("Чек-лист", response.checklist ?? []),
    formatNamedList("Уточняющие вопросы", response.questions ?? []),
    formatNamedList("Следующие шаги", shouldHideNextSteps ? [] : (response.nextSteps ?? [])),
  ].filter(Boolean);

  return sections.join("\n\n").trim();
}

function formatNamedList(title: string, items: string[]): string {
  const normalized = items
    .map((item) => truncateText(item.trim(), MAX_LIST_ITEM_CHARS))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
  if (normalized.length === 0) {
    return "";
  }

  if (title === "Код" && normalized.length === 1) {
    return `${title}:\n${normalized[0]}`;
  }

  return `${title}:\n${normalized.map((item) => `- ${item}`).join("\n")}`;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars).trimEnd()}…`;
}

function truncateCode(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const lines = trimmed.split(/\r?\n/);
  const limitedLines = lines.slice(0, MAX_CODE_LINES).join("\n");
  const limitedText = truncateText(limitedLines, MAX_CODE_CHARS);

  if (lines.length > MAX_CODE_LINES || trimmed.length > MAX_CODE_CHARS) {
    return `${limitedText}\n...сокращено для удобства чтения`;
  }
  return limitedText;
}

function toProxyLanguage(language: PrimaryLanguage): string {
  return language.split("-")[0]?.toLowerCase() || "ru";
}

function getClientOsLabel(): string {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  const platform = navigator.platform || "unknown";
  const userAgent = navigator.userAgent || "";
  return `${platform} ${userAgent}`.trim();
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

async function readErrorMessage(response: Response): Promise<string> {
  const raw = await response.text();
  const fallback = `Ошибка сервера (${response.status})`;

  if (!raw.trim()) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as {
      message?: string;
      error?: string | { message?: string; code?: string };
    };
    const friendly = toFriendlyProxyError(parsed, response.status);
    if (friendly) {
      return friendly;
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message;
    }
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error;
    }
    if (
      parsed.error &&
      typeof parsed.error === "object" &&
      typeof parsed.error.message === "string" &&
      parsed.error.message.trim()
    ) {
      return parsed.error.message;
    }
  } catch {
    return raw;
  }

  return fallback;
}

function toFriendlyProxyError(
  parsed: {
    message?: string;
    error?: string | { message?: string; code?: string };
  },
  status: number,
): string | null {
  const code = typeof parsed.error === "object" ? parsed.error.code ?? "" : "";
  const message =
    typeof parsed.message === "string"
      ? parsed.message
      : typeof parsed.error === "string"
        ? parsed.error
        : parsed.error?.message ?? "";
  const normalized = `${code} ${message}`.toLowerCase();

  if (normalized.includes("http 401 from openai") || normalized.includes("invalid_api_key")) {
    return "Сервис временно недоступен: обработка ответов не настроена.";
  }
  if (status === 502 && normalized.includes("openai")) {
    return "Сервис временно недоступен: не удалось получить ответ.";
  }
  return null;
}

function normalizeValidationError(error: unknown): string {
  if (error instanceof TypeError) {
    return "Не удалось подключиться к сервису. Проверьте интернет и повторите попытку.";
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "Не удалось проверить лицензию.";
}
