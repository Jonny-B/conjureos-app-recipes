import { useEffect, useState } from "react";
import { listBlocked, unblockAuthor, type BlockedAuthor } from "../bridge/recipesApi";
import { clearHiddenRecipes } from "../features/blockedAuthors";
import { useSheetDialog } from "../hooks/useSheetDialog";
import { plainError } from "../features/plainError";

/** Settings: the authors you blocked, each with Unblock. */
export function BlockedSheet({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const [list, setList] = useState<BlockedAuthor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const dialog = useSheetDialog<HTMLDivElement>(onClose);

  useEffect(() => {
    let live = true;
    listBlocked()
      .then((l) => live && setList(l))
      .catch(() => {
        if (live) {
          setList([]);
          setError("Your blocked authors could not be loaded. Try again later.");
        }
      });
    return () => {
      live = false;
    };
  }, []);

  const unblock = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await unblockAuthor(id);
      setList((l) => (l ?? []).filter((b) => b.userId !== id));
      // Their recipes may come back, so let the session re-read them.
      clearHiddenRecipes();
      onChanged?.();
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div
        ref={dialog}
        className="settings-sheet report-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="blocked-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" />
        <h3 id="blocked-title" className="terms-title">
          Blocked authors
        </h3>
        {list === null ? (
          <div className="center-spinner">
            <div className="spinner" />
          </div>
        ) : list.length === 0 ? (
          <p className="report-note">{error ?? "You have not blocked anyone."}</p>
        ) : (
          <ul className="blocked-list">
            {list.map((b) => (
              <li key={b.userId} className="blocked-row">
                <span className="blocked-name">{b.username ? `@${b.username}` : "An author without a handle"}</span>
                <button className="btn secondary" type="button" disabled={busyId === b.userId} onClick={() => void unblock(b.userId)}>
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && list !== null && list.length > 0 && (
          <div className="status-banner error" role="alert">
            {error}
          </div>
        )}
        <div className="terms-actions">
          <button className="btn" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
