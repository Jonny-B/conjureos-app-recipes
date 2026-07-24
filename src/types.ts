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
  /**
   * Optional long-form markdown story attached to the recipe (Chef Payson's
   * blog — his life/career notes). Rendered above the recipe like mainstream
   * recipe sites, with a "Jump to recipe" skip. Only chef posts set this today.
   */
  blog?: string;
  /**
   * Public URL of the recipe's image — a recipe photo, or (for a chef post) the
   * blog header/hero. Uploaded via recipesApi.uploadRecipeImage → the recipes-db
   * `uploadImage` action, which stores it in the public `recipe-images` bucket
   * and returns this URL. Absent/empty means no image.
   */
  imageUrl?: string;
  /** True when this is a promoted "Chef Payson" recipe (server-set). */
  chefFeatured?: boolean;
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
 * Plan My Week: the structured constraints derived from the user's "mood"
 * (picked ingredients, a seed recipe, or free text interpreted by the AI).
 */
export interface MoodConstraints {
  /** Ingredients the week should lean on (soft preference). */
  includeIngredients: string[];
  /** Cuisines/categories to favor (e.g. "italian", "dinner"). */
  cuisines: string[];
  /** Dietary rules, e.g. "vegetarian", "gluten-free". */
  dietary: string[];
  /** Ingredients to exclude entirely. */
  avoid: string[];
  /** How many meals to plan (1-7). */
  mealCount: number;
}

/** One recipe chosen for the week, with its overlap/coverage breakdown. */
export interface PlannedRecipe {
  id: string;
  title: string;
  recipe: Recipe;
  /** Canonical ingredient names already covered by the pantry. */
  pantryCovered: string[];
  /** Canonical names this pick first added to the shared shopping set. */
  marginalNew: string[];
  haveCount: number;
  totalCount: number;
}

/** One consolidated, deduped shopping-list line covering 1+ recipes. */
export interface ShoppingListItem {
  /** Human-friendly display name. */
  name: string;
  /** Normalized key the merge grouped on. */
  canonical: string;
  /** Original amount when only one recipe needs it. */
  quantity?: string;
  /** "enough for N recipes" when many recipes share it. */
  quantityNote?: string;
  /** Which chosen recipes need this item. */
  recipes: { id: string; title: string }[];
  /** Coarse grocery aisle for grouping. */
  aisle: string;
}

/** A saved week plan: the chosen recipes + the consolidated shopping list. */
export interface WeekPlan {
  picks: PlannedRecipe[];
  shoppingList: ShoppingListItem[];
  constraints: MoodConstraints;
  /** mealCount minus picks found (0 when fully satisfied). */
  shortfall: number;
  warnings: string[];
  createdAt: string;
  /**
   * Canonical keys (`ShoppingListItem.canonical`) the user has checked off
   * while shopping. Persisted with the plan so the checklist survives closing
   * the app. Absent/empty = nothing checked yet.
   */
  checked?: string[];
}

/**
 * A recipe as shown in the browse/favorites feed: either a bundled catalog
 * recipe or one the user saved. `favorite` is resolved at render time (catalog
 * favorites from the index, saved favorites from frontmatter).
 */
export type FeedRecipe =
  | { kind: "catalog"; id: string; recipe: CatalogRecipe; favorite: boolean }
  | { kind: "saved"; recipe: SavedRecipe; favorite: boolean };

/** Which slice the Recipes tab shows. Favorites is a filter here, not a tab. */
export type RecipeSource = "all" | "mine" | "favorites";

export type Screen =
  | { kind: "capture" }
  | { kind: "identifying"; photos: CapturedPhoto[] }
  | { kind: "ingredients"; photos: CapturedPhoto[]; ingredients: Ingredient[] }
  | { kind: "generating"; photos: CapturedPhoto[]; ingredients: Ingredient[] }
  | { kind: "recipes"; photos: CapturedPhoto[]; ingredients: Ingredient[]; recipes: Recipe[] };
