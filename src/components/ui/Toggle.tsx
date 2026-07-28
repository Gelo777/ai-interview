interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  description?: string;
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  description,
}: Props) {
  return (
    <label
      className={`flex items-start gap-3 ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <button
        role="switch"
        type="button"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`
          relative mt-0.5 h-6 w-12 shrink-0 rounded-full transition-colors duration-200
          ${checked ? "bg-accent" : "bg-black/[0.14]"}
          ${disabled ? "cursor-not-allowed" : "cursor-pointer"}
        `}
      >
        <span
          className={`
            absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-[0_2px_6px_rgba(20,22,40,0.3)]
            transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]
            ${checked ? "translate-x-6" : "translate-x-0"}
          `}
        />
      </button>
      {(label || description) && (
        <div className="min-w-0 flex-1">
          {label && (
            <span className="block text-sm font-medium text-text-primary">
              {label}
            </span>
          )}
          {description && (
            <span className="mt-0.5 block text-xs leading-relaxed text-text-muted">
              {description}
            </span>
          )}
        </div>
      )}
    </label>
  );
}
