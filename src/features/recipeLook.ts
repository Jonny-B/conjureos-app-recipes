/**
 * How a recipe presents itself when there is no photo to do it: a category
 * hue and glyph, the handful of ingredients that say what the dish IS, and
 * the quantity/name split the ingredient table is set in.
 *
 * Pure functions over data the rows already carry — no fetch, no state — so
 * the browse feed can call them 60 times a render without caring.
 */
import type { IconName } from "../icons";
import type { FeedRecipe, NutritionStrip, Recipe } from "../types";
import { parseIngredient } from "./nutrition";

/**
 * A category's colour, by ROLE, never by value: each one names a --cui-*
 * token pair (see `.hue-*` in styles.css), so the plates follow the palette
 * and both flavours the same way every other surface does. Seven roles for
 * twelve categories, so some share a hue — the glyph is what tells them
 * apart, the hue only groups them (greens are mains and sides, warm yellows
 * are breakfast and bread, and so on).
 */
export type Hue = "accent" | "info" | "third" | "success" | "warning" | "support" | "error";

export interface Look {
  hue: Hue;
  glyph: IconName;
}

const LOOKS: Record<string, Look> = {
  dinner: { hue: "accent", glyph: "utensils" },
  lunch: { hue: "info", glyph: "burger" },
  breakfast: { hue: "third", glyph: "egg" },
  salad: { hue: "success", glyph: "leaf" },
  soup: { hue: "warning", glyph: "bowl-food" },
  dessert: { hue: "support", glyph: "ice-cream" },
  sauce: { hue: "error", glyph: "bottle-droplet" },
  bread: { hue: "third", glyph: "bread-slice" },
  side: { hue: "success", glyph: "carrot" },
  drink: { hue: "info", glyph: "glass-water" },
  appetizer: { hue: "support", glyph: "cheese" },
  snack: { hue: "warning", glyph: "cookie-bite" },
};

/** Saved, AI-written and snapped recipes carry no category: they're yours. */
const UNFILED: Look = { hue: "accent", glyph: "user" };

export function lookFor(category: string | null | undefined): Look {
  return (category && LOOKS[category.trim().toLowerCase()]) || UNFILED;
}

/** The feed item's category, or null for the user's own recipes. */
export function categoryOf(fi: FeedRecipe): string | null {
  return fi.kind === "catalog" ? fi.recipe.category : null;
}

/**
 * Pantry staples that tell you nothing about a dish. "2-Step Chicken" is
 * chicken breasts and cream of chicken soup; that it also takes water and a
 * spoon of oil is true of half the catalog (salt is in 337 of 1,120 rows).
 */
const STAPLES = new Set([
  "salt",
  "pepper",
  "black pepper",
  "ground black pepper",
  "salt and pepper",
  "water",
  "ice",
  "oil",
  "vegetable oil",
  "olive oil",
  "canola oil",
  "cooking spray",
  "nonstick cooking spray",
  "non-stick cooking spray",
]);

/** Container words the tokenizer sometimes leaves on the front of a name. */
const LEADING_CONTAINER = /^(?:packages?|pkgs?|cans?|jars?|bags?|boxes|box|cloves?|envelopes?|packets?)\s+/;
/** A size the tokenizer kept: "(6-inch) corn tortillas", "(14.5-oz) cans diced tomato". */
const LEADING_PAREN = /^\([^)]*\)\s*/;
/** Adjectives that come through as whole tokens when a line is "chicken, boneless". */
const LONE_ADJECTIVES = new Set(["boneless", "skinless", "fresh", "large", "medium", "small", "optional"]);

/**
 * Up to `max` ingredient names that say what the dish is, in recipe order,
 * staples and repeats dropped. Catalog rows carry precomputed `tokens` (the
 * slim feed has no ingredient lines at all); the user's own recipes don't,
 * so theirs are parsed from the lines.
 */
