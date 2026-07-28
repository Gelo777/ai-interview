import { describe, expect, it } from "vitest";
import { isKnownSubtitleCreditNoise } from "@/lib/sttNoise";

describe("whisper hallucination filter", () => {
  it("drops the subtitle credits Whisper emits on silence", () => {
    // The exact phrase that reached a live transcript and started this fix.
    expect(isKnownSubtitleCreditNoise("Субтитры в Киеве")).toBe(true);
    expect(isKnownSubtitleCreditNoise("Субтитры сделал DimaTorzok")).toBe(true);
    expect(isKnownSubtitleCreditNoise("Редактор субтитров А.Синецкая")).toBe(true);
    expect(isKnownSubtitleCreditNoise("Subtitles by the Amara.org community")).toBe(true);
  });

  it("drops the video-outro filler from the same training corpus", () => {
    expect(isKnownSubtitleCreditNoise("Продолжение следует...")).toBe(true);
    expect(isKnownSubtitleCreditNoise("Спасибо за просмотр!")).toBe(true);
    expect(isKnownSubtitleCreditNoise("Подпишись на канал")).toBe(true);
    expect(isKnownSubtitleCreditNoise("Thanks for watching!")).toBe(true);
  });

  it("keeps real interview speech, including words that merely look similar", () => {
    expect(isKnownSubtitleCreditNoise("Расскажи про индексы в PostgreSQL")).toBe(false);
    expect(isKnownSubtitleCreditNoise("Продолжи writing the handler")).toBe(false);
    expect(isKnownSubtitleCreditNoise("Спасибо, дальше про транзакции")).toBe(false);
    expect(isKnownSubtitleCreditNoise("Какая сложность у этого алгоритма?")).toBe(false);
  });
});
