import type { CSSProperties } from "react";

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
        <div className="mb-2.5 flex items-center justify-between">
          <span className="text-sm text-text-secondary">{label}</span>
          <span className="font-mono text-sm font-semibold text-accent">
            {/* key remounts the number on change so the pop replays */}
            <span key={value} className="value-pop">
              {value}
            </span>
            {unit && <span className="ml-1 text-text-muted">{unit}</span>}
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
        className="slider-track h-2 w-full cursor-pointer appearance-none rounded-full
          [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:cursor-pointer
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-[3px]
          [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-accent
          [&::-webkit-slider-thumb]:shadow-[0_4px_12px_-2px_rgba(61,91,255,0.7)]
          [&::-webkit-slider-thumb]:transition-transform hover:[&::-webkit-slider-thumb]:scale-110
          active:[&::-webkit-slider-thumb]:scale-[1.18]
          focus:outline-none focus:ring-2 focus:ring-accent/30 focus:ring-offset-2 focus:ring-offset-bg-primary
          disabled:cursor-not-allowed"
        style={
          {
            "--slider-fill": `${pct}%`,
            background: `linear-gradient(to right, #3d5bff var(--slider-fill), #7a5cff var(--slider-fill), var(--color-bg-tertiary) var(--slider-fill))`,
          } as CSSProperties
        }
      />
    </div>
  );
}
