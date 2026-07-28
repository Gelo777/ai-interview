import { useCallback } from "react";
import { useSettingsStore } from "@/stores/settings";
import type { AppLanguage } from "@/lib/types";
import { EN_TRANSLATIONS } from "@/lib/i18n.translations";

export type TParams = Record<string, string | number>;

/**
 * Translate a Russian source string to the given app language. Russian is the
 * source of truth (keys), so `ru` is returned verbatim for the "ru" language and
 * looked up in {@link EN_TRANSLATIONS} for "en" (falling back to the Russian text
 * when a translation is missing). `{name}` placeholders are substituted from `params`.
 */
export function translate(ru: string, lang: AppLanguage, params?: TParams): string {
  let out = lang === "en" ? EN_TRANSLATIONS[ru] ?? ru : ru;
  if (params) {
    for (const key of Object.keys(params)) {
      out = out.split(`{${key}}`).join(String(params[key]));
    }
  }
  return out;
}

/**
 * React hook: returns a translate function bound to the current app language.
 * Components re-render when the language changes.
 */
export function useT(): (ru: string, params?: TParams) => string {
  // Subscribe so the component re-renders when the app language changes...
  useSettingsStore((s) => s.appLanguage);
  // ...but return a STABLE function that reads the current language at call time.
  // Stability keeps memoized callbacks (useCallback/useMemo) that capture `t`
  // correct — they always translate into the current language and don't need `t`
  // in their dependency arrays.
  return useCallback(
    (ru: string, params?: TParams) =>
      translate(ru, useSettingsStore.getState().appLanguage, params),
    [],
  );
}

/** Non-reactive translate for use outside React (stores, lib modules). */
export function t(ru: string, params?: TParams): string {
  return translate(ru, useSettingsStore.getState().appLanguage, params);
}
