import { create } from "zustand";
import { persist } from "zustand/middleware";
import { appPersistStorage } from "@/lib/persistStorage";

/**
 * Локальный учёт использования до серверного enforcement-а: сколько собесов
 * начато в календарном месяце и когда был последний (окно фри-тарифа «1 раз в
 * 3 дня»). Лицензия привязана к устройству, поэтому счёт на устройстве честен
 * как ОЦЕНКА; источником правды станет сервер, когда появятся квоты в API —
 * тогда эти цифры замещаются серверными.
 */
interface UsageState {
  /** Начатые собесы по месяцам: { "2026-07": 3 }. Хвост старых месяцев подрезается. */
  interviewsByMonth: Record<string, number>;
  /** Unix ms старта последнего собеса (для окна фри «1 / 3 дня»). */
  lastInterviewStartAt: number | null;

  noteInterviewStarted: () => void;
  interviewsUsedThisMonth: () => number;
}

export function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export const useUsageStore = create<UsageState>()(
  persist(
    (set, get) => ({
      interviewsByMonth: {},
      lastInterviewStartAt: null,

      noteInterviewStarted: () => {
        const key = monthKeyOf(new Date());
        set((state) => {
          const next: Record<string, number> = {
            ...state.interviewsByMonth,
            [key]: (state.interviewsByMonth[key] ?? 0) + 1,
          };
          // Держим только текущий и прошлый месяц — большего UI не показывает.
          for (const k of Object.keys(next)) {
            if (k !== key && k < monthKeyOf(new Date(Date.now() - 32 * 86_400_000))) {
              delete next[k];
            }
          }
          return { interviewsByMonth: next, lastInterviewStartAt: Date.now() };
        });
      },

      interviewsUsedThisMonth: () => {
        return get().interviewsByMonth[monthKeyOf(new Date())] ?? 0;
      },
    }),
    {
      name: "ai-interview-usage",
      storage: appPersistStorage,
      partialize: (state) => ({
        interviewsByMonth: state.interviewsByMonth,
        lastInterviewStartAt: state.lastInterviewStartAt,
      }),
    },
  ),
);

/** Окно фри-тарифа: 3 суток от старта прошлого собеса. */
export const FREE_WINDOW_MS = 3 * 86_400_000;

/** null — фри-собес доступен; иначе unix ms, когда окно откроется. */
export function freeWindowOpensAt(lastInterviewStartAt: number | null): number | null {
  if (lastInterviewStartAt === null) {
    return null;
  }
  const opensAt = lastInterviewStartAt + FREE_WINDOW_MS;
  return opensAt > Date.now() ? opensAt : null;
}
