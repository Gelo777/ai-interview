import type {
  CacheSupport,
  LlmApiDialect,
  LlmBaseUrlPreset,
  ModelInfo,
  ModelLifecycleStatus,
  MultimodalSupport,
  Provider,
} from "./types";

interface BuiltinBaseUrlPreset {
  id: Exclude<LlmBaseUrlPreset, "custom">;
  label: string;
  provider: Provider;
  baseUrl: string;
  dialect: LlmApiDialect;
}

export interface LlmEndpointConfig {
  preset: LlmBaseUrlPreset;
  provider: Provider;
  baseUrl: string;
  dialect: LlmApiDialect;
  editableBaseUrl: boolean;
}

export const BUILTIN_BASE_URL_PRESETS: BuiltinBaseUrlPreset[] = [
  {
    id: "gemini",
    label: "Gemini",
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    dialect: "gemini",
  },
  {
    id: "openai",
    label: "OpenAI (ChatGPT)",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    dialect: "openai",
  },
  {
    id: "claude",
    label: "Claude",
    provider: "claude",
    baseUrl: "https://api.anthropic.com/v1",
    dialect: "anthropic",
  },
  {
    id: "neuroapi",
    label: "NeuroAPI",
    provider: "neuroapi",
    baseUrl: "https://neuroapi.host/v1",
    dialect: "openai",
  },
];

export const BASE_URL_PRESET_OPTIONS: Array<{
  value: LlmBaseUrlPreset;
  label: string;
}> = [
  ...BUILTIN_BASE_URL_PRESETS.map((preset) => ({
    value: preset.id,
    label: `${preset.label} (${preset.baseUrl})`,
  })),
  { value: "custom", label: "Custom base URL" },
];

const CACHE_CAPABLE_GEMINI_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-pro",
  "gemini-1.5-flash",
];

const MULTIMODAL_GEMINI_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-pro",
  "gemini-1.5-flash",
];

const LIFECYCLE_FALLBACK_OVERRIDES: Array<{
  match: string;
  status: ModelLifecycleStatus;
  replacementModelId?: string;
  note?: string;
}> = [
  {
    match: "gemini-pro",
    status: "sunset",
    replacementModelId: "gemini-2.5-pro",
    note: "Legacy Gemini Pro family is no longer recommended for new sessions.",
  },
  {
    match: "gemini-1.5-pro",
    status: "deprecated",
    replacementModelId: "gemini-2.5-pro",
    note: "Move to Gemini 2.5 Pro for longer support window.",
  },
  {
    match: "gemini-1.5-flash",
    status: "deprecated",
    replacementModelId: "gemini-2.5-flash",
    note: "Move to Gemini 2.5 Flash for longer support window.",
  },
];

export interface StreamCallbacks {
  onToken: (text: string) => void;
  onFirstToken: (latencyMs: number) => void;
  onDone: (fullText: string, totalLatencyMs: number) => void;
  onError: (error: Error) => void;
}

export interface StreamChatParams {
  apiKey: string;
  modelId: string;
  endpoint: LlmEndpointConfig;
  systemPrompt: string;
  userPrompt: string;
  imageBase64Png?: string;
  maxTokens: number;
  callbacks: StreamCallbacks;
  signal?: AbortSignal;
}

export interface CacheProbeParams {
  apiKey: string;
  modelId: string;
  endpoint: LlmEndpointConfig;
}

export interface CacheProbeResult {
  support: CacheSupport;
  cachedTokens: number;
  promptTokens: number | null;
}

interface GeminiModelsResponse {
  models?: GeminiApiModel[];
}

interface GeminiApiModel {
  name?: string;
  displayName?: string;
  state?: string;
  supportedGenerationMethods?: string[];
}

interface OpenAiModelsResponse {
  data?: OpenAiModelEntry[];
  models?: OpenAiModelEntry[];
}

