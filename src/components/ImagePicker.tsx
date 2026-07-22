import { useRef, useState } from "react";
import { preparePhoto } from "../features/capture";
import { uploadRecipeImage } from "../bridge/recipesApi";
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
}: {
  value: string | undefined;
  onChange: (url: string | undefined) => void;
  label: string;
  hint?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
            <button className="btn ghost" onClick={() => onChange(undefined)} disabled={busy} type="button">
              <Icon name="trash-can" /> Remove
            </button>
          </div>
        </div>
      ) : (
        <button className="image-picker-drop" onClick={pick} disabled={busy} type="button">
          {busy ? (
            <><div className="spinner" /> <span>Uploading…</span></>
          ) : (
            <><Icon name="camera" /> <span>Add a photo</span></>
          )}
        </button>
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
