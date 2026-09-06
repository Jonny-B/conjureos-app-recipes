/**
 * Cross-app Action Registry — exposes recipe-app capabilities to other
 * installed apps (calorie tracker, meal planner, shopping list, etc.)
 * via ConjureOS's Phase 13a action bridge.
 *
 * Four actions:
 *
 *   listRecipes({ filter?, limit? })  →  read
 *     Returns the user's saved recipes, optionally filtered. Used by
 *     calorie / meal-planning / shopping-list apps to surface what's
 *     already in the user's library.
 *
 *   getRecipe({ slug })  →  read
 *     One full recipe by slug, including ingredients + nutrition.
 *
 *   addRecipe({ recipe })  →  write (user grants on first invocation)
 *     Save a recipe to /home/Documents/Recipes/. Meal planners push
 *     here.
 *
 *   markCooked({ slug })  →  write
 *     Bump made-counter + lastMadeAt. Calorie trackers can use this to
 *     confirm a meal was eaten before logging macros against the day.
 *
 * **All param objects validated strictly before reaching the handler.**
 * Other apps are not trusted — a malicious "calorie tracker" could pass
 * arbitrary content, so every field is whitelisted, length-capped, and
 * type-checked. Invalid params reject with HANDLER_THREW (which the
 * kernel reports cleanly to the caller).
 */

import type {
  Difficulty,
  NutritionStrip,
  Recipe,
  SavedRecipe,
} from "../types";
import type { ChatImage } from "./ai";
import {
  listSavedRecipes,
  markMade,
  saveRecipe,
} from "../features/storage";
import { extractRecipeFromImages } from "../features/customRecipe";

declare global {
  /**
   * Augments the shared `ConjureosBridge` interface declared in ai.ts
   * with the actions sub-bridge. TS merges declarations across modules.
   */
  interface ConjureosBridge {
    actions?: {
      register: (
        handlers: Record<string, (params?: unknown) => Promise<unknown>>,
      ) => Promise<void>;
    };
  }
}

const MAX_TITLE = 80;
const MAX_SUMMARY = 400;
const MAX_INGREDIENTS = 30;
const MAX_INGREDIENT_LINE = 80;
const MAX_INSTRUCTIONS = 30;
const MAX_INSTRUCTION_LINE = 400;

// ── Param validation ─────────────────────────────────────────────────

function asObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error("params must be an object");
  }
  return v as Record<string, unknown>;
}

function asString(v: unknown, field: string, maxLen: number): string {
  if (typeof v !== "string") {
    throw new Error(`params.${field} must be a string`);
  }
  const trimmed = v.trim();
  if (!trimmed) throw new Error(`params.${field} cannot be empty`);
  if (trimmed.length > maxLen) {
    throw new Error(`params.${field} exceeds ${maxLen} characters`);
  }
  // Strip ASCII control chars to prevent terminal-escape / log-poisoning
  // when another app's output gets surfaced.
  // eslint-disable-next-line no-control-regex
  return trimmed.replace(/[\x00-\x1F\x7F]/g, "");
}

function asOptionalString(v: unknown, field: string, maxLen: number): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return asString(v, field, maxLen);
}

function asPositiveInt(v: unknown, field: string, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new Error(`params.${field} must be a non-negative number`);
  }
  if (v > max) throw new Error(`params.${field} exceeds ${max}`);
  return Math.round(v);
}

function asDifficulty(v: unknown): Difficulty {
  if (v === "easy" || v === "medium" || v === "hard") return v;
  throw new Error(`params.difficulty must be "easy", "medium", or "hard"`);
}

function asStringArray(
  v: unknown,
  field: string,
  maxItems: number,
  maxLineLen: number,
): string[] {
  if (!Array.isArray(v)) throw new Error(`params.${field} must be an array of strings`);
  if (v.length > maxItems) {
    throw new Error(`params.${field} has more than ${maxItems} items`);
  }
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const s = asString(v[i], `${field}[${i}]`, maxLineLen);
    out.push(s);
  }
  if (out.length === 0) throw new Error(`params.${field} cannot be empty`);
  return out;
}

