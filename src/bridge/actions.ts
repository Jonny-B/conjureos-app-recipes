/**
 * Cross-app Action Registry — exposes this recipe library's capabilities to
 * other installed apps and to the orchestrator, via ConjureOS's action bridge.
 *
 * THIS SURFACE IS HOW CONJURE PANTRY GETS ITS RECIPES, and that is worth
 * knowing before changing it. Pantry declares the SHAPE it wants
 * (`manifest.needs`) and the kernel matches it STRUCTURALLY against the
 * `returns` schemas declared for the actions below — no app names, no
 * allow-list, nothing coordinated between the two authors. `listRecipes`
 * (the saved library) and `searchRecipes` (the catalog) both satisfy its
 * `recipeSearch` need, and `getRecipe` satisfies `recipe`.
 *
 * The practical consequence: changing a `returns` schema in package.json can
 * silently DISCONNECT Pantry. `schemaSatisfies` fails closed, so the failure is
 * not an error anywhere — Pantry just shows "nothing can suggest meals yet" and
 * plans nothing. Drop a field from `listRecipes`' or `searchRecipes`' `required`
 * array and you have broken another app with no test failing. Treat those three
 * schemas as a published contract.
 *
 * WHO CAN CALL THESE, and what that means for the exclusions below.
 *
 * Two kinds of caller reach this registry, and only one of them is prompted.
 * Another installed APP is: the kernel stores
 * actionGrants[targetApp][actionName] and asks per action. The ORCHESTRATOR is
 * not — `actionRegistry` gates on `callerAppPath !== null`, and the
 * orchestrator's is null, so it invokes everything here with no dialog at all.
 * That is a deliberate kernel decision (it is trusted shell code, not a
 * sandboxed third party) and this file does not try to relitigate it.
 *
 * It does mean the exclusion list cannot rest on "the user will be asked" — for
 * the consumer this work was built for, they won't be. Each exclusion has to
 * stand on the act itself being one no automated caller should perform
 * unattended:
 *
 *   - Irreversible. `deleteRecipe`: there is no trash and no undo. Worth
 *     revisiting once deletion is recoverable.
 *   - Publishing or privilege. `setVisibility` to public/unlisted and
 *     `chefUpsert` put content somewhere a later un-publish cannot recall it;
 *     `adminSetRole` / `adminListUsers` are operator functions, not app
 *     capabilities, and "Allow X to change user roles?" is a prompt a user can
 *     accept without understanding. `setUsername` is identity.
 *
 * ALSO GONE, and not to be re-added here: the pantry, week-plan, shopping-list,
 * grocery-store and family actions. They belong to Conjure Pantry now, which
 * owns that data. An app that wants a week plan should discover Pantry, not ask
 * this one.
 *
 * `scaleSavedRecipe` returns a scaled copy and reports `saved: false`, because
 * scaling a recipe and committing one to the user's library are different acts
 * and only the second should need a write grant.
 *
 * The original four:
 *
 *   listRecipes({ filter?, limit? })  →  read
 *     The user's saved recipes, optionally filtered.
 *
 *   getRecipe({ slug })  →  read
 *     One full recipe by slug, including ingredients + nutrition.
 *
 *   addRecipe({ recipe })  →  write (user grants on first invocation)
 *     Save a recipe to /home/Documents/Recipes/.
 *
 *   markCooked({ slug })  →  write
 *     Bump made-counter + lastMadeAt. A calorie tracker can use this to
 *     confirm a meal was eaten before logging macros against the day.
 *
 * **All param objects validated strictly before reaching the handler.**
 * Other apps are not trusted — a malicious "calorie tracker" could pass
 * arbitrary content, so every field is whitelisted, length-capped, and
 * type-checked. Invalid params reject with HANDLER_THREW (which the kernel
 * reports cleanly to the caller).
 */

import type {
  Difficulty,
  NutritionStrip,
  Recipe,
  SavedRecipe,
} from "../types";
import type { ChatImage } from "./ai";
import {
  listSavedRecipesResult,
  markMade,
  saveRecipe,
} from "../features/storage";
import { extractRecipeFromImages } from "../features/customRecipe";
import {
  ensureCatalogLoaded,
  isCatalogLoaded,
  searchCatalog,
  getCatalog,
  categories as catalogCategories,
} from "../features/catalog";
import { loadBlockedForWrite, blockRecipe, unblockRecipe } from "../features/blocked";
import { scaleRecipe } from "../features/scaling";
import * as api from "./recipesApi";

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

/**
 * A slug, REJECTED rather than repaired when it isn't one.
 *
 * This used to lowercase and strip every character outside [a-z0-9-], which
 * silently turns one identifier into a different valid identifier: a caller
 * asking about `chicken_pie!` was answered about `chickenpie`, and a caller
 * asking about a recipe that doesn't exist could be answered about one that
 * does. Case-folding is a real normalization and stays; anything else is a
 * caller bug, and saying so beats guessing what they meant.
 */
function asSlug(v: unknown): string {
  const raw = asString(v, "slug", 80).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(raw)) {
    throw new Error("params.slug must contain only letters, digits and hyphens");
  }
  return raw;
}

// ── Handlers ─────────────────────────────────────────────────────────

/**
 * Every read action answers through one of these.
 *
 * A screen that can't reach the backend draws a spinner and the user
 * understands. An ACTION that can't reach the backend and answers `[]` has
 * told its caller something false, and the caller acts on it: an orchestrator
 * reading `{items: []}` from `getPantry` concludes the kitchen is empty and
 * shops for everything; one reading `{ids: []}` from `getBlocked` re-suggests
 * the dish you thumbed down. `storage.ts` documents this distinction at
 * length and the lenient loaders it warns about are the ones these handlers
 * were calling. Failing loudly is the only honest answer across a bridge.
 */
