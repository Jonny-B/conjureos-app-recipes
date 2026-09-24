/**
 * AI photos for recipes: generate, stamp, upload.
 *
 *   1. ConjureOS makes the image (`ai.image.generate`, the `ai.image`
 *      permission). It is billed to the signed-in user's credits — an admin
 *      generating for someone else's recipe pays with their own. Desktop only
 *      today; `isAiPhotoAvailable()` is false elsewhere and the buttons hide.
 *   2. We STAMP it: "AI-generated" is drawn into the pixels, top-right,
 *      before it is ever uploaded (owner decision, 2026-09-23: burned in, not
 *      a web overlay, so the mark travels with the file). Doing it here, not in
 *      the Edge Function, is deliberate: Edge Functions have a tight CPU budget
 *      and no image library, and a canvas does this in milliseconds.
 *   3. We upload it flagged `ai`, which files it under an `ai-` key; the server
 *      derives `image_ai` on the recipe from that key and never trusts a
 *      client-sent flag.
 */
import type { Recipe } from "../types";
import { uploadRecipeImage } from "../bridge/recipesApi";
import { vfs } from "../bridge/vfs";
import { ensureTermsAccepted } from "./terms";

interface GeneratedImage {
  path: string;
  mediaType: string;
  bytes: number;
  credits: number | null;
}
interface CapabilityOption {
  id: string;
  credits: number;
}
interface CapabilityInfo {
  capability: string;
  available: boolean;
  options: CapabilityOption[];
  defaultOptionId?: string;
}
interface AiImageBridge {
  capabilities?: () => Promise<CapabilityInfo[]>;
  image?: { generate?: (opts: { prompt: string; option?: string }) => Promise<GeneratedImage> };
}

const bridge = (): AiImageBridge | undefined =>
  (globalThis as { __conjureos?: { ai?: AiImageBridge } }).__conjureos?.ai;

export function isAiPhotoAvailable(): boolean {
  return typeof bridge()?.image?.generate === "function";
}

/** What one image costs in credits right now, or null if it can't be said. */
export async function aiPhotoCost(): Promise<number | null> {
  try {
    const caps = (await bridge()?.capabilities?.()) ?? [];
    const cap = caps.find((c) => c.capability === "image.generate");
    if (!cap || !cap.available) return null;
    const opt = cap.options.find((o) => o.id === cap.defaultOptionId) ?? cap.options[0];
    return opt && opt.credits > 0 ? opt.credits : null;
  } catch {
    return null;
  }
}

/** The prompt: what the dish is, how it should look, and what to leave out. */
export function recipePhotoPrompt(recipe: Pick<Recipe, "title" | "ingredients">, category?: string | null): string {
  const main = recipe.ingredients
    .slice(0, 6)
    .map((l) => l.replace(/\(.*?\)/g, "").trim())
    .filter(Boolean)
    .join("; ");
  return [
    `A realistic, appetizing food photograph of "${recipe.title}"${category ? `, a ${category.toLowerCase()} dish` : ""}.`,
    main ? `It is made with: ${main}.` : "",
    "Home-cooked and plated simply on a table, soft natural light, shot from a slight angle, shallow depth of field.",
    "No text, no labels, no logos, no watermarks, no people, no hands.",
  ]
    .filter(Boolean)
    .join(" ");
}

const LONGEST_EDGE = 1024;
export const AI_MARK_TEXT = "AI-generated";

/**
 * Draw the image onto a canvas (at most 1024px on the long edge) with the
 * "AI-generated" mark burned into the TOP-RIGHT corner, and return a JPEG
 * as bare base64. The mark scales with the image so it reads the same at any
 * size: a translucent dark box, white text, about 2.4% of the width tall.
 */
export async function stampAiMark(dataUrl: string): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Couldn't read the generated image."));
    i.src = dataUrl;
  });
  const scale = Math.min(1, LONGEST_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't prepare the image.");
  ctx.drawImage(img, 0, 0, w, h);

  // Pixel colours on an image, not UI colours: the palette tokens don't apply.
  const fontPx = Math.max(12, Math.round(w * 0.024));
  ctx.font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const textW = Math.ceil(ctx.measureText(AI_MARK_TEXT).width);
  const padX = Math.round(fontPx * 0.7);
  const boxW = textW + padX * 2;
  const boxH = Math.round(fontPx * 1.8);
  const margin = Math.round(w * 0.025);
  // Top-right, not the conventional bottom-right: on the open recipe the
  // picture fades into the card from the left and from the bottom, which
  // hid a bottom-right stamp completely. Top-right is the one corner no
  // surface fades or covers, and photos are anchored to their top edge
  // (styles.css .plate--photo) so a crop never takes it either.
  const x = w - boxW - margin;
  const y = margin;
  ctx.fillStyle = "rgba(0, 0, 0, 0.58)";
  ctx.fillRect(x, y, boxW, boxH);
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.textBaseline = "middle";
  ctx.fillText(AI_MARK_TEXT, x + padX, y + boxH / 2 + 1);

  const out = canvas.toDataURL("image/jpeg", 0.88);
  return out.slice(out.indexOf(",") + 1);
}

/**
 * Generate, stamp and upload a photo for a recipe. Returns the public URL,
 * ready to put on the recipe (own recipe: `imageUrl` on save; an admin on any
 * recipe: `adminSetRecipeImage`). Throws with a readable message on failure.
 */
export async function generateRecipePhoto(
  recipe: Pick<Recipe, "title" | "ingredients">,
  category?: string | null,
): Promise<{ url: string; credits: number | null }> {
  const gen = bridge()?.image?.generate;
  if (!gen) throw new Error("AI images aren't available here yet (ConjureOS desktop only).");
  // Terms BEFORE the spend: asking at upload time meant someone who declined
  // had already paid for an image that could never be saved.
  await ensureTermsAccepted();
  const image = await gen({ prompt: recipePhotoPrompt(recipe, category) });
  const b64 = (await vfs.read(image.path)).replace(/^data:[^,]*,/, "");
  const stamped = await stampAiMark(`data:${image.mediaType};base64,${b64}`);
  const url = await uploadRecipeImage("image/jpeg", stamped, { ai: true });
  // The generated original sits in this app's own folder; the stamped copy is
  // the one we keep, so the unmarked file goes.
  vfs.rm(image.path).catch(() => {});
  return { url, credits: image.credits };
}
