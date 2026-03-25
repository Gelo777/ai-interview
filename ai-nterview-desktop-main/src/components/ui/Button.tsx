import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
  icon?: ReactNode;
}

const variantStyles: Record<Variant, string> = {
  primary:
    "border border-[#ffb08b]/30 bg-[linear-gradient(135deg,#ff875b,#ffb36e)] text-slate-950 hover:brightness-105 active:scale-[0.985] shadow-[0_14px_34px_rgba(255,135,91,0.28)]",
  secondary:
    "bg-white/[0.04] text-text-primary border border-white/10 hover:border-white/20 hover:bg-white/[0.07]",
  ghost:
    "text-text-secondary hover:text-text-primary hover:bg-white/[0.05]",
  danger:
    "bg-danger text-white hover:bg-danger-hover active:scale-[0.985]",
};

const sizeStyles: Record<Size, string> = {
  sm: "px-3 py-2 text-xs rounded-xl gap-1.5",
  md: "px-4 py-2.5 text-sm rounded-2xl gap-2",
  lg: "px-6 py-3.5 text-base rounded-[18px] gap-2.5",
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
        inline-flex items-center justify-center font-medium
        transition-all duration-200 cursor-pointer
        disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none
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
