import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestProxyHint } from "@/lib/proxy";

/**
 * The interview context reaches the assistant as its own multipart part, so it
 * must survive all the way into the request body — a silently dropped part is
 * invisible in the UI and only shows up as vaguer answers.
 */
describe("requestProxyHint", () => {
  let lastBody: FormData | null = null;

  beforeEach(() => {
    lastBody = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        lastBody = init.body as FormData;
        return new Response(
          JSON.stringify({
            hintId: "1",
            taskType: "TEXT",
            question: "q",
            output: "ответ",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
  });

  it("sends the interview context as its own part", async () => {
    await requestProxyHint({
      licenseKey: "key",
      baseUrlPreset: "custom",
      customBaseUrl: "https://example.test",
      question: "что такое MVCC?",
      language: "ru-RU",
      context: "Тема и стек:\nbackend, postgres",
    });

    expect(lastBody?.get("question")).toBe("что такое MVCC?");
    expect(lastBody?.get("context")).toBe("Тема и стек:\nbackend, postgres");
  });

  it("omits the part when there is no context", async () => {
    await requestProxyHint({
      licenseKey: "key",
      baseUrlPreset: "custom",
      customBaseUrl: "https://example.test",
      question: "что такое MVCC?",
      language: "ru-RU",
      context: "   ",
    });

    expect(lastBody?.has("context")).toBe(false);
  });
});
