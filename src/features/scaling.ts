/**
 * Recipe scaling — proportional rescaling of ingredient quantities and
 * nutrition by a factor. Two trigger paths:
 *
 *   1. Servings stepper (+/-) on the recipe card. User edits the target
 *      servings; factor = newServings / originalServings.
 *
 *   2. "Scale to my ingredients" button. For each user-confirmed
 *      ingredient with a parseable quantity, compare what the user has
 *      to what the recipe demands. The most-constraining ratio
 *      (smallest available/needed where available < needed) becomes
 *      the factor. Equivalently: "make as much as my limiting ingredient
 *      allows."
 *
 * The numeric parsing is shared with nutrition.ts's per-100g pipeline
 * conceptually but kept separate here so this module stays focused on
 * the literal-text scaling we show in the UI (we want "1 egg" not
 * "50g of eggs" after halving).
 */

import { parseIngredient } from "./nutrition";
import type { Ingredient, Recipe, NutritionStrip } from "../types";

// ── Quantity parsing for display ──────────────────────────────────────

/**
 * Display-quantity parser — ASCII-only. See nutrition.ts for the full
 * rationale on why we don't accept Unicode fraction characters: the
 * literals corrupted in some ZIP-import pipelines, producing iframe-
 * fatal "Invalid regular expression" errors. AI-generated recipes use
 * ASCII fractions ("1/2 cup") universally, so this is zero practical
 * loss.
 */
interface DisplayQuantity {
  /** Numeric coefficient, or null if the line carries no quantity. */
  count: number | null;
  /** Unit token as-written (e.g. "tbsp", "cup", "g"), or null if no unit. */
  unit: string | null;
  /** The rest of the line — the food name + any modifiers. */
  rest: string;
}

const KNOWN_UNITS = new Set([
  "g", "gram", "grams",
  "kg", "kilogram", "kilograms", "kilo", "kilos",
  "mg", "milligram", "milligrams",
  "oz", "ounce", "ounces",
  "lb", "lbs", "pound", "pounds",
  "ml", "milliliter", "milliliters",
  "l", "liter", "liters", "litre", "litres",
  "tsp", "teaspoon", "teaspoons",
  "tbsp", "tbs", "tablespoon", "tablespoons",
  "cup", "cups", "c",
  "pint", "pints", "pt",
  "quart", "quarts", "qt",
]);

/**
 * Parse a recipe ingredient line into its scalable parts. Free-form lines
 * without a numeric quantity (e.g. "salt and pepper", "a handful of basil")
 * return count: null — the caller should leave those unchanged when scaling.
 */
export function parseDisplayQuantity(line: string): DisplayQuantity {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length === 0) return { count: null, unit: null, rest: line };

  // Pull leading numeric tokens. Supports "2", "1.5", "1/2", "1 1/2".
  let i = 0;
  let count: number | null = null;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    const parsed = parseNumericToken(tok);
    if (parsed === null) break;
    count = (count ?? 0) + parsed;
    i += 1;
  }

  if (count === null) {
    return { count: null, unit: null, rest: line.trim() };
  }

  // Unit detection: next token, possibly two for "fl oz". Case-insensitive.
  let unit: string | null = null;
  let restTokens = tokens.slice(i);
  if (restTokens.length > 0) {
    const t0 = restTokens[0]!.replace(/\.$/, "");
    const t0Lower = t0.toLowerCase();
    if (
      t0Lower === "fl" &&
      restTokens[1] &&
      restTokens[1].replace(/\.$/, "").toLowerCase().replace(/s$/, "") === "oz"
    ) {
      unit = "fl oz";
      restTokens = restTokens.slice(2);
    } else if (KNOWN_UNITS.has(t0Lower) || KNOWN_UNITS.has(t0Lower.replace(/s$/, ""))) {
      unit = t0;
      restTokens = restTokens.slice(1);
    }
  }

  return { count, unit, rest: restTokens.join(" ").trim() };
}

