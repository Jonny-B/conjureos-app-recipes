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
import { splitIngredient } from "./recipeLook";

/**
 * The quality tier asked of ConjureOS (owner decision, 2026-09-24). The
 * platform default, "standard", is its cheapest rung (~$0.006, "right for
 * icons and thumbnails") and recipe photos made on it looked poor. "high" is
 * ~$0.05 an image, billed to whoever generates it. "ultra" (~$0.21) exists
 * too; not offered.
 */
export const AI_PHOTO_OPTION = "high";

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
    const opt = cap.options.find((o) => o.id === AI_PHOTO_OPTION);
    return opt && opt.credits > 0 ? opt.credits : null;
  } catch {
    return null;
  }
}

/** Pantry basics that add nothing to a picture of the dish. */
const UNPICTURED = /^(?:salt|pepper|black pepper|water|oil|vegetable oil|olive oil|canola oil|cooking spray|nonstick cooking spray|salt and pepper)$/i;

/**
 * The prompt: what the finished dish looks like, and how to photograph it.
 *
 * It used to paste the ingredient LINES — "1 can (14.5 ounces) diced
 * tomatoes, low-sodium" — which gave the model quantities and packaging to
 * draw instead of food. Now it names up to six main ingredients, plain,
 * and spends its words on the photograph: a full plated scene (the platform
 * asks for a transparent background, and a bare cut-out saved as JPEG goes
 * black), natural light, real texture.
 */
export function recipePhotoPrompt(recipe: Pick<Recipe, "title" | "ingredients">, category?: string | null): string {
  const seen = new Set<string>();
  const main: string[] = [];
  for (const line of recipe.ingredients) {
    const name = splitIngredient(line)
      .name.replace(/\(.*?\)/g, "")
      .split(/,|;| or /)[0]!
      .trim()
      .toLowerCase();
    if (!name || UNPICTURED.test(name) || seen.has(name)) continue;
    seen.add(name);
    main.push(name);
    if (main.length >= 6) break;
  }
  const kind = category ? `${category.toLowerCase()} ` : "";
  return [
    `Professional food photograph of ${recipe.title}, a finished ${kind}dish, freshly cooked and plated to serve.`,
    main.length ? `The dish visibly features ${main.join(", ")}.` : "",
    "A complete scene filling the whole frame: the dish on a plate or in a bowl on a wooden or stone table, with a softly blurred kitchen background.",
    "Natural window light, three-quarter angle, shallow depth of field, rich true-to-life colours, appetizing and realistic textures, editorial cookbook style.",
    "Photorealistic. No text, no labels, no logos, no watermarks, no people, no hands, no cutlery clutter.",
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
 * size: a faint dark box and soft white text, about 1.7% of the width tall.
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
  // A neutral table colour UNDER the image: the platform asks the model for a
  // transparent background, and any transparent pixels would otherwise turn
  // black in the JPEG. (Pixel colour on an image, not a UI colour.)
  ctx.fillStyle = "#e9e4dc";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  // Pixel colours on an image, not UI colours: the palette tokens don't apply.
  // Deliberately quiet (owner: "not so visible"): small, a faint box, soft
  // text — present and legible, not a banner across the food.
  const fontPx = Math.max(11, Math.round(w * 0.017));
  ctx.font = `500 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const textW = Math.ceil(ctx.measureText(AI_MARK_TEXT).width);
  const padX = Math.round(fontPx * 0.6);
  const boxW = textW + padX * 2;
  const boxH = Math.round(fontPx * 1.7);
  const margin = Math.round(w * 0.02);
  // Top-right, not the conventional bottom-right: on the open recipe the
  // picture fades into the card from the left and from the bottom, which
  // hid a bottom-right stamp completely. Top-right is the one corner no
  // surface fades or covers, and photos are anchored to their top edge
  // (styles.css .plate--photo) so a crop never takes it either.
  const x = w - boxW - margin;
  const y = margin;
  ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
  ctx.fillRect(x, y, boxW, boxH);
  ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
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
  const image = await gen({ prompt: recipePhotoPrompt(recipe, category), option: AI_PHOTO_OPTION });
  const b64 = (await vfs.read(image.path)).replace(/^data:[^,]*,/, "");
  const stamped = await stampAiMark(`data:${image.mediaType};base64,${b64}`);
  const url = await uploadRecipeImage("image/jpeg", stamped, { ai: true });
  // The generated original sits in this app's own folder; the stamped copy is
  // the one we keep, so the unmarked file goes.
  vfs.rm(image.path).catch(() => {});
  return { url, credits: image.credits };
}
