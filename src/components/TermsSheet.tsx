import { useState } from "react";
import { acceptTerms } from "../bridge/recipesApi";
import { TERMS_BODY, TERMS_TITLE, TERMS_VERSION, hasAcceptedCurrentTerms, setAcceptedTermsVersion } from "../features/terms";

/**
 * The Recipes terms for your content. Two uses: asked for (the first time you
 * save or upload, with Accept / Not now), or just read from the cog menu.
 */
export function TermsSheet({ onClose, asking }: { onClose: (accepted: boolean) => void; asking: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accepted = hasAcceptedCurrentTerms();

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await acceptTerms(TERMS_VERSION);
      setAcceptedTermsVersion(TERMS_VERSION);
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-overlay" onClick={() => !busy && onClose(false)}>
      <div
        className="settings-sheet terms-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terms-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" />
        <h3 id="terms-title" className="terms-title">
          {TERMS_TITLE}
        </h3>
        {asking && (
          <p className="terms-lede">Before you add your first recipe or photo, please read and accept these terms.</p>
        )}
        <div className="terms-body">
          {TERMS_BODY.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          <p className="faint">Version {TERMS_VERSION}</p>
        </div>
        {error && <div className="status-banner error">{error}</div>}
        <div className="terms-actions">
          {accepted && !asking ? (
            <>
              <span className="muted">You accepted these terms.</span>
              <button className="btn" type="button" onClick={() => onClose(true)}>
                Close
              </button>
            </>
          ) : (
            <>
              <button className="btn ghost" type="button" disabled={busy} onClick={() => onClose(false)}>
                Not now
              </button>
              <button className="btn" type="button" disabled={busy} onClick={() => void accept()}>
                {busy ? "Saving…" : "I accept"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
