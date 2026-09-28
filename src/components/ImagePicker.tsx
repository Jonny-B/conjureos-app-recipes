import type { Recipe } from "../types";
import { photoBusyText, usePhotoActions } from "../hooks/usePhotoActions";
import { Icon } from "../icons";

/**
 * Pick one image for a recipe or a chef blog header. Every way in lives in
 * `usePhotoActions`: upload, upload & enhance with AI, enhance the current
 * photo, or generate one from scratch. The parent stores the URL; we only
 * hand it back.
 */
export function ImagePicker({
  value,
  onChange,
  label,
  hint,
  aiSource,
}: {
  value: string | undefined;
  onChange: (url: string | undefined) => void;
  label: string;
  hint?: string;
  /**
   * When set, offers the AI options (enhance and generate): the recipe the
   * photo is for, read at click time so it reflects the latest edits. AI
   * results are stamped on the image and billed to the user's credits
   * (features/aiPhoto.ts). A blog header has no recipe, so no AI.
   */
  aiSource?: () => { recipe: Pick<Recipe, "title" | "ingredients">; category?: string | null };
}) {
  const photo = usePhotoActions({
    subject: () => aiSource?.() ?? { recipe: { title: "", ingredients: [] } },
    apply: (url) => onChange(url ?? undefined),
  });
  const busy = photo.busy !== null;
  const canEnhance = !!aiSource && photo.canEnhance;
  const canGenerate = !!aiSource && photo.canGenerate;

  const enhanceButton = (label: string, onClick: () => void) => (
    <button className="btn secondary" onClick={onClick} disabled={busy} type="button">
      <Icon name="wand" /> {label}
      {photo.enhanceCost !== null && <span className="ai-cost"> · up to {photo.enhanceCost} credits</span>}
    </button>
  );
  const generateButton = (label: string) =>
    canGenerate && (
      <button className="btn secondary" onClick={() => void photo.generate()} disabled={busy} type="button">
        <Icon name="wand" /> {label}
        {photo.generateCost !== null && <span className="ai-cost"> · {photo.generateCost} credits</span>}
      </button>
    );

  return (
    <div className="image-picker">
      <div className="image-picker-head">
        <h4 style={{ margin: 0 }}>{label}</h4>
        {hint && <p className="muted" style={{ fontSize: 13, margin: "2px 0 0" }}>{hint}</p>}
      </div>

      {photo.fileInput}

      {value ? (
        <div className="image-picker-preview">
          <img src={value} alt={label} />
          {busy && <div className="image-picker-overlay"><div className="spinner" /></div>}
          <div className="image-picker-actions">
            <button className="btn secondary" onClick={photo.upload} disabled={busy} type="button">
              <Icon name="camera" /> Change
            </button>
            {canEnhance && !photo.original && enhanceButton("Enhance with AI", () => void photo.enhanceExisting(value))}
            {photo.original && (
              <button className="btn ghost" onClick={() => void photo.restoreOriginal()} disabled={busy} type="button">
                <Icon name="clock-rotate-left" /> Use my original
              </button>
            )}
            {generateButton("Regenerate with AI")}
            <button className="btn ghost" onClick={() => void photo.remove()} disabled={busy} type="button">
              <Icon name="trash-can" /> Remove
            </button>
          </div>
        </div>
      ) : (
        <>
          <button className="image-picker-drop" onClick={photo.upload} disabled={busy} type="button">
            {busy ? (
              <><div className="spinner" /> <span>{photoBusyText(photo.busy!)}</span></>
            ) : (
              <><Icon name="camera" /> <span>Upload a photo</span></>
            )}
          </button>
          {(canEnhance || canGenerate) && (
            <div className="image-picker-ai">
              {canEnhance && enhanceButton("Upload & enhance with AI", () => void photo.uploadAndEnhance())}
              {generateButton("Generate with AI")}
              <span className="muted">AI photos are marked on the image.</span>
            </div>
          )}
        </>
      )}

      {busy && value && <p className="muted image-picker-status">{photoBusyText(photo.busy!)}</p>}
      {photo.error && (
        <div className="status-banner error" style={{ marginTop: 8 }}>
          <Icon name="triangle-exclamation" />
          <span>{photo.error}</span>
        </div>
      )}
    </div>
  );
}
