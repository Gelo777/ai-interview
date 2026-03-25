import { useEffect, useMemo, useRef, useState } from "react";
import { resolveLlmEndpointConfig } from "@/lib/llm";
import { validateLicenseKeyDetailed } from "@/lib/proxy";
import type { LlmBaseUrlPreset } from "@/lib/types";

const API_KEY_VALIDATION_DEBOUNCE_MS = 500;
const API_KEY_VALIDATION_MIN_LENGTH = 16;

export function useApiKeyValidation(
  apiKey: string,
  baseUrlPreset: LlmBaseUrlPreset,
  customBaseUrl: string,
  disabled = false,
): { validating: boolean; valid: boolean | null; detail: string | null } {
  const [validating, setValidating] = useState(false);
  const [valid, setValid] = useState<boolean | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const endpoint = useMemo(
    () => resolveLlmEndpointConfig(baseUrlPreset, customBaseUrl),
    [baseUrlPreset, customBaseUrl],
  );

  useEffect(() => {
    const trimmed = apiKey.trim();
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;

    if (
      !trimmed ||
      trimmed.length < API_KEY_VALIDATION_MIN_LENGTH ||
      !endpoint.baseUrl ||
      disabled
    ) {
      const resetTimer = window.setTimeout(() => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setValidating(false);
        setValid(null);
        setDetail(null);
      }, 0);
      return () => {
        window.clearTimeout(resetTimer);
      };
    }

    const timer = window.setTimeout(() => {
      if (requestIdRef.current !== requestId) {
        return;
      }
      setValidating(true);
      setValid(null);
      setDetail(null);
      void validateLicenseKeyDetailed(trimmed, baseUrlPreset, customBaseUrl).then((result) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setValid(result.valid);
        setDetail(result.detail);
        setValidating(false);
      });
    }, API_KEY_VALIDATION_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [apiKey, disabled, endpoint]);

  return { validating, valid, detail };
}
