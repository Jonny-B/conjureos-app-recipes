import { useRef, useState, type DragEvent, type ChangeEvent } from "react";
import { preparePhoto, formatBytes } from "../features/capture";

interface Props {
  onPhoto: (dataUrl: string) => void;
}

export function CaptureScreen({ onPhoto }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<{ dataUrl: string; w: number; h: number; bytes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setErr(null);
    setBusy(true);
    try {
      const prep = await preparePhoto(file);
      setPreview({ dataUrl: prep.dataUrl, w: prep.width, h: prep.height, bytes: prep.originalBytes });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = "";
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  if (preview) {
    return (
      <div className="capture-screen">
        <h2>Look good?</h2>
        <div className="photo-preview">
          <img src={preview.dataUrl} alt="Captured" />
        </div>
        <div className="muted" style={{ textAlign: "center", fontSize: 12 }}>
          {preview.w}×{preview.h} · downscaled from {formatBytes(preview.bytes)}
        </div>
        <div className="capture-buttons">
          <button className="btn ghost" onClick={() => setPreview(null)}>
            Retake
          </button>
          <button className="btn" onClick={() => onPhoto(preview.dataUrl)}>
            Identify ingredients →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="capture-screen">
      <h2>Show me your fridge</h2>
      <p className="muted" style={{ margin: 0 }}>
        Snap or upload a photo of the inside. I'll spot the ingredients and suggest recipes you can actually make tonight.
      </p>

      <div
        className={`capture-area${dragOver ? " dragover" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="icon">📷</div>
        <div style={{ marginBottom: 16 }}>
          {busy ? "Preparing photo…" : "Drag a photo here, or:"}
        </div>
        <div className="capture-buttons">
          <button
            className="btn"
            disabled={busy}
            onClick={() => cameraRef.current?.click()}
          >
            📸 Take photo
          </button>
          <button
            className="btn secondary"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            🖼 Choose from library
          </button>
        </div>
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={onFileChange}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={onFileChange}
        />
      </div>

      {err && (
        <div className="status-banner error">
          <span>⚠</span>
          <span>{err}</span>
        </div>
      )}

      <div className="faint" style={{ fontSize: 12, textAlign: "center" }}>
        Photos are downscaled locally before being sent to the AI — keeps token cost low and never persists the full-res original.
      </div>
    </div>
  );
}
