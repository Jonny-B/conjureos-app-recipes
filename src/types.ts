/**
 * Domain types shared across the app.
 *
 * Kept deliberately narrow — adding fields later is cheap, removing them
 * after they land in saved markdown frontmatter is not.
 */

export interface Ingredient {
  /** Lowercase canonical name, e.g. "eggs", "red onion". */
  name: string;
  /** 0–1 confidence from the vision pass. User-added ingredients default to 1. */
  confidence: number;
  /**
   * Best-effort quantity available, as a parseable string when possible
   * ("1 pint", "200g", "half a carton", "~6 eggs"). The vision model is
   * asked to estimate this from package size + fill level; the user can
   * edit it. Used by the recipe scaler to decide whether the user has
   * enough of an ingredient and to scale a recipe down if not.
   * Free-form on purpose — vision-estimated quantities are imprecise and
   * forcing a strict unit shape would lose useful signal ("half full").
   */
  quantity?: string;
  /** Optional free-form note ("looks past date", "fresh, opened"). */
  notes?: string;
  /** True when the user has explicitly confirmed (or added) this item. */
  confirmed: boolean;
}

/**
 * One captured photo + its prep metadata. Multi-image capture lets the
 * user shoot fridge + pantry together, or several angles of the same
 * shelf; the vision pass dedupes across them.
 */
export interface CapturedPhoto {
  /** Stable id for React keys + per-photo removal. */
  id: string;
  /** `data:image/jpeg;base64,...` for <img src> + the bridge call. */
  dataUrl: string;
  /** Base64 without the `data:` prefix — what the AI bridge needs. */
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  width: number;
  height: number;
  originalBytes: number;
}

export type Difficulty = "easy" | "medium" | "hard";

export interface Recipe {
  title: string;
  difficulty: Difficulty;
  /** Total time in minutes (prep + cook). */
  cookTime: number;
  /** How many servings the recipe yields. Defaults to 2 if the AI omits it. */
  servings: number;
  /** Ingredients with rough quantities, e.g. "2 eggs", "1 tbsp olive oil". */
  ingredients: string[];
  /** Numbered steps, one string per step. */
  instructions: string[];
  /** Short pitch shown above the steps. */
  summary?: string;
  /** Per-serving estimated macros from USDA FoodData Central. Null when lookup hasn't run yet or failed. */
  nutrition?: NutritionStrip | null;
}

/**
 * Estimated per-serving macros. All values are rounded integers. `est` is
 * always true (this is a sum-of-USDA-100g-values × parsed-quantity calculation,
 * not a lab-measured number). Display with a "~" prefix and an "est." footer.
 */
export interface NutritionStrip {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  /** Number of ingredients we successfully matched to USDA entries. */
  matched: number;
  /** Total ingredient count. matched/total < 0.7 → display "rough" instead of "est." */
  total: number;
  est: true;
}

/**
 * A persisted recipe with the metadata we track post-save. The on-disk
 * markdown has the same shape via YAML frontmatter — see storage.ts.
 */
export interface SavedRecipe extends Recipe {
  /** File path under /home/Documents/Recipes. */
  path: string;
  /** Slug used in the filename. */
  slug: string;
  /** ISO timestamp when saved. */
  savedAt: string;
  /** How many times the user has clicked "I made this". */
  madeCount: number;
  /** ISO timestamp of the most recent "made this" click, or null. */
  lastMadeAt: string | null;
  /** User-flagged favorite. Persisted as `favorite: true` in frontmatter. */
  favorite?: boolean;
}

/**
 * A recipe from the bundled, AllRecipes-sourced catalog (see
 * scripts/build-catalog.ts + src/data/catalog.json). A superset of Recipe
 * with provenance + precomputed match tokens. Never persisted as-is: saving
 * goes through catalog.toRecipe() -> storage.saveRecipe().
 */
export interface CatalogRecipe extends Recipe {
  /** Stable catalog id, e.g. "ar-3f9c51c7a881". */
  id: string;
  /** One of the ~12 taxonomy categories (catalog `categories` list). */
  category: string;
  /** Derived flags: "quick", "high-protein", "vegetarian", etc. */
  tags: string[];
  /** Original AllRecipes URL, kept for attribution + provenance. */
  sourceUrl: string;
  /** Canonical ingredient names (parseIngredient), precomputed at build time. */
  tokens: string[];
}

/**
 * One persistent pantry/fridge item the user keeps on hand. Stored as JSON at
 * /home/Documents/Recipes/.pantry.json (see features/pantry.ts). Feeds the
 * match-ranking + Plan My Week features via ingredientsFromPantry().
 */
export interface PantryItem {
  /** Sanitized lowercase name, e.g. "sour cream". */
  name: string;
  /** Optional free-form amount on hand ("1 pint", "200g", "half a carton"). */
  quantity?: string;
  /** Optional free-form note ("opened", "use soon"). */
  notes?: string;
  /** ISO timestamp first added. */
  addedAt: string;
}

/**
 * A recipe as shown in the browse/favorites feed: either a bundled catalog
 * recipe or one the user saved. `favorite` is resolved at render time (catalog
 * favorites from the index, saved favorites from frontmatter).
 */
export type FeedRecipe =
  | { kind: "catalog"; id: string; recipe: CatalogRecipe; favorite: boolean }
  | { kind: "saved"; recipe: SavedRecipe; favorite: boolean };

export type Screen =
  | { kind: "capture" }
  | { kind: "identifying"; photos: CapturedPhoto[] }
  | { kind: "ingredients"; photos: CapturedPhoto[]; ingredients: Ingredient[] }
  | { kind: "generating"; photos: CapturedPhoto[]; ingredients: Ingredient[] }
  | { kind: "recipes"; photos: CapturedPhoto[]; ingredients: Ingredient[]; recipes: Recipe[] };
