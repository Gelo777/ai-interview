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
      className={`flex items-start gap-3 cursor-pointer ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <button
        role="switch"
        type="button"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`
          relative mt-0.5 w-11 h-6 rounded-full transition-colors duration-200
          ${checked ? "bg-accent" : "bg-bg-tertiary border border-border"}
          ${disabled ? "cursor-not-allowed" : "cursor-pointer"}
        `}
      >
        <span
          className={`
            absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-md
            transition-transform duration-200
            ${checked ? "translate-x-5" : "translate-x-0"}
          `}
        />
      </button>
      {(label || description) && (
        <div className="flex-1 min-w-0">
          {label && (
            <span className="block text-sm font-medium text-text-primary">
              {label}
            </span>
          )}
          {description && (
            <span className="block text-xs text-text-muted mt-0.5 leading-relaxed">
              {description}
            </span>
          )}
        </div>
      )}
    </label>
  );
}