const UNAVAILABLE = "Your recipe library isn't reachable right now — nothing was read. Try again in a moment.";

async function requireLibrary(): Promise<SavedRecipe[]> {
  const r = await listSavedRecipesResult();
  if (!r.ok) throw new Error(UNAVAILABLE);
  return r.recipes;
}

async function requireCatalog(): Promise<void> {
  await ensureCatalogLoaded();
  if (!isCatalogLoaded()) {
    throw new Error("The recipe catalog isn't reachable right now — try again in a moment.");
  }
}

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
  const all = await requireLibrary();
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
  const all = await requireLibrary();
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
  const all = await requireLibrary();
  const found = all.find((r) => r.slug === slug);
  if (!found) throw new Error(`Recipe not found: ${slug}`);
  const updated = await markMade(found);
  return {
    madeCount: updated.madeCount,
    lastMadeAt: updated.lastMadeAt ?? new Date().toISOString(),
  };
}

// ── Catalog + library reads ──────────────────────────────────────────

/**
 * Search the ~1,200-recipe catalog. Distinct from `listRecipes`, which only
 * ever saw the user's OWN library — an orchestrator asked "find me a chilli
 * recipe" had no way to reach the catalog at all.
 *
 * `ingredients` here are the catalog's canonical TOKENS ("chicken breasts"),
 * not the recipe's lines ("2 chicken breasts (boneless, skinless)"): the list
 * payload never carries the lines, and the tokens are what a caller matching
 * recipes against a kitchen wants anyway. Declaring them `required` is what
 * lets Conjure Pantry's `recipeSearch` need match this action, so the catalog
 * reaches its planner and not only the handful of recipes a user has saved.
 */
async function searchRecipes(rawParams?: unknown): Promise<{ recipes: unknown[] }> {
  const p = asObject(rawParams ?? {});
  const query = typeof p.query === "string" ? p.query.slice(0, 100).trim() : "";
  const category = typeof p.category === "string" ? p.category.slice(0, 40) : "";
  const limit = p.limit === undefined ? 20 : asPositiveInt(p.limit, "limit", 50);
  await requireCatalog();
  let hits = query ? searchCatalog(query) : getCatalog();
  if (category) hits = hits.filter((r) => r.category.toLowerCase() === category.toLowerCase());
  return {
    recipes: hits.slice(0, Math.max(1, limit)).map((r) => ({
      id: r.id,
      title: r.title,
      ingredients: Array.isArray(r.tokens) ? [...r.tokens] : [],
      category: r.category,
      difficulty: r.difficulty,
      cookTime: r.cookTime,
      servings: r.servings,
      tags: r.tags,
      ...(r.nutrition ? { nutrition: r.nutrition } : {}),
    })),
  };
}

/** The catalog's category taxonomy with counts, so a caller can filter sensibly. */
async function listCategories(): Promise<{ categories: { name: string; count: number }[] }> {
  await requireCatalog();
  return { categories: catalogCategories() };
}

// ── Pantry ───────────────────────────────────────────────────────────

async function setFavorite(rawParams?: unknown): Promise<{ slug: string; favorite: boolean }> {
  const p = asObject(rawParams);
  const slug = asSlug(p.slug);
  if (typeof p.favorite !== "boolean") throw new Error("params.favorite must be a boolean");
  const all = await requireLibrary();
  const found = all.find((r) => r.slug === slug);
  if (!found) throw new Error(`Recipe not found: ${slug}`);
  const updated = await api.setFavorite(api.recipeIdFromPath(found.path), p.favorite);
  return { slug, favorite: !!updated.favorite };
}

/**
 * Thumbs-down / undo. Scoped to RECOMMENDATIONS only, exactly as in the UI:
 * a blocked recipe stays searchable, openable and cookable, the planner just
 * stops picking it. Reversible, which is why it's on the safe side of the line.
 */
async function setBlocked(rawParams?: unknown): Promise<{ id: string; blocked: boolean; count: number }> {
  const p = asObject(rawParams);
  if (typeof p.id !== "string" || !p.id.trim()) throw new Error("params.id must be a non-empty string");
  if (typeof p.blocked !== "boolean") throw new Error("params.blocked must be a boolean");
  // Truncating here doesn't lose data, it CHANGES the target: a 200-character
  // id cut to 64 is a different id, and the block landed on some other recipe
  // (or on nothing) while the caller was told it worked.
  const id = asString(p.id, "id", 64);
  const after = p.blocked ? await blockRecipe(id) : await unblockRecipe(id);
  return { id, blocked: p.blocked, count: after.size };
}

async function getBlocked(): Promise<{ ids: string[] }> {
  return { ids: [...(await loadBlockedForWrite())] };
}

// ── Scaling ──────────────────────────────────────────────────────────

async function scaleSavedRecipe(rawParams?: unknown): Promise<Record<string, unknown>> {
  const p = asObject(rawParams);
  const slug = asSlug(p.slug);
  const servings = asPositiveInt(p.servings, "servings", 64);
  if (servings < 1) throw new Error("params.servings must be at least 1");
  const all = await requireLibrary();
  const found = all.find((r) => r.slug === slug);
  if (!found) throw new Error(`Recipe not found: ${slug}`);
  const scaled = scaleRecipe(found, servings / Math.max(1, found.servings));
  return {
    slug,
    title: scaled.title,
    servings: scaled.servings,
    ingredients: scaled.ingredients,
    ...(scaled.nutrition ? { nutrition: scaled.nutrition } : {}),
    saved: false,
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
    searchRecipes,
    listCategories,
    setFavorite,
    setBlocked,
    getBlocked,
    scaleSavedRecipe,
  });
}
