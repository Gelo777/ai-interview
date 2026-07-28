import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
  className?: string;
  title?: string;
  description?: string;
}

export function Card({ children, className = "", title, description }: Props) {
  return (
    <div
      className={`card-elevated relative overflow-hidden rounded-3xl p-6 ${className}`}
    >
      {title && (
        <div className="mb-5 flex items-start gap-3 border-b border-border pb-4">
          <span className="mt-1 h-9 w-1 shrink-0 rounded-full gradient-aurora" />
          <div className="min-w-0">
            <h3 className="font-display text-base font-semibold tracking-[-0.01em] text-text-primary">
              {title}
            </h3>
            {description && (
              <p className="mt-1 text-xs leading-relaxed text-text-muted">{description}</p>
            )}
          </div>
        </div>
      )}
      {children}
    </div>
  );
}
