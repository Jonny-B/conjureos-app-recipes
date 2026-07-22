/**
 * recipesApi: client for the `recipes-db` backend (the all-in-DB recipe store).
 *
 * Two access paths, matching the backend:
 *   - PUBLIC reads (catalog browse, share-link resolve): a plain fetch to the
 *     per-env URL the kernel injects at window.__conjureos.env.recipesApiUrl
 *     (falls back to the dev project, like nutrition.ts). No auth.
 *   - PER-USER ops (list/add/update/delete/setVisibility/setFavorite/markCooked):
 *     a Phase 16c remote action. We invoke our OWN "recipesDb" remote action;
 *     the kernel mints a short-lived identity token, attaches it, and POSTs to
 *     the manifest URL. The backend derives the owner from the token.
 *
 * DB rows are mapped here into the app's existing CatalogRecipe / SavedRecipe
 * shapes so the screens barely change. A saved recipe's `path` is `db:<id>`
 * (the old VFS markdown path is gone); use recipeIdFromPath() to recover the id.
 */
import type { CatalogRecipe, Difficulty, NutritionStrip, Recipe, SavedRecipe } from "../types";

/** Dev project recipes-db, used when the host has not injected a URL (conj-pack dev). */
const DEV_RECIPES_URL = "https://mqpvjlsywrptefgwuztn.supabase.co/functions/v1/recipes-db";
/**
 * The app's OWN kernel path, derived from its per-app origin rather than
 * hardcoded — desktop serves each app from `<slug>.conjureos.app`, mobile from
 * `<slug>.mobile.conjureos.app`. A self-invoke must target the ACTUAL install
 * slug: mobile's install-time collision avoidance (appStore `pickSlug`) can
 * land the app at `/apps/recipes-2`, and a hardcoded `/apps/recipes` then fails
 * to resolve (`target app not installed`), silently breaking every per-user
 * backend call. Falls back to `/apps/recipes` off-origin (dev / standalone).
 */
function selfAppPath(): string {
  try {
    const host = (globalThis as { location?: { hostname?: string } }).location?.hostname ?? "";
    if (host.endsWith(".conjureos.app")) {
      const slug = host.split(".")[0] ?? "";
      if (/^[a-z0-9][a-z0-9-]*$/.test(slug)) return `/apps/${slug}`;
    }
  } catch {
    /* ignore — fall back below */
  }
  return "/apps/recipes";
}
const APP_PATH = selfAppPath();
const REMOTE_ACTION = "recipesDb";

interface Bridge {
  actions?: { invoke: (appPath: string, action: string, params: unknown) => Promise<unknown> };
  env?: { recipesApiUrl?: string };
}
const cjs = (): Bridge => (globalThis as { __conjureos?: Bridge }).__conjureos ?? {};
const apiUrl = (): string => cjs().env?.recipesApiUrl || DEV_RECIPES_URL;

/** True when the per-user backend is reachable (we're inside ConjureOS). */
export function isBackendAvailable(): boolean {
  return typeof cjs().actions?.invoke === "function";
}

interface DbRecipe {
  id: string;
  title: string;
  category: string;
  difficulty: string;
  cookTime: number;
  servings: number;
  ingredients: string[];
  instructions: string[];
  tokens: string[];
  nutrition: { calories: number; protein: number; fat: number; carbs: number } | null;
  summary: string | null;
  blog: string | null;
  imageUrl: string | null;
  chefFeatured: boolean;
  favorite: boolean;
  tags: string[];
  sourceUrl: string | null;
  visibility: string;
  shareToken: string;
  madeCount: number;
  lastMadeAt: string | null;
  createdAt: string;
  updatedAt: string;
  mine: boolean;
}

function toStrip(n: DbRecipe["nutrition"], total: number): NutritionStrip | null {
  if (!n) return null;
  return {
    calories: n.calories,
    protein: n.protein,
    fat: n.fat,
    carbs: n.carbs,
    matched: total,
    total,
    est: true,
  };
}

export function toCatalogRecipe(r: DbRecipe): CatalogRecipe {
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    difficulty: r.difficulty as Difficulty,
    cookTime: r.cookTime,
    servings: r.servings,
    ingredients: r.ingredients,
    instructions: r.instructions,
    summary: r.summary ?? undefined,
    nutrition: toStrip(r.nutrition, r.ingredients.length),
    blog: r.blog ?? undefined,
    imageUrl: r.imageUrl ?? undefined,
    chefFeatured: r.chefFeatured,
    tags: r.tags,
    sourceUrl: r.sourceUrl ?? "",
    tokens: r.tokens,
  };
}

