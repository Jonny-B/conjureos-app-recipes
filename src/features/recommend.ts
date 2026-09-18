/**
 * The recommendation engine: which recipe to put in front of someone, and why.
 *
 * This lived inside HomeScreen until the Pantry-first IA landed and the Home
 * tab went away. It is genuinely useful logic (pantry coverage dominates the
 * score, favourites nudge it, quick recipes nudge it, a daily seed keeps the
 * ties from freezing) and it has more than one caller now, so it lives here
 * rather than inside whichever screen happens to render it today.
 *
 * Nothing in this module touches React or the DOM. Coverage is deliberately
 * computed SEPARATELY from scoring: the two have different inputs, and folding
 * them together meant one tapped heart re-ran computeCoverage across the whole
 * ~1,200-recipe catalog.
 */
import type { CatalogRecipe, FeedRecipe, SavedRecipe } from "../types";
import type { CoverageResult } from "./scaling";
import { computeCoverage } from "./scaling";
import type { ingredientsFromPantry } from "./pantry";

export interface Scored {
  fi: FeedRecipe;
  cov: CoverageResult | null;
  score: number;
  /** A plain-language sentence for why this is being suggested. */
  reason: string;
}

type PantryIngredients = ReturnType<typeof ingredientsFromPantry>;

/** Stable identity for a feed row, across catalog and saved recipes. */
export function keyOf(fi: FeedRecipe): string {
  return fi.kind === "catalog" ? `c:${fi.id}` : `s:${fi.recipe.path}`;
}

/** Every feed row, in one place, so coverage and scoring iterate the same set. */
export function feedItems(
  catalog: CatalogRecipe[],
  saved: SavedRecipe[],
  favs: Set<string>,
): FeedRecipe[] {
  const items: FeedRecipe[] = [];
  for (const r of saved) if (r.favorite) items.push({ kind: "saved", recipe: r, favorite: true });
  for (const c of catalog) items.push({ kind: "catalog", id: c.id, recipe: c, favorite: favs.has(c.id) });
  return items;
}

/** Coverage per row key. Depends on the catalog and the pantry — never on favourites. */
export function buildCoverage(
  catalog: CatalogRecipe[],
  saved: SavedRecipe[],
  pantryIng: PantryIngredients,
  hasPantry: boolean,
): Map<string, CoverageResult | null> {
  const out = new Map<string, CoverageResult | null>();
  if (!hasPantry) return out;
  // `favs` is irrelevant to coverage, so an empty set is fine for keying here.
  for (const fi of feedItems(catalog, saved, new Set())) {
    out.set(keyOf(fi), computeCoverage(fi.recipe, pantryIng));
  }
  return out;
}

export function buildScored(
  catalog: CatalogRecipe[],
  saved: SavedRecipe[],
  favs: Set<string>,
  covByKey: Map<string, CoverageResult | null>,
  seed: number,
): Scored[] {
  const items = feedItems(catalog, saved, favs);

  const scored = items.map<Scored>((fi) => {
    const recipe = fi.recipe;
    const cov = covByKey.get(keyOf(fi)) ?? null;
    let score = 0;
    if (cov) score += cov.score; // -1..1, dominant signal when a pantry exists
    if (fi.favorite) score += 0.4;
    if (recipe.cookTime > 0 && recipe.cookTime <= 30) score += 0.1;
    if (cov && cov.total > 0 && cov.missing === 0) score += 0.3;
    return { fi, cov, score, reason: reasonFor(fi, cov) };
  });
  // Tiebreak on a per-recipe seeded hash, NOT the title. A title tiebreak makes
  // equal-scored recipes sort alphabetically, so when scores are flat (no
  // pantry) the whole top of the list is "A" recipes and the hero rotation
  // loops through them. The hash scatters equal-scored items across the
  // catalog, and folding in the daily seed reshuffles them once a day.
  return scored.sort((a, b) => b.score - a.score || shuffleKey(a.fi, seed) - shuffleKey(b.fi, seed));
}

/** Stable FNV-1a hash of the recipe key mixed with a seed → a uint32 sort key. */
export function shuffleKey(fi: FeedRecipe, seed: number): number {
  const str = `${keyOf(fi)}:${seed}`;
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function reasonFor(fi: FeedRecipe, cov: CoverageResult | null): string {
  if (cov && cov.total > 0 && cov.missing === 0) return "You have everything for this.";
  if (cov && cov.have > 0) {
    const need = cov.missing === 1 ? "1 thing" : `${cov.missing} things`;
    return `You have ${cov.have} of ${cov.total} ingredients. Just ${need} to grab.`;
  }
  if (fi.favorite) return "One of your favorites, worth revisiting.";
  if (fi.recipe.cookTime > 0 && fi.recipe.cookTime <= 20) return `Quick: on the table in ${fi.recipe.cookTime} minutes.`;
  if (fi.kind === "catalog") return `A ${fi.recipe.category.toLowerCase()} idea worth a try.`;
  return "Worth a try tonight.";
}

/** Day index for the daily-rotating seed (browser Date; not the workflow sandbox). */
export function daySeed(): number {
  return Math.floor(new Date().getTime() / 86_400_000);
}
