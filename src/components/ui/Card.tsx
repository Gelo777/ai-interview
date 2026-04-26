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
      className={`rounded-[24px] border border-white/10 bg-[linear-gradient(165deg,rgba(25,37,56,0.9),rgba(13,21,34,0.92))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_22px_44px_rgba(0,0,0,0.3)] backdrop-blur-xl ${className}`}
    >
      {title && (
        <div className="mb-4 border-b border-white/8 pb-3">
          <h3 className="text-base font-semibold tracking-[0.01em] text-text-primary">
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
