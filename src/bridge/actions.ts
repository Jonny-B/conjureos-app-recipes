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
 * Added since (0.59.0), so a caller can do more than find a recipe's name:
 *
 *   getCatalogRecipe({ id })            →  read   a catalog recipe in full
 *   getSharedRecipe({ shareToken })     →  read   a recipe from a share link
 *   listChefPicks({ limit? })           →  read   the featured chef recipes
 *   parseIngredients({ lines })         →  read   quantity / unit / food
 *   estimateNutrition({ ingredients, servings? })  →  read   USDA estimate
 *   scaleRecipe({ slug | id | recipe, servings })  →  read   never saves
 *   unmarkCooked({ slug, previousLastMadeAt? })    →  write  undo markCooked
 *
 * and `listRecipes` takes `favoritesOnly` and `cookedSince`. None of them
 * change the three contract schemas above; the new fields on `listRecipes`
 * and `markCooked` are optional additions.
 *
 * **All param objects validated strictly before reaching the handler.**
 * Other apps are not trusted — a malicious "calorie tracker" could pass
 * arbitrary content, so every field is whitelisted, length-capped, and
 * type-checked. Invalid params reject with HANDLER_THREW (which the kernel
 * reports cleanly to the caller).
 */

import type {
  CatalogRecipe,
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
import { computeNutrition, parseIngredient } from "../features/nutrition";
import { extractRecipeFromImages } from "../features/customRecipe";
import {
  ensureCatalogLoaded,
  isCatalogLoaded,
  searchCatalog,
  getCatalog,
  categories as catalogCategories,
} from "../features/catalog";
import { loadBlockedForWrite, blockRecipe, unblockRecipe } from "../features/blocked";
import { parseDisplayQuantity, scaleRecipe } from "../features/scaling";
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
  // Strip ASCII control chars to prevent terminal-escape / log-poisoning
  // when another app's output gets surfaced. Line breaks and tabs become a
  // space first: deleting them glued words together ("1 cup\tflour" was
  // saved as "1 cupflour"). Checked AFTER cleaning, so "\x00" is empty.
  const cleaned = v
    .replace(/[\t\r\n]+/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim();
  if (!cleaned) throw new Error(`params.${field} cannot be empty`);
  if (cleaned.length > maxLen) {
    throw new Error(`params.${field} exceeds ${maxLen} characters`);
  }
  return cleaned;
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
  favorite: boolean;
}

/** An ISO date or timestamp, as epoch ms. Rejected, not guessed, when it isn't one. */
function asIsoDate(v: unknown, field: string): number {
  const s = asString(v, field, 40);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new Error(`params.${field} must be an ISO date, e.g. 2026-09-21`);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`params.${field} is not a valid date`);
  return t;
}

