/**
 * Cross-app Action Registry — exposes recipe-app capabilities to other
 * installed apps and to the orchestrator (calorie tracker, meal planner,
 * shopping list, etc.) via ConjureOS's Phase 13a action bridge.
 *
 * WHAT IS DELIBERATELY *NOT* HERE, and why. Grants are per-action (the kernel
 * stores actionGrants[targetApp][actionName] and prompts for each one), so the
 * risk is not "grant one, get all" — it is a SINGLE mistaken approval that
 * cannot be taken back. Everything below is excluded on one of three grounds:
 *
 *   - Irreversible. `deleteRecipe` / `deletePlan`: there is no trash and no
 *     undo. Worth revisiting once deletion is recoverable.
 *   - Consequences land on people who never saw the prompt. Family
 *     membership mutation (join / leave / addMember): leaving can delete the
 *     household and orphan everyone's plans, joining grants a third party
 *     access to other people's data. One user consents, several are affected.
 *     `renameFamily` is the exception and IS exposed — owner-only, reversible,
 *     and it changes nobody's access. `createFamily` stays out only because
 *     its undo is `leaveFamily`, which is excluded: a door with no way back.
 *   - Publishing or privilege. `setVisibility` to public/unlisted and
 *     `chefUpsert` put content somewhere a later un-publish cannot recall it;
 *     `adminSetRole` / `adminListUsers` are operator functions, not app
 *     capabilities, and "Allow X to change user roles?" is a prompt a user can
 *     accept without understanding. `setUsername` is identity.
 *
 * Also absent: shopping-list check-off. It runs through a compare-and-swap op
 * queue so two people shopping the same list don't overwrite each other; a
 * bridge write bolted onto that path would reintroduce the lost-update bug it
 * exists to prevent. It needs the queue, not a second door into the same row.
 *
 * The read/compute actions never persist. `planWeek` returns a PROPOSAL and
 * `scaleSavedRecipe` returns a scaled copy — both report `saved: false` —
 * because proposing a week and committing one to the user's library are
 * different acts, and only the second should need a write grant.
 *
 * The original four:
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
import {
  ensureCatalogLoaded,
  searchCatalog,
  getCatalog,
  categories as catalogCategories,
} from "../features/catalog";
import {
  loadPantry,
  addPantryItems as addToPantryItems,
  removePantryItem,
  ingredientsFromPantry,
} from "../features/pantry";
import { loadBlocked, blockRecipe, unblockRecipe } from "../features/blocked";
import { loadStores } from "../features/storeLayout";
import { scaleRecipe } from "../features/scaling";
import { planFromChosen, type PlanCandidate } from "../features/planWeek";
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

// ── Catalog + library reads ──────────────────────────────────────────

/**
 * Search the ~1,200-recipe catalog. Distinct from `listRecipes`, which only
 * ever saw the user's OWN library — an orchestrator asked "find me a chilli
 * recipe" had no way to reach the catalog at all.
 */
