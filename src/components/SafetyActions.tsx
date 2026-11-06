import { useState } from "react";
import { blockAuthor } from "../bridge/recipesApi";
import { hideRecipe } from "../features/blockedAuthors";
import { useSheetDialog } from "../hooks/useSheetDialog";
import { ReportSheet } from "./ReportSheet";
import { Icon } from "../icons";

/**
 * Report and Block for another person's public recipe. Both are 44px targets.
 * Blocking asks first, hides the recipe at once, and tells the screen so it can
 * re-read its feed (the server leaves a blocked author out of the next read).
 * Never shown on your own recipe: the caller decides, and the server refuses
 * both anyway.
 */
export function SafetyActions({ recipeId, onBlocked }: { recipeId: string; onBlocked?: () => void }) {
  const [reporting, setReporting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="safety-actions">
      <button className="safety-btn" type="button" onClick={() => setReporting(true)}>
        <Icon name="triangle-exclamation" /> Report
      </button>
      <button className="safety-btn" type="button" onClick={() => setConfirming(true)}>
        <Icon name="xmark" /> Block this author
      </button>
      {reporting && <ReportSheet recipeId={recipeId} onClose={() => setReporting(false)} />}
      {confirming && (
        <BlockConfirm
          recipeId={recipeId}
          onClose={() => setConfirming(false)}
          onBlocked={() => {
            hideRecipe(recipeId);
            setConfirming(false);
            onBlocked?.();
          }}
        />
      )}
    </div>
  );
}

function BlockConfirm({ recipeId, onClose, onBlocked }: { recipeId: string; onClose: () => void; onBlocked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useSheetDialog<HTMLDivElement>(busy ? null : onClose);
  const block = async () => {
    setBusy(true);
    setError(null);
    try {
      await blockAuthor(recipeId);
      onBlocked();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <div className="sheet-overlay" onClick={() => !busy && onClose()}>
      <div
        ref={dialog}
        className="settings-sheet report-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="block-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" />
        <h3 id="block-title" className="terms-title">
          Block this author?
        </h3>
        <p className="report-note">
          Their recipes disappear from your feed and search. You can undo this under Blocked authors in Settings.
        </p>
        {error && (
          <div className="status-banner error" role="alert">
            {error}
          </div>
        )}
        <div className="terms-actions">
          <button className="btn ghost" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" type="button" disabled={busy} onClick={() => void block()}>
            {busy ? "Blocking…" : "Block"}
          </button>
        </div>
      </div>
    </div>
  );
}
