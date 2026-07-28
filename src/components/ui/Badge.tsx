import type { ReactNode } from "react";

type Variant = "success" | "warning" | "danger" | "muted" | "accent";

interface Props {
  variant: Variant;
  children: ReactNode;
  className?: string;
}

const styles: Record<Variant, string> = {
  success: "border border-success/30 bg-success-muted text-success",
  warning: "border border-warning/35 bg-warning-muted text-warning",
  danger: "border border-danger/35 bg-danger-muted text-danger",
  muted: "border border-border bg-bg-tertiary text-text-muted",
  // Solid fill — the loudest statement the calm theme allows (gradients are
  // flattened to the accent colour). Reserved for the plan/tier chip.
  accent: "border border-transparent bg-accent text-white",
};

export function Badge({ variant, children, className = "" }: Props) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-[-0.005em] ${styles[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