async function searchRecipes(rawParams?: unknown): Promise<{ recipes: unknown[] }> {
  const p = asObject(rawParams ?? {});
  const query = typeof p.query === "string" ? p.query.slice(0, 100).trim() : "";
  const category = typeof p.category === "string" ? p.category.slice(0, 40) : "";
  const limit = p.limit === undefined ? 20 : asPositiveInt(p.limit, "limit", 50);
  await ensureCatalogLoaded();
  let hits = query ? searchCatalog(query) : getCatalog();
  if (category) hits = hits.filter((r) => r.category.toLowerCase() === category.toLowerCase());
  return {
    recipes: hits.slice(0, Math.max(1, limit)).map((r) => ({
      id: r.id,
      title: r.title,
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
  await ensureCatalogLoaded();
  return { categories: catalogCategories() };
}

// ── Pantry ───────────────────────────────────────────────────────────

async function getPantry(): Promise<{ items: { name: string; quantity?: string; notes?: string }[] }> {
  const items = await loadPantry();
  return {
    items: items.map((i) => ({
      name: i.name,
      ...(i.quantity ? { quantity: i.quantity } : {}),
      ...(i.notes ? { notes: i.notes } : {}),
    })),
  };
}

async function addToPantry(rawParams?: unknown): Promise<{ count: number }> {
  const p = asObject(rawParams);
  if (!Array.isArray(p.items)) throw new Error("params.items must be an array");
  const incoming = p.items.slice(0, 50).map((raw, i) => {
    const o = asObject(raw);
    if (typeof o.name !== "string" || !o.name.trim()) {
      throw new Error(`params.items[${i}].name must be a non-empty string`);
    }
    return {
      name: o.name.slice(0, 80),
      ...(typeof o.quantity === "string" ? { quantity: o.quantity.slice(0, 40) } : {}),
      ...(typeof o.notes === "string" ? { notes: o.notes.slice(0, 120) } : {}),
    };
  });
  const after = await addToPantryItems(incoming);
  return { count: after.length };
}

async function removeFromPantry(rawParams?: unknown): Promise<{ count: number }> {
  const p = asObject(rawParams);
  if (typeof p.name !== "string" || !p.name.trim()) {
    throw new Error("params.name must be a non-empty string");
  }
  const after = await removePantryItem(p.name.slice(0, 80));
  return { count: after.length };
}

// ── Reversible marks ─────────────────────────────────────────────────

async function setFavorite(rawParams?: unknown): Promise<{ slug: string; favorite: boolean }> {
  const p = asObject(rawParams);
  const slug = asSlug(p.slug);
  if (typeof p.favorite !== "boolean") throw new Error("params.favorite must be a boolean");
  const all = await listSavedRecipes();
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
  const id = p.id.slice(0, 64);
  const after = p.blocked ? await blockRecipe(id) : await unblockRecipe(id);
  return { id, blocked: p.blocked, count: after.size };
}

async function getBlocked(): Promise<{ ids: string[] }> {
  return { ids: [...(await loadBlocked())] };
}

// ── Plans (read) ─────────────────────────────────────────────────────

async function listPlans(): Promise<{ plans: { id: string; title: string; shared: boolean; updatedAt: string }[] }> {
  const plans = await api.listPlans();
  return {
    plans: plans.map((r) => ({
      id: r.id,
      title: r.title ?? "Untitled plan",
      shared: r.familyId !== null,
      updatedAt: r.updatedAt,
    })),
  };
}

async function getPlan(rawParams?: unknown): Promise<Record<string, unknown>> {
  const p = asObject(rawParams);
  if (typeof p.id !== "string" || !p.id.trim()) throw new Error("params.id must be a non-empty string");
  const plans = await api.listPlans();
  const found = plans.find((r) => r.id === p.id);
  if (!found) throw new Error(`Plan not found: ${p.id}`);
  return {
    id: found.id,
    title: found.title ?? "Untitled plan",
    shared: found.familyId !== null,
    picks: (found.data.picks ?? []).map((x) => ({ id: x.id, title: x.title })),
    shoppingList: (found.data.shoppingList ?? []).map((x) => ({
      name: x.name,
      aisle: x.aisle,
      ...(x.quantity ? { quantity: x.quantity } : {}),
      recipes: x.recipes.map((r) => r.title),
    })),
    checked: found.data.checked ?? [],
  };
}

// ── Compute — nothing here persists ──────────────────────────────────

/**
 * Build a week's plan and RETURN it. Deliberately does not save: an
 * orchestrator proposing a week is a different act from committing one to the
 * user's library, and only the second needs a write grant.
 */
async function planWeek(rawParams?: unknown): Promise<Record<string, unknown>> {
  const p = asObject(rawParams ?? {});
  const mealCount = p.mealCount === undefined ? 5 : asPositiveInt(p.mealCount, "mealCount", 7);
  const include = asStringArray(p.includeIngredients ?? [], "includeIngredients", 20, 60);
  const cuisines = asStringArray(p.cuisines ?? [], "cuisines", 10, 40);
  const avoid = asStringArray(p.avoid ?? [], "avoid", 20, 60);
  const dietary = asStringArray(p.dietary ?? [], "dietary", 10, 40);

  const pantry = await loadPantry();
  const blocked = [...(await loadBlocked())];
  const constraints = { mealCount, includeIngredients: include, cuisines, avoid, dietary };
  const res = await api.planWeekRemote({
    constraints: constraints as unknown as Record<string, unknown>,
    onHand: pantry.map((i) => i.name),
    excludeIds: blocked,
  });
  const chosen: PlanCandidate[] = res.recipes.map((r) => ({
    id: r.id, title: r.title, recipe: r, category: r.category, tags: r.tags, isFavorite: false,
  }));
  const plan = planFromChosen(
    chosen,
    ingredientsFromPantry(pantry),
    constraints as never,
    res.warnings,
    res.shortfall,
  );
  return {
    picks: plan.picks.map((x) => ({ id: x.id, title: x.title })),
    shoppingList: plan.shoppingList.map((x) => ({
      name: x.name,
      aisle: x.aisle,
      ...(x.quantity ? { quantity: x.quantity } : {}),
    })),
    shortfall: plan.shortfall,
    warnings: plan.warnings,
    saved: false,
  };
}

/** Rescale a saved recipe and return it. Does not modify the stored copy. */
async function scaleSavedRecipe(rawParams?: unknown): Promise<Record<string, unknown>> {
  const p = asObject(rawParams);
  const slug = asSlug(p.slug);
  const servings = asPositiveInt(p.servings, "servings", 64);
  if (servings < 1) throw new Error("params.servings must be at least 1");
  const all = await listSavedRecipes();
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

// ── Household + stores (read-only, deliberately minimal) ─────────────

/**
 * The user's households: id, name, and THEIR role in each. Deliberately does
 * NOT return the member list — those are other people, who never saw the
 * consent prompt this caller answered. Nor the invite code, which is a
 * credential: anyone holding it can join, so it is not a field a third-party
 * app gets to read.
 *
 * A user can be in up to three, so this is a list rather than a single family.
 */
async function getFamily(): Promise<{
  inFamily: boolean;
  families: { id: string; name: string; role: string }[];
}> {
  const profile = await api.getMyProfile();
  const families = (profile.families ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    role: f.role ?? "member",
  }));
  return { inFamily: families.length > 0, families };
}

/**
 * Rename a household the user OWNS.
 *
 * The one family mutation that is safe to expose, and it took a question to
 * see it — the first pass excluded "all family mutation" as one lump, which
 * was too coarse. Rename fails none of the three tests the others fail: the
 * server enforces owner-only (a member gets 403 `not_owner`), it is reversible
 * by renaming back, and it changes nobody's ACCESS to anything. Compare
 * `leaveFamily`, which can delete the household and orphan everyone's plans,
 * or `addFamilyMember`, which hands a third party the keys.
 *
 * `createFamily` stays out for a different reason: its only undo is
 * `leaveFamily`, which is on the excluded list, so exposing it would add a door
 * with no way back through the bridge.
 */
async function renameFamily(rawParams?: unknown): Promise<{ id: string; name: string }> {
  const p = asObject(rawParams);
  if (typeof p.familyId !== "string" || !p.familyId.trim()) {
    throw new Error("params.familyId must be a non-empty string");
  }
  const name = typeof p.name === "string" ? p.name.trim().slice(0, 60) : "";
  if (!name) throw new Error("params.name must be a non-empty string");
  // Checked here for a clear error; the server re-checks and is authoritative.
  const profile = await api.getMyProfile();
  const fam = (profile.families ?? []).find((f) => f.id === p.familyId);
  if (!fam) throw new Error("You're not a member of that family.");
  if (fam.role !== "owner") throw new Error("Only the family's owner can rename it.");
  const updated = await api.renameFamily(p.familyId, name);
  return { id: updated.id, name: updated.name };
}

async function listStores(): Promise<{ stores: { id: string; name: string; aisles: number }[] }> {
  const { stores } = await loadStores();
  return { stores: stores.map((s) => ({ id: s.id, name: s.name, aisles: s.aisles.length })) };
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
    getPantry,
    addToPantry,
    removeFromPantry,
    setFavorite,
    setBlocked,
    getBlocked,
    listPlans,
    getPlan,
    planWeek,
    scaleSavedRecipe,
    getFamily,
    renameFamily,
    listStores,
  });
}
