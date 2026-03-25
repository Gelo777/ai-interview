import type { ReactNode } from "react";

type Variant = "success" | "warning" | "danger" | "muted";

interface Props {
  variant: Variant;
  children: ReactNode;
  className?: string;
}

const styles: Record<Variant, string> = {
  success: "bg-success-muted text-success",
  warning: "bg-warning-muted text-warning",
  danger: "bg-danger-muted text-danger",
  muted: "bg-bg-tertiary text-text-muted",
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
