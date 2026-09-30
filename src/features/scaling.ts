/**
 * Recipe scaling — proportional rescaling of ingredient quantities and
 * nutrition by a factor, driven by the servings stepper on a recipe card:
 * factor = newServings / originalServings.
 *
 * THE OTHER HALF OF THIS FILE IS GONE. It carried "scale to my ingredients"
 * and the coverage engine behind it — availability matching, ingredient-name
 * normalisation, have/short/missing counts, roughly five hundred lines that
 * answered "do I have enough of this?". That is Conjure Pantry's question
 * now, and it went there with the pantry rather than being left here with no
 * caller. If a recipe screen ever wants to ask it again, the answer is to ASK
 * PANTRY through the action bridge, not to grow a second copy of the matcher.
 *
 * The numeric parsing is conceptually shared with nutrition.ts's per-100g
 * pipeline but kept separate, so this module stays focused on the literal-text
 * scaling the UI shows (we want "1 egg", not "50g of eggs", after halving).
 */

import type { Recipe, NutritionStrip } from "../types";

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

  // The leading quantity: "2", "1.5", "1/2", or a whole number followed by a
  // proper fraction, "1 1/2". Nothing more: summing every leading number read
  // "1 14 oz can tomatoes" as 15 and scaled the can size with it.
  let i = 0;
  let count: number | null = null;
  const first = tokens[0] ? parseNumericToken(tokens[0]) : null;
  if (first !== null) {
    count = first;
    i = 1;
    // "1 1/2", and "1 and 1/2" the way people also write it.
    const withAnd = tokens[1]?.toLowerCase() === "and";
    const second = tokens[withAnd ? 2 : 1];
    if (/^\d+$/.test(tokens[0]!) && second && /^\d+\/\d+$/.test(second)) {
      const frac = parseNumericToken(second);
      if (frac !== null && frac < 1) {
        count += frac;
        i = withAnd ? 3 : 2;
      }
    }
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
/**
 * The smallest amount this formatter can render as a fraction. Anything
 * positive below it has no honest numeric form here — see `scaleLine`, which
 * words it instead of printing a number that means "none".
 */
export const SMALLEST_RENDERABLE = 1 / 16;

export function formatScaledNumber(n: number): string {
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
  // A range, "2-3 cups" or "2 to 3 cups": both ends scale. It used to parse as
  // no quantity at all and pass through unscaled.
  const range = line.match(/^\s*(\d+(?:\.\d+)?(?:\/\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?(?:\/\d+)?)\b\s*(.*)$/);
  if (range) {
    const lo = parseNumericToken(range[1]!);
    const hi = parseNumericToken(range[2]!);
    if (lo !== null && hi !== null && hi > lo) {
      const tail = range[3]!.trim();
      return `${formatScaledNumber(lo * factor)}-${formatScaledNumber(hi * factor)}${tail ? ` ${tail}` : ""}`;
    }
  }
  // A compound amount, "1 cup + 2 tbsp flour" or "1 cup plus 2 tbsp": the
  // second amount scales too, or the proportions come out wrong.
  const compound = line.match(/^(.*?\S)\s+(\+|plus|and)\s+(\d.*)$/);
  if (compound && parseDisplayQuantity(compound[1]!).count !== null && parseDisplayQuantity(compound[1]!).unit) {
    const tail = compound[3]!;
    const tq = parseDisplayQuantity(tail);
    if (tq.count !== null && tq.unit) {
      return `${scaleLine(compound[1]!, factor)} ${compound[2]} ${scaleLine(tail, factor)}`;
    }
  }
  const parsed = parseDisplayQuantity(line);
  if (parsed.count === null) return line;
  const scaled = parsed.count * factor;
  // A REQUIRED ingredient must never scale down to the word "0".
  //
  // formatScaledNumber falls through to `${Math.floor(n)}` once the fraction
  // is under 0.02, and to a "0.00"-trimmed decimal below that — so scaling a
  // 40-serving recipe to 1 turned "1 tsp baking powder" into "0 tsp baking
  // powder". The guided cook renders that as a step, and a cook following it
  // adds no leavening at all. Reachable from the stepper mid-cook and from
  // scale-to-my-ingredients, and the wrong line is what gets saved.
  //
  // "less than 1/16" is the honest statement: too little to measure, not zero.
  // Left as a phrase rather than a number so no downstream parser mistakes it
  // for an amount.
  if (scaled > 0 && scaled < SMALLEST_RENDERABLE) {
    // The unit is dropped, not kept: at this size it carries no information
    // ("a trace of tsp baking powder" is not a sentence), and the ingredient
    // name alone is what the cook needs to see on the line.
    const what = parsed.rest || parsed.unit;
    return what ? `a trace of ${what}` : line;
  }
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
  // Nutrition is per-serving, and per-serving composition IS invariant under
  // scaling — but only while the yield scales exactly. It doesn't: servings is
  // rounded to an integer above, so the food is divided among a different
  // number of plates than the factor implies, and the leftover lands in each
  // serving.
  //
  //   4 servings at 600 cal, factor 0.3 -> 1.2 servings rounds to 1 plate,
  //   which now holds 4 x 0.3 x 600 = 720 cal, not 600.
  //
  // Reachable from "scale to my ingredients" (RecipesScreen) and the guided
  // cook's scale-to-pantry, both of which set arbitrary fractional factors —
  // and the wrong value was then PERSISTED to the user's library on save.
  // Correct for the rounding: the batch total is invariant, the per-plate share
  // is not.
  const exactServings = recipe.servings * factor;
  const rounding = exactServings > 0 ? exactServings / servings : 1;
  return {
    ...recipe,
    servings,
    ingredients,
    ...(recipe.nutrition && rounding !== 1
      ? { nutrition: scaleStripPerServing(recipe.nutrition, rounding) }
      : {}),
  };
}

/** Re-divide per-serving macros after the yield was rounded to whole plates. */
function scaleStripPerServing(n: NutritionStrip, k: number): NutritionStrip {
  return {
    ...n,
    calories: Math.round(n.calories * k),
    protein: Math.round(n.protein * k),
    fat: Math.round(n.fat * k),
    carbs: Math.round(n.carbs * k),
  };
}
