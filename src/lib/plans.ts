import type { LicenseAuthStatus } from "@/stores/license";

/**
 * Тарифная сетка (23.07.2026). Клиентская копия матрицы лимитов — источник
 * правды для UI (что показать/спрятать и какие остатки рисовать). Серверный
 * enforcement появится отдельной фазой; цифры здесь и на сервере должны
 * совпадать, менять синхронно.
 */
export type PlanId = "free" | "study" | "pro" | "ultra";

export interface InterviewQuota {
  /** Сколько собесов доступно в окне. */
  limit: number;
  /** Окно квоты. */
  window: "3days" | "month";
}

export interface PlanLimits {
  id: PlanId;
  /** Название для UI. */
  title: string;
  /** Максимальная длительность одного собеса, минут. */
  maxInterviewMinutes: number;
  /** Квота на количество собесов; null = безлимит. */
  interviews: InterviewQuota | null;
  /** Доступно ли резюме (файлы контекста до собеса). */
  resumeAllowed: boolean;
  /** Доступно ли текстовое поле контекста (рядом с резюме на главной). */
  contextAllowed: boolean;
  /** Ножницы (снятие области экрана) за один собес; 0 = недоступны. */
  scissorsPerInterview: number;
  /** Загрузки файлов/скринов во время собеса, за один собес. */
  uploadsPerInterview: number;
  /** Аудио-подсказки (push-to-talk + «последние N сек») за один собес. */
  audioHintsPerInterview: number;
}

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    id: "free",
    title: "Фри",
    maxInterviewMinutes: 10,
    interviews: { limit: 1, window: "3days" },
    resumeAllowed: false,
    contextAllowed: false,
    scissorsPerInterview: 0,
    uploadsPerInterview: 1,
    audioHintsPerInterview: 10,
  },
  study: {
    id: "study",
    title: "Учебная",
    maxInterviewMinutes: 60,
    interviews: { limit: 20, window: "month" },
    resumeAllowed: true,
    contextAllowed: true,
    scissorsPerInterview: 10,
    uploadsPerInterview: 5,
    audioHintsPerInterview: 25,
  },
  pro: {
    id: "pro",
    title: "Про",
    maxInterviewMinutes: 60,
    interviews: { limit: 25, window: "month" },
    resumeAllowed: true,
    contextAllowed: true,
    scissorsPerInterview: 10,
    uploadsPerInterview: 10,
    audioHintsPerInterview: 30,
  },
  ultra: {
    id: "ultra",
    title: "Ультра",
    maxInterviewMinutes: 150,
    interviews: null,
    resumeAllowed: true,
    contextAllowed: true,
    scissorsPerInterview: 30,
    uploadsPerInterview: 30,
    audioHintsPerInterview: 50,
  },
};

/**
 * Сервер хранит план свободной строкой (ключи исторически выдавал бот).
 * Любой активный ключ с неопознанным планом считаем учебным — «все нынешние
 * лицензии — это учебка». Без активного ключа действует фри.
 */
export function planIdFromServerPlan(plan: string | null | undefined): PlanId {
  const normalized = (plan ?? "").trim().toLowerCase();
  if (normalized.includes("ultra") || normalized.includes("ультра")) {
    return "ultra";
  }
  if (normalized.includes("pro") || normalized.includes("про")) {
    return "pro";
  }
  return "study";
}

export function resolvePlanId(
  authStatus: LicenseAuthStatus,
  serverPlan: string | null | undefined,
): PlanId {
  // Просроченный/чужой/невалидный ключ деградирует до фри, как и его отсутствие.
  if (authStatus !== "active" && authStatus !== "activating") {
    return "free";
  }
  return planIdFromServerPlan(serverPlan);
}

export function planLimitsFor(
  authStatus: LicenseAuthStatus,
  serverPlan: string | null | undefined,
): PlanLimits {
  return PLAN_LIMITS[resolvePlanId(authStatus, serverPlan)];
}

/** «18 из 20» → остаток, не уходящий в минус. */
export function remainingOf(limit: number, used: number): number {
  return Math.max(0, limit - used);
}

export function formatInterviewQuota(quota: InterviewQuota | null): string {
  if (!quota) {
    return "без ограничений";
  }
  if (quota.window === "month") {
    return `${quota.limit} в месяц`;
  }
  return quota.limit === 1 ? "1 раз в 3 дня" : `${quota.limit} раз в 3 дня`;
}
