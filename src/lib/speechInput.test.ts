import { describe, expect, it } from "vitest";

import { appendUtterance, dictationAcceptsTrack } from "@/lib/speechInput";

describe("dictationAcceptsTrack", () => {
  it("routes both tracks into the window on the default setting", () => {
    expect(dictationAcceptsTrack("both", "mic")).toBe(true);
    expect(dictationAcceptsTrack("both", "system")).toBe(true);
  });

  it("takes only the interviewer when the window listens to the computer", () => {
    expect(dictationAcceptsTrack("system", "system")).toBe(true);
    expect(dictationAcceptsTrack("system", "mic")).toBe(false);
  });

  it("takes only your voice when the window listens to the microphone", () => {
    expect(dictationAcceptsTrack("mic", "mic")).toBe(true);
    expect(dictationAcceptsTrack("mic", "system")).toBe(false);
  });
});

describe("appendUtterance", () => {
  it("starts the window with the first phrase as-is", () => {
    expect(appendUtterance({ settled: "", phrase: "расскажи про GC", gapMs: 0 })).toBe(
      "расскажи про GC",
    );
  });

  it("joins chunks of one sentence with a space", () => {
    expect(
      appendUtterance({ settled: "расскажи про", phrase: "сборку мусора", gapMs: 600 }),
    ).toBe("расскажи про сборку мусора");
  });

  it("closes the sentence when the speaker paused", () => {
    expect(
      appendUtterance({
        settled: "расскажи про сборку мусора",
        phrase: "как работает G1",
        gapMs: 4000,
      }),
    ).toBe("расскажи про сборку мусора. как работает G1");
  });

  it("does not double up existing punctuation", () => {
    expect(
      appendUtterance({
        settled: "расскажи про сборку мусора?",
        phrase: "как работает G1",
        gapMs: 4000,
      }),
    ).toBe("расскажи про сборку мусора? как работает G1");
  });

  it("mixes both tracks into one line, which is what 'обе дорожки' means", () => {
    // Interviewer asks, you add a clarification inside the same window.
    const afterInterviewer = appendUtterance({
      settled: "",
      phrase: "что такое escape analysis",
      gapMs: 0,
    });
    const afterYou = appendUtterance({
      settled: afterInterviewer,
      phrase: "ответь коротко",
      gapMs: 3000,
    });

    expect(afterYou).toBe("что такое escape analysis. ответь коротко");
  });

  it("ignores an empty phrase and trims the tail", () => {
    expect(appendUtterance({ settled: "вопрос ", phrase: "   ", gapMs: 9000 })).toBe(
      "вопрос",
    );
  });
});
