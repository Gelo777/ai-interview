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

/**
 * Typed error thrown by product endpoints. Carries the server error `code`
 * and `requestId` from the `{ "error": { code, message, requestId } }` envelope
 * so callers (overlay, cabinet store) can branch on license/auth codes.
 * Extends `Error`, so existing call-sites reading `error.message` keep working.
 */
export class ProxyApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly requestId: string | null;

  constructor(
    message: string,
    status: number,
    code: string | null,
    requestId: string | null,
  ) {
    super(message);
    this.name = "ProxyApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/**
 * Single source of truth for turning backend license/auth error codes into
 * Russian user-facing text. Covers both the locked impl-contract codes
 * (AUTH_TOKEN_*, LICENSE_*, RATE_LIMITED, ACTIVATION_FINGERPRINT_REQUIRED) and
 * the near-term design codes (TOKEN_*, LICENSE_NOT_FOUND, PAYMENT_REQUIRED).
 */
export const LICENSE_ERROR_MESSAGES: Record<string, string> = {
  AUTH_TOKEN_REQUIRED:
    "Активация недействительна. Откройте «Кабинет» и активируйте ключ заново.",
  AUTH_TOKEN_INVALID:
    "Активация недействительна. Откройте «Кабинет» и активируйте ключ заново.",
  AUTH_TOKEN_REVOKED:
    "Активация отозвана. Откройте «Кабинет» и активируйте ключ заново.",
  AUTH_FINGERPRINT_REQUIRED:
    "Не удалось определить устройство. Перезапустите приложение и попробуйте снова.",
  ACTIVATION_FINGERPRINT_REQUIRED:
    "Не удалось определить устройство. Перезапустите приложение и попробуйте снова.",
  LICENSE_DEVICE_FINGERPRINT_REQUIRED:
    "Не удалось определить устройство. Перезапустите приложение и попробуйте снова.",
  TOKEN_EXPIRED: "Сеанс устарел, обновляем активацию...",
  TOKEN_INVALID:
    "Активация недействительна. Откройте «Кабинет» и активируйте ключ заново.",
  LICENSE_EXPIRED:
    "Срок действия лицензии истёк. Продлить можно в разделе «Кабинет».",
  LICENSE_DEVICE_MISMATCH:
    "Ключ привязан к другому устройству. Отвяжите его там или напишите в поддержку.",
  LICENSE_NOT_FOUND: "Ключ не найден. Проверьте ключ из бота.",
  LICENSE_INVALID: "Ключ не найден. Проверьте ключ из бота.",
  LICENSE_DISABLED: "Лицензия отключена. Напишите в поддержку.",
  PAYMENT_REQUIRED:
    "Требуется оплата или исчерпан лимит тарифа. Откройте «Кабинет».",
  RATE_LIMITED: "Слишком много запросов. Подождите немного и повторите.",
};

/**
 * In-memory cache of the license access token. The token lives canonically in
 * the OS keychain (Rust `secret_store`); we warm this cache once at startup and
 * after activation so every request does not hit the keychain. The token is
 * NEVER placed into zustand persist.
 */
let cachedAccessToken: string | null = null;

export function setCachedAccessToken(token: string | null): void {
  const trimmed = token?.trim() ?? "";
  cachedAccessToken = trimmed ? trimmed : null;
}

export function getCachedAccessToken(): string | null {
  return cachedAccessToken;
}

/**
 * Reads the license access token from the keychain (Tauri only) and warms the
 * module cache. Safe to call outside Tauri (no-op) and safe to call repeatedly.
 */
export async function warmLicenseAccessTokenCache(): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return;
  }
  try {
    const { getLicenseAccessToken } = await import("@/lib/tauri");
    const token = (await getLicenseAccessToken())?.trim() ?? "";
    setCachedAccessToken(token || null);
  } catch (error) {
    logWarn("license.token", "Failed to warm license access token cache", error);
  }
}

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
  const normalizedCustom = customBaseUrl.trim();
  if (normalizedCustom) {
    return normalizedCustom.replace(/\/+$/, "");
  }
  return PROXY_BASE_URL.replace(/\/+$/, "");
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

/**
 * Builds auth headers for product endpoints. During the transition the backend
 * accepts either `Authorization: Bearer <token>` (new) OR `X-License-Key`
 * (legacy). We prefer the token when the module cache has one, otherwise fall
 * back to the license key. Device headers are always attached.
 */
export async function getAuthHeaders(
  licenseKey?: string,
): Promise<Record<string, string>> {
  const deviceHeaders = await getDeviceHeaders();
  const token = getCachedAccessToken();
  if (token) {
    return {
      Authorization: `Bearer ${token}`,
      ...deviceHeaders,
    };
  }
  const key = (licenseKey ?? "").trim();
  return {
    ...(key ? { "X-License-Key": key } : {}),
    ...deviceHeaders,
  };
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
      ...(await getAuthHeaders(trimmedKey)),
    },
  });

  if (!response.ok) {
    throw await readApiError(response);
  }

  return (await response.json()) as ProxyLicenseStatus;
}