interface OpenAiModelEntry {
  id?: string;
  name?: string;
  display_name?: string;
}

interface AnthropicModelsResponse {
  data?: AnthropicModelEntry[];
}

interface AnthropicModelEntry {
  id?: string;
  display_name?: string;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function inferCustomDialect(baseUrl: string): LlmApiDialect {
  const normalized = baseUrl.toLowerCase();
  if (normalized.includes("generativelanguage.googleapis.com")) {
    return "gemini";
  }
  if (normalized.includes("anthropic.com")) {
    return "anthropic";
  }
  return "openai";
}

function getBuiltinPreset(id: Exclude<LlmBaseUrlPreset, "custom">): BuiltinBaseUrlPreset {
  return (
    BUILTIN_BASE_URL_PRESETS.find((preset) => preset.id === id) ??
    BUILTIN_BASE_URL_PRESETS[0]
  );
}

export function isKnownBaseUrlPreset(value: unknown): value is LlmBaseUrlPreset {
  return (
    value === "gemini" ||
    value === "openai" ||
    value === "claude" ||
    value === "neuroapi" ||
    value === "custom"
  );
}

export function providerFromBaseUrlPreset(preset: LlmBaseUrlPreset): Provider {
  return preset;
}

export function providerLabel(provider: Provider): string {
  switch (provider) {
    case "gemini":
      return "Gemini";
    case "openai":
      return "OpenAI";
    case "claude":
      return "Claude";
    case "neuroapi":
      return "NeuroAPI";
    case "custom":
      return "Custom";
    default:
      return provider;
  }
}

export function resolveLlmEndpointConfig(
  preset: LlmBaseUrlPreset,
  customBaseUrl: string,
): LlmEndpointConfig {
  if (preset === "custom") {
    const normalizedCustom = normalizeBaseUrl(customBaseUrl);
    return {
      preset,
      provider: "custom",
      baseUrl: normalizedCustom,
      dialect: inferCustomDialect(normalizedCustom),
      editableBaseUrl: true,
    };
  }

  const builtin = getBuiltinPreset(preset);
  return {
    preset,
    provider: builtin.provider,
    baseUrl: builtin.baseUrl,
    dialect: builtin.dialect,
    editableBaseUrl: false,
  };
}

export function apiKeyPlaceholder(endpoint: LlmEndpointConfig): string {
  if (endpoint.dialect === "gemini") {
    return "AIza...";
  }
  if (endpoint.dialect === "anthropic") {
    return "sk-ant-...";
  }
  return "sk-...";
}

function joinBaseUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

function buildCacheProbePrompt(): string {
  const repeated = new Array(2200).fill("cache_probe_token").join(" ");
  return `${repeated}\nReply with exactly: ok`;
}

function extractOpenAiLikeCacheMetrics(parsed: unknown): {
  cachedTokens: number;
  promptTokens: number | null;
} {
  if (!parsed || typeof parsed !== "object") {
    return { cachedTokens: 0, promptTokens: null };
  }

  const payload = parsed as {
    usage?: {
      prompt_tokens?: number;
      input_tokens?: number;
      prompt_tokens_details?: {
        cached_tokens?: number;
      };
      input_tokens_details?: {
        cached_tokens?: number;
      };
      cache_read_input_tokens?: number;
    };
  };

  const usage = payload.usage;
  const promptTokens =
    typeof usage?.prompt_tokens === "number"
      ? usage.prompt_tokens
      : typeof usage?.input_tokens === "number"
        ? usage.input_tokens
        : null;

  const candidates = [
    usage?.prompt_tokens_details?.cached_tokens,
    usage?.input_tokens_details?.cached_tokens,
    usage?.cache_read_input_tokens,
  ];
  const cachedTokens = candidates.find((value) => typeof value === "number");

  return {
    cachedTokens: typeof cachedTokens === "number" ? Math.max(0, cachedTokens) : 0,
    promptTokens,
  };
}

function detectGeminiCacheSupport(modelId: string): CacheSupport {
  if (CACHE_CAPABLE_GEMINI_MODELS.some((m) => modelId.includes(m))) {
    return "supported";
  }
  return "not_supported";
}

function detectOpenAiLikeCacheSupport(modelId: string): CacheSupport {
  const id = modelId.toLowerCase();

  if (id.includes("gemini")) {
    return detectGeminiCacheSupport(id);
  }

  if (id.includes("claude")) {
    return "supported";
  }

  const openAiPromptCachingHints = [
    "gpt-5",
    "gpt-4.1",
    "gpt-4o",
    "o1",
    "o3",
    "o4",
  ];

  if (openAiPromptCachingHints.some((hint) => id.includes(hint))) {
    return "supported";
  }

  return "not_supported";
}

function detectGeminiMultimodalSupport(modelId: string): MultimodalSupport {
  if (MULTIMODAL_GEMINI_MODELS.some((m) => modelId.includes(m))) {
    return "supported";
  }
  return "not_supported";
}

function detectLifecycle(
  modelId: string,
  modelState?: string,
): {
  lifecycle: ModelLifecycleStatus;
  replacementModelId: string | null;
  lifecycleNote: string | null;
} {
  const normalizedState = modelState?.trim().toUpperCase();
  if (normalizedState) {
    if (normalizedState.includes("DEPRECATED")) {
      const replacement = findLifecycleFallback(modelId)?.replacementModelId ?? null;
      return {
        lifecycle: "deprecated",
        replacementModelId: replacement,
        lifecycleNote: "This model is marked as deprecated by the provider.",
      };
    }
    if (
      normalizedState.includes("SUNSET") ||
      normalizedState.includes("DISCONTINUED") ||
      normalizedState.includes("RETIRED")
    ) {
      const replacement = findLifecycleFallback(modelId)?.replacementModelId ?? null;
      return {
        lifecycle: "sunset",
        replacementModelId: replacement,
        lifecycleNote: "This model is retired and should not be used.",
      };
    }
  }

  const fallback = findLifecycleFallback(modelId);
  if (fallback) {
    return {
      lifecycle: fallback.status,
      replacementModelId: fallback.replacementModelId ?? null,
      lifecycleNote: fallback.note ?? null,
    };
  }

  return {
    lifecycle: "active",
    replacementModelId: null,
    lifecycleNote: null,
  };
}

function findLifecycleFallback(modelId: string) {
  return LIFECYCLE_FALLBACK_OVERRIDES.find((item) => modelId.includes(item.match));
}

function isLikelyMultimodalOpenAiLikeModel(modelId: string): MultimodalSupport {
  const id = modelId.toLowerCase();
  const positiveHints = [
    "gpt-4o",
    "gpt-4.1",
    "gpt-5",
    "o1",
    "o3",
    "o4",
    "claude",
    "gemini",
    "vision",
    "multimodal",
    "vl",
    "llava",
  ];
  if (positiveHints.some((hint) => id.includes(hint))) {
    return "supported";
  }
  return "not_supported";
}

function toOpenAiLikeModelInfo(modelId: string, displayName?: string): ModelInfo {
  return {
    id: modelId,
    name: displayName || modelId,
    remoteCaching: detectOpenAiLikeCacheSupport(modelId),
    multimodalImage: isLikelyMultimodalOpenAiLikeModel(modelId),
    lifecycle: "active",
    replacementModelId: null,
    lifecycleNote: null,
  };
}

function buildAnthropicHeaders(apiKey: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

export async function validateApiKey(
  apiKey: string,
  endpoint: LlmEndpointConfig,
): Promise<boolean> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey || !endpoint.baseUrl) {
    return false;
  }

