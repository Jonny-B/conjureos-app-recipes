import { useState, useCallback } from "react";
import { Icon } from "../icons";

/**
 * The app's one way of telling a user a thing they asked for did not happen.
 *
 * The gap this closes: every AWAITED mutation on Home and Browse — favourite,
 * save to library, "I made this", delete — was called from an `onClick` with
 * no `try`. There is no error boundary and no `unhandledrejection` handler in
 * the app, so a rejected promise went to the console and nowhere else. Offline,
 * tapping the heart did nothing at all; tapping Delete left the confirm dialog
 * sitting open forever with no explanation. `jsonDoc.ts` composes a careful,
 * specific, user-facing sentence for precisely these failures ("your existing
 * pantry is untouched") that no user had ever seen.
 *
 * Deliberately a hook plus a component rather than a wrapper: the screens
 * already own their handlers, and the smallest change that fixes every call
 * site is one `run()` around the body and one banner in the tree.
 */
export const errText = (e: unknown): string =>
  e instanceof Error && e.message ? e.message : String(e ?? "Something went wrong.");

export function useActionError(): {
  error: string | null;
  clear: () => void;
  /** Run a mutation; on failure surface the message instead of swallowing it. */
  run: (fn: () => Promise<unknown>) => Promise<void>;
} {
  const [error, setError] = useState<string | null>(null);
  const clear = useCallback(() => setError(null), []);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    }
  }, []);
  return { error, clear, run };
}

export function ErrorBanner({ error, onDismiss }: { error: string | null; onDismiss?: () => void }) {
  if (!error) return null;
  return (
    <div className="status-banner error" style={{ marginBottom: 8 }}>
      <Icon name="triangle-exclamation" />
      <span>{error}</span>
      {onDismiss && (
        <button className="link-btn" type="button" onClick={onDismiss} style={{ marginLeft: "auto" }}>
          Dismiss
        </button>
      )}
    </div>
  );
}
