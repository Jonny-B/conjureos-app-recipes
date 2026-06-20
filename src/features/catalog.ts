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

/** The full catalog, memoized after first decode. */
export function getCatalog(): CatalogRecipe[] {
  if (!memo) memo = raw.r.map(decodeRecord);
  return memo;
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

/** Category names that actually appear, with counts, in catalog order. */
export function categories(): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of getCatalog()) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  return raw.categories
    .filter((c) => counts.has(c))
    .map((name) => ({ name, count: counts.get(name) ?? 0 }));
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
