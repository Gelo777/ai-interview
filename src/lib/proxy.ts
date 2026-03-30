import { resolveLlmEndpointConfig } from "@/lib/llm";
import type { LlmBaseUrlPreset, PrimaryLanguage } from "@/lib/types";

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

function joinBaseUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function getProxyBaseUrl(
  baseUrlPreset: LlmBaseUrlPreset,
  customBaseUrl: string,
): string {
  return resolveLlmEndpointConfig(baseUrlPreset, customBaseUrl).baseUrl;
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

  const response = await fetch(joinBaseUrl(baseUrl, "/api/v1/license/status"), {
    headers: {
      "X-License-Key": trimmedKey,
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
}): Promise<ProxyHintResponse> {
  const { licenseKey, baseUrlPreset, customBaseUrl, question, language, imageBase64Png } =
    params;
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

  const response = await fetch(joinBaseUrl(baseUrl, "/api/v1/hint"), {
    method: "POST",
    headers: {
      "X-License-Key": trimmedKey,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

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

function normalizeValidationError(error: unknown): string {
  if (error instanceof TypeError) {
    return "Не удалось подключиться к прокси. Проверьте адрес сервера, сеть и CORS.";
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "Не удалось проверить лицензию.";
}
