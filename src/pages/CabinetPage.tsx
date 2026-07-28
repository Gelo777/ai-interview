import { useCallback, useEffect, useState } from "react";
import {
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  MonitorSmartphone,
  CalendarCheck,
  Activity,
  Copy,
  Check,
  Clock,
  Scissors,
  Paperclip,
  FileText,
  AudioLines,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useSettingsStore } from "@/stores/settings";
import { useLicenseStore, type LicenseAuthStatus } from "@/stores/license";
import {
  PLAN_LIMITS,
  formatInterviewQuota,
  resolvePlanId,
  type PlanId,
} from "@/lib/plans";
import { freeWindowOpensAt, monthKeyOf, useUsageStore } from "@/stores/usage";
import { useT } from "@/lib/i18n";

function pluralizeDays(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) {
    return "дней";
  }
  if (last === 1) {
    return "день";
  }
  if (last >= 2 && last <= 4) {
    return "дня";
  }
  return "дней";
}

function formatDateRu(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function formatDateTimeRu(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatTimeRu(ms: number): string {
  return new Date(ms).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function daysLeft(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export function CabinetPage() {
  const t = useT();
  const apiKey = useSettingsStore((s) => s.apiKey);
  const setApiKey = useSettingsStore((s) => s.setApiKey);

  const authStatus = useLicenseStore((s) => s.authStatus);
  const snapshot = useLicenseStore((s) => s.snapshot);
  const activationError = useLicenseStore((s) => s.activationError);
  const revalidating = useLicenseStore((s) => s.revalidating);
  const lastSyncError = useLicenseStore((s) => s.lastSyncError);
  const activate = useLicenseStore((s) => s.activate);
  const revalidate = useLicenseStore((s) => s.revalidate);

  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    // Refresh usage/status whenever the cabinet is opened.
    void revalidate();
  }, [revalidate]);

  const isActivating = authStatus === "activating";
  const hasKey = apiKey.trim().length > 0;
  // Once a snapshot exists we stay on the dashboard cards even during a re-activation
  // (changing the key from the "Ключ" card) — the full activation screen only shows
  // on the very first activation, when there is nothing to display yet.
  const showActivation =
    authStatus === "unactivated" ||
    (!snapshot &&
      (authStatus === "activating" ||
        authStatus === "device_mismatch" ||
        authStatus === "invalid"));

  const handleActivate = useCallback(() => {
    if (!hasKey || isActivating) {
      return;
    }
    void activate(apiKey);
  }, [activate, apiKey, hasKey, isActivating]);

  return (
    <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8">
      <div className="mb-6">
        <h1 className="font-display text-[1.9rem] font-bold leading-[1.05] tracking-[-0.03em] text-text-primary">
          {t("Кабинет")}
        </h1>
        <p className="mt-1.5 text-sm leading-6 text-text-secondary">
          {t("Лицензия, использование и устройство.")}
        </p>
      </div>

      {showActivation ? (
        <div className="space-y-5">
          <ActivationCard
            apiKey={apiKey}
            setApiKey={setApiKey}
            showKey={showKey}
            setShowKey={setShowKey}
            isActivating={isActivating}
            hasKey={hasKey}
            activationError={activationError}
            onActivate={handleActivate}
          />
          <Card
            title={t("Тариф «Фри»")}
            description={t(
              "Действует без ключа. Активируйте ключ, чтобы поднять лимиты.",
            )}
          >
            <PlanLimitsSection planId="free" />
          </Card>
        </div>
      ) : (
        <div className="space-y-5">
          <LicenseCard
            authStatus={authStatus}
            snapshot={snapshot}
            lastSyncError={lastSyncError}
            revalidating={revalidating}
            onRecheck={() => void revalidate({ force: true })}
          />
          <KeyCard
            apiKey={apiKey}
            activate={activate}
            isActivating={isActivating}
            activationError={activationError}
          />
          <UsageCard
            snapshot={snapshot}
            revalidating={revalidating}
            onRefresh={() => void revalidate({ force: true })}
          />
          <DeviceCard snapshot={snapshot} />
        </div>
      )}
    </div>
  );
}

function ActivationCard({
  apiKey,
  setApiKey,
  showKey,
  setShowKey,
  isActivating,
  hasKey,
  activationError,
  onActivate,
}: {
  apiKey: string;
  setApiKey: (value: string) => void;
  showKey: boolean;
  setShowKey: (value: boolean) => void;
  isActivating: boolean;
  hasKey: boolean;
  activationError: string | null;
  onActivate: () => void;
}) {
  const t = useT();
  return (
    <Card
      title={t("Активация")}
      description={t("Введите лицензионный ключ из бота — приложение привяжет его к этому устройству.")}
    >
      <div className="flex flex-col gap-2.5 sm:flex-row">
        <div className="relative flex-1">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onActivate();
              }
            }}
            disabled={isActivating}
            placeholder={t("Введите лицензионный ключ")}
            className="w-full rounded-xl border border-border bg-bg-input px-3.5 py-3 pr-12
              text-sm text-text-primary placeholder:text-text-muted transition-all
              focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25
              disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-secondary"
          >
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <Button
          variant="primary"
          onClick={onActivate}
          disabled={isActivating || !hasKey}
          icon={isActivating ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
          className="shrink-0"
        >
          {isActivating ? t("Активируем...") : t("Активировать")}
        </Button>
      </div>

      {activationError && !isActivating && (
        <p className="mt-3 text-sm leading-6 text-danger">{activationError}</p>
      )}
    </Card>
  );
}

