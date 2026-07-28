import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Tauri mock (also backs the persist storage, so include app-state fns) ---
const activateLicenseMock = vi.fn<(request: unknown) => Promise<unknown>>();
const isTauriMock = vi.fn(() => true);
const setSecureApiKeyMock = vi.fn<(key: string) => Promise<void>>();
const getLicenseAccessTokenMock = vi.fn<() => Promise<string | null>>();

vi.mock("@/lib/tauri", () => ({
  activateLicense: (request: unknown) => activateLicenseMock(request),
  isTauri: () => isTauriMock(),
  setSecureApiKey: (key: string) => setSecureApiKeyMock(key),
  getLicenseAccessToken: () => getLicenseAccessTokenMock(),
  readAppState: async () => null,
  writeAppState: async () => {},
  removeAppState: async () => {},
}));

// --- Proxy mock: keep the real ProxyApiError / maps, override network + cache ---
const fetchLicenseStatusFullMock = vi.fn<(key?: string) => Promise<unknown>>();
const getCachedAccessTokenMock = vi.fn<() => string | null>();
const warmLicenseAccessTokenCacheMock = vi.fn<() => Promise<void>>();

vi.mock("@/lib/proxy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/proxy")>();
  return {
    ...actual,
    fetchLicenseStatusFull: (key?: string) => fetchLicenseStatusFullMock(key),
    getCachedAccessToken: () => getCachedAccessTokenMock(),
    warmLicenseAccessTokenCache: () => warmLicenseAccessTokenCacheMock(),
  };
});

import { ProxyApiError } from "@/lib/proxy";
import { useLicenseStore } from "@/stores/license";
import { useSettingsStore } from "@/stores/settings";

const ACTIVE_STATUS = {
  status: "ACTIVE",
  plan: "PRO",
  expiresAt: null,
  usageToday: { hints: 3, snapshots: 1, llmTokens: 4200 },
  limits: null,
  device: { bound: true, name: "DESKTOP-TEST", activatedAt: null, lastSeenAt: null },
};

function resetStores() {
  useLicenseStore.setState({
    authStatus: "unactivated",
    snapshot: null,
    activationError: null,
    revalidating: false,
    lastSyncError: null,
    migratedLegacyKey: false,
  });
  useSettingsStore.setState({ apiKey: "" });
}

beforeEach(() => {
  vi.clearAllMocks();
  isTauriMock.mockReturnValue(true);
  getCachedAccessTokenMock.mockReturnValue(null);
  getLicenseAccessTokenMock.mockResolvedValue(null);
  activateLicenseMock.mockResolvedValue({ status: {} });
  fetchLicenseStatusFullMock.mockResolvedValue(ACTIVE_STATUS);
  localStorage.clear();
  resetStores();
});

describe("licenseStore.activate", () => {
  it("activates successfully and stores the key", async () => {
    const ok = await useLicenseStore.getState().activate("KEY-123");

    expect(ok).toBe(true);
    expect(activateLicenseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        license_key: "KEY-123",
        proxy_url: expect.stringContaining("/api/v1/license/activate"),
      }),
    );
    expect(useLicenseStore.getState().authStatus).toBe("active");
    expect(useLicenseStore.getState().migratedLegacyKey).toBe(true);
    expect(useSettingsStore.getState().apiKey).toBe("KEY-123");
  });

  it.each([
    ["LICENSE_EXPIRED", "expired"],
    ["LICENSE_DEVICE_MISMATCH", "device_mismatch"],
    ["LICENSE_DISABLED", "invalid"],
    ["LICENSE_INVALID", "invalid"],
    ["LICENSE_NOT_FOUND", "invalid"],
  ])("maps activation error %s to authStatus %s", async (code, expected) => {
    activateLicenseMock.mockRejectedValueOnce(new Error(code));

    const ok = await useLicenseStore.getState().activate("KEY");

    expect(ok).toBe(false);
    expect(useLicenseStore.getState().authStatus).toBe(expected);
    expect(useLicenseStore.getState().activationError).toBeTruthy();
  });

  it("keeps status unactivated when activation and legacy validation both fail (offline)", async () => {
    activateLicenseMock.mockRejectedValueOnce(
      new Error("Не удалось подключиться к сервису лицензий: timeout"),
    );
    fetchLicenseStatusFullMock.mockRejectedValueOnce(new Error("network down"));

    const ok = await useLicenseStore.getState().activate("KEY");

    expect(ok).toBe(false);
    expect(useLicenseStore.getState().authStatus).toBe("unactivated");
  });

  it("falls back to legacy validation and saves the key when /activate is unavailable", async () => {
    // The new token endpoint is missing (e.g. backend not deployed), but the key
    // is valid, so the legacy /license/status path activates it.
    activateLicenseMock.mockRejectedValueOnce(new Error("Сервис вернул HTTP 404"));

    const ok = await useLicenseStore.getState().activate("KEY-XYZ");

    expect(ok).toBe(true);
    expect(useLicenseStore.getState().authStatus).toBe("active");
    expect(useSettingsStore.getState().apiKey).toBe("KEY-XYZ");
  });

  it("rejects an empty key without calling Tauri", async () => {
    const ok = await useLicenseStore.getState().activate("   ");

    expect(ok).toBe(false);
    expect(activateLicenseMock).not.toHaveBeenCalled();
    expect(useLicenseStore.getState().activationError).toBeTruthy();
  });
});

