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
 * Canonicalize an ingredient name for loose matching: lowercase, drop common
 * modifier stopwords, crude singularize. Exported so the coverage matcher,
 * the cross-recipe overlap optimizer, and the shopping-list merge all share
 * one definition of "same ingredient" (no drift).
 */
export function normalizeIngredientName(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => !NAME_STOPWORDS.has(t))
    .join(" ")
    .replace(/s$/, "");
}

// ── "same ingredient?" ────────────────────────────────────────────────

/**
 * Adjectives that describe a FORM of the same food rather than a different
 * food. Dropped from both names before comparing, so a pantry "chicken breast"
 * still meets a recipe's "boneless skinless chicken breasts".
 */
const NEUTRAL_MODIFIERS = new Set([
  "boneless", "skinless", "bone-in", "skin-on", "lean", "unsalted", "salted",
  "organic", "ripe", "peeled", "softened", "melted", "packed", "plain",
  "uncooked", "all-purpose", "allpurpose", "virgin", "extra-virgin",
  "kosher", "baby", "rolled", "heavy", "whipping",
]);

/**
 * Trailing words that name a CUT or FORM of the food named before them, so
 * dropping them leaves the SAME ingredient: a chicken breast is chicken, feta
 * cheese is feta.
 *
 * Deliberately excludes every word that names a food MADE FROM the one before
 * it — broth, stock, crumbs, oil, sauce, powder, juice, butter, flour, milk.
 * That class is the whole reason this list exists: "chicken" is not "chicken
 * broth" and "bread" is not "bread crumbs", and the old either-contains-the-
 * other test said they were.
 */
const CUT_OR_FORM_HEADS = new Set(
  [
    "breast", "thigh", "drumstick", "wing", "leg", "fillet", "filet", "cutlet",
    "loin", "tenderloin", "tender", "shoulder", "rib", "ribeye", "chop",
    "steak", "chuck", "brisket", "sirloin", "flank", "skirt", "shank", "rump",
    "roast", "mince", "meat", "cheese", "leaf", "leave", "sprig", "clove",
    "half", "halve", "piece", "chunk", "slice", "strip", "cube", "wedge",
    "floret", "stalk", "stem", "bulb", "kernel",
  ].map(reduceToken),
);

/**
 * Compounds whose head IS in CUT_OR_FORM_HEADS but which are a different food
 * from their own prefix. Cream cheese is not cream.
 */
const NOT_ITS_PREFIX = new Set(["cream cheese", "head cheese"].map((s) => s.split(" ").map(reduceToken).join(" ")));

/** Shortest name we'll fuzzy-match at all. Blocks "ice"/"oil"-scale collisions. */
const MIN_FUZZY_LEN = 3;

/**
 * Fold one token to a comparison form. This has to absorb TWO plural spellings
 * of the same word, because the input may arrive raw ("tomatoes") or already
 * through normalizeIngredientName, whose crude `/s$/` strip leaves "tomatoe".
 * Both must land on "tomato" or the two spellings stop matching each other.
 */
function reduceToken(t: string): string {
  let s = t;
  if (s.length > 4 && s.endsWith("ies")) return `${s.slice(0, -3)}y`; // berries -> berry
  if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  // What's left of an "-es" plural (or of normalizeIngredientName's strip):
  // "tomatoe" -> "tomato", "dishe" -> "dish", "boxe" -> "box".
  if (s.length > 3 && /(?:o|ch|sh|s|x|z)e$/.test(s)) s = s.slice(0, -1);
  return s;
}

/**
 * The comparison form of a name: leading measure/container noise off
 * (prettyIngredient), modifier stopwords off (normalizeIngredientName), form
 * adjectives off, every token folded. Same pipeline planWeek's canonOf uses,
 * so canonical shopping-list keys and pantry names meet on the same ground.
 */
// Ingredient names repeat heavily (the browse screen scores a pantry against
// every recipe in the catalog), and this runs per pair, so memoize the folding.
const tokenCache = new Map<string, string[]>();
const TOKEN_CACHE_MAX = 5000;

function matchTokens(name: string): string[] {
  const hit = tokenCache.get(name);
  if (hit) return hit;
  const all = normalizeIngredientName(prettyIngredient(name))
    .split(" ")
    .filter((t) => t.length > 0);
  // A name made ENTIRELY of form adjectives is that food, not a modifier of one
  // ("baby" is a modifier, "baby corn" too, but a pantry line reading "baby"
  // would otherwise reduce to nothing and match every recipe or none).
  const kept = all.filter((t) => !NEUTRAL_MODIFIERS.has(t));
  const out = (kept.length > 0 ? kept : all).map(reduceToken);
  if (tokenCache.size < TOKEN_CACHE_MAX) tokenCache.set(name, out);
  return out;
}