function asOptionalNutrition(v: unknown): NutritionStrip | null {
  if (v === undefined || v === null) return null;
  const obj = asObject(v);
  // Every macro is optional in the published manifest schema (no `required`
  // array), but this used to demand all four — so a conforming caller sending
  // {calories: 420}, which is all a meal planner may know, had its whole
  // addRecipe rejected with HANDLER_THREW. Missing macros default to 0 and are
  // still range-checked when present.
  return {
    calories: asPositiveInt(obj.calories ?? 0, "nutrition.calories", 10_000),
    protein: asPositiveInt(obj.protein ?? 0, "nutrition.protein", 1000),
    fat: asPositiveInt(obj.fat ?? 0, "nutrition.fat", 1000),
    carbs: asPositiveInt(obj.carbs ?? 0, "nutrition.carbs", 1000),
    matched: asPositiveInt(obj.matched ?? 0, "nutrition.matched", 100),
    total: asPositiveInt(obj.total ?? 0, "nutrition.total", 100),
    est: true,
  };
}

function asSlug(v: unknown): string {
  const raw = asString(v, "slug", 80);
  // Slugs are URL-safe: lowercase letters, digits, hyphens.
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!cleaned) throw new Error("params.slug invalid after sanitization");
  return cleaned;
}

// ── Handlers ─────────────────────────────────────────────────────────

interface ListedRecipe {
  slug: string;
  title: string;
  difficulty: Difficulty;
  cookTime: number;
  servings: number;
  ingredients: string[];
  savedAt: string;
  madeCount: number;
  /** ISO timestamp of the most recent cook, or null. Lets calorie/health
   *  apps answer "what did I cook this week?" without a getRecipe per item. */
  lastMadeAt: string | null;
  nutrition: NutritionStrip | null;
}

async function listRecipes(rawParams?: unknown): Promise<{ recipes: ListedRecipe[] }> {
  let filter: string | undefined;
  let limit = 50;
  if (rawParams !== undefined && rawParams !== null) {
    const p = asObject(rawParams);
    filter = asOptionalString(p.filter, "filter", 100)?.toLowerCase();
    if (p.limit !== undefined) {
      limit = Math.min(500, asPositiveInt(p.limit, "limit", 500));
    }
  }
  const all = await listSavedRecipes();
  const matches = filter
    ? all.filter((r) => {
        if (r.title.toLowerCase().includes(filter!)) return true;
        if (r.summary?.toLowerCase().includes(filter!)) return true;
        for (const ing of r.ingredients) {
          if (ing.toLowerCase().includes(filter!)) return true;
        }
        return false;
      })
    : all;
  return {
    recipes: matches.slice(0, limit).map(projectListed),
  };
}

function projectListed(r: SavedRecipe): ListedRecipe {
  return {
    slug: r.slug,
    title: r.title,
    difficulty: r.difficulty,
    cookTime: r.cookTime,
    servings: r.servings,
    ingredients: r.ingredients,
    savedAt: r.savedAt,
    madeCount: r.madeCount,
    lastMadeAt: r.lastMadeAt ?? null,
    nutrition: r.nutrition ?? null,
  };
}

async function getRecipe(rawParams?: unknown): Promise<{ recipe: SavedRecipe | null }> {
  const p = asObject(rawParams);
  const slug = asSlug(p.slug);
  const all = await listSavedRecipes();
  const found = all.find((r) => r.slug === slug);
  return { recipe: found ?? null };
}

async function addRecipe(rawParams?: unknown): Promise<{ slug: string; path: string }> {
  const p = asObject(rawParams);
  const recipeRaw = asObject(p.recipe ?? p);
  const title = asString(recipeRaw.title, "recipe.title", MAX_TITLE);
  const difficulty = asDifficulty(recipeRaw.difficulty);
  const cookTime = asPositiveInt(recipeRaw.cookTime, "recipe.cookTime", 720);
  const servings = recipeRaw.servings !== undefined
    ? Math.max(1, asPositiveInt(recipeRaw.servings, "recipe.servings", 24))
    : 2;
  const ingredients = asStringArray(
    recipeRaw.ingredients,
    "recipe.ingredients",
    MAX_INGREDIENTS,
    MAX_INGREDIENT_LINE,
  );
  const instructions = asStringArray(
    recipeRaw.instructions,
    "recipe.instructions",
    MAX_INSTRUCTIONS,
    MAX_INSTRUCTION_LINE,
  );
  const summary = asOptionalString(recipeRaw.summary, "recipe.summary", MAX_SUMMARY);
  const nutrition = asOptionalNutrition(recipeRaw.nutrition);

  const recipe: Recipe = {
    title,
    difficulty,
    cookTime,
    servings,
    ingredients,
    instructions,
    nutrition,
    ...(summary ? { summary } : {}),
  };
  const saved = await saveRecipe(recipe);
  return { slug: saved.slug, path: saved.path };
}

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const MAX_IMPORT_IMAGES = 6;