describe("licenseStore.bootstrap", () => {
  it("auto-migrates an existing legacy key to a device-bound token", async () => {
    useSettingsStore.setState({ apiKey: "LEGACY-KEY" });
    getCachedAccessTokenMock.mockReturnValue(null);

    await useLicenseStore.getState().bootstrap();

    expect(activateLicenseMock).toHaveBeenCalledWith(
      expect.objectContaining({ license_key: "LEGACY-KEY" }),
    );
    expect(useLicenseStore.getState().migratedLegacyKey).toBe(true);
    expect(useLicenseStore.getState().authStatus).toBe("active");
  });

  it("does not re-migrate once migratedLegacyKey is set", async () => {
    useSettingsStore.setState({ apiKey: "LEGACY-KEY" });
    useLicenseStore.setState({ migratedLegacyKey: true });
    getCachedAccessTokenMock.mockReturnValue(null);

    await useLicenseStore.getState().bootstrap();

    expect(activateLicenseMock).not.toHaveBeenCalled();
  });

  it("skips migration when a token already exists", async () => {
    useSettingsStore.setState({ apiKey: "LEGACY-KEY" });
    getCachedAccessTokenMock.mockReturnValue("aitk_existing");

    await useLicenseStore.getState().bootstrap();

    expect(activateLicenseMock).not.toHaveBeenCalled();
    expect(useLicenseStore.getState().authStatus).toBe("active");
  });
});

describe("licenseStore.revalidate", () => {
  it("updates the snapshot on success", async () => {
    useSettingsStore.setState({ apiKey: "KEY" });

    await useLicenseStore.getState().revalidate({ force: true });

    const snapshot = useLicenseStore.getState().snapshot;
    expect(snapshot?.plan).toBe("PRO");
    expect(snapshot?.usageToday?.hints).toBe(3);
    expect(useLicenseStore.getState().authStatus).toBe("active");
    expect(useLicenseStore.getState().lastSyncError).toBeNull();
  });

  it("does not clobber the cached snapshot on a network error", async () => {
    const snapshot = {
      status: "ACTIVE",
      plan: "PRO",
      expiresAt: null,
      usageToday: { hints: 5, snapshots: 0, llmTokens: 0 },
      limits: null,
      device: null,
      syncedAt: 123,
    };
    useLicenseStore.setState({ snapshot, authStatus: "active" });
    useSettingsStore.setState({ apiKey: "KEY" });
    fetchLicenseStatusFullMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await useLicenseStore.getState().revalidate({ force: true });

    expect(useLicenseStore.getState().snapshot).toEqual(snapshot);
    expect(useLicenseStore.getState().authStatus).toBe("active");
    expect(useLicenseStore.getState().lastSyncError).toBeTruthy();
  });

  it("hard-transitions to expired on a LICENSE_EXPIRED server code", async () => {
    useSettingsStore.setState({ apiKey: "KEY" });
    useLicenseStore.setState({ authStatus: "active" });
    fetchLicenseStatusFullMock.mockRejectedValueOnce(
      new ProxyApiError("expired", 403, "LICENSE_EXPIRED", "req-1"),
    );

    await useLicenseStore.getState().revalidate({ force: true });

    expect(useLicenseStore.getState().authStatus).toBe("expired");
  });

  it("keeps status on an auth-token error (records sync error only)", async () => {
    useSettingsStore.setState({ apiKey: "KEY" });
    useLicenseStore.setState({ authStatus: "active" });
    fetchLicenseStatusFullMock.mockRejectedValueOnce(
      new ProxyApiError("invalid token", 401, "AUTH_TOKEN_INVALID", null),
    );

    await useLicenseStore.getState().revalidate({ force: true });

    expect(useLicenseStore.getState().authStatus).toBe("active");
    expect(useLicenseStore.getState().lastSyncError).toBeTruthy();
  });
});

describe("licenseStore server notes", () => {
  it("noteServerLicenseError maps LICENSE_EXPIRED to expired", () => {
    useLicenseStore.getState().noteServerLicenseError("LICENSE_EXPIRED");
    expect(useLicenseStore.getState().authStatus).toBe("expired");
  });

  it("noteServerLicenseRecovered restores active from expired", () => {
    useLicenseStore.setState({ authStatus: "expired" });
    useLicenseStore.getState().noteServerLicenseRecovered();
    expect(useLicenseStore.getState().authStatus).toBe("active");
  });
});
