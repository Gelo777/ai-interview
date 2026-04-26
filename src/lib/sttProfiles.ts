import type { PrimaryLanguage, SecondaryLanguage, SttModelVariant } from "@/lib/types";

export type SttQualityProfileId = SttModelVariant;

export type SttQualityProfile = {
  id: SttQualityProfileId;
  label: string;
  shortLabel: string;
  description: string;
  primaryVariant: SttModelVariant;
  secondaryVariant: SttModelVariant;
};

export const STT_QUALITY_PROFILES: readonly SttQualityProfile[] = [
  {
    id: "small",
    label: "Small",
    shortLabel: "Small",
    description: "Быстрый старт и минимальная нагрузка. Хороший стабильный live-режим.",
    primaryVariant: "small",
    secondaryVariant: "small",
  },
  {
    id: "large",
    label: "Large",
    shortLabel: "Large",
    description: "Более точное распознавание Vosk, но модель тяжелее и запускается дольше.",
    primaryVariant: "large",
    secondaryVariant: "large",
  },
] as const;

export function getSttQualityProfileById(profileId: SttQualityProfileId): SttQualityProfile {
  return (
    STT_QUALITY_PROFILES.find((profile) => profile.id === profileId) ??
    STT_QUALITY_PROFILES[0]
  );
}

export function resolveSttQualityProfile(
  primaryVariant: SttModelVariant,
  secondaryVariant: SttModelVariant,
): SttQualityProfile | null {
  if (primaryVariant !== secondaryVariant) {
    return null;
  }
  return STT_QUALITY_PROFILES.find((profile) => profile.id === primaryVariant) ?? null;
}

export function getSttPerformanceProfileLabel(
  primaryVariant: SttModelVariant,
  secondaryVariant: SttModelVariant,
): string {
  return resolveSttQualityProfile(primaryVariant, secondaryVariant)?.shortLabel ?? "Свой";
}

export function resolvePreferredSttVariantForLanguage(params: {
  language: PrimaryLanguage;
  primaryLanguage: PrimaryLanguage;
  primaryVariant: SttModelVariant;
  secondaryLanguage: SecondaryLanguage;
  secondaryVariant: SttModelVariant;
}): SttModelVariant {
  const {
    language,
    primaryLanguage,
    primaryVariant,
    secondaryLanguage,
    secondaryVariant,
  } = params;

  if (language === primaryLanguage) {
    return primaryVariant;
  }

  if (secondaryLanguage !== "none" && language === secondaryLanguage) {
    return secondaryVariant;
  }

  return primaryVariant;
}