/**
 * Do these two ingredient names refer to the same thing? The single definition
 * of that question — the pantry-coverage matcher, the "scale to my ingredients"
 * matcher and the shopping-list merge all route through here, so the detail
 * screen can't claim you have something the shopping list then tells you to buy.
 *
 * Matching is loose about morphology and about a trailing cut/form word, and
 * STRICT about everything else:
 *
 *   rice / ice            -> no  (not a whole token)
 *   buttermilk / milk     -> no  (not a whole token)
 *   eggplant / egg        -> no  (not a whole token)
 *   olive oil / oil       -> no  (the shared token isn't the head of both)
 *   sour cream / cream    -> no  (ditto)
 *   chicken broth/chicken -> no  ("broth" is a food made FROM chicken)
 *   bread crumbs / bread  -> no  (ditto)
 *   chicken breasts / chicken -> YES (a cut of the same food)
 *   feta cheese / feta        -> YES (a category word, not a new food)
 *   tomatoes / tomato         -> YES (reduceToken folds both spellings)
 *
 * The old rule was `a.includes(b) || b.includes(a)` on raw normalized strings,
 * guarded only by a 2-character minimum. A pantry holding literally "ice" and
 * "oil" satisfied a recipe needing rice and olive oil, and the recipe card said
 * "You have everything for this".
 */
/**
 * Cultivar/size words that don't change what the food IS — but only in front of
 * a head noun listed in VARIETY_HEADS. Kept tiny on purpose: a false positive
 * here puts the user in the kitchen without an ingredient the app promised.
 * Notably ABSENT: "brown" (brown sugar isn't sugar), "green"/"spring" (a green
 * onion is a scallion), "sour"/"heavy"/"double" (creams), and every plant-milk
 * word.
 */
const VARIETY_WORDS = new Set([
  "red", "white", "yellow", "purple", "cherry", "grape", "plum", "roma",
  "russet", "baby", "ripe",
]);
// "sweet" is deliberately NOT here: a sweet potato is a different vegetable
// from a potato, so folding it would promise the cook an ingredient they don't
// have — the exact failure this whole matcher exists to prevent.

/** Head nouns whose varieties are interchangeable enough to match. */
const VARIETY_HEADS = new Set([
  "onion", "tomato", "potato", "apple", "spinach", "lettuce", "cabbage",
  "mushroom", "grape", "carrot", "bean",
]);

export function ingredientNamesMatch(a: string, b: string): boolean {
  const ta = matchTokens(a);
  const tb = matchTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  if (ta.length === tb.length) return ta.every((t, i) => t === tb[i]);

  const [short, longRaw] = ta.length < tb.length ? [ta, tb] : [tb, ta];
  // Leading VARIETY words name a cultivar of the same food, not a different
  // food: "red onion" is an onion, "cherry tomatoes" are tomatoes. Without this
  // the prefix test below rejected them, and the app told you to buy onions you
  // already had. Deliberately narrow, and gated on the head noun, because the
  // same adjective changes the food elsewhere: "red pepper" is not black
  // pepper, "green onion" is a scallion, "brown sugar" is not sugar. Only the
  // pairs listed in VARIETY_HEADS are folded.
  const long =
    longRaw.length > short.length &&
    VARIETY_WORDS.has(longRaw[0]!) &&
    VARIETY_HEADS.has(longRaw[longRaw.length - 1]!)
      ? longRaw.slice(1)
      : longRaw;
  if (short.length > long.length) return false;
  // The shorter name must be a whole-token PREFIX of the longer one: the extra
  // words may only narrow the head ("chicken" -> "chicken breast"), never
  // qualify it from the front ("cream" -> "sour cream").
  for (let i = 0; i < short.length; i++) {
    if (short[i] !== long[i]) return false;
  }
  if (short.join(" ").length < MIN_FUZZY_LEN) return false;
  if (NOT_ITS_PREFIX.has(long.join(" "))) return false;
  return long.slice(short.length).every((t) => CUT_OR_FORM_HEADS.has(t));
}

/** True when any name in `names` refers to the same ingredient as `name`. */
export function matchesAnyName(name: string, names: Iterable<string>): boolean {
  for (const other of names) {
    if (ingredientNamesMatch(name, other)) return true;
  }
  return false;
}

