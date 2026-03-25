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
      className={`rounded-[24px] border border-white/8 bg-[linear-gradient(180deg,rgba(20,31,47,0.88),rgba(14,23,35,0.94))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_18px_40px_rgba(0,0,0,0.18)] backdrop-blur-xl ${className}`}
    >
      {title && (
        <div className="mb-4">
          <h3 className="text-base font-semibold tracking-[0.02em] text-text-primary">
            {title}
          </h3>
          {description && (
            <p className="mt-1 text-xs leading-relaxed text-text-muted">{description}</p>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
