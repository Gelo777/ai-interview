interface Props {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  label?: string;
  unit?: string;
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled,
  label,
  unit,
}: Props) {
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div className={disabled ? "opacity-50" : ""}>
      {label && (
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-text-secondary">{label}</span>
          <span className="text-sm font-mono text-accent">
            {value}
            {unit && <span className="text-text-muted ml-1">{unit}</span>}
          </span>
        </div>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer
          [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent
          [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:cursor-pointer
          [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-bg-primary
          disabled:cursor-not-allowed"
        style={{
          background: `linear-gradient(to right, var(--color-accent) ${pct}%, var(--color-bg-tertiary) ${pct}%)`,
        }}
      />
    </div>
  );
}
