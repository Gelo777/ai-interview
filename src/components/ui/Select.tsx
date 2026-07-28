import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";

interface Option {
  value: string;
  label: string;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

interface MenuPos {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

const MENU_SHADOW =
  "0 1px 2px rgba(20, 22, 40, 0.05), 0 18px 44px -30px rgba(30, 35, 60, 0.4)";

/**
 * App-styled dropdown. Replaces the native <select> (whose option list is
 * rendered by the OS and cannot be themed) with a custom popover. The popover
 * is portaled to <body> with fixed positioning so it is never clipped by the
 * card's `overflow-hidden`.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = "Select...",
  disabled,
  className = "",
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [highlight, setHighlight] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectedIndex = useMemo(
    () => options.findIndex((o) => o.value === value),
    [options, value],
  );
  // Fall back to the first option when the stored value matches nothing — this
  // mirrors the native <select> behaviour so the trigger never renders blank.
  const displayLabel =
    selectedIndex >= 0
      ? options[selectedIndex].label
      : options.length > 0
        ? options[0].label
        : null;

  const computePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) {
      return;
    }
    const r = el.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    const spaceBelow = window.innerHeight - r.bottom - margin;
    const spaceAbove = r.top - margin;
    const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    const maxHeight = Math.min(300, Math.max(140, openUp ? spaceAbove : spaceBelow));
    setPos(
      openUp
        ? {
            left: r.left,
            width: r.width,
            bottom: window.innerHeight - r.top + gap,
            maxHeight,
          }
        : { left: r.left, width: r.width, top: r.bottom + gap, maxHeight },
    );
  }, []);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setHighlight(-1);
  }, []);

  const openMenu = useCallback(() => {
    if (disabled || options.length === 0) {
      return;
    }
    computePosition();
    setHighlight(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }, [computePosition, disabled, options.length, selectedIndex]);

  const selectOption = useCallback(
    (v: string) => {
      onChange(v);
      closeMenu();
      triggerRef.current?.focus();
    },
    [onChange, closeMenu],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const reposition = () => computePosition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      closeMenu();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, computePosition, closeMenu]);

  useLayoutEffect(() => {
    if (open && highlight >= 0) {
      optionRefs.current[highlight]?.scrollIntoView({ block: "nearest" });
    }
  }, [open, highlight]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (disabled) {
      return;
    }
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        closeMenu();
        break;
      case "ArrowDown":
        e.preventDefault();
        setHighlight((h) => Math.min(options.length - 1, h + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlight((h) => Math.max(0, h - 1));
        break;
      case "Home":
        e.preventDefault();
        setHighlight(0);
        break;
      case "End":
        e.preventDefault();
        setHighlight(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (highlight >= 0 && highlight < options.length) {
          selectOption(options[highlight].value);
        }
        break;
      default:
        break;
    }
  };

  return (
    <div className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex w-full items-center rounded-2xl border bg-bg-input px-3.5 py-2.5 pr-10 text-left text-sm font-medium transition-all duration-200
          disabled:cursor-not-allowed disabled:opacity-50
          ${
            open
              ? "border-accent ring-2 ring-accent/30 ring-offset-2 ring-offset-bg-primary"
              : "border-border hover:border-border-active"
          }
          ${displayLabel ? "text-text-primary" : "text-text-muted"}`}
      >
        <span className="min-w-0 flex-1 truncate">{displayLabel ?? placeholder}</span>
      </button>
      <ChevronDown
        className={`pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted transition-transform duration-200 ${
          open ? "rotate-180" : ""
        }`}
      />

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            style={{
              position: "fixed",
              left: pos.left,
              width: pos.width,
              top: pos.top,
              bottom: pos.bottom,
              maxHeight: pos.maxHeight,
              boxShadow: MENU_SHADOW,
            }}
            className="z-50 overflow-y-auto overflow-x-hidden rounded-2xl border border-border bg-bg-card p-1"
          >
            {options.map((o, i) => {
              const isSelected = o.value === value;
              const isActive = i === highlight;
              return (
                <button
                  key={o.value}
                  ref={(el) => {
                    optionRefs.current[i] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => selectOption(o.value)}
                  onMouseEnter={() => setHighlight(i)}
                  className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors
                    ${isActive ? "bg-bg-secondary" : ""}
                    ${isSelected ? "font-medium text-text-primary" : "text-text-secondary"}`}
                >
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {isSelected && <Check className="h-4 w-4 shrink-0 text-accent" />}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
