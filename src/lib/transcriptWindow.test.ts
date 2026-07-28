import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/lib/types";
import {
  countHiddenPhrases,
  selectVisibleMessages,
  TRANSCRIPT_TAIL_NOTICES,
  TRANSCRIPT_TAIL_PHRASES,
} from "@/lib/transcriptWindow";

function phrase(text: string): ChatMessage {
  return {
    id: text,
    timestamp: 0,
    source: "interviewer",
    text,
    isFinal: true,
  };
}

function notice(text: string): ChatMessage {
  return {
    id: text,
    timestamp: 0,
    source: "ai_marker",
    text,
    isFinal: true,
  };
}

describe("selectVisibleMessages", () => {
  it("returns everything in full transcript mode", () => {
    const messages = [phrase("a"), notice("n1"), phrase("b")];
    expect(selectVisibleMessages(messages, { showFullTranscript: true })).toBe(messages);
  });

  it("keeps the last four phrases even when notices arrive in a burst", () => {
    const messages = [
      phrase("p1"),
      phrase("p2"),
      phrase("p3"),
      phrase("p4"),
      notice("n1"),
      notice("n2"),
      notice("n3"),
    ];

    const visible = selectVisibleMessages(messages, { showFullTranscript: false });
    const texts = visible.map((message) => message.text);

    // This is the regression: the old slice(-4) showed n1..n3 plus p4 and nothing else.
    expect(texts).toContain("p1");
    expect(texts).toContain("p4");
    expect(
      visible.filter((message) => message.source !== "ai_marker"),
    ).toHaveLength(TRANSCRIPT_TAIL_PHRASES);
  });

  it("caps notices at the freshest few", () => {
    const messages = [notice("n1"), notice("n2"), notice("n3"), notice("n4")];

    const visible = selectVisibleMessages(messages, { showFullTranscript: false });

    expect(visible).toHaveLength(TRANSCRIPT_TAIL_NOTICES);
    expect(visible.map((message) => message.text)).toEqual(["n3", "n4"]);
  });

  it("preserves chronological order across both budgets", () => {
    const messages = [
      phrase("p1"),
      notice("n1"),
      phrase("p2"),
      notice("n2"),
      phrase("p3"),
    ];

    const visible = selectVisibleMessages(messages, { showFullTranscript: false });

    expect(visible.map((message) => message.text)).toEqual([
      "p1",
      "n1",
      "p2",
      "n2",
      "p3",
    ]);
  });

  it("drops the oldest phrases past the budget", () => {
    const messages = [
      phrase("p1"),
      phrase("p2"),
      phrase("p3"),
      phrase("p4"),
      phrase("p5"),
    ];

    const visible = selectVisibleMessages(messages, { showFullTranscript: false });

    expect(visible.map((message) => message.text)).toEqual(["p2", "p3", "p4", "p5"]);
    expect(countHiddenPhrases(messages, visible)).toBe(1);
  });
});

describe("countHiddenPhrases", () => {
  it("ignores notices on both sides of the count", () => {
    const messages = [phrase("p1"), notice("n1"), phrase("p2")];
    const visible = [notice("n1"), phrase("p2")];

    expect(countHiddenPhrases(messages, visible)).toBe(1);
  });
});
