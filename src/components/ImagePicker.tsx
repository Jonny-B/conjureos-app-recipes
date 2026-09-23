import { useEffect, useRef, useState } from "react";
import type { Recipe } from "../types";
import { preparePhoto } from "../features/capture";
import { uploadRecipeImage } from "../bridge/recipesApi";
import { aiPhotoCost, generateRecipePhoto, isAiPhotoAvailable } from "../features/aiPhoto";
import { Icon } from "../icons";

/**
 * Pick / upload one image for a recipe or a chef blog header. The chosen file
 * is downscaled client-side (reusing the camera `preparePhoto` path) and
 * uploaded via the recipes-db `uploadImage` action, which returns a public URL.
 * The parent stores that URL on the recipe; we only hand back the URL string.
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
   * When set, offers "Generate with AI": the recipe to picture, read at click
   * time so it reflects the latest edits. The result is stamped
   * "AI-generated" and billed to the user's credits (features/aiPhoto.ts).
   */
  aiSource?: () => { recipe: Pick<Recipe, "title" | "ingredients">; category?: string | null };
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canAi = !!aiSource && isAiPhotoAvailable();
  const [cost, setCost] = useState<number | null>(null);
  useEffect(() => {
    if (canAi) void aiPhotoCost().then(setCost);
  }, [canAi]);

  const generate = async () => {
    if (!aiSource) return;
    const { recipe, category } = aiSource();
    if (!recipe.title.trim()) {
      setError("Give the recipe a title first, so the image has something to show.");
      return;
    }
    setError(null);
    setBusy(true);
    setGenerating(true);
    try {
      const { url } = await generateRecipePhoto(recipe, category);
      onChange(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setGenerating(false);
    }
  };

  const aiButton = canAi && (
    <button className="btn secondary" onClick={() => void generate()} disabled={busy} type="button">
      <Icon name="wand" /> {generating ? "Generating… (up to a minute)" : value ? "Regenerate with AI" : "Generate with AI"}
      {!generating && cost !== null && <span className="ai-cost"> · {cost} credits</span>}
    </button>
  );

  const pick = () => inputRef.current?.click();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so choosing the same file again re-fires onChange.
    e.target.value = "";
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const photo = await preparePhoto(file);
      const url = await uploadRecipeImage(photo.mediaType, photo.base64);
      onChange(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="image-picker">
      <div className="image-picker-head">
        <h4 style={{ margin: 0 }}>{label}</h4>
        {hint && <p className="muted" style={{ fontSize: 13, margin: "2px 0 0" }}>{hint}</p>}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        hidden
        onChange={onFile}
      />

      {value ? (
        <div className="image-picker-preview">
          <img src={value} alt={label} />
          {busy && <div className="image-picker-overlay"><div className="spinner" /></div>}
          <div className="image-picker-actions">
            <button className="btn secondary" onClick={pick} disabled={busy} type="button">
              <Icon name="camera" /> Change
            </button>
            {aiButton}
            <button className="btn ghost" onClick={() => onChange(undefined)} disabled={busy} type="button">
              <Icon name="trash-can" /> Remove
            </button>
          </div>
        </div>
      ) : (
        <>
          <button className="image-picker-drop" onClick={pick} disabled={busy} type="button">
            {busy ? (
              <><div className="spinner" /> <span>{generating ? "Generating an image…" : "Uploading…"}</span></>
            ) : (
              <><Icon name="camera" /> <span>Add a photo</span></>
            )}
          </button>
          {aiButton && <div className="image-picker-ai">{aiButton}<span className="muted">Marked “AI-generated” on the image.</span></div>}
        </>
      )}

      {error && (
        <div className="status-banner error" style={{ marginTop: 8 }}>
          <Icon name="triangle-exclamation" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
