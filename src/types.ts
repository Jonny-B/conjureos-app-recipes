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
  /** Optional free-form note: quantity guess, condition ("looks past date"), etc. */
  notes?: string;
  /** True when the user has explicitly confirmed (or added) this item. */
  confirmed: boolean;
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
}

export type Screen =
  | { kind: "capture" }
  | { kind: "identifying"; photoDataUrl: string }
  | { kind: "ingredients"; photoDataUrl: string; ingredients: Ingredient[] }
  | { kind: "generating"; photoDataUrl: string; ingredients: Ingredient[] }
  | { kind: "recipes"; photoDataUrl: string; ingredients: Ingredient[]; recipes: Recipe[] }
  | { kind: "browse" };
