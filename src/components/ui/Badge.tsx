import type { ReactNode } from "react";

type Variant = "success" | "warning" | "danger" | "muted";

interface Props {
  variant: Variant;
  children: ReactNode;
  className?: string;
}

const styles: Record<Variant, string> = {
  success: "border border-success/30 bg-success-muted text-success",
  warning: "border border-warning/30 bg-warning-muted text-warning",
  danger: "border border-danger/35 bg-danger-muted text-danger",
  muted: "border border-white/10 bg-bg-tertiary text-text-muted",
};

export function Badge({ variant, children, className = "" }: Props) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${styles[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
