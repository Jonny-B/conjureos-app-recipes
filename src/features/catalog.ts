/**
 * In-app recipe catalog.
 *
 * The bundled `src/data/catalog.json` (produced by scripts/build-catalog.ts
 * from the user's scraped AllRecipes corpus) is imported once at build time
 * and inlined into the app bundle (resolveJsonModule + esbuild). No runtime
 * fetch, no VFS. This module decodes the compact short-key form into typed
 * CatalogRecipe objects and exposes the read API the Recipes / Favorites /
 * match-ranking / Plan-My-Week surfaces call.
 */

import { CATALOG } from "../data/catalog";
import { fetchCatalog } from "../bridge/recipesApi";
import type { CatalogRecipe, Difficulty, NutritionStrip, Recipe } from "../types";

/** Compact on-disk record. Keys are short to keep the bundled JSON small. */
interface RawRecord {
  i: string;          // id
  t: string;          // title
  c: number;          // category index
  d: string;          // difficulty
  m: number;          // cookTime minutes
  s: number;          // servings
  g: string[];        // ingredients (display strings)
  n: string[];        // instructions
  u: string;          // sourceUrl
  k: string[];        // precomputed canonical tokens
  z?: number[];       // [cal, protein, fat, carbs] (omitted if absent)
  a?: string[];       // tags (omitted if empty)
}

interface RawCatalog {
  v: number;
  generatedAt: string;
  count: number;
  categories: string[];
  r: RawRecord[];
}

const raw = CATALOG as unknown as RawCatalog;

let memo: CatalogRecipe[] | null = null;
/** DB-loaded catalog (recipes-db). When set, it supersedes the bundled copy. */
let override: CatalogRecipe[] | null = null;

function decodeRecord(x: RawRecord): CatalogRecipe {
  const nutrition: NutritionStrip | null = x.z
    ? {
        calories: x.z[0] ?? 0,
        protein: x.z[1] ?? 0,
        fat: x.z[2] ?? 0,
        carbs: x.z[3] ?? 0,
        // Scrape-sourced per-serving values; treat as full-coverage "est."
        matched: x.g.length,
        total: x.g.length,
        est: true,
      }
    : null;
  return {
    id: x.i,
    title: x.t,
    category: raw.categories[x.c] ?? "Dinner",
    difficulty: x.d as Difficulty,
    cookTime: x.m,
    servings: x.s,
    ingredients: x.g,
    instructions: x.n,
    sourceUrl: x.u,
    tokens: x.k,
    tags: x.a ?? [],
    nutrition,
  };
}

/**
 * The full catalog: the DB copy once ensureCatalogLoaded() has run, otherwise
 * the bundled copy decoded on first use (the instant + offline baseline).
 */
export function getCatalog(): CatalogRecipe[] {
  if (override) return override;
  if (!memo) memo = raw.r.map(decodeRecord);
  return memo;
}

/**
 * Load the catalog from the recipes-db backend, replacing the bundled copy.
 * The bundled data stays the instant + offline fallback: if the fetch fails
 * (offline, not deployed yet, signed out) or returns nothing, getCatalog()
 * keeps serving whatever it served before. Returns true when the in-memory
 * catalog actually changed, so the caller can trigger a re-render. Only
 * fetches once unless `force` is set.
 */
export async function ensureCatalogLoaded(force = false): Promise<boolean> {
  if (override && !force) return false;
  try {
    const fromDb = await fetchCatalog();
    if (fromDb.length > 0) {
      override = fromDb;
      return true;
    }
  } catch {
    /* keep the bundled catalog */
  }
  return false;
}

export function getCatalogRecipe(id: string): CatalogRecipe | undefined {
  return getCatalog().find((r) => r.id === id);
}

/** Case-insensitive search over title, category, tokens, and tags. Empty -> all. */
export function searchCatalog(q: string): CatalogRecipe[] {
  const s = q.trim().toLowerCase();
  if (!s) return getCatalog();
  return getCatalog().filter(
    (r) =>
      r.title.toLowerCase().includes(s) ||
      r.category.toLowerCase().includes(s) ||
      r.tokens.some((t) => t.includes(s)) ||
      r.tags.some((t) => t.includes(s)),
  );
}

export function byCategory(category: string): CatalogRecipe[] {
  return getCatalog().filter((r) => r.category === category);
}

/** Category names that actually appear, with counts, in first-seen order. */
export function categories(): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of getCatalog()) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  // First-seen order works for both the bundled short-key form and DB rows.
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
