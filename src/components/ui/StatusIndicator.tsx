import { CheckCircle, AlertTriangle, XCircle, Loader2 } from "lucide-react";
import type { PermissionStatus, CacheSupport } from "@/lib/types";

type Status = PermissionStatus | CacheSupport;

interface Props {
  status: Status;
  label: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
}

const icons: Record<string, React.ReactNode> = {
  granted: <CheckCircle className="w-5 h-5 text-success" />,
  supported: <CheckCircle className="w-5 h-5 text-success" />,
  denied: <XCircle className="w-5 h-5 text-danger" />,
  not_supported: <XCircle className="w-5 h-5 text-danger" />,
  unknown: <AlertTriangle className="w-5 h-5 text-warning" />,
  limited: <AlertTriangle className="w-5 h-5 text-warning" />,
  checking: <Loader2 className="w-5 h-5 text-text-muted animate-spin" />,
};

const statusLabels: Record<string, string> = {
  granted: "Ready",
  supported: "Supported",
  denied: "Not available",
  not_supported: "Not supported",
  unknown: "Unknown",
  limited: "Limited",
  checking: "Checking...",
};

export function StatusIndicator({
  status,
  label,
  description,
  actionLabel,
  onAction,
  actionDisabled,
}: Props) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-white/6 bg-white/[0.025] px-3 py-3">
      <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/8 bg-white/[0.04]">
        {icons[status]}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-text-primary">
            {label}
          </span>
          <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-text-muted">
            {statusLabels[status]}
          </span>
          {actionLabel && onAction && (
            <button
              type="button"
              onClick={onAction}
              disabled={actionDisabled}
              className="ml-auto rounded-full border border-white/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-text-secondary hover:text-text-primary hover:border-white/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {actionLabel}
            </button>
          )}
        </div>
        {description && (
          <p className="text-xs text-text-muted mt-0.5 leading-relaxed">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