export function keyIngredients(fi: FeedRecipe, max = 4): string[] {
  const names =
    fi.kind === "catalog" && fi.recipe.tokens.length
      ? fi.recipe.tokens
      : fi.recipe.ingredients.map((l) => parseIngredient(l)?.name ?? "");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const n = raw.trim().toLowerCase().replace(LEADING_PAREN, "").replace(LEADING_CONTAINER, "");
    if (!n || STAPLES.has(n) || LONE_ADJECTIVES.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

// ── Ingredient lines: quantity | name ─────────────────────────────────

const FRACTION = "[¼½¾⅓⅔⅛⅜⅝⅞]";
const NUM = `(?:\\d+\\s+\\d+/\\d+|\\d+/\\d+|\\d*\\.\\d+|\\d+(?:\\s*${FRACTION})?|${FRACTION})`;
const UNIT =
  "cups?|c|tablespoons?|tbsps?|tbs|teaspoons?|tsps?|fluid ounces?|fl\\.? oz|ounces?|oz|pounds?|lbs?|" +
  "cans?|cloves?|pinch(?:es)?|dash(?:es)?|slices?|pieces?|quarts?|qts?|pints?|pts?|grams?|g|kilograms?|kg|" +
  "milliliters?|ml|liters?|l|packages?|pkgs?|sticks?|heads?|bunch(?:es)?|stalks?|sprigs?|jars?|bags?|" +
  "box(?:es)?|bottles?|containers?|envelopes?|packets?|handfuls?|large|medium|small|whole";
const QTY = new RegExp(`^(${NUM}(?:\\s*(?:-|–|to)\\s*${NUM})?)(?:\\s*(?:${UNIT})\\b\\.?)?`, "i");

export interface SplitLine {
  /** "1 tablespoon", "2", "1/2 cup" — empty when the line has no amount. */
  qty: string;
  /** What it is: "vegetable oil (or cooking oil of choice)". */
  name: string;
  /**
   * A can or package size that sat between the amount and the name —
   * "1 can (10.75 ounces) cream of chicken soup" — moved after the name so the
   * name column starts with the ingredient, not a parenthesis.
   */
  note: string;
}

/**
 * Split an ingredient line for the two-column ingredient table. Never loses
 * text: when the line doesn't start with an amount it all goes in `name`.
 */
export function splitIngredient(line: string): SplitLine {
  const text = line.trim();
  const m = QTY.exec(text);
  // The amount has to be a word of its own: "7-Up" and "3-bean salad" start
  // with a digit but not with a quantity.
  const after = m ? text.charAt(m[0].length) : "";
  if (!m || !m[0].trim() || (after && !/[\s(]/.test(after))) return { qty: "", name: text, note: "" };
  let rest = text.slice(m[0].length).trim();
  let note = "";
  const paren = /^\(([^)]*)\)\s*/.exec(rest);
  if (paren && rest.length > paren[0].length) {
    note = `(${paren[1]})`;
    rest = rest.slice(paren[0].length);
  }
  // "of" after a unit ("1 pinch of salt") belongs to the amount, not the name.
  rest = rest.replace(/^of\s+/i, "");
  if (!rest) return { qty: "", name: text, note: "" };
  return { qty: m[0].trim(), name: rest, note };
}

// ── Nutrition ─────────────────────────────────────────────────────────

export interface MacroShare {
  key: "protein" | "carbs" | "fat";
  label: string;
  grams: number;
  /** Share of the macro calories, 0–1. */
  share: number;
}

/**
 * Where a serving's calories come from, by macro (4/4/9 kcal per gram). Null
 * when there's nothing to split — a strip of zeros is "unknown", not "0%".
 */
export function macroShares(n: NutritionStrip | null | undefined): MacroShare[] | null {
  if (!n) return null;
  const kcal = { protein: n.protein * 4, carbs: n.carbs * 4, fat: n.fat * 9 };
  const total = kcal.protein + kcal.carbs + kcal.fat;
  if (!(total > 0)) return null;
  return [
    { key: "protein", label: "Protein", grams: n.protein, share: kcal.protein / total },
    { key: "carbs", label: "Carbs", grams: n.carbs, share: kcal.carbs / total },
    { key: "fat", label: "Fat", grams: n.fat, share: kcal.fat / total },
  ];
}

/** 1–3, for the three-square difficulty mark. */
export function difficultyLevel(r: Pick<Recipe, "difficulty">): 1 | 2 | 3 {
  return r.difficulty === "hard" ? 3 : r.difficulty === "medium" ? 2 : 1;
}
