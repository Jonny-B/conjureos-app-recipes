/**
 * The recommendation engine: which recipe to put in front of someone, and why.
 *
 * PANTRY COVERAGE USED TO DOMINATE THIS SCORE, and it is gone. When this app
 * kept a pantry, "you have everything for this" was the strongest signal there
 * was and everything else was a nudge. The pantry is Conjure Pantry's now, so
 * what is left is what a recipe library actually knows about you: what you
 * marked a favourite, what is quick, and what you have not cooked lately.
 *
 * THE LAST ONE MATTERS MORE THAN IT LOOKS. Without coverage, the raw score is
 * nearly flat, and a flat score means the suggestion never changes. So the
 * daily seed is not decoration: it is the thing that stops "tonight's pick"
 * being the same recipe every night forever.
 *
 * Nothing here touches React or the DOM.
 */
import type { CatalogRecipe, FeedRecipe, SavedRecipe } from "../types";

export interface Scored {
  fi: FeedRecipe;
  score: number;
  /** A plain-language sentence for why this is being suggested. */
  reason: string;
}

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

/** How long ago a saved recipe was last cooked, in days, or null. */
function daysSinceCooked(fi: FeedRecipe): number | null {
  if (fi.kind !== "saved") return null;
  const at = fi.recipe.lastMadeAt;
  if (!at) return null;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export function buildScored(
  catalog: CatalogRecipe[],
  saved: SavedRecipe[],
  favs: Set<string>,
  seed: number,
): Scored[] {
  const items = feedItems(catalog, saved, favs);

  const scored = items.map<Scored>((fi) => {
    const recipe = fi.recipe;
    let score = 0;
    if (fi.favorite) score += 0.4;
    if (recipe.cookTime > 0 && recipe.cookTime <= 30) score += 0.1;
    // Something you liked enough to cook, long enough ago to fancy again. A
    // recipe cooked in the last fortnight is pushed DOWN rather than up: the
    // one thing a library knows for certain is what you just ate.
    const since = daysSinceCooked(fi);
    if (since !== null) score += since < 14 ? -0.5 : 0.25;
    return { fi, score, reason: reasonFor(fi) };
  });
  // Tiebreak on a per-recipe seeded hash, NOT the title. A title tiebreak makes
  // equal-scored recipes sort alphabetically, and with coverage gone the scores
  // ARE mostly flat — so without this the whole top of the list would be "A"
  // recipes and the hero would loop through them. The hash scatters equal-scored
  // items across the catalog, and the daily seed reshuffles them once a day.
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

export function reasonFor(fi: FeedRecipe): string {
  const since = daysSinceCooked(fi);
  if (since !== null && since >= 14) {
    const months = Math.floor(since / 30);
    return months >= 1
      ? `You made this ${months === 1 ? "a month" : `${months} months`} ago. Worth another go.`
      : "You made this a couple of weeks back. Worth another go.";
  }
  if (fi.favorite) return "One of your favorites, worth revisiting.";
  if (fi.recipe.cookTime > 0 && fi.recipe.cookTime <= 20)
    return `Quick: on the table in ${fi.recipe.cookTime} minutes.`;
  if (fi.kind === "catalog") return `A ${fi.recipe.category.toLowerCase()} idea worth a try.`;
  return "Worth a try tonight.";
}

/** Day index for the daily-rotating seed (browser Date; not the workflow sandbox). */
export function daySeed(): number {
  return Math.floor(new Date().getTime() / 86_400_000);
}
