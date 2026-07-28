import { create } from "zustand";
import { persist } from "zustand/middleware";
import { appPersistStorage } from "@/lib/persistStorage";
import { useSettingsStore } from "@/stores/settings";
import {
  fetchLicenseStatusFull,
  getCachedAccessToken,
  LICENSE_ERROR_MESSAGES,
  ProxyApiError,
  PROXY_BASE_URL,
  warmLicenseAccessTokenCache,
  type LicenseStatusFull,
} from "@/lib/proxy";

export type LicenseAuthStatus =
  | "unactivated" // no key / no activation
  | "activating" // activation in flight (transient)
  | "active"
  | "expired" // server: license expired
  | "device_mismatch" // key is bound to another device
  | "invalid"; // not found / disabled

export interface LicenseSnapshot {
  /** Raw server status string. */
  status: string;
  plan: string | null;
  /** ISO-8601; null = perpetual license. */
  expiresAt: string | null;
  usageToday: { hints: number; snapshots: number; llmTokens: number } | null;
  limits: {
    maxHintsPerDay: number;
    maxSnapshotsPerDay: number;
    maxAudioSecondsPerHint: number;
  } | null;
  device: {
    bound: boolean;
    name: string | null;
    activatedAt: string | null;
    lastSeenAt: string | null;
  } | null;
  /** Date.now() of the last successful sync. */
  syncedAt: number;
}

interface LicenseStoreState {
  authStatus: LicenseAuthStatus;
  snapshot: LicenseSnapshot | null;
  activationError: string | null; // transient
  revalidating: boolean; // transient
  lastSyncError: string | null; // transient: network down, showing cached snapshot
  migratedLegacyKey: boolean; // legacy-key auto-activation already attempted

  bootstrap: () => Promise<void>;
  activate: (key: string) => Promise<boolean>;
  revalidate: (opts?: { force?: boolean }) => Promise<void>;
  noteServerLicenseError: (code: string | null) => void;
  noteServerLicenseRecovered: () => void;
}

const ACTIVATE_PATH = "/api/v1/license/activate";

function activateUrl(): string {
  return `${PROXY_BASE_URL.replace(/\/+$/, "")}${ACTIVATE_PATH}`;
}

function snapshotFromStatus(full: LicenseStatusFull): LicenseSnapshot {
  return {
    status: full.status,
    plan: full.plan,
    expiresAt: full.expiresAt,
    usageToday: full.usageToday,
    limits: full.limits,
    device: full.device,
    syncedAt: Date.now(),
  };
}

/**
 * Maps the raw server status + expiry into an auth status. The server status is
 * authoritative; expiry is only a fallback when the server did not explicitly
 * mark the license expired.
 */
function mapStatusToAuth(status: string, expiresAt: string | null): LicenseAuthStatus {
  const normalized = status.trim().toUpperCase();
  if (normalized === "ACTIVE" || normalized === "OK" || normalized === "LICENSED") {
    if (expiresAt) {
      const expiresAtMs = new Date(expiresAt).getTime();
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
        return "expired";
      }
    }
    return "active";
  }
  if (normalized === "EXPIRED") {
    return "expired";
  }
  if (normalized === "DEVICE_MISMATCH" || normalized === "LICENSE_DEVICE_MISMATCH") {
    return "device_mismatch";
  }
  // DISABLED / REVOKED / INVALID / NOT_FOUND / anything else.
  return "invalid";
}

/**
 * Best-effort classification of an activation error string. The Tauri activation
 * command returns the backend's human message (after descending into
 * `error.message`), not a structured code, so we scan for known code tokens AND
 * Russian phrases. Network failures fall through to `unactivated` so migration
 * retries on the next launch.
 */
function classifyActivationError(raw: string): {
  authStatus: LicenseAuthStatus;
  message: string;
} {
  const upper = raw.toUpperCase();
  const knownCode = Object.keys(LICENSE_ERROR_MESSAGES).find((code) =>
    upper.includes(code),
  );
  const message = knownCode
    ? LICENSE_ERROR_MESSAGES[knownCode]
    : raw.trim() || "Не удалось активировать ключ. Попробуйте ещё раз.";

  let authStatus: LicenseAuthStatus = "unactivated";
  if (upper.includes("LICENSE_EXPIRED") || raw.includes("истёк") || raw.includes("истек")) {
    authStatus = "expired";
  } else if (upper.includes("DEVICE_MISMATCH") || /друг\S* устройств/i.test(raw)) {
    authStatus = "device_mismatch";
  } else if (
    upper.includes("LICENSE_DISABLED") ||
    upper.includes("LICENSE_INVALID") ||
    upper.includes("LICENSE_NOT_FOUND") ||
    raw.includes("не найден") ||
    raw.includes("отключена")
  ) {
    authStatus = "invalid";
  }

  return { authStatus, message };
}

function authFromCode(code: string | null): LicenseAuthStatus | null {
  const upper = (code ?? "").trim().toUpperCase();
  if (!upper) {
    return null;
  }
  if (upper.includes("LICENSE_EXPIRED")) {
    return "expired";
  }
  if (upper.includes("DEVICE_MISMATCH")) {
    return "device_mismatch";
  }
  if (
    upper.includes("LICENSE_DISABLED") ||
    upper.includes("LICENSE_INVALID") ||
    upper.includes("LICENSE_NOT_FOUND")
  ) {
    return "invalid";
  }
  return null;
}

// Single-flight guard for revalidate() — module scoped so concurrent callers
// (monitor + cabinet mount + bootstrap) share one in-flight request.
let revalidateInFlight: Promise<void> | null = null;

