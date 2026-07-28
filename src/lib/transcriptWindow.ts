import type { ChatMessage } from "@/lib/types";

/**
 * The compact transcript used to be "the last four messages", but startup notices are
 * messages too: a failed audio start emits three of them in a row and the transcript
 * turns into a wall of grey service text with no speech left in it.
 *
 * Phrases and notices get separate budgets instead. Notices stay visible — they are
 * how the user learns what happened — but they can never crowd out what was said.
 */
export const TRANSCRIPT_TAIL_PHRASES = 4;
export const TRANSCRIPT_TAIL_NOTICES = 2;

export function selectVisibleMessages(
  messages: ChatMessage[],
  options: { showFullTranscript: boolean },
): ChatMessage[] {
  if (options.showFullTranscript) {
    return messages;
  }

  const keep = new Set<number>();
  collectTailIndexes(messages, (message) => message.source !== "ai_marker", TRANSCRIPT_TAIL_PHRASES).forEach(
    (index) => keep.add(index),
  );
  collectTailIndexes(messages, (message) => message.source === "ai_marker", TRANSCRIPT_TAIL_NOTICES).forEach(
    (index) => keep.add(index),
  );

  // Filtering by index rather than concatenating the two groups keeps the notices
  // where they actually happened relative to the speech.
  return messages.filter((_, index) => keep.has(index));
}

function collectTailIndexes(
  messages: ChatMessage[],
  predicate: (message: ChatMessage) => boolean,
  limit: number,
): number[] {
  const indexes: number[] = [];
  for (let index = messages.length - 1; index >= 0 && indexes.length < limit; index -= 1) {
    if (predicate(messages[index])) {
      indexes.push(index);
    }
  }
  return indexes;
}

/** Number of spoken phrases hidden by the compact view, for the "showing last N" hint. */
export function countHiddenPhrases(
  messages: ChatMessage[],
  visible: ChatMessage[],
): number {
  const countPhrases = (list: ChatMessage[]) =>
    list.filter((message) => message.source !== "ai_marker").length;
  return Math.max(0, countPhrases(messages) - countPhrases(visible));
}
