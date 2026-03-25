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
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useHistoryStore } from "@/stores/history";
import { useAppStore } from "@/stores/app";
import { useSettingsStore } from "@/stores/settings";
import { formatHistoryRetentionLabel } from "@/lib/historyRetention";
import { providerLabel } from "@/lib/llm";
import type { SessionRecord, FinalReport } from "@/lib/types";

export function HistoryPage() {
  const { sessions, deleteSession, cleanup } = useHistoryStore();
  const historyRetentionDays = useSettingsStore((s) => s.historyRetentionDays);
  const { setSettingsTab, setSettingsFocus, setView } = useAppStore();
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    cleanup();
  }, [cleanup]);

  const openRetentionSettings = useCallback(() => {
    setSettingsTab("storage");
    setSettingsFocus("storage-history-retention");
    setView("settings");
  }, [setSettingsFocus, setSettingsTab, setView]);

  const selectedSession = sessions.find((s) => s.id === selected);

  return (
    <div className="p-6 max-w-5xl h-full flex flex-col">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">History</h1>
          <p className="text-sm text-text-muted mt-1">
            {historyRetentionDays === null
              ? "Interview history is kept forever."
              : `Interview history is kept for ${formatHistoryRetentionLabel(historyRetentionDays)} and then deleted automatically.`}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={openRetentionSettings}
          className="shrink-0"
        >
          Configure
        </Button>
      </div>

      {sessions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <FileText className="w-12 h-12 text-text-muted mx-auto" />
            <p className="text-sm text-text-muted">No sessions recorded yet.</p>
            <p className="text-xs text-text-muted">
              Complete an interview to see it here.
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
                  Select a session to view details.
                </p>
              </div>
            )}
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
  const date = new Date(session.startedAt);

  return (
    <div
      onClick={onSelect}
      className={`
        p-3 rounded-lg border cursor-pointer transition-all
        ${isSelected ? "border-accent bg-accent-muted" : "border-border hover:border-border-active bg-bg-secondary"}
      `}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm font-medium text-text-primary">
            {date.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </div>
          <div className="text-xs text-text-muted mt-0.5">
            {date.toLocaleTimeString("en-US", {
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
        <span>{session.metrics.llmRequestCount} requests</span>
      </div>
    </div>
  );
}

function SessionDetail({ session, onClose }: { session: SessionRecord; onClose: () => void }) {
  const date = new Date(session.startedAt);
  const { metrics, finalReport } = session;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-text-primary">
            Interview Session
          </h2>
          <p className="text-xs text-text-muted">
            {date.toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
            {" at "}
            {date.toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>
        <button onClick={onClose} className="p-1 text-text-muted hover:text-text-secondary">
          <X className="w-5 h-5" />
        </button>
      </div>

      <Card title="Metrics">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <MetricItem
            icon={<Clock className="w-4 h-4" />}
            label="Duration"
            value={formatDuration(metrics.durationMs)}
          />
          <MetricItem
            icon={<Brain className="w-4 h-4" />}
            label="LLM Requests"
            value={metrics.llmRequestCount.toString()}
          />
          <MetricItem
            icon={<Activity className="w-4 h-4" />}
            label="Avg First Token"
            value={`${Math.round(metrics.avgFirstTokenLatencyMs)}ms`}
          />
          <MetricItem
            icon={<Activity className="w-4 h-4" />}
            label="Avg Total Latency"
            value={`${Math.round(metrics.avgTotalLatencyMs)}ms`}
          />
          <MetricItem
            icon={<TrendingUp className="w-4 h-4" />}
            label="Your Speech"
            value={`${Math.round(metrics.userSpeechRatio * 100)}%`}
          />
          <MetricItem
            icon={<TrendingUp className="w-4 h-4" />}
            label="Interviewer"
            value={`${Math.round(metrics.interviewerSpeechRatio * 100)}%`}
          />
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span>Model: <span className="text-text-secondary">{session.model}</span></span>
          <span>·</span>
          <span>Provider: <span className="text-text-secondary">{providerLabel(session.provider)}</span></span>
        </div>
      </Card>

      {finalReport && <ReportCard report={finalReport} />}

      {!finalReport && (
        <div className="flex items-start gap-2.5 p-3 bg-bg-secondary border border-border rounded-lg">
          <AlertCircle className="w-4 h-4 text-text-muted mt-0.5 shrink-0" />
          <p className="text-xs text-text-muted">
            No final report was generated for this session. Enable Final Report in
            Settings before starting the interview.
          </p>
        </div>
      )}
    </div>
  );
}

function ReportCard({ report }: { report: FinalReport }) {
  return (
    <Card title="Final Report">
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="text-center">
            <div className="text-3xl font-bold text-accent">
              {report.overallScore}
            </div>
            <div className="text-[10px] text-text-muted">Overall</div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-bold text-text-secondary">
              {report.interviewerScore}
            </div>
            <div className="text-[10px] text-text-muted">Interviewer</div>
          </div>
          <p className="text-xs text-text-muted flex-1">
            {report.interviewerComment}
          </p>
        </div>

        <ReportSection title="Strengths" items={report.strengths} variant="success" />
        <ReportSection title="Weaknesses" items={report.weaknesses} variant="danger" />
        <ReportSection title="Improvements" items={report.improvements} variant="warning" />
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
    <div>
      <div className="flex items-center gap-1.5 text-text-muted mb-0.5">
        {icon}
        <span className="text-[10px]">{label}</span>
      </div>
      <div className="text-base font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