export function toSavedRecipe(r: DbRecipe): SavedRecipe {
  return {
    title: r.title,
    difficulty: r.difficulty as Difficulty,
    cookTime: r.cookTime,
    servings: r.servings,
    ingredients: r.ingredients,
    instructions: r.instructions,
    summary: r.summary ?? undefined,
    nutrition: toStrip(r.nutrition, r.ingredients.length),
    blog: r.blog ?? undefined,
    imageUrl: r.imageUrl ?? undefined,
    chefFeatured: r.chefFeatured,
    path: `db:${r.id}`,
    slug: r.id,
    savedAt: r.createdAt,
    madeCount: r.madeCount,
    lastMadeAt: r.lastMadeAt,
    favorite: r.favorite,
  };
}

/** Recover the DB id from a saved recipe's `db:<id>` path. */
export function recipeIdFromPath(path: string): string {
  return path.startsWith("db:") ? path.slice(3) : path;
}

/** Map an app Recipe (plus optional catalog metadata) to the backend payload. */
function toPayload(
  recipe: Recipe & {
    category?: string;
    tags?: string[];
    tokens?: string[];
    sourceUrl?: string;
    visibility?: string;
  },
): Record<string, unknown> {
  return {
    title: recipe.title,
    category: recipe.category ?? "Dinner",
    difficulty: recipe.difficulty,
    cookTime: recipe.cookTime,
    servings: recipe.servings,
    ingredients: recipe.ingredients,
    instructions: recipe.instructions,
    summary: recipe.summary ?? null,
    blog: recipe.blog ?? null,
    imageUrl: recipe.imageUrl ?? null,
    tokens: recipe.tokens ?? [],
    tags: recipe.tags ?? [],
    sourceUrl: recipe.sourceUrl ?? null,
    visibility: recipe.visibility ?? "private",
    nutrition: recipe.nutrition
      ? {
          calories: recipe.nutrition.calories,
          protein: recipe.nutrition.protein,
          fat: recipe.nutrition.fat,
          carbs: recipe.nutrition.carbs,
        }
      : null,
  };
}

// ── public reads (no auth) ──────────────────────────────────────────────

export async function fetchCatalog(): Promise<CatalogRecipe[]> {
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "catalog", limit: 2000 }),
  });
  if (!res.ok) throw new Error(`catalog ${res.status}`);
  const j = (await res.json()) as { recipes?: DbRecipe[] };
  return (j.recipes ?? []).map(toCatalogRecipe);
}

