import type { ContextFile } from "@/lib/types";

/**
 * Builds the background block sent alongside every assistant request: the
 * topic/stack the user typed plus the text extracted from their context files.
 *
 * The server trims this too, but budgeting here keeps whole files readable
 * instead of letting one long résumé push the others out.
 */

/** Kept in sync with `app.openai.hintContextMaxChars` on the backend. */
export const ASSISTANT_CONTEXT_MAX_CHARS = 6000;
const MIN_FILE_EXCERPT_CHARS = 400;
const TRUNCATION_MARK = "\n[...обрезано]";

export function buildAssistantContext(params: {
  topic: string;
  files: ContextFile[];
}): string {
  const blocks: string[] = [];
  const topic = params.topic.trim();
  if (topic) {
    blocks.push(`Тема и стек:\n${topic}`);
  }

  const files = params.files.filter((file) => file.content.trim().length > 0);
  if (files.length > 0) {
    const used = blocks.join("\n\n").length;
    const budget = ASSISTANT_CONTEXT_MAX_CHARS - used;
    // Headers and separators also cost characters, hence the per-file reserve.
    const perFile = Math.max(
      MIN_FILE_EXCERPT_CHARS,
      Math.floor(budget / files.length) - 40,
    );

    for (const file of files) {
      const excerpt = truncate(file.content.trim(), perFile);
      blocks.push(`Файл «${file.name}»:\n${excerpt}`);
    }
  }

  return truncate(blocks.join("\n\n"), ASSISTANT_CONTEXT_MAX_CHARS);
}

function truncate(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars).trimEnd()}${TRUNCATION_MARK}`;
}
