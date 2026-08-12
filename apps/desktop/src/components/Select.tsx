import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export type SelectOption = {
  value: string;
  label?: string;
};

/**
 * Theme-aware dropdown (native <select> renders an unthemed white list).
 * Button + absolutely-positioned menu; closes on outside click / Escape.
 */
export function ThemedSelect({
  value,
  options,
  onChange,
  disabled,
  title,
  className,
  menuMaxHeight = 280,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  menuMaxHeight?: number;
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const [dropUp, setDropUp] = useState(false);

  const currentIdx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const current = options[currentIdx];

  const close = useCallback(() => setOpen(false), []);

  // Decide drop direction from available space.
  useLayoutEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    setDropUp(spaceBelow < Math.min(menuMaxHeight, 240) && rect.top > spaceBelow);
    setActiveIdx(currentIdx);
  }, [open, currentIdx, menuMaxHeight]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  // Keep the keyboard-highlighted option visible.
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const el = menuRef.current.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  const commit = (v: string) => {
    onChange(v);
    close();
  };

  const onButtonKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const opt = options[activeIdx];
      if (opt) commit(opt.value);
    } else if (e.key === "Tab") {
      close();
    }
  };

  return (
    <div
      ref={rootRef}
      className={`themed-select${open ? " open" : ""}${className ? ` ${className}` : ""}`}
    >
      <button
        type="button"
        className="themed-select-btn"
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onButtonKeyDown}
      >
        <span className="themed-select-value">
          {current?.label ?? current?.value ?? ""}
        </span>
        <svg
          className="themed-select-chevron"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden
        >
          <path
            d="M3 4.5 6 7.5 9 4.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </button>
      {open ? (
        <ul
          ref={menuRef}
          className={`themed-select-menu${dropUp ? " drop-up" : ""}`}
          role="listbox"
          style={{ maxHeight: menuMaxHeight }}
          tabIndex={-1}
        >
          {options.map((o, i) => (
            <li key={o.value} role="option" aria-selected={o.value === value}>
              <button
                type="button"
                className={[
                  "themed-select-option",
                  o.value === value ? "selected" : "",
                  i === activeIdx ? "active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => commit(o.value)}
              >
                <span className="themed-select-option-label">
                  {o.label ?? o.value}
                </span>
                {o.value === value ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                    <path
                      d="M2.5 6.2 5 8.7 9.5 3.6"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      fill="none"
                    />
                  </svg>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
