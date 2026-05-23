/**
 * Photo capture utilities — file → downscaled data URL → base64 split.
 *
 * Vision API token cost scales with image size. A full-resolution phone
 * photo (~4000×3000) easily runs 1500+ tokens *per call*; cap the longer
 * side at 1280px and quality drops aren't visible at fridge-recognition
 * scale, but cost drops 4-5×.
 */

const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 0.85;

import type { CapturedPhoto } from "../types";

export async function preparePhoto(input: File | Blob): Promise<CapturedPhoto> {
  const originalBytes = input.size;
  const bitmap = await loadBitmap(input);
  const { canvas, width, height } = downscale(bitmap, MAX_DIMENSION);
  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  const base64 = dataUrl.split(",", 2)[1] ?? "";
  // crypto.randomUUID is universal in modern browsers (Safari 15.4+); we
  // ship to ConjureOS which already targets ES2022.
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    dataUrl,
    base64,
    mediaType: "image/jpeg",
    width,
    height,
    originalBytes,
  };
}

async function loadBitmap(input: File | Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(input);
  }
  // Safari fallback — older versions don't expose createImageBitmap on files.
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(input);
  });
}

interface DownscaleResult {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

function downscale(
  bitmap: ImageBitmap | HTMLImageElement,
  maxDim: number,
): DownscaleResult {
  const srcW = "width" in bitmap ? bitmap.width : (bitmap as HTMLImageElement).naturalWidth;
  const srcH = "height" in bitmap ? bitmap.height : (bitmap as HTMLImageElement).naturalHeight;
  const longer = Math.max(srcW, srcH);
  const scale = longer > maxDim ? maxDim / longer : 1;
  const dstW = Math.round(srcW * scale);
  const dstH = Math.round(srcH * scale);
  const canvas = document.createElement("canvas");
  canvas.width = dstW;
  canvas.height = dstH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, dstW, dstH);
  return { canvas, width: dstW, height: dstH };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