export interface LicenseUsageToday {
  hints: number;
  snapshots: number;
  llmTokens: number;
}

export interface LicenseLimits {
  maxHintsPerDay: number;
  maxSnapshotsPerDay: number;
  maxAudioSecondsPerHint: number;
}

export interface LicenseDeviceInfo {
  bound: boolean;
  name: string | null;
  activatedAt: string | null;
  lastSeenAt: string | null;
}

export interface LicenseStatusFull {
  status: string;
  plan: string | null;
  expiresAt: string | null;
  usageToday: LicenseUsageToday | null;
  limits: LicenseLimits | null;
  device: LicenseDeviceInfo | null;
}

function toNumberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeLicenseStatusFull(raw: Record<string, unknown>): LicenseStatusFull {
  const usageRaw = raw.usageToday;
  const limitsRaw = raw.limits;
  const deviceRaw = raw.device;

  const usageToday =
    usageRaw && typeof usageRaw === "object"
      ? {
          hints: toNumberOrZero((usageRaw as Record<string, unknown>).hints),
          snapshots: toNumberOrZero((usageRaw as Record<string, unknown>).snapshots),
          llmTokens: toNumberOrZero((usageRaw as Record<string, unknown>).llmTokens),
        }
      : null;

  const limits =
    limitsRaw && typeof limitsRaw === "object"
      ? {
          maxHintsPerDay: toNumberOrZero(
            (limitsRaw as Record<string, unknown>).maxHintsPerDay,
          ),
          maxSnapshotsPerDay: toNumberOrZero(
            (limitsRaw as Record<string, unknown>).maxSnapshotsPerDay,
          ),
          maxAudioSecondsPerHint: toNumberOrZero(
            (limitsRaw as Record<string, unknown>).maxAudioSecondsPerHint,
          ),
        }
      : null;

  const device =
    deviceRaw && typeof deviceRaw === "object"
      ? {
          bound: Boolean((deviceRaw as Record<string, unknown>).bound),
          name: toStringOrNull((deviceRaw as Record<string, unknown>).name),
          activatedAt: toStringOrNull(
            (deviceRaw as Record<string, unknown>).activatedAt,
          ),
          lastSeenAt: toStringOrNull(
            (deviceRaw as Record<string, unknown>).lastSeenAt,
          ),
        }
      : null;

  return {
    status: typeof raw.status === "string" ? raw.status : "UNKNOWN",
    plan: toStringOrNull(raw.plan),
    expiresAt: toStringOrNull(raw.expiresAt),
    usageToday,
    limits,
    device,
  };
}

/**
 * GET /api/v1/license/status with typed errors and the full response body
 * (status, plan, expiresAt, usageToday, limits, device). Used by the license
 * store for periodic revalidation. Sends Bearer token when available, else the
 * license key, plus device headers.
 */
export async function fetchLicenseStatusFull(
  licenseKey?: string,
): Promise<LicenseStatusFull> {
  const response = await fetch(joinBaseUrl(PROXY_BASE_URL, "/api/v1/license/status"), {
    headers: {
      ...(await getAuthHeaders(licenseKey)),
    },
  });

  if (!response.ok) {
    throw await readApiError(response);
  }

  const raw = (await response.json()) as Record<string, unknown>;
  return normalizeLicenseStatusFull(raw);
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
  /** Pre-interview background: topic/stack plus text from the context files. */
  context?: string;
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
    context,
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

  const trimmedContext = context?.trim();
  if (trimmedContext) {
    formData.set("context", trimmedContext);
  }

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
        ...(await getAuthHeaders(trimmedKey)),
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
    const apiError = await readApiError(response);
    logWarn("service.hint", "Assistant request failed with HTTP status", {
      status: response.status,
      detail: apiError.message,
      code: apiError.code,
    });
    throw apiError;
  }

  logInfo("service.hint", "Assistant request completed successfully", {
    status: response.status,
  });
  return (await response.json()) as ProxyHintResponse;
}

export interface LiveSttWebSocketTicket {
  ticket: string;
  expiresAt: string;
}

export async function requestLiveSttWebSocketTicket(params: {
  licenseKey: string;
  baseUrl?: string;
}): Promise<LiveSttWebSocketTicket> {
  const licenseKey = params.licenseKey.trim();
  if (!licenseKey) {
    throw new Error("Введите лицензионный ключ.");
  }

  const baseUrl = params.baseUrl?.trim() || PROXY_BASE_URL;
  const response = await fetch(joinBaseUrl(baseUrl, "/api/v1/stt/live/ticket"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await getAuthHeaders(licenseKey)),
    },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw await readApiError(response);
  }

  const payload = (await response.json()) as Partial<LiveSttWebSocketTicket>;
  if (!payload.ticket?.trim() || !payload.expiresAt?.trim()) {
    throw new Error("Сервис вернул некорректный билет для live STT.");
  }
  return {
    ticket: payload.ticket.trim(),
    expiresAt: payload.expiresAt.trim(),
  };
}

