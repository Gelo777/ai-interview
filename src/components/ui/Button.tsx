import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "xs" | "sm" | "md" | "lg";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
  icon?: ReactNode;
}

// Borderless variants carry a transparent border so they keep the same box as
// `secondary` — otherwise a bordered button sits 2px taller than its neighbour.
const variantStyles: Record<Variant, string> = {
  primary:
    "bg-accent text-white border border-transparent hover:bg-accent-hover active:scale-[0.99] shadow-[0_1px_2px_rgba(20,22,40,0.12)]",
  secondary:
    "bg-bg-card text-text-primary border border-border hover:border-border-active hover:bg-bg-tertiary/60",
  ghost:
    "text-text-secondary border border-transparent hover:text-text-primary hover:bg-black/[0.04]",
  danger:
    "bg-danger text-white border border-transparent hover:bg-danger-hover active:scale-[0.99] shadow-[0_1px_2px_rgba(20,22,40,0.12)]",
};

const sizeStyles: Record<Size, string> = {
  // Explicit heights keep every variant on the same row rhythm regardless of
  // borders or how tall the label content (icons, keycaps) happens to be.
  xs: "h-7 px-3 text-xs rounded-lg gap-1.5",
  sm: "h-8 px-3.5 text-xs rounded-lg gap-1.5",
  md: "px-4 py-2.5 text-sm rounded-xl gap-2",
  lg: "px-6 py-3.5 text-[0.95rem] rounded-xl gap-2.5",
};

export function Button({
  variant = "primary",
  size = "md",
  children,
  icon,
  className = "",
  disabled,
  ...props
}: Props) {
  return (
    <button
      className={`
        inline-flex items-center justify-center font-semibold tracking-[-0.005em]
        transition-colors duration-200 cursor-pointer
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary
        disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none disabled:shadow-none
        ${variantStyles[variant]}
        ${sizeStyles[size]}
        ${className}
      `}
      disabled={disabled}
      {...props}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {children}
    </button>
  );
}
