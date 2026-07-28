import type { DictationSource } from "@/lib/types";

/**
 * The microphone button opens a capture window, and everything recognised inside it
 * lands in the question field. Which tracks feed that window is the user's choice
 * ("Что слушать" in the dictation settings) — the point of the window is that the app
 * listens at the moment a question is being asked instead of all the time.
 */
export function dictationAcceptsTrack(
  source: DictationSource,
  track: "mic" | "system",
): boolean {
  if (source === "both") {
    return true;
  }
  return source === track;
}

/**
 * The engine reports one utterance at a time and no punctuation, so the naive
 * `${settled} ${next}` join turns a window into a single run-on line that neither the
 * user nor the model can parse. Pauses are where a speaker puts their punctuation:
 * under a second and a half the sentence is still going, longer and it ended.
 */
export const SPEECH_SENTENCE_GAP_MS = 1500;

const TRAILING_PUNCTUATION = /[.!?…,:;—-]$/;

export function appendUtterance(params: {
  settled: string;
  phrase: string;
  gapMs: number;
}): string {
  const phrase = params.phrase.trim();
  const settled = params.settled.replace(/\s+$/, "");
  if (!phrase) {
    return settled;
  }
  if (!settled) {
    return phrase;
  }
  return `${settled}${separatorFor(settled, params.gapMs)}${phrase}`;
}

function separatorFor(settled: string, gapMs: number): string {
  if (TRAILING_PUNCTUATION.test(settled)) {
    return " ";
  }
  return gapMs < SPEECH_SENTENCE_GAP_MS ? " " : ". ";
}