  try {
    let res: Response;
    if (endpoint.dialect === "gemini") {
      const url = `${joinBaseUrl(endpoint.baseUrl, "/v1beta/models")}?key=${encodeURIComponent(trimmedKey)}&pageSize=1`;
      res = await fetch(url);
    } else if (endpoint.dialect === "anthropic") {
      res = await fetch(joinBaseUrl(endpoint.baseUrl, "/models"), {
        headers: buildAnthropicHeaders(trimmedKey),
      });
    } else {
      res = await fetch(joinBaseUrl(endpoint.baseUrl, "/models"), {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${trimmedKey}`,
        },
      });
    }
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchGeminiModels(
  apiKey: string,
  endpoint: LlmEndpointConfig,
): Promise<ModelInfo[]> {
  const url = `${joinBaseUrl(endpoint.baseUrl, "/v1beta/models")}?key=${encodeURIComponent(apiKey)}&pageSize=100`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch models: ${res.status}`);
  }

  const data = (await res.json()) as GeminiModelsResponse;
  return (data.models ?? [])
    .flatMap((m) => {
      if (
        !m.name?.startsWith("models/gemini") ||
        !m.supportedGenerationMethods?.includes("generateContent")
      ) {
        return [];
      }

      const id = m.name.replace("models/", "");
      const lifecycle = detectLifecycle(id, m.state);
      return [
        {
          id,
          name: m.displayName || id,
          remoteCaching: detectGeminiCacheSupport(id),
          multimodalImage: detectGeminiMultimodalSupport(id),
          lifecycle: lifecycle.lifecycle,
          replacementModelId: lifecycle.replacementModelId,
          lifecycleNote: lifecycle.lifecycleNote,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchOpenAiLikeModels(
  apiKey: string,
  endpoint: LlmEndpointConfig,
): Promise<ModelInfo[]> {
  const res = await fetch(joinBaseUrl(endpoint.baseUrl, "/models"), {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch models: ${res.status}`);
  }

  const data = (await res.json()) as OpenAiModelsResponse;
  const entries = Array.isArray(data.data)
    ? data.data
    : Array.isArray(data.models)
      ? data.models
      : [];

  return entries
    .flatMap((entry) => {
      const id = entry.id?.trim();
      if (!id) {
        return [];
      }
      if (/(embedding|moderation|whisper|tts|transcribe)/i.test(id)) {
        return [];
      }
      return [
        toOpenAiLikeModelInfo(
          id,
          entry.display_name?.trim() || entry.name?.trim() || id,
        ),
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchAnthropicModels(
  apiKey: string,
  endpoint: LlmEndpointConfig,
): Promise<ModelInfo[]> {
  const res = await fetch(joinBaseUrl(endpoint.baseUrl, "/models"), {
    headers: buildAnthropicHeaders(apiKey),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch models: ${res.status}`);
  }

  const data = (await res.json()) as AnthropicModelsResponse;
  const entries = Array.isArray(data.data) ? data.data : [];
  return entries
    .flatMap((entry) => {
      const id = entry.id?.trim();
      if (!id) {
        return [];
      }
      return [
        toOpenAiLikeModelInfo(id, entry.display_name?.trim() || id),
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchModels(
  apiKey: string,
  endpoint: LlmEndpointConfig,
): Promise<ModelInfo[]> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey || !endpoint.baseUrl) {
    return [];
  }

  if (endpoint.dialect === "gemini") {
    return fetchGeminiModels(trimmedKey, endpoint);
  }
  if (endpoint.dialect === "anthropic") {
    return fetchAnthropicModels(trimmedKey, endpoint);
  }
  return fetchOpenAiLikeModels(trimmedKey, endpoint);
}

export async function probeContextCachingSupport(
  params: CacheProbeParams,
): Promise<CacheProbeResult> {
  const { apiKey, modelId, endpoint } = params;
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    throw new Error("API key is required for cache probe.");
  }
  if (!endpoint.baseUrl) {
    throw new Error("Base URL is required for cache probe.");
  }
  if (endpoint.dialect !== "openai") {
    return {
      support: detectGeminiCacheSupport(modelId),
      cachedTokens: 0,
      promptTokens: null,
    };
  }

  const requestBody = {
    model: modelId,
    stream: false,
    temperature: 0,
    max_tokens: 1,
    messages: buildOpenAiMessages(
      "Reply with exactly: ok",
      buildCacheProbePrompt(),
    ),
  };

  const url = joinBaseUrl(endpoint.baseUrl, "/chat/completions");
  let secondResponseMetrics: { cachedTokens: number; promptTokens: number | null } | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${trimmedKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const raw = await response.text();
    if (!response.ok) {
      let details = raw;
      try {
        const parsedError = JSON.parse(raw) as unknown;
        details = extractApiErrorMessage(parsedError) ?? raw;
      } catch {
        // Keep raw body.
      }
      throw new Error(`Cache probe failed (${response.status}): ${details}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Cache probe got non-JSON response from API.");
    }

    if (attempt === 1) {
      secondResponseMetrics = extractOpenAiLikeCacheMetrics(parsed);
    }
  }

  const metrics = secondResponseMetrics ?? { cachedTokens: 0, promptTokens: null };
  return {
    support: metrics.cachedTokens > 0 ? "supported" : "not_supported",
    cachedTokens: metrics.cachedTokens,
    promptTokens: metrics.promptTokens,
  };
}

function parseOpenAiDeltaText(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") {
    return "";
  }
  const payload = parsed as {
    choices?: Array<{
      delta?: {
        content?: string | Array<{ text?: string }>;
      };
      message?: {
        content?: string | Array<{ text?: string }>;
      };
    }>;
  };
  const deltaContent = payload.choices?.[0]?.delta?.content;
  if (typeof deltaContent === "string") {
    return deltaContent;
  }
  if (Array.isArray(deltaContent)) {
    return deltaContent
      .map((item) => (typeof item?.text === "string" ? item.text : ""))
      .join("");
  }

  const fallbackContent = payload.choices?.[0]?.message?.content;
  if (typeof fallbackContent === "string") {
    return fallbackContent;
  }
  if (Array.isArray(fallbackContent)) {
    return fallbackContent
      .map((item) => (typeof item?.text === "string" ? item.text : ""))
      .join("");
  }
  return "";
}

function parseGeminiDeltaText(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") {
    return "";
  }
  const payload = parsed as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

function parseAnthropicDeltaText(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") {
    return "";
  }

  const payload = parsed as {
    type?: string;
    delta?: {
      type?: string;
      text?: string;
    };
    content_block?: {
      type?: string;
      text?: string;
    };
  };

  if (
    payload.type === "content_block_delta" &&
    payload.delta?.type === "text_delta" &&
    typeof payload.delta.text === "string"
  ) {
    return payload.delta.text;
  }
  if (
    payload.type === "content_block_start" &&
    payload.content_block?.type === "text" &&
    typeof payload.content_block.text === "string"
  ) {
    return payload.content_block.text;
  }
  if (typeof payload.delta?.text === "string") {
    return payload.delta.text;
  }
  return "";
}

function parseNonStreamingOpenAiText(parsed: unknown): string {
  const delta = parseOpenAiDeltaText(parsed);
  if (delta) {
    return delta;
  }

  if (!parsed || typeof parsed !== "object") {
    return "";
  }

  const payload = parsed as {
    choices?: Array<{ text?: string }>;
  };
  const text = payload.choices?.[0]?.text;
  return typeof text === "string" ? text : "";
}

function parseNonStreamingAnthropicText(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") {
    return "";
  }

  const payload = parsed as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  return blocks
    .map((item) => (item?.type === "text" && typeof item.text === "string" ? item.text : ""))
    .join("");
}

function parseNonStreamingText(dialect: LlmApiDialect, parsed: unknown): string {
  if (dialect === "gemini") {
    return parseGeminiDeltaText(parsed);
  }
  if (dialect === "anthropic") {
    return parseNonStreamingAnthropicText(parsed);
  }
  return parseNonStreamingOpenAiText(parsed);
}

function extractApiErrorMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const payload = parsed as {
    error?: { message?: string; type?: string; code?: string | number };
    message?: string;
  };

  if (typeof payload.error?.message === "string" && payload.error.message.trim()) {
    const type = typeof payload.error.type === "string" ? payload.error.type : "api_error";
    const code =
      typeof payload.error.code === "string" || typeof payload.error.code === "number"
        ? String(payload.error.code)
        : null;
    return code
      ? `LLM API error (${type}, code ${code}): ${payload.error.message}`
      : `LLM API error (${type}): ${payload.error.message}`;
  }

  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message;
  }

  return null;
}

function parseDeltaText(dialect: LlmApiDialect, parsed: unknown): string {
  if (dialect === "gemini") {
    return parseGeminiDeltaText(parsed);
  }
  if (dialect === "anthropic") {
    return parseAnthropicDeltaText(parsed);
  }
  return parseOpenAiDeltaText(parsed);
}

async function streamFromSseResponse(
  response: Response,
  dialect: LlmApiDialect,
  callbacks: StreamCallbacks,
  startTime: number,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let fullText = "";
  let firstTokenReceived = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line) {
        currentEvent = "";
        continue;
      }
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
        continue;
      }
      if (line.startsWith(":")) {
        continue;
      }
      if (!line.startsWith("data:")) {
        continue;
      }

      const jsonStr = line.slice(5).trim();
      if (!jsonStr || jsonStr === "[DONE]") {
        continue;
      }

      try {
        const parsed = JSON.parse(jsonStr);
        const text = parseDeltaText(dialect, parsed);
        if (!text) {
          continue;
        }
        if (!firstTokenReceived) {
          firstTokenReceived = true;
          callbacks.onFirstToken(performance.now() - startTime);
        }
        fullText += text;
        callbacks.onToken(text);
      } catch {
        if (currentEvent === "ping") {
          continue;
        }
      }
    }
  }

  callbacks.onDone(fullText, performance.now() - startTime);
}

async function streamFromNonSseResponse(
  response: Response,
  dialect: LlmApiDialect,
  callbacks: StreamCallbacks,
  startTime: number,
): Promise<void> {
  const raw = await response.text();
  const trimmed = raw.trim();

  if (!trimmed) {
    throw new Error("LLM returned an empty non-stream response body.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`LLM returned a non-JSON response: ${trimmed.slice(0, 300)}`);
  }

  const apiErrorMessage = extractApiErrorMessage(parsed);
  if (apiErrorMessage) {
    throw new Error(apiErrorMessage);
  }

  const text = parseNonStreamingText(dialect, parsed);
  if (!text.trim()) {
    throw new Error("LLM returned a successful response without text content.");
  }

  const latency = performance.now() - startTime;
  callbacks.onFirstToken(latency);
  callbacks.onToken(text);
  callbacks.onDone(text, latency);
}

function buildGeminiContents(
  systemPrompt: string,
  userPrompt: string,
  imageBase64Png?: string,
) {
  const userParts: Array<
    { text: string } | { inlineData: { mimeType: string; data: string } }
  > = [{ text: userPrompt }];
  if (imageBase64Png) {
    userParts.push({
      inlineData: {
        mimeType: "image/png",
        data: imageBase64Png,
      },
    });
  }

  return [
    { role: "user", parts: [{ text: systemPrompt }] },
    { role: "model", parts: [{ text: "Understood. I'll assist during the interview." }] },
    { role: "user", parts: userParts },
  ];
}

function buildOpenAiMessages(
  systemPrompt: string,
  userPrompt: string,
  imageBase64Png?: string,
) {
  const dataUrl = imageBase64Png
    ? `data:image/png;base64,${imageBase64Png}`
    : null;

  return [
    {
      role: "system",
      content: systemPrompt,
    },
    {
      role: "user",
      content: dataUrl
        ? [
            { type: "text", text: userPrompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ]
        : userPrompt,
    },
  ];
}

function buildAnthropicMessages(
  userPrompt: string,
  imageBase64Png?: string,
) {
  const content: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source: {
          type: "base64";
          media_type: "image/png";
          data: string;
        };
      }
  > = [{ type: "text", text: userPrompt }];

  if (imageBase64Png) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: imageBase64Png,
      },
    });
  }

  return [{ role: "user", content }];
}

export async function streamChat(params: StreamChatParams): Promise<void> {
  const {
    apiKey,
    modelId,
    endpoint,
    systemPrompt,
    userPrompt,
    imageBase64Png,
    maxTokens,
    callbacks,
    signal,
  } = params;

  const startTime = performance.now();
  try {
    let response: Response;

    if (endpoint.dialect === "gemini") {
      const url = `${joinBaseUrl(endpoint.baseUrl, `/v1beta/models/${modelId}:streamGenerateContent`)}?alt=sse&key=${encodeURIComponent(apiKey)}`;
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: buildGeminiContents(systemPrompt, userPrompt, imageBase64Png),
          generationConfig: { maxOutputTokens: maxTokens },
        }),
        signal,
      });
    } else if (endpoint.dialect === "anthropic") {
      response = await fetch(joinBaseUrl(endpoint.baseUrl, "/messages"), {
        method: "POST",
        headers: buildAnthropicHeaders(apiKey),
        body: JSON.stringify({
          model: modelId,
          max_tokens: maxTokens,
          system: systemPrompt,
          stream: true,
          messages: buildAnthropicMessages(userPrompt, imageBase64Png),
        }),
        signal,
      });
    } else {
      response = await fetch(joinBaseUrl(endpoint.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          stream: true,
          max_tokens: maxTokens,
          messages: buildOpenAiMessages(systemPrompt, userPrompt, imageBase64Png),
        }),
        signal,
      });
    }

    if (!response.ok) {
      const errBody = await response.text();
      let details = errBody;
      try {
        const parsed = JSON.parse(errBody) as unknown;
        details = extractApiErrorMessage(parsed) ?? errBody;
      } catch {
        // Keep raw text body as details.
      }
      throw new Error(`LLM API error ${response.status}: ${details}`);
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("text/event-stream")) {
      await streamFromNonSseResponse(response, endpoint.dialect, callbacks, startTime);
      return;
    }

    await streamFromSseResponse(response, endpoint.dialect, callbacks, startTime);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return;
    }
    if (err instanceof Error) {
      callbacks.onError(err);
      return;
    }
    callbacks.onError(new Error("Unknown LLM streaming error"));
  }
}

export function buildSystemPrompt(): string {
  return `You are an AI interview assistant. You help the user during a technical interview by:
1. Analyzing the conversation context between the interviewer and the candidate
2. Providing concise, accurate, and helpful answers
3. When a screenshot/code is provided, analyzing it in the context of the interview

Rules:
- Be concise but thorough
- Prioritize accuracy over speed
- If code is shown, provide working solutions
- Format responses with markdown when helpful
- Respond in the same language as the interview conversation`;
}

export function buildFinalReportPrompt(): string {
  return `Based on the entire interview conversation, generate a structured performance report in JSON format:
{
  "overallScore": <1-5>,
  "interviewerScore": <1-5>,
  "interviewerComment": "<1-2 sentences about the interviewer>",
  "strengths": ["<3-6 bullet points>"],
  "weaknesses": ["<3-6 bullet points>"],
  "improvements": ["<3-6 bullet points>"]
}
Only output valid JSON, no markdown fences.`;
}
