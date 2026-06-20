import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";

/**
 * Themed dropdown (trigger + popover) generalized from BrowseScreen's
 * SortDropdown. A native <select>'s OS popup can't be themed, so this is a
 * styled button + listbox on Modern Whimsy surfaces. Closes on outside-click
 * or Escape. Reuses the existing .dropdown* CSS.
 */
export interface DropdownOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  options: DropdownOption<T>[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}

export function Dropdown<T extends string>({ options, value, onChange, ariaLabel }: Props<T>) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((o) => o.value === value) ?? options[0]!;

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="dropdown" ref={wrapRef}>
      <button
        type="button"
        className="dropdown-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span>{current.label}</span>
        <Icon name="chevron-down" className={`dropdown-caret${open ? " open" : ""}`} />
      </button>
      {open && (
        <ul className="dropdown-menu" role="listbox">
          {options.map((o) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`dropdown-option${o.value === value ? " active" : ""}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span>{o.label}</span>
              {o.value === value && <Icon name="check" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
