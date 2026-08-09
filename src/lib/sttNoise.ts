/**
 * Speech models trained on subtitle corpora tend, on silence or background noise, to
 * emit the credits and filler that ended those files — "Субтитры в Киеве",
 * "Продолжение следует", "Thanks for watching". None of it was ever spoken, and in an
 * interview transcript it reads as if the candidate said it.
 *
 * Any mention of subtitles is treated as noise outright: the word has no legitimate
 * place in a technical interview, so a false positive costs nothing.
 */
const HALLUCINATED_FILLER_PATTERNS: RegExp[] = [
  /субтитр/i,
  /продолжение\s+следует/i,
  // No \b here: JavaScript word boundaries are ASCII-only, so after a Cyrillic
  // letter they never fire and the pattern would silently never match.
  /спасибо\s+за\s+(просмотр|внимание)/i,
  /подпиш(и|ись|итесь)/i,
  /ставьте\s+лайк/i,
  /subtitle|amara\.org/i,
  /thanks?\s+for\s+watching/i,
  /please\s+subscribe/i,
];

export function isKnownSubtitleCreditNoise(text: string): boolean {
  return HALLUCINATED_FILLER_PATTERNS.some((pattern) => pattern.test(text));
}
