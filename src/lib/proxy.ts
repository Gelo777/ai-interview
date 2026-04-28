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

export interface LicenseValidationResult {
  valid: boolean;
  detail: string | null;
  status: ProxyLicenseStatus | null;
}

const MAX_OUTPUT_CHARS = 1600;
const MAX_LIST_ITEMS = 2;
const MAX_LIST_ITEM_CHARS = 260;
const MAX_CODE_LINES = 48;
const MAX_CODE_CHARS = 2800;
export const HARDCODED_PROXY_BASE_URL = "http://85.198.82.221:8080";

function joinBaseUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function getProxyBaseUrl(
  baseUrlPreset: LlmBaseUrlPreset,
  customBaseUrl: string,
): string {
  void baseUrlPreset;
  void customBaseUrl;
  return HARDCODED_PROXY_BASE_URL;
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
    throw new Error("Укажите адрес прокси.");
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
    throw new Error("Укажите адрес прокси.");
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
    logInfo("proxy.hint", "Sending hint request", {
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
      logWarn("proxy.hint", "Hint request timed out", {
        timeoutMs: effectiveTimeoutMs,
      });
      throw new Error(
        `Прокси не ответил за ${Math.round(effectiveTimeoutMs / 1000)} сек. Попробуйте еще раз.`,
      );
    }
    if (signal?.aborted) {
      logInfo("proxy.hint", "Hint request aborted by signal");
      throw new Error("Запрос был отменен.");
    }
    logWarn("proxy.hint", "Hint request failed with network error", error);
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
    signal?.removeEventListener("abort", forwardAbort);
  }

  if (!response.ok) {
    const detail = await readErrorMessage(response);
    logWarn("proxy.hint", "Hint request failed with HTTP status", {
      status: response.status,
      detail,
    });
    throw new Error(detail);
  }

  logInfo("proxy.hint", "Hint request completed successfully", {
    status: response.status,
  });
  return (await response.json()) as ProxyHintResponse;
}

export function formatProxyHintResponse(response: ProxyHintResponse): string {
  const compactOutput = truncateText(response.output?.trim() ?? "", MAX_OUTPUT_CHARS);
  const compactCode = truncateCode(response.code ?? "");

  const sections = [
    compactOutput,
    formatNamedList("Код", compactCode ? [compactCode] : []),
    formatNamedList("Чек-лист", response.checklist ?? []),
    formatNamedList("Уточняющие вопросы", response.questions ?? []),
    formatNamedList("Следующие шаги", response.nextSteps ?? []),
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
    return "AI-сервис временно недоступен: на сервере нужно обновить OpenAI API key.";
  }
  if (status === 502 && normalized.includes("openai")) {
    return "AI-сервис временно недоступен: proxy не смог получить ответ от OpenAI.";
  }
  return null;
}

function normalizeValidationError(error: unknown): string {
  if (error instanceof TypeError) {
    return "Не удалось подключиться к прокси. Проверьте адрес сервера, сеть и CORS.";
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "Не удалось проверить лицензию.";
}
