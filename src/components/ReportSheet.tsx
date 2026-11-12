import { useState } from "react";
import { useSheetDialog } from "../hooks/useSheetDialog";
import { reportChef, reportRecipe } from "../bridge/recipesApi";
import { REPORT_CATEGORIES, REPORT_DETAILS_MAX, type ReportCategory } from "../features/report";
import { plainError } from "../features/plainError";

/**
 * Report another person's public recipe, or the chef who wrote it. The reasons
 * are the ones recipes-db accepts, labelled as ConjureOS's own Report dialog
 * labels them. The server files it and resolves the author, so no user id
 * passes through here.
 */
export function ReportSheet({
  recipeId,
  onClose,
  initialTarget = "recipe",
}: {
  recipeId: string;
  onClose: () => void;
  initialTarget?: "recipe" | "chef";
}) {
  const [target, setTarget] = useState<"recipe" | "chef">(initialTarget);
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const dialog = useSheetDialog<HTMLDivElement>(busy ? null : onClose);

  const submit = async () => {
    if (!category) return;
    setBusy(true);
    setError(null);
    try {
      await (target === "chef" ? reportChef : reportRecipe)(recipeId, category, details);
      setDone(true);
    } catch (e) {
      setError(plainError(e));
    } finally {
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
        aria-labelledby="report-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" />
        <h3 id="report-title" className="terms-title">
          {done ? "Report sent" : "Report"}
        </h3>
        {done ? (
          <>
            <p className="report-note" role="status">
              Thanks. Your report was sent and will be reviewed.
            </p>
            <div className="terms-actions">
              <button className="btn" type="button" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="report-group" role="radiogroup" aria-label="What to report">
              <label className="report-row">
                <input type="radio" name="report-target" checked={target === "recipe"} onChange={() => setTarget("recipe")} />
                <span>Report this recipe</span>
              </label>
              <label className="report-row">
                <input type="radio" name="report-target" checked={target === "chef"} onChange={() => setTarget("chef")} />
                <span>Report this chef</span>
              </label>
            </div>
            <div className="report-group" role="radiogroup" aria-label="Reason">
              {REPORT_CATEGORIES.map((c) => (
                <label className="report-row" key={c.id}>
                  <input
                    type="radio"
                    name="report-category"
                    checked={category === c.id}
                    onChange={() => setCategory(c.id)}
                  />
                  <span>{c.label}</span>
                </label>
              ))}
            </div>
            <label className="report-details">
              <span className="report-note">Details (optional)</span>
              <textarea
                rows={3}
                maxLength={REPORT_DETAILS_MAX}
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder="What is wrong with it?"
              />
            </label>
            {error && (
              <div className="status-banner error" role="alert">
                {error}
              </div>
            )}
            <div className="terms-actions">
              <button className="btn ghost" type="button" disabled={busy} onClick={onClose}>
                Cancel
              </button>
              <button className="btn" type="button" disabled={busy || !category} onClick={() => void submit()}>
                {busy ? "Sending…" : "Send report"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
