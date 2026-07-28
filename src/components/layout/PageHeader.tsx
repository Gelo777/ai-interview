import type { LucideIcon } from "lucide-react";

interface Props {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
}

export function PageHeader({ title, subtitle }: Props) {
  return (
    <div className="mb-6">
      <h1 className="font-display text-[1.9rem] font-bold leading-[1.05] tracking-[-0.03em] text-text-primary">
        {title}
      </h1>
      {subtitle && (
        <p className="mt-1.5 max-w-2xl text-sm leading-6 text-text-secondary">{subtitle}</p>
      )}
    </div>
  );
}