function parseNumericToken(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  if (/^\d+\.\d+$/.test(token)) return Number(token);
  const m = token.match(/^(\d+)\/(\d+)$/);
  if (m) {
    const num = Number(m[1]);
    const den = Number(m[2]);
    if (den !== 0) return num / den;
  }
  return null;
}

// ── Scaled-line formatting ────────────────────────────────────────────

/**
 * Format a numeric quantity back to a readable string. Picks fractions
 * over decimals for the common cookbook values (halves, thirds, quarters,
 * eighths) so "1.5 cups" reads as "1 1/2 cups" not "1.5 cups".
 */
function formatScaledNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  // Round to the nearest 1/8 to surface clean fractions, but only when
  // the result is within 1% of the rounded value (otherwise show decimal).
  const candidates: Array<[number, string]> = [
    [1 / 8, "1/8"], [1 / 4, "1/4"], [1 / 3, "1/3"],
    [1 / 2, "1/2"], [2 / 3, "2/3"], [3 / 4, "3/4"],
  ];
  const whole = Math.floor(n);
  const frac = n - whole;
  for (const [v, label] of candidates) {
    if (Math.abs(frac - v) < 0.04) {
      if (whole === 0) return label;
      return `${whole} ${label}`;
    }
  }
  if (Math.abs(frac) < 0.02) return `${whole}`;
  // Fall back to short decimal. Trim trailing zero so "0.50" → "0.5".
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Scale a single ingredient line by a numeric factor. If the line has
 * no parseable quantity ("salt and pepper"), it passes through unchanged.
 */
export function scaleLine(line: string, factor: number): string {
  if (factor === 1 || !Number.isFinite(factor) || factor <= 0) return line;
  const parsed = parseDisplayQuantity(line);
  if (parsed.count === null) return line;
  const scaled = parsed.count * factor;
  const parts: string[] = [formatScaledNumber(scaled)];
  if (parsed.unit) parts.push(parsed.unit);
  if (parsed.rest) parts.push(parsed.rest);
  return parts.join(" ");
}

// ── Scale a whole recipe ──────────────────────────────────────────────

/**
 * Apply a scaling factor to a recipe — ingredients, servings, and nutrition.
 * Returns a new Recipe; the original is not mutated. cookTime is NOT scaled
 * because cooking time doesn't change linearly with quantity (a 2× batch of
 * stew doesn't take 2× as long).
 */
export function scaleRecipe(recipe: Recipe, factor: number): Recipe {
  if (factor === 1 || !Number.isFinite(factor) || factor <= 0) return recipe;
  const servings = Math.max(1, Math.round(recipe.servings * factor));
  const ingredients = recipe.ingredients.map((line) => scaleLine(line, factor));
  // Nutrition is per-serving. Scaling factor changes the recipe yield but
  // NOT the per-serving macros (each serving still has the same macros);
  // exception: if the user explicitly scaled servings up/down via the
  // stepper, per-serving stays the same. If they scaled by limiting
  // ingredient, per-serving still stays the same (each serving is still
  // the same composition). So nutrition does NOT scale with the factor.
  return {
    ...recipe,
    servings,
    ingredients,
  };
}

// ── "Scale to my ingredients" — availability check ────────────────────

export interface AvailabilityResult {
  /** Scaling factor to apply (≤ 1.0 = need to scale down; 1.0 = fine as-is). */
  factor: number;
  /**
   * Per-ingredient breakdown. UI uses this to flag "not enough X" or
   * highlight the constraining item.
   */
  matches: Array<{
    recipeLine: string;
    userIngredient: string;
    needed: number;
    available: number;
    /** available / needed. <1 means short; ≥1 means enough. */
    ratio: number;
    /** Marked true on the single most-constraining (smallest-ratio) row. */
    constraining: boolean;
  }>;
  /**
   * True when no recipe ingredient could be matched to a user ingredient
   * with a parseable quantity. UI should disable the scale button.
   */
  noMatchesFound: boolean;
}