/**
 * Validate untrusted { mediaType, data } image params from another app
 * (the ConjureOS orchestrator forwards the user's attached photos here).
 * Whitelist the media type, require a non-empty base64 string, cap the
 * count. We do NOT decode/inspect the bytes.
 *
 * NOTE, corrected: this used to claim "the editable-preview-on-save step" as a
 * content defense, "same posture as Snap-a-recipe in the app UI". That is FALSE
 * for this path. Snap-a-recipe routes its transcription through RecipeEditor so
 * the user checks it before saving; importRecipeFromImage saves directly,
 * because a bridge call has no UI to present a preview in — the app may not
 * even be open. The real posture here is: the caller holds `actions.write`,
 * which the user granted per-app, and the model's output is sanitised by
 * saveRecipe on the way in. A recipe the user did not vet can therefore land in
 * their library, and the mitigation is that they can see and delete it.
 * If a review step is ever wanted here it needs a genuine notification surface,
 * not a comment.
 */
function asChatImages(v: unknown): ChatImage[] {
  if (!Array.isArray(v)) {
    throw new Error("params.images must be an array of { mediaType, data }");
  }
  if (v.length === 0) throw new Error("params.images cannot be empty");
  const out: ChatImage[] = [];
  for (let i = 0; i < v.length && out.length < MAX_IMPORT_IMAGES; i++) {
    const it = v[i];
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    if (typeof o.mediaType !== "string" || !ALLOWED_IMAGE_TYPES.has(o.mediaType)) {
      throw new Error(
        `params.images[${i}].mediaType must be one of image/jpeg, image/png, image/webp, image/gif`,
      );
    }
    if (typeof o.data !== "string" || o.data.length === 0) {
      throw new Error(`params.images[${i}].data must be a non-empty base64 string`);
    }
    out.push({ mediaType: o.mediaType as ChatImage["mediaType"], data: o.data });
  }
  if (out.length === 0) throw new Error("params.images had no usable images");
  return out;
}

/**
 * Transcribe a recipe from one or more attached photos and save it to the
 * user's library. This is the action behind "add this recipe to my recipe
 * app" with a photo: the ConjureOS orchestrator routes the user's attached
 * image here, we run the same vision transcription Snap-a-recipe uses, then
 * persist via saveRecipe. Returns the new slug so the caller can deep-link.
 *
 * Saves WITHOUT a review step, unlike the in-app Snap-a-recipe flow — see the
 * note on asChatImages above.
 */
async function importRecipeFromImage(
  rawParams?: unknown,
): Promise<{ slug: string; title: string; path: string }> {
  const p = asObject(rawParams);
  const images = asChatImages(p.images);
  const recipe = await extractRecipeFromImages(images);
  const saved = await saveRecipe(recipe);
  return { slug: saved.slug, title: saved.title, path: saved.path };
}

async function markCooked(rawParams?: unknown): Promise<{ madeCount: number; lastMadeAt: string }> {
  const p = asObject(rawParams);
  const slug = asSlug(p.slug);
  const all = await listSavedRecipes();
  const found = all.find((r) => r.slug === slug);
  if (!found) throw new Error(`Recipe not found: ${slug}`);
  const updated = await markMade(found);
  return {
    madeCount: updated.madeCount,
    lastMadeAt: updated.lastMadeAt ?? new Date().toISOString(),
  };
}

// ── Registration ─────────────────────────────────────────────────────

export async function registerActions(): Promise<void> {
  const bridge = window.__conjureos?.actions;
  if (!bridge) {
    // Either we're not running inside ConjureOS (npm run dev) or the
    // host is too old to expose the bridge. Either way: silently no-op.
    return;
  }
  await bridge.register({
    listRecipes,
    getRecipe,
    addRecipe,
    importRecipeFromImage,
    markCooked,
  });
}