export async function fetchShared(shareToken: string): Promise<CatalogRecipe | null> {
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "getShared", shareToken }),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getShared ${res.status}`);
  const j = (await res.json()) as { recipe?: DbRecipe };
  return j.recipe ? toCatalogRecipe(j.recipe) : null;
}

// ── per-user ops (remote action, minted identity token) ─────────────────

async function invoke(action: string, params: Record<string, unknown> = {}): Promise<{ recipes?: DbRecipe[]; recipe?: DbRecipe }> {
  const actions = cjs().actions;
  if (!actions?.invoke) throw new Error("Recipes backend is unavailable (open this inside ConjureOS).");
  return (await actions.invoke(APP_PATH, REMOTE_ACTION, { action, ...params })) as {
    recipes?: DbRecipe[];
    recipe?: DbRecipe;
  };
}

export async function listMine(): Promise<SavedRecipe[]> {
  const r = await invoke("list");
  return (r.recipes ?? []).map(toSavedRecipe);
}

export async function addRecipe(
  recipe: Recipe & { category?: string; tags?: string[]; tokens?: string[]; sourceUrl?: string; visibility?: string },
): Promise<SavedRecipe> {
  const r = await invoke("add", { recipe: toPayload(recipe) });
  if (!r.recipe) throw new Error("add failed");
  return toSavedRecipe(r.recipe);
}

export async function updateRecipe(id: string, recipe: Recipe): Promise<SavedRecipe> {
  const r = await invoke("update", { id, recipe: toPayload(recipe) });
  if (!r.recipe) throw new Error("update failed");
  return toSavedRecipe(r.recipe);
}

export async function deleteRecipe(id: string): Promise<void> {
  await invoke("delete", { id });
}

export async function markCooked(id: string): Promise<SavedRecipe> {
  const r = await invoke("markCooked", { id });
  if (!r.recipe) throw new Error("markCooked failed");
  return toSavedRecipe(r.recipe);
}

export async function setFavorite(id: string, favorite: boolean): Promise<SavedRecipe> {
  const r = await invoke("setFavorite", { id, favorite });
  if (!r.recipe) throw new Error("setFavorite failed");
  return toSavedRecipe(r.recipe);
}

export async function setVisibility(id: string, visibility: "public" | "unlisted" | "private"): Promise<SavedRecipe> {
  const r = await invoke("setVisibility", { id, visibility });
  if (!r.recipe) throw new Error("setVisibility failed");
  return toSavedRecipe(r.recipe);
}

// ── Chef Payson ─────────────────────────────────────────────────────────

/**
 * Create or update a promoted "Chef Payson" recipe (with optional blog). The
 * backend re-verifies the chef role from the minted token; a non-chef caller
 * gets a 403 here. Chef posts are forced public + chef_featured server-side.
 */
export async function publishChefRecipe(
  recipe: Recipe & { category?: string; tags?: string[]; sourceUrl?: string; blog?: string },
  id?: string,
): Promise<SavedRecipe> {
  const r = await invoke("chefUpsert", { ...(id ? { id } : {}), recipe: toPayload(recipe) });
  if (!r.recipe) throw new Error("publish failed");
  return toSavedRecipe(r.recipe);
}

/**
 * Public feed of promoted chef recipes, newest first (no auth). Returned as
 * CatalogRecipe (read-only public shape, carries blog + chefFeatured) so both
 * the home promo and the Studio list reuse the existing catalog detail path.
 */
export async function fetchChefLatest(limit = 12): Promise<CatalogRecipe[]> {
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "chefFeed", limit }),
  });
  if (!res.ok) throw new Error(`chefFeed ${res.status}`);
  const j = (await res.json()) as { recipes?: DbRecipe[] };
  return (j.recipes ?? []).map(toCatalogRecipe);
}

// ── image upload ──────────────────────────────────────────────────────────

/**
 * Upload one image (a recipe photo, or a chef post's blog header) and get back
 * a public URL to store on the recipe. The app holds no Supabase session and
 * has no storage capability, so the bytes ride as base64 over the minted-token
 * `uploadImage` action, which service-role-uploads them to the public
 * `recipe-images` bucket. `base64` is the raw payload (no `data:` prefix).
 * Under `npm run dev` (no backend) we echo a local data URL so the picker +
 * preview stay iterable without a live upload.
 */
export async function uploadRecipeImage(mediaType: string, base64: string): Promise<string> {
  if (!isBackendAvailable()) return `data:${mediaType};base64,${base64}`;
  const r = await invokeRaw<{ url?: string }>("uploadImage", { image: { mediaType, data: base64 } });
  if (!r.url) throw new Error("image upload failed");
  return r.url;
}

// ── roles + admin console ────────────────────────────────────────────────

export type AppRole = "user" | "chef" | "admin";

export interface AppUser {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: AppRole;
  createdAt: string;
  lastSeenAt: string;
}

/** Generic remote-action call for endpoints that don't return recipe shapes. */
async function invokeRaw<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const actions = cjs().actions;
  if (!actions?.invoke) throw new Error("Recipes backend is unavailable (open this inside ConjureOS).");
  return (await actions.invoke(APP_PATH, REMOTE_ACTION, { action, ...params })) as T;
}

/**
 * The signed-in user's role. Drives which surfaces the app reveals (chef →
 * Studio, admin → Admin console). Server-authoritative: derived from the
 * minted identity token in recipes-db, never trusted from the client.
 * Dev mock poses as admin so both gated surfaces are iterable under `npm run dev`.
 */
export async function getMyRole(): Promise<{ role: AppRole; email: string | null; err: string | null }> {
  if (!isBackendAvailable()) return { role: "admin", email: "dev@local", err: null };
  try {
    const r = await invokeRaw<{ role?: AppRole; email?: string | null }>("myRole");
    return { role: r.role ?? "user", email: r.email ?? null, err: null };
  } catch (e) {
    // Surface the reason (REQUIRES_AUTH / blocked consent / HTTP 4xx) so the
    // footer can show why the identity call didn't land, on-device.
    return { role: "user", email: null, err: e instanceof Error ? e.message : String(e) };
  }
}

/** Admin-only: search the user directory (by email / display name). */
export async function adminListUsers(query = "", limit = 50, offset = 0): Promise<{ users: AppUser[]; total: number }> {
  if (!isBackendAvailable()) return { users: MOCK_USERS, total: MOCK_USERS.length };
  const r = await invokeRaw<{ users?: AppUser[]; total?: number }>("adminListUsers", { query, limit, offset });
  return { users: r.users ?? [], total: r.total ?? 0 };
}

/** Admin-only: set a user's role. */
export async function adminSetRole(userId: string, role: AppRole): Promise<AppUser> {
  if (!isBackendAvailable()) {
    const u = MOCK_USERS.find((m) => m.userId === userId);
    if (u) u.role = role;
    return u ?? { userId, email: null, displayName: null, role, createdAt: "", lastSeenAt: "" };
  }
  const r = await invokeRaw<{ user?: AppUser }>("adminSetRole", { userId, role });
  if (!r.user) throw new Error("role change failed");
  return r.user;
}

const MOCK_USERS: AppUser[] = [
  { userId: "u-1", email: "you@dev.local", displayName: "You", role: "admin", createdAt: "2026-05-28T00:00:00Z", lastSeenAt: "2026-07-20T12:00:00Z" },
  { userId: "u-2", email: "uncle@dev.local", displayName: "Uncle (Chef)", role: "chef", createdAt: "2026-06-01T00:00:00Z", lastSeenAt: "2026-07-19T09:00:00Z" },
  { userId: "u-3", email: "tester@dev.local", displayName: "Tester", role: "user", createdAt: "2026-06-10T00:00:00Z", lastSeenAt: "2026-07-18T20:00:00Z" },
];
