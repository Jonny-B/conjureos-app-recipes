/**
 * In-app recipe catalog — fetched, never bundled, never persisted.
 *
 * The catalog used to ship inside the app bundle (~1.4 MB of the 1.78 MB
 * download) AND be re-fetched from the DB, which meant two sources of truth
 * that silently drifted. It's now fetched from recipes-db on load and held in
 * memory only: closing the app drops it. Nothing recipe-shaped is written to
 * the device.
 *
 * What we fetch is the SLIM projection — id/title/category/time/servings/
 * nutrition/tags/tokens. `ingredients` + `instructions` are ~66% of the bytes
 * and are pulled per-recipe (fetchCatalogRecipe) only when one is opened.
 * `tokens` rides along because pantry-matching ranks the whole corpus.
 */
import { fetchCatalog, fetchCatalogRecipe } from "../bridge/recipesApi";
import type { CatalogRecipe, Recipe } from "../types";

let catalog: CatalogRecipe[] = [];
let loaded = false;
let inflight: Promise<boolean> | null = null;

/** Full recipe bodies, filled lazily as recipes are opened. Memory only. */
const bodies = new Map<string, { ingredients: string[]; instructions: string[] }>();

/** Everything loaded so far. Empty until ensureCatalogLoaded() resolves. */
export function getCatalog(): CatalogRecipe[] {
  return catalog;
}

export function isCatalogLoaded(): boolean {
  return loaded;
}

/**
 * Load the catalog from recipes-db. Pages until a short page comes back, so
 * it's correct against any server-side page cap. Concurrent callers share one
 * in-flight request. Returns true when the in-memory catalog changed.
 */
export async function ensureCatalogLoaded(force = false): Promise<boolean> {
  if (loaded && !force) return false;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const rows = await fetchCatalog();
      if (rows.length > 0) {
        catalog = rows;
        loaded = true;
        return true;
      }
    } catch {
      /* offline / backend down — keep whatever we have (possibly nothing) */
    } finally {
      inflight = null;
    }
    return false;
  })();
  return inflight;
}

/**
 * A recipe with its full body. The list payload omits ingredients/instructions,
 * so this fetches them on first open and memoizes for the session.
 */
export async function loadRecipeBody<T extends { id?: string; ingredients: string[]; instructions: string[] }>(
  c: T,
): Promise<T> {
  // Saved/AI recipes already carry their body; only slim catalog rows are empty.
  if (!c.id || (c.ingredients.length > 0 && c.instructions.length > 0)) return c;
  const cached = bodies.get(c.id);
  if (cached) return { ...c, ...cached };
  try {
    const full = await fetchCatalogRecipe(c.id);
    if (full) {
      bodies.set(c.id, { ingredients: full.ingredients, instructions: full.instructions });
      // Patch the in-memory row so subsequent reads are already complete.
      const i = catalog.findIndex((r) => r.id === c.id);
      if (i >= 0) catalog[i] = { ...catalog[i]!, ingredients: full.ingredients, instructions: full.instructions };
      return { ...c, ingredients: full.ingredients, instructions: full.instructions };
    }
  } catch {
    /* leave the row as-is; the detail screen renders what it has */
  }
  return c;
}

export function getCatalogRecipe(id: string): CatalogRecipe | undefined {
  return catalog.find((r) => r.id === id);
}

/** Case-insensitive search over title, category, tokens, and tags. Empty -> all. */
export function searchCatalog(q: string): CatalogRecipe[] {
  const s = q.trim().toLowerCase();
  if (!s) return catalog;
  return catalog.filter(
    (r) =>
      r.title.toLowerCase().includes(s) ||
      r.category.toLowerCase().includes(s) ||
      r.tokens.some((t) => t.includes(s)) ||
      r.tags.some((t) => t.includes(s)),
  );
}

export function byCategory(category: string): CatalogRecipe[] {
  return catalog.filter((r) => r.category === category);
}

/** Category names that actually appear, with counts, in first-seen order. */
export function categories(): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of catalog) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}

/** Strip catalog-only fields to a plain Recipe (the seam to storage.saveRecipe). */
export function toRecipe(c: CatalogRecipe): Recipe {
  return {
    title: c.title,
    difficulty: c.difficulty,
    cookTime: c.cookTime,
    servings: c.servings,
    ingredients: c.ingredients,
    instructions: c.instructions,
    summary: c.summary,
    nutrition: c.nutrition ?? null,
  };
}

export function catalogTokens(c: CatalogRecipe): string[] {
  return c.tokens;
}
