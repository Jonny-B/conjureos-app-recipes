import { useEffect, useRef } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard behaviour for a modal bottom sheet (`role="dialog"`,
 * `aria-modal="true"`): Escape closes it, focus moves into it on open, Tab
 * stays inside it, and focus goes back where it was on close. Without this a
 * keyboard user opened the cog and kept tabbing through the page behind it,
 * with no key that closed the sheet.
 *
 * `onEscape` is read at key time; pass null while the sheet must not close
 * (the terms sheet mid-save).
 */
export function useSheetDialog<T extends HTMLElement>(onEscape: (() => void) | null) {
  const ref = useRef<T | null>(null);
  const escape = useRef(onEscape);
  escape.current = onEscape;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    (el?.querySelector<HTMLElement>(FOCUSABLE) ?? el)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (escape.current) {
          e.preventDefault();
          escape.current();
        }
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !ref.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, []);

  return ref;
}