export const useLicenseStore = create<LicenseStoreState>()(
  persist(
    (set, get) => ({
      authStatus: "unactivated",
      snapshot: null,
      activationError: null,
      revalidating: false,
      lastSyncError: null,
      migratedLegacyKey: false,

      bootstrap: async () => {
        await warmLicenseAccessTokenCache();
        const hasToken = Boolean(getCachedAccessToken());
        const apiKey = useSettingsStore.getState().apiKey.trim();

        if (hasToken && get().authStatus === "unactivated") {
          // A token already exists in the keychain — treat as active until the
          // first revalidation confirms/corrects it.
          set({ authStatus: "active" });
        }

        // Silent migration of an existing legacy key (first launch of this
        // version): exchange the stored key for a device-bound token.
        if (
          !hasToken &&
          !get().migratedLegacyKey &&
          apiKey &&
          get().authStatus === "unactivated"
        ) {
          const ok = await get().activate(apiKey);
          if (ok) {
            set({ migratedLegacyKey: true });
          } else if (get().authStatus !== "unactivated") {
            // Definitive license error (device mismatch / expired / invalid):
            // stop retrying, the cabinet will surface the error on open.
            set({ migratedLegacyKey: true });
          } else {
            // Network error: keep retrying on the next launch, hide the scary
            // activation error from the silent path.
            set({ activationError: null });
          }
        }

        if (getCachedAccessToken() || useSettingsStore.getState().apiKey.trim()) {
          await get().revalidate();
        }
      },

      activate: async (rawKey) => {
        const key = rawKey.trim();
        if (!key) {
          set({ activationError: "Введите лицензионный ключ." });
          return false;
        }

        set({ authStatus: "activating", activationError: null });

        const { isTauri } = await import("@/lib/tauri");
        if (!isTauri()) {
          set({
            authStatus: "unactivated",
            activationError: "Активация доступна только в приложении.",
          });
          return false;
        }

        // Persist the key IMMEDIATELY (settings store → keychain) so it is saved
        // and shown in the cabinet regardless of the activation outcome — the key
        // belongs to the user either way.
        useSettingsStore.getState().setApiKey(key);

        try {
          const { activateLicense } = await import("@/lib/tauri");
          await activateLicense({ license_key: key, proxy_url: activateUrl() });
          await warmLicenseAccessTokenCache();
          set({
            authStatus: "active",
            activationError: null,
            migratedLegacyKey: true,
          });
          void get().revalidate({ force: true });
          return true;
        } catch (error) {
          const raw = error instanceof Error ? error.message : String(error);
          const { authStatus, message } = classifyActivationError(raw);

          // A definitive server rejection of the key — surface it and stop.
          if (
            authStatus === "device_mismatch" ||
            authStatus === "expired" ||
            authStatus === "invalid"
          ) {
            set({ authStatus, activationError: message });
            return false;
          }

          // Otherwise the token endpoint is unavailable (e.g. the new backend is
          // not deployed yet) or a transient error — fall back to validating the
          // already-saved key the legacy way (X-License-Key via /license/status).
          set({ migratedLegacyKey: true });
          await get().revalidate({ force: true });
          const fallbackStatus = get().authStatus;
          if (fallbackStatus === "active") {
            set({ activationError: null });
            return true;
          }
          // Not active — leave a retry-able state (never stuck on "activating").
          set({
            authStatus: fallbackStatus === "activating" ? "unactivated" : fallbackStatus,
            activationError: message,
          });
          return false;
        }
      },

      revalidate: async (opts) => {
        if (revalidateInFlight && !opts?.force) {
          return revalidateInFlight;
        }

        const run = (async () => {
          set({ revalidating: true });
          try {
            const apiKey = useSettingsStore.getState().apiKey.trim();
            const full = await fetchLicenseStatusFull(apiKey || undefined);
            set({
              snapshot: snapshotFromStatus(full),
              authStatus: mapStatusToAuth(full.status, full.expiresAt),
              lastSyncError: null,
            });
          } catch (error) {
            if (error instanceof ProxyApiError) {
              const mapped = authFromCode(error.code);
              if (mapped) {
                // Explicit license/auth code from the server: hard transition.
                set({ authStatus: mapped, lastSyncError: null });
              } else {
                // Auth-token / rate-limit / other: keep the cached snapshot and
                // status, just record the sync error.
                set({ lastSyncError: error.message });
              }
            } else {
              // Network failure (offline grace): never tears down the status.
              const message =
                error instanceof Error
                  ? error.message
                  : "Не удалось обновить статус лицензии.";
              set({ lastSyncError: message });
            }
          } finally {
            set({ revalidating: false });
          }
        })();

        revalidateInFlight = run.finally(() => {
          revalidateInFlight = null;
        });
        return revalidateInFlight;
      },

      noteServerLicenseError: (code) => {
        const mapped = authFromCode(code);
        if (mapped) {
          set({ authStatus: mapped });
        }
      },

      noteServerLicenseRecovered: () => {
        if (get().authStatus === "expired") {
          set({ authStatus: "active", lastSyncError: null });
        }
      },
    }),
    {
      name: "ai-interview-license",
      storage: appPersistStorage,
      partialize: (state) => ({
        snapshot: state.snapshot,
        migratedLegacyKey: state.migratedLegacyKey,
        authStatus: state.authStatus,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) {
          return;
        }
        // Transient fields never persist.
        state.activationError = null;
        state.revalidating = false;
        state.lastSyncError = null;
        // An interrupted activation must not resume as "activating".
        if (state.authStatus === "activating") {
          state.authStatus = "unactivated";
        }
        state.migratedLegacyKey = state.migratedLegacyKey === true;
      },
    },
  ),
);