export function buildLiveSttWebSocketUrl(params: {
  ticket: string;
  lang: string;
  deviceFingerprint?: string;
  deviceName?: string;
  baseUrl?: string;
}): string {
  const wsUrl = toLiveSttWebSocketUrl(params.baseUrl?.trim() || PROXY_BASE_URL);
  const ticket = params.ticket.trim();
  if (!ticket) {
    throw new Error("Билет для live STT отсутствует.");
  }
  wsUrl.searchParams.set("ticket", ticket);
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
  baseUrl?: string;
  seconds?: number;
  saveAudioDebug?: boolean;
  debugTag?: string;
  consumeAfterRead?: boolean;
  retainTailSeconds?: number;
  contextHint?: string;
}): Promise<LiveSttTranscribeLatestResponse> {
  const trimmedKey = params.licenseKey.trim();
  if (!trimmedKey) {
    throw new Error("Введите лицензионный ключ.");
  }
  const streamId = params.streamId.trim();
  if (!streamId) {
    throw new Error("Live STT stream не инициализирован.");
  }

  const baseUrl = params.baseUrl?.trim() || PROXY_BASE_URL;
  const response = await fetch(joinBaseUrl(baseUrl, "/api/v2/stt/live/transcribe-latest"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await getAuthHeaders(trimmedKey)),
    },
    body: JSON.stringify({
      streamId,
      lang: toProxyLanguage(params.language),
      seconds: typeof params.seconds === "number" ? Math.max(1, Math.round(params.seconds)) : 12,
      saveAudioDebug: Boolean(params.saveAudioDebug),
      debugTag: params.debugTag?.trim() || undefined,
      consumeAfterRead: Boolean(params.consumeAfterRead),
      retainTailSeconds:
        typeof params.retainTailSeconds === "number"
          ? Math.max(0, Math.round(params.retainTailSeconds))
          : undefined,
      contextHint: params.contextHint?.trim() || undefined,
    }),
  });

  if (!response.ok) {
    throw await readApiError(response);
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
      ...(await getAuthHeaders(trimmedKey)),
    },
    body: JSON.stringify({
      appVersion: params.appVersion,
      category: params.category ?? "desktop",
      report: params.report,
    }),
  });

  if (!response.ok) {
    throw await readApiError(response);
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

  const response = await fetch(joinBaseUrl(PROXY_BASE_URL, "/api/v2/support/feedback"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await getAuthHeaders(trimmedKey)),
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
    throw await readApiError(response);
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
      ...(await getAuthHeaders(trimmedKey)),
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
    throw await readApiError(response);
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

interface ApiErrorEnvelope {
  message?: unknown;
  code?: unknown;
  error?:
    | string
    | {
        code?: unknown;
        message?: unknown;
        requestId?: unknown;
      };
}

/**
 * Parses the `{ "error": { code, message, requestId } }` envelope (and legacy
 * shapes) into a typed `ProxyApiError`. The message is resolved to friendly
 * Russian text via the code map / OpenAI special cases when possible.
 */
export async function readApiError(response: Response): Promise<ProxyApiError> {
  const raw = await response.text();
  const status = response.status;
  let code: string | null = null;
  let requestId: string | null = null;
  let serverMessage = "";

  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as ApiErrorEnvelope;
      const errorField = parsed.error;
      if (errorField && typeof errorField === "object") {
        if (typeof errorField.code === "string") {
          code = errorField.code;
        }
        if (typeof errorField.requestId === "string") {
          requestId = errorField.requestId;
        }
        if (typeof errorField.message === "string") {
          serverMessage = errorField.message;
        }
      } else if (typeof errorField === "string") {
        serverMessage = errorField;
      }
      if (!serverMessage && typeof parsed.message === "string") {
        serverMessage = parsed.message;
      }
      if (!code && typeof parsed.code === "string") {
        code = parsed.code;
      }
    } catch {
      serverMessage = raw;
    }
  }

  const message = resolveFriendlyErrorMessage(code, serverMessage, status);
  return new ProxyApiError(message, status, code, requestId);
}

function resolveFriendlyErrorMessage(
  code: string | null,
  serverMessage: string,
  status: number,
): string {
  const normalizedCode = code?.trim().toUpperCase() ?? "";
  if (normalizedCode && LICENSE_ERROR_MESSAGES[normalizedCode]) {
    return LICENSE_ERROR_MESSAGES[normalizedCode];
  }
  if (status === 402) {
    return LICENSE_ERROR_MESSAGES.PAYMENT_REQUIRED;
  }
  const openAiFriendly = toFriendlyProxyError(
    { error: { code: normalizedCode, message: serverMessage } },
    status,
  );
  if (openAiFriendly) {
    return openAiFriendly;
  }
  if (serverMessage.trim()) {
    return serverMessage.trim();
  }
  return `Ошибка сервера (${status})`;
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
