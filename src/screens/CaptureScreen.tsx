import { useRef, useState, type DragEvent, type ChangeEvent } from "react";
import { preparePhoto, formatBytes } from "../features/capture";
import type { CapturedPhoto } from "../types";

interface Props {
  onIdentify: (photos: CapturedPhoto[]) => void;
}

const MAX_PHOTOS = 6;

export function CaptureScreen({ onIdentify }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | File[]) => {
    setErr(null);
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    const room = MAX_PHOTOS - photos.length;
    if (room <= 0) {
      setErr(`Up to ${MAX_PHOTOS} photos per session — remove one to add another.`);
      return;
    }
    const slice = incoming.slice(0, room);
    if (slice.length < incoming.length) {
      setErr(`Only added the first ${slice.length} (${MAX_PHOTOS}-photo cap).`);
    }
    setBusy(true);
    try {
      const prepared: CapturedPhoto[] = [];
      for (const file of slice) {
        try {
          const photo = await preparePhoto(file);
          prepared.push(photo);
        } catch (e) {
          // Skip the bad file but keep going on the others; surface the
          // first failure if everything blew up.
          if (prepared.length === 0 && !err) {
            setErr(e instanceof Error ? e.message : String(e));
          }
        }
      }
      if (prepared.length > 0) {
        setPhotos((prev) => [...prev, ...prepared]);
      }
    } finally {
      setBusy(false);
    }
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) addFiles(files);
    e.target.value = "";
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) addFiles(files);
  };

  const removePhoto = (id: string) => {
    setPhotos((prev) => prev.filter((p) => p.id !== id));
  };

  const room = MAX_PHOTOS - photos.length;
  const canAddMore = room > 0;

  return (
    <div className="capture-screen">
      <h2>{photos.length === 0 ? "Show me your fridge" : "Add more photos?"}</h2>
      {photos.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Snap or upload one or more photos. Open shelves help; the pantry counts too. I'll dedupe items across photos so you don't get the same sour cream twice.
        </p>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          More angles = better recognition. Shoot the door, the back of a shelf, your spice rack — I'll merge them.
        </p>
      )}

      {photos.length > 0 && (
        <div className="photo-gallery">
          {photos.map((p, i) => (
            <div key={p.id} className="photo-tile">
              <img src={p.dataUrl} alt={`Photo ${i + 1}`} />
              <button
                className="photo-tile-remove"
                onClick={() => removePhoto(p.id)}
                aria-label="Remove photo"
                title="Remove"
              >
                ✕
              </button>
              <div className="photo-tile-meta">
                {p.width}×{p.height} · {formatBytes(p.originalBytes)}
              </div>
            </div>
          ))}
        </div>
      )}

      <div
        className={`capture-area${dragOver ? " dragover" : ""}${canAddMore ? "" : " disabled"}`}
        onDragOver={(e) => {
          if (!canAddMore) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={canAddMore ? onDrop : undefined}
      >
        <div className="icon">📷</div>
        <div style={{ marginBottom: 16 }}>
          {busy
            ? "Preparing photos…"
            : canAddMore
            ? photos.length === 0
              ? "Drag photos here, or:"
              : `Add up to ${room} more, or:`
            : `${MAX_PHOTOS}-photo limit reached.`}
        </div>
        <div className="capture-buttons">
          <button
            className="btn"
            disabled={busy || !canAddMore}
            onClick={() => cameraRef.current?.click()}
          >
            📸 Take photo
          </button>
          <button
            className="btn secondary"
            disabled={busy || !canAddMore}
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
          multiple
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

      <div className="capture-buttons" style={{ marginTop: 4 }}>
        <button
          className="btn"
          disabled={photos.length === 0 || busy}
          onClick={() => onIdentify(photos)}
        >
          {photos.length === 0
            ? "Add a photo to continue"
            : `Identify ingredients from ${photos.length} photo${photos.length === 1 ? "" : "s"} →`}
        </button>
      </div>

      <div className="faint" style={{ fontSize: 12, textAlign: "center" }}>
        Photos are downscaled locally before being sent to the AI. Up to {MAX_PHOTOS} per session.
      </div>
    </div>
  );
}
