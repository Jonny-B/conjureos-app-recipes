import { useEffect, useRef, useState, type DragEvent, type ChangeEvent } from "react";
import { preparePhoto, formatBytes } from "../features/capture";
import { Icon } from "../icons";
import type { CapturedPhoto } from "../types";

/**
 * True on touch devices (phones/tablets): a coarse pointer. We use this to
 * shape the capture affordances — "Take photo" (camera capture) only makes
 * sense with a camera-backed coarse pointer, and "drag photos here" only
 * makes sense with a mouse. A desktop window narrowed to phone width still
 * reports a fine pointer, which is correct: it has no camera to capture from.
 */
function usePointerCoarse(): boolean {
  const [coarse, setCoarse] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: coarse)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(pointer: coarse)");
    const onChange = () => setCoarse(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return coarse;
}

interface Props {
  onIdentify: (photos: CapturedPhoto[]) => void;
  /**
   * Photos to start with. Every caller flips to a "working" mode while the AI
   * call runs, which renders a DIFFERENT branch and therefore unmounts this
   * component — taking its local photo state with it. On a failure the caller
   * flips back, remounting a fresh CaptureScreen, and the user's photos were
   * gone: reshoot the whole fridge because the model returned bad JSON. The
   * caller now retains them and hands them back here.
   */
  initialPhotos?: CapturedPhoto[];
  /** Heading shown before any photo is added. Default: fridge-scan copy. */
  title?: string;
  /** Sub-line shown with zero photos. Default: fridge-scan copy. */
  emptyHint?: string;
  /** Sub-line shown once photos exist. Default: fridge-scan copy. */
  moreHint?: string;
  /** Label for the primary "go" button once photos exist. */
  actionLabel?: (count: number) => string;
}

const MAX_PHOTOS = 6;

export function CaptureScreen({ onIdentify, initialPhotos, title, emptyHint, moreHint, actionLabel }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [photos, setPhotos] = useState<CapturedPhoto[]>(initialPhotos ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const isTouch = usePointerCoarse();

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
      <h2>{photos.length === 0 ? title ?? "Show me your fridge" : "Add more photos?"}</h2>
      {photos.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          {emptyHint ?? "Snap or upload a photo or two — I'll list what I see."}
        </p>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          {moreHint ??
            "More angles, better recognition. Shoot the door, the back of a shelf, your spice rack, and I'll merge them."}
        </p>
      )}

      {photos.length > 0 && (
        <div className="capture-buttons" style={{ marginTop: 4 }}>
          <button className="btn" disabled={busy} onClick={() => onIdentify(photos)}>
            {actionLabel
              ? actionLabel(photos.length)
              : `Identify ingredients from ${photos.length} photo${photos.length === 1 ? "" : "s"} →`}
          </button>
        </div>
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
                <Icon name="xmark" />
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
        <div className="icon">
          {/* Font Awesome free "camera" (solid). Inlined as SVG rather than
              pulled from a CDN/icon-font so the single-file embed build stays
              fully self-contained. Filled with the Modern Whimsy accent
              gradient (purple → blue). */}
          <svg viewBox="0 0 512 512" role="img" aria-label="Camera">
            <defs>
              <linearGradient id="camGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#a5b4fc" />
                <stop offset="100%" stopColor="#7c6af7" />
              </linearGradient>
            </defs>
            <path
              fill="url(#camGrad)"
              d="M149.1 64.8L138.7 96 64 96C28.7 96 0 124.7 0 160L0 416c0 35.3 28.7 64 64 64l384 0c35.3 0 64-28.7 64-64l0-256c0-35.3-28.7-64-64-64l-74.7 0L362.9 64.8C356.4 45.2 338.1 32 317.4 32L194.6 32c-20.7 0-39 13.2-45.5 32.8zM256 192a96 96 0 1 1 0 192 96 96 0 1 1 0-192z"
            />
          </svg>
        </div>
        <div style={{ marginBottom: 16 }}>
          {busy
            ? "Preparing photos…"
            : canAddMore
            ? photos.length === 0
              ? isTouch
                ? "Add a photo:"
                : "Drag photos here, or:"
              : `Add up to ${room} more, or:`
            : `${MAX_PHOTOS}-photo limit reached.`}
        </div>
        <div className="capture-buttons">
          {/* "Take photo" (camera capture) only on touch devices; a desktop
              has no camera to capture from, so it would just open a file
              dialog — confusing. There, "Choose files" is the primary action. */}
          {isTouch && (
            <button
              className="btn"
              disabled={busy || !canAddMore}
              onClick={() => cameraRef.current?.click()}
            >
              <Icon name="camera" />
              Take photo
            </button>
          )}
          <button
            className={`btn${isTouch ? " secondary" : ""}`}
            disabled={busy || !canAddMore}
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="images" />
            {isTouch ? "Choose from library" : "Choose files"}
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
          <Icon name="wand" />
          <span>{err}</span>
        </div>
      )}

      <div className="faint" style={{ fontSize: 12, textAlign: "center" }}>
        Photos are downscaled locally before being sent to the AI. Up to {MAX_PHOTOS} per session.
      </div>
    </div>
  );
}
