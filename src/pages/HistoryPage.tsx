import { useState, useEffect, useCallback } from "react";
import {
  Clock,
  Brain,
  Activity,
  TrendingUp,
  Trash2,
  AlertCircle,
  Star,
  FileText,
  X,
  Copy,
  Download,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useHistoryStore } from "@/stores/history";
import { useSettingsStore } from "@/stores/settings";
import { formatHistoryRetentionLabel } from "@/lib/historyRetention";
import { useT } from "@/lib/i18n";
import type { SessionRecord, FinalReport } from "@/lib/types";

const RETENTION_PRESETS: { label: string; days: number | null }[] = [
  { label: "7 дней", days: 7 },
  { label: "30 дней", days: 30 },
  { label: "90 дней", days: 90 },
  { label: "Бессрочно", days: null },
];

export function HistoryPage() {
  const t = useT();
  const { sessions, deleteSession, cleanup } = useHistoryStore();
  const historyRetentionDays = useSettingsStore((s) => s.historyRetentionDays);
  const setHistoryRetentionDays = useSettingsStore((s) => s.setHistoryRetentionDays);
  const [selected, setSelected] = useState<string | null>(null);
  const [retentionOpen, setRetentionOpen] = useState(false);

  useEffect(() => {
    cleanup();
  }, [cleanup]);

  useEffect(() => {
    if (!retentionOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setRetentionOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [retentionOpen]);

  const applyRetention = useCallback(
    (days: number | null) => {
      setHistoryRetentionDays(days);
      cleanup();
    },
    [cleanup, setHistoryRetentionDays],
  );

  const selectedSession = sessions.find((s) => s.id === selected);

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col px-5 py-8 sm:px-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-[1.9rem] font-bold leading-[1.05] tracking-[-0.03em] text-text-primary">
            {t("История")}
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-text-secondary">
            {historyRetentionDays === null
              ? t("Записи прошлых интервью хранятся здесь без ограничения по времени.")
              : t("Записи прошлых интервью хранятся {label}, потом удаляются автоматически.", {
                  label: formatHistoryRetentionLabel(historyRetentionDays),
                })}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setRetentionOpen(true)}
          className="shrink-0"
        >
          {t("Настроить хранение")}
        </Button>
      </div>

      {sessions.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="space-y-4 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl border border-border bg-white/60">
              <FileText className="h-7 w-7 text-accent" />
            </div>
            <p className="text-sm font-medium text-text-secondary">{t("Здесь пока пусто")}</p>
            <p className="max-w-xs text-xs leading-relaxed text-text-muted">
              {t("Проведите интервью — после завершения его запись с метриками и разбором появится здесь.")}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex gap-4 overflow-hidden min-h-0">
          {/* Session list */}
          <div className="w-80 shrink-0 overflow-y-auto space-y-2 pr-2">
            {sessions.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                isSelected={s.id === selected}
                onSelect={() => setSelected(s.id)}
                onDelete={() => {
                  deleteSession(s.id);
                  if (selected === s.id) setSelected(null);
                }}
              />
            ))}
          </div>

          {/* Detail panel */}
          <div className="flex-1 overflow-y-auto">
            {selectedSession ? (
              <SessionDetail session={selectedSession} onClose={() => setSelected(null)} />
            ) : (
              <div className="h-full flex items-center justify-center">
                <p className="text-sm text-text-muted">
                  {t("Выберите сессию, чтобы посмотреть детали.")}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {retentionOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={() => setRetentionOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-border bg-bg-card p-5 shadow-[0_30px_60px_-20px_rgba(24,28,55,0.35)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-text-primary">
                  {t("Сколько хранить записи")}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-text-muted">
                  {t("Старые интервью удаляются автоматически по истечении срока.")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRetentionOpen(false)}
                className="rounded-md p-1 text-text-muted transition-colors hover:text-text-secondary"
                title={t("Закрыть")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {RETENTION_PRESETS.map((preset) => {
                const active =
                  preset.days === null
                    ? historyRetentionDays === null
                    : historyRetentionDays === preset.days;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => applyRetention(preset.days)}
                    className={`rounded-xl border px-3 py-2.5 text-sm font-semibold transition-colors ${
                      active
                        ? "border-accent bg-accent text-white shadow-[0_2px_8px_-2px_rgba(59,91,219,0.5)]"
                        : "border-border bg-bg-card text-text-secondary hover:border-border-active hover:bg-bg-tertiary/50 hover:text-text-primary"
                    }`}
                  >
                    {t(preset.label)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SessionCard({
  session,
  isSelected,
  onSelect,
  onDelete,
}: {
  session: SessionRecord;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const date = new Date(session.startedAt);

  return (
    <div
      onClick={onSelect}
      className={`
        relative cursor-pointer rounded-2xl border p-3.5 transition-all
        ${isSelected
          ? "border-accent/40 bg-accent/[0.07] shadow-[inset_0_0_0_1px_rgba(61,91,255,0.15)]"
          : "border-border bg-white/60 hover:-translate-y-0.5 hover:border-border-active hover:shadow-[0_16px_30px_-24px_rgba(35,40,90,0.5)]"}
      `}
    >
      {isSelected && (
        <span className="absolute left-0 top-1/2 h-8 w-1 -translate-y-1/2 rounded-full gradient-aurora" />
      )}
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm font-medium text-text-primary">
            {date.toLocaleDateString("ru-RU", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </div>
          <div className="text-xs text-text-muted mt-0.5">
            {date.toLocaleTimeString("ru-RU", {
              hour: "2-digit",
              minute: "2-digit",
            })}
            {" · "}
            {formatDuration(session.metrics.durationMs)}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {session.finalReport && (
            <Badge variant="success">
              <Star className="w-3 h-3" />
              {session.finalReport.overallScore}/5
            </Badge>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="p-1 text-text-muted hover:text-danger transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="flex items-center gap-3 mt-2 text-[10px] text-text-muted">
        <span>{session.model}</span>
        <span>{t("{count} запросов", { count: session.metrics.llmRequestCount })}</span>
      </div>
    </div>
  );
}

function SessionDetail({ session, onClose }: { session: SessionRecord; onClose: () => void }) {
  const t = useT();
  const date = new Date(session.startedAt);
  const { metrics, finalReport } = session;
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);

  const markdown = buildSessionMarkdown(session);

  const copyMarkdown = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopiedMarkdown(true);
      window.setTimeout(() => setCopiedMarkdown(false), 1800);
    } catch {
      setCopiedMarkdown(false);
    }
  }, [markdown]);

  const downloadMarkdown = useCallback(() => {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ai-interview-${new Date(session.startedAt).toISOString().slice(0, 10)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [markdown, session.startedAt]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-xl font-bold tracking-[-0.02em] text-text-primary">
            {t("Сессия интервью")}
          </h2>
          <p className="text-xs text-text-muted">
            {date.toLocaleDateString("ru-RU", {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
            {" в "}
            {date.toLocaleTimeString("ru-RU", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>
        <button onClick={onClose} className="p-1 text-text-muted hover:text-text-secondary">
          <X className="w-5 h-5" />
        </button>
      </div>

      <Card title={t("Метрики")}>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <MetricItem
            icon={<Clock className="w-4 h-4" />}
            label={t("Длительность")}
            value={formatDuration(metrics.durationMs)}
          />
          <MetricItem
            icon={<Brain className="w-4 h-4" />}
            label={t("Запросы")}
            value={metrics.llmRequestCount.toString()}
          />
          <MetricItem
            icon={<Activity className="w-4 h-4" />}
            label={t("Старт ответа")}
            value={`${Math.round(metrics.avgFirstTokenLatencyMs)}ms`}
          />
          <MetricItem
            icon={<Activity className="w-4 h-4" />}
            label={t("Полная задержка")}
            value={`${Math.round(metrics.avgTotalLatencyMs)}ms`}
          />
          <MetricItem
            icon={<TrendingUp className="w-4 h-4" />}
            label={t("Вы говорили")}
            value={`${Math.round(metrics.userSpeechRatio * 100)}%`}
          />
          <MetricItem
            icon={<TrendingUp className="w-4 h-4" />}
            label={t("Собеседник")}
            value={`${Math.round(metrics.interviewerSpeechRatio * 100)}%`}
          />
        </div>
      </Card>

      {(session.interviewContext ||
        (session.contextFiles && session.contextFiles.length > 0)) && (
        <Card title={t("Контекст интервью")}>
          <div className="space-y-4">
            {session.interviewContext && (
              <div>
                <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-text-muted">
                  {t("Тема")}
                </h4>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">
                  {session.interviewContext}
                </p>
              </div>
            )}
            {session.contextFiles && session.contextFiles.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-text-muted">
                  {t("Файлы ({count})", { count: session.contextFiles.length })}
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {session.contextFiles.map((file, i) => (
                    <span
                      key={`${file.name}-${i}`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg-secondary px-2 py-1 text-[11px]"
                      title={`${file.name} · ${formatFileSize(file.size)}`}
                    >
                      <FileText className="h-3 w-3 shrink-0 text-accent" />
                      <span className="max-w-[180px] truncate font-medium text-text-primary">
                        {file.name}
                      </span>
                      <span className="shrink-0 text-text-muted">{formatFileSize(file.size)}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      <Card>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span>
            {t("Режим:")}{" "}
            <span className={session.mode === "safe" ? "text-warning" : "text-success"}>
              {session.mode === "safe" ? t("Без аудио") : t("С распознаванием")}
            </span>
          </span>
        </div>
        {session.safeModeReason && (
          <div className="mt-2 text-xs leading-relaxed text-text-muted">
            {session.safeModeReason}
          </div>
        )}
      </Card>

      <Card title={t("Материалы сессии")}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs leading-relaxed text-text-muted">
              {t("Сохраняем последние фразы и ответы помощника, чтобы можно было разобрать интервью после завершения.")}
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={copyMarkdown}
              icon={<Copy className="h-3.5 w-3.5" />}
            >
              {copiedMarkdown ? t("Скопировано") : t("Скопировать Markdown")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={downloadMarkdown}
              icon={<Download className="h-3.5 w-3.5" />}
            >
              {t("Скачать Markdown")}
            </Button>
          </div>

          {session.aiResponses && session.aiResponses.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-text-muted">
                {t("Ответы помощника")}
              </h4>
              <div className="space-y-2">
                {session.aiResponses.slice(-5).map((response) => (
                  <div
                    key={response.id}
                    className="rounded-lg border border-border bg-bg-secondary p-3 text-xs leading-relaxed text-text-secondary"
                  >
                    <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-text-muted">
                      {new Date(response.timestamp).toLocaleTimeString("ru-RU", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </div>
                    <div className="max-h-44 overflow-y-auto whitespace-pre-wrap">
                      {response.text || t("Пустой ответ")}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {session.transcript && session.transcript.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-text-muted">
                {t("Последние фразы")}
              </h4>
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border bg-bg-secondary p-3">
                {session.transcript.slice(-30).map((message) => (
                  <div key={message.id} className="text-xs leading-relaxed text-text-secondary">
                    <span className="text-text-muted">
                      {message.source === "interviewer"
                        ? t("Интервьюер")
                        : message.source === "user"
                          ? t("Вы")
                          : t("Система")}
                      :
                    </span>{" "}
                    {message.text}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>

      {finalReport && <ReportCard report={finalReport} />}

      {!finalReport && (
        <div className="flex items-start gap-2.5 p-3 bg-bg-secondary border border-border rounded-lg">
          <AlertCircle className="w-4 h-4 text-text-muted mt-0.5 shrink-0" />
          <p className="text-xs text-text-muted">
            {t("Для этой сессии финальный отчёт не был сгенерирован. Включите «Финальный отчёт» в настройках перед началом интервью.")}
          </p>
        </div>
      )}
    </div>
  );
}

function buildSessionMarkdown(session: SessionRecord): string {
  const started = new Date(session.startedAt).toLocaleString("ru-RU");
  const contextFilesLine =
    session.contextFiles && session.contextFiles.length > 0
      ? `Файлы: ${session.contextFiles.map((file) => file.name).join(", ")}`
      : null;
  const lines = [
    `# Interview session`,
    "",
    `Старт: ${started}`,
    `Длительность: ${formatDuration(session.metrics.durationMs)}`,
    `Режим: ${session.mode === "safe" ? "Без аудио" : "С распознаванием"}`,
    session.safeModeReason ? `Причина режима без аудио: ${session.safeModeReason}` : null,
    session.interviewContext ? `Тема: ${session.interviewContext}` : null,
    contextFilesLine,
    `Запросов: ${session.metrics.llmRequestCount}`,
    "",
    "## Ответы помощника",
    "",
  ].filter((line): line is string => line !== null);

  const responses = session.aiResponses ?? [];
  if (responses.length === 0) {
    lines.push("_Ответы не сохранены._", "");
  } else {
    responses.forEach((response, index) => {
      lines.push(`### Ответ ${index + 1}`, "", response.text || "_Пустой ответ_", "");
    });
  }

  lines.push("## Транскрипт", "");
  const transcript = session.transcript ?? [];
  if (transcript.length === 0) {
    lines.push("_Транскрипт не сохранен._", "");
  } else {
    transcript.forEach((message) => {
      const speaker =
        message.source === "interviewer"
          ? "Собеседник"
          : message.source === "user"
            ? "Вы"
            : "Система";
      lines.push(`- **${speaker}:** ${message.text}`);
    });
  }

  return lines.join("\n");
}

function ReportCard({ report }: { report: FinalReport }) {
  const t = useT();
  return (
    <Card title={t("Финальный отчёт")}>
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-2xl gradient-primary text-white glow-accent">
            <div className="font-display text-2xl font-bold leading-none">
              {report.overallScore}
            </div>
            <div className="mt-0.5 text-[9px] uppercase tracking-[0.14em] text-white/80">{t("Итог")}</div>
          </div>
          <div className="text-center">
            <div className="font-display text-3xl font-bold text-text-secondary">
              {report.interviewerScore}
            </div>
            <div className="text-[10px] text-text-muted">{t("Оценка собеседника")}</div>
          </div>
          <p className="flex-1 text-xs text-text-muted">
            {report.interviewerComment}
          </p>
        </div>

        <ReportSection title={t("Сильные стороны")} items={report.strengths} variant="success" />
        <ReportSection title={t("Слабые стороны")} items={report.weaknesses} variant="danger" />
        <ReportSection title={t("Что улучшить")} items={report.improvements} variant="warning" />
      </div>
    </Card>
  );
}

function ReportSection({
  title,
  items,
  variant,
}: {
  title: string;
  items: string[];
  variant: "success" | "danger" | "warning";
}) {
  const colors = {
    success: "text-success",
    danger: "text-danger",
    warning: "text-warning",
  };

  return (
    <div>
      <h4 className={`text-xs font-semibold ${colors[variant]} mb-1.5`}>
        {title}
      </h4>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-xs text-text-secondary flex items-start gap-1.5">
            <span className={`mt-1.5 w-1 h-1 rounded-full shrink-0 bg-current ${colors[variant]}`} />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MetricItem({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-3.5">
      <div className="mb-1.5 flex items-center gap-2 text-text-muted">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-muted text-accent">
          {icon}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em]">{label}</span>
      </div>
      <div className="font-display text-lg font-semibold tracking-[-0.01em] text-text-primary">{value}</div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}ч ${m % 60}м`;
  if (m > 0) return `${m}м ${s % 60}с`;
  return `${s}с`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

