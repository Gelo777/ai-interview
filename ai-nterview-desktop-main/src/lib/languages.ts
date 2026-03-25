import type { PrimaryLanguage } from "@/lib/types";

export interface AppLanguageOption {
  code: PrimaryLanguage;
  label: string;
  nativeLabel: string;
}

export const APP_LANGUAGE_OPTIONS: AppLanguageOption[] = [
  { code: "en-US", label: "English", nativeLabel: "English" },
  { code: "ru-RU", label: "Russian", nativeLabel: "Русский" },
  { code: "es-ES", label: "Spanish", nativeLabel: "Español" },
  { code: "de-DE", label: "German", nativeLabel: "Deutsch" },
  { code: "fr-FR", label: "French", nativeLabel: "Français" },
  { code: "it-IT", label: "Italian", nativeLabel: "Italiano" },
  { code: "pt-BR", label: "Portuguese", nativeLabel: "Português (Brasil)" },
  { code: "zh-CN", label: "Chinese", nativeLabel: "中文（简体）" },
  { code: "ja-JP", label: "Japanese", nativeLabel: "日本語" },
  { code: "ko-KR", label: "Korean", nativeLabel: "한국어" },
];

const SYSTEM_LANGUAGE_TO_APP: Array<{ prefixes: string[]; code: PrimaryLanguage }> = [
  { prefixes: ["ru"], code: "ru-RU" },
  { prefixes: ["en"], code: "en-US" },
  { prefixes: ["es"], code: "es-ES" },
  { prefixes: ["de"], code: "de-DE" },
  { prefixes: ["fr"], code: "fr-FR" },
  { prefixes: ["it"], code: "it-IT" },
  { prefixes: ["pt"], code: "pt-BR" },
  { prefixes: ["zh"], code: "zh-CN" },
  { prefixes: ["ja"], code: "ja-JP" },
  { prefixes: ["ko"], code: "ko-KR" },
];

export function detectPrimaryLanguageFromSystem(): PrimaryLanguage {
  if (typeof navigator === "undefined") {
    return "en-US";
  }

  const candidates = [navigator.language, ...(navigator.languages ?? [])]
    .map((value) => value?.toLowerCase().trim())
    .filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    for (const mapping of SYSTEM_LANGUAGE_TO_APP) {
      if (mapping.prefixes.some((prefix) => candidate.startsWith(prefix))) {
        return mapping.code;
      }
    }
  }

  return "en-US";
}

export function normalizePrimaryLanguage(value: unknown): PrimaryLanguage {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    const match = APP_LANGUAGE_OPTIONS.find(
      (option) => option.code.toLowerCase() === normalized,
    );
    if (match) {
      return match.code;
    }
    if (normalized === "en") {
      return "en-US";
    }
    if (normalized === "ru") {
      return "ru-RU";
    }
  }

  return detectPrimaryLanguageFromSystem();
}

export function getLanguageLabel(code: PrimaryLanguage): string {
  return (
    APP_LANGUAGE_OPTIONS.find((option) => option.code === code)?.nativeLabel ??
    "English"
  );
}
