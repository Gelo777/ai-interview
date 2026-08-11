import { describe, expect, it } from "vitest";
import { buildLiveSttWebSocketUrl } from "@/lib/proxy";

describe("live STT WebSocket URL", () => {
  it("uses a short-lived ticket and never includes a license key", () => {
    const url = new URL(
      buildLiveSttWebSocketUrl({
        ticket: "one-time-ticket",
        lang: "ru-RU",
        baseUrl: "https://service.example",
      }),
    );

    expect(url.protocol).toBe("wss:");
    expect(url.searchParams.get("ticket")).toBe("one-time-ticket");
    expect(url.searchParams.has("licenseKey")).toBe(false);
  });
});
