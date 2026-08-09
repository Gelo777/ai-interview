import { afterEach, describe, expect, it } from "vitest";
import type { DiagnosticEntry } from "@/lib/diagnostics";
import {
  buildRedactedDiagnosticsReport,
  redactSecrets,
} from "@/lib/supportReporting";
import { useSettingsStore } from "@/stores/settings";

const originalApiKey = useSettingsStore.getState().apiKey;

afterEach(() => {
  useSettingsStore.setState({ apiKey: originalApiKey });
});

describe("support report secret redaction", () => {
  it("redacts the active license key regardless of its format", () => {
    const licenseKey = "customer-key.with:arbitrary_format-2026";
    useSettingsStore.setState({ apiKey: licenseKey });
    const entry: DiagnosticEntry = {
      id: "secret-test",
      timestamp: 0,
      level: "error",
      scope: "service.connection",
      message: `Connection failed for ${licenseKey}`,
      details: `licenseKey=${licenseKey}`,
    };

    const report = buildRedactedDiagnosticsReport([entry]);

    expect(report).not.toContain(licenseKey);
    expect(report).toContain("[секрет скрыт]");
  });

  it("redacts Gemini, JWT, bearer, and WebSocket query secrets", () => {
    const geminiKey = `AIza${"a".repeat(35)}`;
    const jwt = `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`;
    const input = [
      geminiKey,
      jwt,
      `Authorization: Bearer raw-bearer-token`,
      `wss://example.test/live?licenseKey=raw-license&mode=stt`,
    ].join("\n");

    const redacted = redactSecrets(input, []);

    expect(redacted).not.toContain(geminiKey);
    expect(redacted).not.toContain(jwt);
    expect(redacted).not.toContain("raw-bearer-token");
    expect(redacted).not.toContain("raw-license");
  });
});