function maskKey(key: string): string {
  const k = key.trim();
  if (!k) {
    return "—";
  }
  if (k.length <= 8) {
    return "•".repeat(Math.max(4, k.length));
  }
  return `${k.slice(0, 4)}-••••-••••-${k.slice(-4)}`;
}

function KeyCard({
  apiKey,
  activate,
  isActivating,
  activationError,
}: {
  apiKey: string;
  activate: (key: string) => Promise<boolean>;
  isActivating: boolean;
  activationError: string | null;
}) {
  const t = useT();
  const trimmed = apiKey.trim();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [changing, setChanging] = useState(false);
  const [newKey, setNewKey] = useState("");

  const copyKey = useCallback(async () => {
    if (!trimmed) {
      return;
    }
    try {
      await navigator.clipboard.writeText(trimmed);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked — reveal the key so it can be copied manually.
      setRevealed(true);
    }
  }, [trimmed]);

  const submitNew = useCallback(async () => {
    const next = newKey.trim();
    if (!next || isActivating) {
      return;
    }
    const ok = await activate(next);
    if (ok) {
      setChanging(false);
      setNewKey("");
    }
  }, [activate, isActivating, newKey]);

  return (
    <Card title={t("Ключ")} description={t("Лицензионный ключ, привязанный к этому устройству.")}>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-xl border border-border bg-bg-secondary/60 px-3.5 py-2.5 font-mono text-sm text-text-primary">
          {revealed ? trimmed || "—" : maskKey(trimmed)}
        </code>
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          className="shrink-0 rounded-xl border border-border bg-bg-input p-2.5 text-text-muted transition-colors hover:text-text-secondary"
          aria-label={revealed ? t("Скрыть ключ") : t("Показать ключ")}
        >
          {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={() => void copyKey()}
          disabled={!trimmed}
          className="shrink-0 rounded-xl border border-border bg-bg-input p-2.5 text-text-muted transition-colors hover:text-text-secondary disabled:opacity-50"
          aria-label={t("Скопировать ключ")}
        >
          {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>

      {!changing ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setChanging(true)}
          className="mt-3"
        >
          {t("Сменить ключ")}
        </Button>
      ) : (
        <div className="mt-3 space-y-2.5">
          <input
            type="text"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitNew();
              }
            }}
            disabled={isActivating}
            placeholder={t("Введите новый ключ")}
            className="w-full rounded-xl border border-border bg-bg-input px-3.5 py-3 text-sm text-text-primary
              placeholder:text-text-muted transition-all focus:border-accent focus:outline-none
              focus:ring-2 focus:ring-accent/25 disabled:opacity-50"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void submitNew()}
              disabled={isActivating || !newKey.trim()}
              icon={isActivating ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
            >
              {isActivating ? t("Активируем...") : t("Активировать новый")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setChanging(false);
                setNewKey("");
              }}
              disabled={isActivating}
            >
              {t("Отмена")}
            </Button>
          </div>
          {activationError && !isActivating && (
            <p className="text-sm leading-6 text-danger">{activationError}</p>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * Backend plans are either paid ("PRO", "FOREVER", custom) or trials
 * ("TRIAL", "TRIAL_DAY", "TRIAL_WEEK", "TRIAL_MONTH"). Only paid tiers get the
 * solid accent treatment — a highlighted trial would misrepresent the account.
 */
function isTrialPlan(plan: string): boolean {
  return plan.trim().toUpperCase().startsWith("TRIAL");
}

function LicenseCard({
  authStatus,
  snapshot,
  lastSyncError,
  revalidating,
  onRecheck,
}: {
  authStatus: string;
  snapshot: ReturnType<typeof useLicenseStore.getState>["snapshot"];
  lastSyncError: string | null;
  revalidating: boolean;
  onRecheck: () => void;
}) {
  const t = useT();
  const isExpired = authStatus === "expired";
  const hasSnapshot = snapshot !== null;
  const plan = snapshot?.plan?.trim() || null;
  const planId = resolvePlanId(authStatus as LicenseAuthStatus, snapshot?.plan ?? null);
  const expiresAt = snapshot?.expiresAt ?? null;
  const expiryLabel = formatDateRu(expiresAt);
  const isPerpetual = hasSnapshot && expiresAt === null;
  const remaining = expiresAt ? daysLeft(expiresAt) : null;

  // Fraction of the license period left drives the ring; the period is derived
  // from the device activation date when the server provides it.
  const activatedMs = snapshot?.device?.activatedAt
    ? new Date(snapshot.device.activatedAt).getTime()
    : NaN;
  const expiresMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
  const periodDays =
    Number.isFinite(activatedMs) && Number.isFinite(expiresMs) && expiresMs > activatedMs
      ? Math.max(1, Math.round((expiresMs - activatedMs) / 86_400_000))
      : null;

  const expiringSoon = !isExpired && remaining !== null && remaining <= 5;
  const ringPercent = isPerpetual
    ? 100
    : isExpired
      ? 0
      : remaining === null
        ? 100
        : (remaining / (periodDays ?? 30)) * 100;
  const ringTone = isExpired ? "danger" : expiringSoon ? "warning" : "accent";

  const countdownText =
    hasSnapshot && !isPerpetual && !isExpired && remaining !== null && remaining >= 0
      ? periodDays
        ? t("Осталось {remaining} {days} из {total}", {
            remaining,
            days: pluralizeDays(remaining),
            total: periodDays,
          })
        : t("Осталось {remaining} {days}", { remaining, days: pluralizeDays(remaining) })
      : null;

  return (
    <Card title={t("Лицензия")}>
      <div className="flex flex-wrap items-center gap-7">
        {hasSnapshot && (
          <LicenseRing
            percent={ringPercent}
            tone={ringTone}
            centerTop={isPerpetual ? "∞" : String(Math.max(0, remaining ?? 0))}
            centerBottom={isPerpetual ? null : pluralizeDays(Math.max(0, remaining ?? 0))}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            {plan && (
              <span title={plan}>
                {isTrialPlan(plan) ? (
                  <Badge variant="muted" className="px-3 py-1 text-[13px]">
                    {t("Тариф «{plan}»", { plan: PLAN_LIMITS[planId].title })}
                  </Badge>
                ) : (
                  <Badge
                    variant="accent"
                    className="gap-1.5 px-3 py-1 text-[13px] tracking-[0.01em]"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {t("Тариф «{plan}»", { plan: PLAN_LIMITS[planId].title })}
                  </Badge>
                )}
              </span>
            )}
            {isExpired ? (
              <Badge variant="danger">{t("Срок действия истёк")}</Badge>
            ) : (
              <Badge variant="success">
                <span className="h-1.5 w-1.5 rounded-full bg-success animate-glow" />
                {t("Активна")}
              </Badge>
            )}
          </div>

          <div className="mt-3">
            {isPerpetual ? (
              <p className="font-display text-2xl font-bold leading-tight tracking-[-0.02em] text-text-primary">
                {t("Бессрочная лицензия")}
              </p>
            ) : expiryLabel ? (
              <p
                className={`font-display text-2xl font-bold leading-tight tracking-[-0.02em] ${
                  isExpired ? "text-danger" : "text-text-primary"
                }`}
              >
                {isExpired
                  ? t("Срок действия истёк {expiryLabel}", { expiryLabel })
                  : t("Действует до {expiryLabel}", { expiryLabel })}
              </p>
            ) : (
              <p className="text-base text-text-muted">{t("Синхронизируем статус лицензии...")}</p>
            )}
            {countdownText && (
              <p
                className={`mt-1.5 text-sm leading-6 ${
                  expiringSoon ? "font-medium text-warning" : "text-text-secondary"
                }`}
              >
                {countdownText}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-6 border-t border-border pt-5">
        <div className="mb-3 text-sm font-semibold tracking-[-0.01em] text-text-secondary">
          {t("Лимиты тарифа")}
        </div>
        <PlanLimitsSection planId={planId} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onRecheck}
          disabled={revalidating}
          icon={<RefreshCw className={`h-3.5 w-3.5 ${revalidating ? "animate-spin" : ""}`} />}
        >
          {t("Проверить лицензию")}
        </Button>
        {lastSyncError && snapshot && (
          <span className="text-xs text-text-muted">
            {t("Не удалось обновить, данные на {time}.", { time: formatTimeRu(snapshot.syncedAt) })}
          </span>
        )}
      </div>
    </Card>
  );
}

const RING_TONE_COLOR = {
  accent: "var(--color-accent)",
  warning: "var(--color-warning)",
  danger: "var(--color-danger)",
} as const;

function LicenseRing({
  percent,
  tone,
  centerTop,
  centerBottom,
}: {
  percent: number;
  tone: keyof typeof RING_TONE_COLOR;
  centerTop: string;
  centerBottom?: string | null;
}) {
  const r = 34;
  const circ = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, percent));
  const offset = circ * (1 - clamped / 100);
  return (
    <div className="relative h-32 w-32 shrink-0">
      <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--color-border)" strokeWidth="6" />
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          stroke={RING_TONE_COLOR[tone]}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(0.22,1,0.36,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-[2.4rem] font-bold leading-none tracking-[-0.03em] text-text-primary">
          {centerTop}
        </span>
        {centerBottom && (
          <span className="mt-1 text-[13px] leading-none text-text-muted">{centerBottom}</span>
        )}
      </div>
    </div>
  );
}

function LimitTile({
  icon: Icon,
  label,
  value,
  usedToday = null,
  limit,
  usageText = null,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
  usedToday?: number | null;
  limit?: number;
  /** Подпись под прогресс-баром вместо дефолтной «Сегодня: n». */
  usageText?: string | null;
}) {
  const t = useT();
  const showUsage =
    usedToday !== null && typeof limit === "number" && Number.isFinite(limit) && limit > 0;
  const usedPercent = showUsage
    ? Math.max(usedToday > 0 ? 2 : 0, Math.min(100, (usedToday / limit) * 100))
    : 0;
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary/50 p-4">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent-muted text-accent">
          <Icon className="h-4 w-4" />
        </span>
        <span className="text-[13px] font-medium leading-tight text-text-secondary">{label}</span>
      </div>
      <div className="mt-3.5 font-display text-2xl font-bold tracking-[-0.02em] text-text-primary">
        {value}
      </div>
      {showUsage && (
        <div className="mt-2.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
            <div
              className="h-full rounded-full bg-accent/70 transition-[width] duration-500"
              style={{ width: `${usedPercent}%` }}
            />
          </div>
          <div className="mt-2 text-xs leading-none text-text-muted">
            {usageText ?? t("Сегодня: {n}", { n: usedToday })}
          </div>
        </div>
      )}
    </div>
  );
}

function formatInterviewMinutes(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} мин`;
  }
  return `${(minutes / 60).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ч`;
}

/**
 * Лимиты тарифа из клиентской матрицы (plans.ts). Месячный счёт собесов пока
 * локальный (лицензия привязана к устройству, так что оценка честная); при
 * появлении серверных квот цифры заместятся серверными.
 */
function PlanLimitsSection({ planId }: { planId: PlanId }) {
  const t = useT();
  const limits = PLAN_LIMITS[planId];
  const interviewsUsed = useUsageStore(
    (s) => s.interviewsByMonth[monthKeyOf(new Date())] ?? 0,
  );
  const lastInterviewStartAt = useUsageStore((s) => s.lastInterviewStartAt);
  const quota = limits.interviews;
  const monthQuota = quota && quota.window === "month" ? quota : null;
  const freeOpensAt = planId === "free" ? freeWindowOpensAt(lastInterviewStartAt) : null;

  return (
    <div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <LimitTile
          icon={Clock}
          label={t("Длительность собеса")}
          value={t("до {n}", { n: formatInterviewMinutes(limits.maxInterviewMinutes) })}
        />
        <LimitTile
          icon={CalendarCheck}
          label={t("Собесы")}
          value={formatInterviewQuota(quota)}
          usedToday={monthQuota ? interviewsUsed : null}
          limit={monthQuota?.limit}
          usageText={monthQuota ? t("В этом месяце: {n}", { n: interviewsUsed }) : null}
        />
        <LimitTile
          icon={Scissors}
          label={t("Ножницы за один собес")}
          value={
            limits.scissorsPerInterview === 0
              ? t("Недоступны")
              : t("до {n}", { n: limits.scissorsPerInterview })
          }
        />
        <LimitTile
          icon={Paperclip}
          label={t("Загрузки файлов за один собес")}
          value={t("до {n}", { n: limits.uploadsPerInterview })}
        />
        <LimitTile
          icon={AudioLines}
          label={t("Аудио-подсказки за один собес")}
          value={t("до {n}", { n: limits.audioHintsPerInterview })}
        />
        <LimitTile
          icon={FileText}
          label={t("Резюме и контекст")}
          value={limits.resumeAllowed ? t("Доступны") : t("Недоступны")}
        />
      </div>
      {freeOpensAt && (
        <p className="mt-3 text-xs leading-relaxed text-warning">
          {t("Фри-собес использован. Следующий будет доступен {when}.", {
            when: formatDateTimeRu(new Date(freeOpensAt).toISOString()) ?? "",
          })}
        </p>
      )}
      <p className="mt-3 text-xs leading-relaxed text-text-muted">
        {t("Остатки за текущий собес показываются в оверлее рядом с таймером.")}
      </p>
    </div>
  );
}

function UsageCard({
  snapshot,
  revalidating,
  onRefresh,
}: {
  snapshot: ReturnType<typeof useLicenseStore.getState>["snapshot"];
  revalidating: boolean;
  onRefresh: () => void;
}) {
  const t = useT();
  const usage = snapshot?.usageToday ?? null;
  const format = (value: number) => value.toLocaleString("ru-RU");

  return (
    <Card title={t("Использование сегодня")}>
      {usage ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <UsageStat label={t("Подсказки")} value={format(usage.hints)} />
          <UsageStat label={t("Токены ИИ")} value={format(usage.llmTokens)} />
          <UsageStat label={t("Скриншоты")} value={format(usage.snapshots)} />
        </div>
      ) : (
        <p className="text-sm text-text-muted">{t("Данные об использовании пока недоступны.")}</p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={revalidating}
          icon={<RefreshCw className={`h-3.5 w-3.5 ${revalidating ? "animate-spin" : ""}`} />}
        >
          {t("Обновить")}
        </Button>
        {snapshot && (
          <span className="text-xs text-text-muted">
            {t("Обновлено в {time}", { time: formatTimeRu(snapshot.syncedAt) })}
          </span>
        )}
      </div>
    </Card>
  );
}

function UsageStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary/60 px-4 py-3.5">
      <div className="text-[13px] font-medium leading-tight text-text-secondary">{label}</div>
      <div className="mt-1.5 font-display text-2xl font-bold tracking-[-0.02em] text-text-primary">
        {value}
      </div>
    </div>
  );
}

function DeviceCard({
  snapshot,
}: {
  snapshot: ReturnType<typeof useLicenseStore.getState>["snapshot"];
}) {
  const t = useT();
  const device = snapshot?.device ?? null;
  const activatedAt = formatDateTimeRu(device?.activatedAt ?? null);
  const lastSeenAt = formatDateTimeRu(device?.lastSeenAt ?? null);

  const bound = device?.bound ?? true;

  return (
    <Card title={t("Устройство")}>
      <div className="flex items-start gap-3.5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-border bg-bg-tertiary">
          <MonitorSmartphone className="h-[22px] w-[22px] text-text-secondary" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-text-primary">
              {device?.name?.trim() || t("Это устройство")}
            </p>
            {bound && (
              <Badge variant="success">
                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                {t("Активно")}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs leading-5 text-text-muted">
            {t("Лицензия привязана к этому устройству")}
          </p>
        </div>
      </div>

      {(activatedAt || lastSeenAt) && (
        <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {activatedAt && (
            <DeviceInfo
              icon={<CalendarCheck className="h-4 w-4" />}
              label={t("Активировано")}
              value={activatedAt}
            />
          )}
          {lastSeenAt && (
            <DeviceInfo
              icon={<Activity className="h-4 w-4" />}
              label={t("Последняя активность")}
              value={lastSeenAt}
            />
          )}
        </div>
      )}
    </Card>
  );
}

function DeviceInfo({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-2xl border border-border bg-bg-secondary/50 px-4 py-3">
      <span className="mt-0.5 shrink-0 text-text-muted">{icon}</span>
      <div className="min-w-0">
        <div className="text-[13px] font-medium leading-tight text-text-secondary">{label}</div>
        <div className="mt-1 text-sm leading-5 text-text-primary">{value}</div>
      </div>
    </div>
  );
}