async function listRecipes(rawParams?: unknown): Promise<{ recipes: ListedRecipe[] }> {
  let filter: string | undefined;
  let limit = 50;
  let favoritesOnly = false;
  let cookedSince: number | null = null;
  if (rawParams !== undefined && rawParams !== null) {
    const p = asObject(rawParams);
    filter = asOptionalString(p.filter, "filter", 100)?.toLowerCase();
    if (p.limit !== undefined) {
      limit = Math.min(500, asPositiveInt(p.limit, "limit", 500));
    }
    if (p.favoritesOnly !== undefined) {
      if (typeof p.favoritesOnly !== "boolean") throw new Error("params.favoritesOnly must be a boolean");
      favoritesOnly = p.favoritesOnly;
    }
    if (p.cookedSince !== undefined && p.cookedSince !== null) {
      cookedSince = asIsoDate(p.cookedSince, "cookedSince");
    }
  }
  const all = await requireLibrary();
  const matches = all.filter((r) => {
    if (favoritesOnly && !r.favorite) return false;
    // "Cooked since" knows only the MOST RECENT cook (lastMadeAt): a recipe
    // cooked on Monday and again today counts once, as today's.
    if (cookedSince !== null && !(r.lastMadeAt && Date.parse(r.lastMadeAt) >= cookedSince)) return false;
    if (!filter) return true;
    if (r.title.toLowerCase().includes(filter)) return true;
    if (r.summary?.toLowerCase().includes(filter)) return true;
    for (const ing of r.ingredients) {
      if (ing.toLowerCase().includes(filter)) return true;
    }
    return false;
  });
  if (cookedSince !== null) {
    // Most recently cooked first, which is the order "what did I cook" wants.
    matches.sort((a, b) => Date.parse(b.lastMadeAt!) - Date.parse(a.lastMadeAt!));
  }
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
    favorite: !!r.favorite,
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

async function markCooked(
  rawParams?: unknown,
): Promise<{ madeCount: number; lastMadeAt: string; previousLastMadeAt: string | null }> {
  const p = asObject(rawParams);
  const slug = asSlug(p.slug);
  const all = await requireLibrary();
  const found = all.find((r) => r.slug === slug);
  if (!found) throw new Error(`Recipe not found: ${slug}`);
  const updated = await markMade(found);
  return {
    madeCount: updated.madeCount,
    lastMadeAt: updated.lastMadeAt ?? new Date().toISOString(),
    // Hand this back to unmarkCooked to undo exactly, as the in-app undo does.
    previousLastMadeAt: found.lastMadeAt ?? null,
  };
}

/**
 * Undo one "I made this": the count goes down by one. The app's own undo
 * remembers the cook BEFORE the one it is undoing; a caller can too, by
 * passing back markCooked's `previousLastMadeAt`. Without it the most recent
 * timestamp is kept as it is (slightly wrong, the undone cook's time) rather
 * than cleared, because clearing it would make an older, real cook vanish
 * from `listRecipes({cookedSince})`. At zero cooks it is cleared either way.
 */
async function unmarkCooked(
  rawParams?: unknown,
): Promise<{ madeCount: number; lastMadeAt: string | null }> {
  const p = asObject(rawParams);
  const slug = asSlug(p.slug);
  let previous: string | null = null;
  if (p.previousLastMadeAt !== undefined && p.previousLastMadeAt !== null) {
    previous = new Date(asIsoDate(p.previousLastMadeAt, "previousLastMadeAt")).toISOString();
  }
  const all = await requireLibrary();
  const found = all.find((r) => r.slug === slug);
  if (!found) throw new Error(`Recipe not found: ${slug}`);
  if (found.madeCount < 1) throw new Error(`${found.title} hasn't been marked cooked, so there is nothing to undo.`);
  const updated = await api.unmarkCooked(api.recipeIdFromPath(found.path), previous ?? found.lastMadeAt ?? null);
  return { madeCount: updated.madeCount, lastMadeAt: updated.lastMadeAt ?? null };
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
  // Validated, not coerced: a wrong-typed query used to become "" and the
  // caller got the first page of the whole catalog as "matches".
  const query = asOptionalString(p.query, "query", 100) ?? "";
  const category = asOptionalString(p.category, "category", 40) ?? "";
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

// ── Catalog, shared and chef recipes by id ───────────────────────────

/** A catalog-side id (catalog rows, chef picks). Rejected, not repaired. */
function asCatalogId(v: unknown): string {
  const id = asString(v, "id", 64);
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("params.id must contain only letters, digits and hyphens");
  return id;
}

/**
 * The full public shape of a catalog-side recipe. `ingredients` here are the
 * recipe's LINES ("2 chicken breasts, boneless"); `tokens` are the canonical
 * names `searchRecipes` returns as its `ingredients`. The chef blog is left
 * out: it is long-form prose for the reader in this app, not recipe data.
 */
function projectCatalog(r: CatalogRecipe): Record<string, unknown> {
  return {
    id: r.id,
    title: r.title,
    ...(r.summary ? { summary: r.summary } : {}),
    category: r.category,
    tags: r.tags,
    difficulty: r.difficulty,
    cookTime: r.cookTime,
    servings: r.servings,
    ingredients: r.ingredients,
    instructions: r.instructions,
    tokens: r.tokens,
    nutrition: r.nutrition ?? null,
    ...(r.imageUrl ? { imageUrl: r.imageUrl, imageAi: !!r.imageAi } : {}),
    ...(r.imageUrl && r.imageCredit ? { imageCredit: r.imageCredit } : {}),
    ...(r.sourceUrl ? { sourceUrl: r.sourceUrl } : {}),
  };
}

/**
 * One catalog recipe by the `id` `searchRecipes` returned, in full: the
 * search results carry tokens only, so without this a caller could find a
 * recipe and never read how to make it. A separate action from `getRecipe`
 * on purpose: that one's params and returns are Pantry's `recipe` contract.
 */
async function getCatalogRecipe(rawParams?: unknown): Promise<{ recipe: Record<string, unknown> | null }> {
  const p = asObject(rawParams);
  const id = asCatalogId(p.id);
  let r: CatalogRecipe | null;
  try {
    r = await api.fetchCatalogRecipe(id);
  } catch {
    throw new Error("The recipe catalog isn't reachable right now — try again in a moment.");
  }
  return { recipe: r ? projectCatalog(r) : null };
}

/**
 * A recipe someone shared by link, by its share token (the 64-character hex
 * string in the link). Only public and unlisted recipes resolve, exactly as
 * opening the link in this app does; a private or revoked one reads as null.
 */
async function getSharedRecipe(rawParams?: unknown): Promise<{ recipe: Record<string, unknown> | null }> {
  const p = asObject(rawParams);
  const token = asString(p.shareToken, "shareToken", 64).toLowerCase();
  if (!/^[0-9a-f]{16,64}$/.test(token)) throw new Error("params.shareToken must be the hex token from a share link");
  let r: CatalogRecipe | null;
  try {
    r = await api.fetchShared(token);
  } catch {
    throw new Error("Shared recipes aren't reachable right now — try again in a moment.");
  }
  return { recipe: r ? projectCatalog(r) : null };
}

/** The promoted chef recipes, newest first: the app's own "featured" shelf. */
async function listChefPicks(rawParams?: unknown): Promise<{ recipes: Record<string, unknown>[] }> {
  const p = asObject(rawParams ?? {});
  const limit = p.limit === undefined ? 12 : Math.max(1, asPositiveInt(p.limit, "limit", 50));
  let picks: CatalogRecipe[];
  try {
    picks = await api.fetchChefLatest(limit);
  } catch {
    throw new Error("Chef picks aren't reachable right now — try again in a moment.");
  }
  return {
    recipes: picks.map((r) => ({
      id: r.id,
      title: r.title,
      ...(r.summary ? { summary: r.summary } : {}),
      category: r.category,
      difficulty: r.difficulty,
      cookTime: r.cookTime,
      servings: r.servings,
      ingredients: r.tokens,
      ...(r.imageUrl ? { imageUrl: r.imageUrl } : {}),
    })),
  };
}

// ── Recipe tools (pure: nothing is read from or written to the library) ──

const MAX_TOOL_LINES = 60;
const MAX_TOOL_LINE = 200;

/**
 * Split ingredient lines into quantity, unit and food, with this app's own
 * parsers: `quantity`/`unit` are what the scaler reads, `name` and `grams`
 * what the nutrition lookup reads. Anything a line doesn't state is null,
 * never a guess ("salt to taste" has no quantity). `grams` is ROUGH: volume
 * units convert at about the density of water, so a cup of oats reads 240 g.
 */
async function parseIngredients(rawParams?: unknown): Promise<{ ingredients: Record<string, unknown>[] }> {
  const p = asObject(rawParams);
  const lines = asStringArray(p.lines, "lines", MAX_TOOL_LINES, MAX_TOOL_LINE);
  return {
    ingredients: lines.map((line) => {
      const q = parseDisplayQuantity(line);
      const n = parseIngredient(line);
      return {
        line,
        quantity: q.count === null ? null : Math.round(q.count * 1000) / 1000,
        unit: q.unit,
        name: n?.name || null,
        // The nutrition parser assumes a default amount for a line with no
        // quantity ("salt to taste" becomes 30 g); that is its guess, not the
        // line's, so it is not passed on.
        grams: q.count !== null && n && n.grams > 0 ? Math.round(n.grams) : null,
      };
    }),
  };
}

/**
 * Per-serving macros for any list of ingredient lines, by the same USDA
 * FoodData Central lookup the app runs on a recipe. An ESTIMATE, as
 * everywhere in this app (`nutrition.est` is always true, and
 * `matched`/`total` say how much of the list it could read). The lookup is
 * rate-limited; `rateLimited` says a result is short for that reason, so a
 * caller can retry later rather than log a low number as real.
 */
async function estimateNutrition(rawParams?: unknown): Promise<Record<string, unknown>> {
  const p = asObject(rawParams);
  const ingredients = asStringArray(p.ingredients, "ingredients", MAX_TOOL_LINES, MAX_TOOL_LINE);
  const servings = p.servings === undefined ? 1 : asPositiveInt(p.servings, "servings", 64);
  if (servings < 1) throw new Error("params.servings must be at least 1");
  const result = await computeNutrition({
    title: "",
    difficulty: "easy",
    cookTime: 0,
    servings,
    ingredients,
    instructions: [],
  });
  return {
    nutrition: result.strip,
    rateLimited: result.rateLimited,
    missedDueToRateLimit: result.missedDueToRateLimit,
  };
}

/**
 * Rescale any recipe: a saved one (`slug`), a catalog one (`id`), or one the
 * caller passes in (`recipe`: its own ingredient lines and serving count).
 * The app's scaler, so fractions come back as a cook reads them ("1 1/2
 * cups") and unscalable lines ("salt to taste") come back as they went in.
 * Never saves anything. `scaleSavedRecipe` is the older, slug-only form.
 */
async function scaleAnyRecipe(rawParams?: unknown): Promise<Record<string, unknown>> {
  const p = asObject(rawParams);
  const target = asPositiveInt(p.servings, "servings", 64);
  if (target < 1) throw new Error("params.servings must be at least 1");
  const given = [p.slug, p.id, p.recipe].filter((v) => v !== undefined && v !== null).length;
  if (given !== 1) throw new Error("pass exactly one of params.slug, params.id or params.recipe");

  let source: Recipe;
  let ref: Record<string, string> = {};
  if (p.slug !== undefined && p.slug !== null) {
    const slug = asSlug(p.slug);
    const found = (await requireLibrary()).find((r) => r.slug === slug);
    if (!found) throw new Error(`Recipe not found: ${slug}`);
    source = found;
    ref = { slug };
  } else if (p.id !== undefined && p.id !== null) {
    const id = asCatalogId(p.id);
    const { recipe } = await getCatalogRecipe({ id });
    if (!recipe) throw new Error(`Catalog recipe not found: ${id}`);
    source = recipe as unknown as Recipe;
    ref = { id };
  } else {
    const r = asObject(p.recipe);
    source = {
      title: asOptionalString(r.title, "recipe.title", MAX_TITLE) ?? "",
      difficulty: "easy",
      cookTime: 0,
      servings: Math.max(1, asPositiveInt(r.servings, "recipe.servings", 64)),
      ingredients: asStringArray(r.ingredients, "recipe.ingredients", MAX_TOOL_LINES, MAX_TOOL_LINE),
      instructions: [],
      nutrition: asOptionalNutrition(r.nutrition),
    };
  }
  const scaled = scaleRecipe(source, target / Math.max(1, source.servings));
  return {
    ...ref,
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
    unmarkCooked,
    getCatalogRecipe,
    getSharedRecipe,
    listChefPicks,
    parseIngredients,
    estimateNutrition,
    scaleRecipe: scaleAnyRecipe,
  });
}
