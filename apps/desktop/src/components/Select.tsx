import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type SelectOption = {
  value: string;
  label?: string;
};

/**
 * Theme-aware dropdown (native <select> renders an unthemed white list).
 * Button + fixed-position menu portaled to <body> (a portal is required:
 * backdrop-filter on an ancestor — e.g. .chat-header / .composer — makes it a
 * Backdrop Root, which caps any descendant's own backdrop-filter and the menu
 * would lose its frosted blur). Closes on outside click / Escape.
 */
export function ThemedSelect({
  value,
  options,
  onChange,
  disabled,
  title,
  className,
  menuMaxHeight = 280,
  align = "left",
  stretchOnOpen = false,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  menuMaxHeight?: number;
  /** Which edge of the button the menu aligns with. */
  align?: "left" | "right";
  /** Codex-style: the button stretches to the menu's width while open. */
  stretchOnOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const [dropUp, setDropUp] = useState(false);
  // The menu stays mounted briefly after `open` flips false so the collapse
  // animation can play; `closing` is what actually drives the exit keyframes.
  const [menuMounted, setMenuMounted] = useState(false);
  const [menuWidth, setMenuWidth] = useState<number | null>(null);
  const [menuPos, setMenuPos] = useState<{
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
    minWidth: number;
  } | null>(null);

  const currentIdx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const current = options[currentIdx];

  const close = useCallback(() => setOpen(false), []);

  // Decide drop direction and fixed position from the button's viewport rect.
  useLayoutEffect(() => {
    if (!open) return;
    const compute = () => {
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const up = spaceBelow < Math.min(menuMaxHeight, 240) && rect.top > spaceBelow;
      setDropUp(up);
      setMenuPos({
        ...(up
          ? { bottom: window.innerHeight - rect.top + 6 }
          : { top: rect.bottom + 6 }),
        ...(align === "right"
          ? { right: window.innerWidth - rect.right }
          : { left: rect.left }),
        minWidth: rect.width,
      });
      setActiveIdx(currentIdx);
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [open, currentIdx, menuMaxHeight, align]);

  // Mount immediately on open; on close keep the menu around for the exit
  // animation (must outlast the CSS animation duration below).
  useEffect(() => {
    if (open) {
      setMenuMounted(true);
      return;
    }
    if (!menuMounted) return;
    const timer = window.setTimeout(() => setMenuMounted(false), 150);
    return () => window.clearTimeout(timer);
  }, [open, menuMounted]);

  // Measure the menu so the button can stretch to the same width. Depends on
  // menuMounted: the portal only exists after the mount effect has run.
  useLayoutEffect(() => {
    if (!open || !stretchOnOpen || !menuMounted || !menuRef.current) return;
    setMenuWidth(menuRef.current.offsetWidth);
  }, [open, stretchOnOpen, menuMounted, menuPos]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
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
        style={
          stretchOnOpen && menuWidth != null
            ? { minWidth: open ? menuWidth : 0 }
            : undefined
        }
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
      {menuMounted && menuPos
        ? createPortal(
            <ul
              ref={menuRef}
              className={`themed-select-menu${dropUp ? " drop-up" : ""}${open ? "" : " closing"}`}
              role="listbox"
              style={{ ...menuPos, maxHeight: menuMaxHeight }}
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
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}
