import { describe, expect, it } from "vitest";
import {
  ASSISTANT_CONTEXT_MAX_CHARS,
  buildAssistantContext,
} from "@/lib/interviewContext";
import type { ContextFile } from "@/lib/types";

function makeFile(name: string, content: string): ContextFile {
  return {
    id: name,
    name,
    size: content.length,
    mimeType: "text/plain",
    content,
    addedAt: 0,
  };
}

describe("buildAssistantContext", () => {
  it("returns an empty string when there is nothing to send", () => {
    expect(buildAssistantContext({ topic: "   ", files: [] })).toBe("");
  });

  it("keeps the topic and names every file", () => {
    const context = buildAssistantContext({
      topic: "backend interview · concurrency",
      files: [makeFile("resume.pdf", "Senior engineer"), makeFile("job.docx", "Kotlin, Postgres")],
    });

    expect(context).toContain("Тема и стек:\nbackend interview · concurrency");
    expect(context).toContain("Файл «resume.pdf»:\nSenior engineer");
    expect(context).toContain("Файл «job.docx»:\nKotlin, Postgres");
  });

  it("skips files whose extraction produced nothing", () => {
    const context = buildAssistantContext({
      topic: "",
      files: [makeFile("empty.txt", "   "), makeFile("ok.txt", "полезный текст")],
    });

    expect(context).not.toContain("empty.txt");
    expect(context).toContain("ok.txt");
  });

  it("shares the budget so one long file cannot crowd out the others", () => {
    const context = buildAssistantContext({
      topic: "тема",
      files: [
        makeFile("huge.pdf", "а".repeat(ASSISTANT_CONTEXT_MAX_CHARS * 2)),
        makeFile("small.txt", "короткий файл"),
      ],
    });

    expect(context.length).toBeLessThanOrEqual(ASSISTANT_CONTEXT_MAX_CHARS);
    expect(context).toContain("[...обрезано]");
    expect(context).toContain("Файл «small.txt»:\nкороткий файл");
  });
});