/**
 * Match a recipe ingredient name to a user-supplied one. Tolerates modifiers +
 * crude singularization, prefers an exact normalized match, and otherwise
 * accepts only the cut/form relation ingredientNamesMatch allows.
 */
export function findUserMatch(
  recipeName: string,
  user: Array<{ name: string; grams: number }>,
): { name: string; grams: number } | null {
  const target = normalizeIngredientName(recipeName);
  if (!target) return null;

  // Exact normalized match wins.
  for (const u of user) {
    if (normalizeIngredientName(u.name) === target) return u;
  }
  // Otherwise: "feta" matches "feta cheese", "chicken" matches "chicken breast".
  for (const u of user) {
    if (ingredientNamesMatch(u.name, recipeName)) return u;
  }
  return null;
}

// ── Pantry coverage (match ranking) ───────────────────────────────────

export interface CoverageResult {
  /** Recipe lines that name a real (non-trace) ingredient. */
  total: number;
  /** Lines the pantry covers in full (or by name when unquantified). */
  have: number;
  /** Lines matched by name but short on quantity. */
  short: number;
  /** Lines with no pantry match. */
  missing: number;
  haveNames: string[];
  shortNames: string[];
  missingNames: string[];
  /** Higher = more complete. (have - 0.5*short - missing) / total. */
  score: number;
}

/**
 * Score how well a pantry covers a recipe, for the "what can I make" ranking.
 *
 * This is the piece `computeAvailability` alone can't do: that function only
 * matches a line when BOTH the recipe line and a pantry item parse to grams,
 * so an un-quantified pantry ("sour cream", no amount) scores zero coverage.
 * Here we layer a name-only presence path on top: quantified-both -> ratio
 * decides have/short; matched-by-name-only -> have; no match -> missing.
 */
export function computeCoverage(
  recipe: Recipe,
  userIngredients: Ingredient[],
): CoverageResult {
  const userNorms = userIngredients
    .map((i) => normalizeIngredientName(parseIngredient(i.name)?.name ?? i.name))
    .filter((n) => n.length > 0);

  const avail = computeAvailability(recipe, userIngredients);
  const ratioByLine = new Map<string, number>();
  for (const m of avail.matches) ratioByLine.set(m.recipeLine, m.ratio);

  let have = 0;
  let short = 0;
  let missing = 0;
  const haveNames: string[] = [];
  const shortNames: string[] = [];
  const missingNames: string[] = [];

  for (const line of recipe.ingredients) {
    const parsed = parseIngredient(line);
    if (!parsed) continue; // trace / unparseable -> not counted against the recipe
    const name = parsed.name;
    const ratio = ratioByLine.get(line);
    if (ratio !== undefined) {
      if (ratio >= 0.999) {
        have++;
        haveNames.push(name);
      } else {
        short++;
        shortNames.push(name);
      }
    } else if (nameInPantry(normalizeIngredientName(name), userNorms)) {
      have++;
      haveNames.push(name);
    } else {
      missing++;
      missingNames.push(name);
    }
  }

  const total = have + short + missing;
  const score = (have - 0.5 * short - missing) / Math.max(1, total);
  return { total, have, short, missing, haveNames, shortNames, missingNames, score };
}

/**
 * Tidy a canonical ingredient name for chip/label display. parseIngredient
 * leaves leading parenthetical sizes ("(10.75 ounce) can chicken broth") and
 * stray unit words ("fluid ounce melon liqueur") on some catalog lines; strip
 * those so chips read "chicken broth" / "melon liqueur". Falls back to the
 * input if stripping would empty it.
 */
const LEADING_NOISE =
  /^((can|cans|jar|jars|package|packages|pkg|bottle|bottles|container|containers|packet|packets|fluid|ounce|ounces|oz|lb|lbs|pound|pounds|cup|cups|tablespoon|tablespoons|tbsp|teaspoon|teaspoons|tsp|clove|cloves|slice|slices|pinch|dash|head|stalk|stalks|sprig|sprigs|bunch|piece|pieces|strip|strips|fillet|fillets|sheet|sheets|small|medium|large)\s+)+/i;

export function prettyIngredient(name: string): string {
  let s = name.replace(/^\([^)]*\)\s*/, "").replace(LEADING_NOISE, "").trim();
  if (!s) s = name.trim();
  return s;
}

/** Name-only presence in the pantry, on the shared same-ingredient rule. */
function nameInPantry(targetNorm: string, userNorms: string[]): boolean {
  if (!targetNorm) return false;
  for (const u of userNorms) {
    if (u === targetNorm) return true;
  }
  return matchesAnyName(targetNorm, userNorms);
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