/**
 * Compare a recipe's ingredient demands against what the user has on
 * hand. For every recipe line we can parse to grams AND a user ingredient
 * with a parseable quantity by the same name, compute ratio. The minimum
 * ratio (clipped at 1.0) becomes the safe scale factor.
 *
 * Name matching is intentionally loose — recipe "1 cup sour cream" and
 * user "sour cream / 1 pint" should match. We normalize both to lowercase
 * and check if one contains the other (after stripping common modifiers
 * like "fresh", "chopped", etc.).
 */
export function computeAvailability(
  recipe: Recipe,
  userIngredients: Ingredient[],
): AvailabilityResult {
  const userParsed = userIngredients
    .map((ing) => {
      if (!ing.quantity) return null;
      const p = parseIngredient(`${ing.quantity} ${ing.name}`);
      if (!p || p.grams <= 0) return null;
      return { name: ing.name, grams: p.grams };
    })
    .filter((x): x is { name: string; grams: number } => x !== null);

  const matches: AvailabilityResult["matches"] = [];
  for (const line of recipe.ingredients) {
    const parsed = parseIngredient(line);
    if (!parsed || parsed.grams <= 0) continue;
    const user = findUserMatch(parsed.name, userParsed);
    if (!user) continue;
    const ratio = user.grams / parsed.grams;
    matches.push({
      recipeLine: line,
      userIngredient: user.name,
      needed: parsed.grams,
      available: user.grams,
      ratio,
      constraining: false,
    });
  }

  if (matches.length === 0) {
    return { factor: 1, matches: [], noMatchesFound: true };
  }

  // Find the smallest ratio. Cap factor at 1.0 — we don't scale UP when
  // the user has more than enough (the recipe is already designed for its
  // declared servings count; scaling up because there's extra sour cream
  // would force the user to eat more of everything).
  let minRatio = Infinity;
  let minIdx = -1;
  for (let i = 0; i < matches.length; i++) {
    if (matches[i]!.ratio < minRatio) {
      minRatio = matches[i]!.ratio;
      minIdx = i;
    }
  }
  if (minIdx >= 0) matches[minIdx]!.constraining = true;

  const factor = Math.min(1, minRatio);
  return { factor, matches, noMatchesFound: false };
}

const NAME_STOPWORDS = new Set([
  "fresh", "frozen", "dried", "chopped", "diced", "sliced", "minced",
  "grated", "shredded", "crushed", "ground", "raw", "cooked",
  "of", "small", "medium", "large", "whole", "halved",
]);

/**
 * Match a recipe ingredient name to a user-supplied one. Tolerates
 * modifiers + crude singularization, prefers exact match, falls back to
 * directional substring (either contains the other).
 */
function findUserMatch(
  recipeName: string,
  user: Array<{ name: string; grams: number }>,
): { name: string; grams: number } | null {
  const normalize = (s: string): string =>
    s
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => !NAME_STOPWORDS.has(t))
      .join(" ")
      .replace(/s$/, "");

  const target = normalize(recipeName);
  if (!target) return null;

  // Exact normalized match wins.
  for (const u of user) {
    if (normalize(u.name) === target) return u;
  }
  // Otherwise: either contains the other. "feta" matches "feta cheese", etc.
  for (const u of user) {
    const un = normalize(u.name);
    if (un.includes(target) || target.includes(un)) return u;
  }
  return null;
}

// ── Nutrition per-serving (unchanged across factor) ───────────────────

/**
 * Returns the nutrition strip unchanged. Exported so the UI doesn't have
 * to special-case "what happens to nutrition when we scale?" — scaling
 * changes recipe yield, not per-serving composition.
 */
export function nutritionForScaledRecipe(
  nutrition: NutritionStrip | null | undefined,
): NutritionStrip | null {
  return nutrition ?? null;
}
