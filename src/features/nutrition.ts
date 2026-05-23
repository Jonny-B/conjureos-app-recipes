/**
 * Per-recipe nutrition estimate via USDA FoodData Central.
 *
 * Pipeline: ingredient text → {quantity, unit, name, grams} → cached USDA
 * lookup → per-100g macros × grams. Sum across ingredients, divide by
 * servings, round, return a NutritionStrip. Best-effort — flags missing
 * matches in the strip so the UI can show "rough" instead of "est." when
 * coverage is poor.
 *
 * API: https://api.nal.usda.gov/fdc/v1/foods/search — free, requires an
 * API key. We ship with `DEMO_KEY` (30/hr per IP) as the default; users
 * who fork + rebuild can set `VITE_USDA_API_KEY` for the 1000/hr limit
 * a real signup-key gets. Heavy caching to `/apps/<slug>/nutrition-cache.json`
 * means most users never see a request after the first ~50 unique
 * ingredients — every saved recipe shares its core ingredients with
 * everything else the user cooks.
 *
 * Accuracy: ~±25-40% on totals. The big sources of error are
 * (a) ambiguous quantity strings ("a pinch", "to taste") which we skip;
 * (b) USDA matching imperfection ("feta cheese" has 15+ entries — we take
 * the first hit); (c) cooking-method effects (a stir-fry adds oil we
 * didn't model). For "should I cook this?" this is fine; for medical-grade
 * macro tracking, route through Phase 12b's calorie tracker instead.
 */

import { vfs } from "../bridge/vfs";
import type { NutritionStrip, Recipe } from "../types";

const USDA_BASE = "https://api.nal.usda.gov/fdc/v1";
const API_KEY = (import.meta.env.VITE_USDA_API_KEY as string | undefined) ?? "DEMO_KEY";
export const USING_DEMO_KEY = API_KEY === "DEMO_KEY";
/** USDA's rate-limit ceilings. DEMO_KEY is 30/hour/IP; a registered
 *  signup key is 1000/hour. We can't be 100% sure which tier the user
 *  is on (the API doesn't tell us until it 429s) — surfacing the DEMO
 *  ceiling on DEMO_KEY and the registered ceiling otherwise is the
 *  best static approximation. The Info popover labels this as
 *  "approximate" so users don't read it as gospel. */
const USDA_HOURLY_LIMIT = USING_DEMO_KEY ? 30 : 1000;
const CACHE_PATH = "nutrition-cache.json";
const SEARCH_CONCURRENCY = 3;
/** Session-wide rate-limit short-circuit. When this is in the future, USDA
 *  calls return immediately with rateLimited:true and never touch the network.
 *  Set to now + 1h on the first 429 we see; cleared by the next session.
 *  Prevents the user's recipe batch from burning through all 8 ingredients
 *  with a fresh 429 each. */
let rateLimitedUntil = 0;

/** Sliding-window timestamps (ms) of USDA fetches that actually went out
 *  to the network this session. Cached lookups don't count (they don't
 *  consume rate quota). 429s DO count — the request still hit USDA's
 *  metered endpoint even though it bounced. Trimmed to the last hour on
 *  every read, so the array stays small. */
const recentFetchTimestamps: number[] = [];
const FETCH_WINDOW_MS = 60 * 60 * 1000;

/** Snapshot of USDA quota state for the Info popover. Returned values
 *  are "approximate" — the real ceiling is enforced server-side and
 *  shared across other clients on the same IP if the user's on
 *  DEMO_KEY. The UI labels this caveat. */
export interface USDAUsageSnapshot {
  /** Fetches we sent in the last rolling hour. */
  recentInLastHour: number;
  /** Approximate per-hour ceiling (30 for DEMO_KEY, 1000 for signup key). */
  approxLimit: number;
  /** Approximate remaining. Clamped to 0. */
  approxRemaining: number;
  /** True when we've seen a 429 and are short-circuiting. */
  rateLimited: boolean;
  /** ms timestamp the rate-limit short-circuit clears at (0 if not active). */
  rateLimitedUntil: number;
  /** Are we on DEMO_KEY (vs. a registered key)? Determines the limit + the help copy. */
  usingDemoKey: boolean;
}

export function getUSDAUsage(): USDAUsageSnapshot {
  const now = Date.now();
  const cutoff = now - FETCH_WINDOW_MS;
  // Drop expired entries from the front of the array (cheap because
  // timestamps are appended in order). Splice from the first index
  // that's still within the window.
  let firstFresh = 0;
  while (
    firstFresh < recentFetchTimestamps.length &&
    recentFetchTimestamps[firstFresh]! < cutoff
  ) {
    firstFresh++;
  }
  if (firstFresh > 0) recentFetchTimestamps.splice(0, firstFresh);
  const recent = recentFetchTimestamps.length;
  return {
    recentInLastHour: recent,
    approxLimit: USDA_HOURLY_LIMIT,
    approxRemaining: Math.max(0, USDA_HOURLY_LIMIT - recent),
    rateLimited: rateLimitedUntil > now,
    rateLimitedUntil,
    usingDemoKey: USING_DEMO_KEY,
  };
}

/** Per-100g macros from USDA. All values are floats; rounding happens at the strip level. */
interface FoodMacros {
  /** USDA fdcId of the hit we resolved. Stored for debugging / re-resolution. */
  fdcId: number;
  /** USDA `description` field. Helps explain weird matches when the user reads the JSON cache. */
  description: string;
  /** Calories per 100g. */
  kcal: number;
  /** Grams of protein per 100g of the food. */
  protein: number;
  /** Grams of fat per 100g. */
  fat: number;
  /** Grams of carbohydrate per 100g. */
  carbs: number;
}

interface CacheShape {
  v: 1;
  entries: Record<string, FoodMacros | null>; // null = lookup ran and failed, don't retry every time
}

let cache: CacheShape | null = null;
let cacheLoaded = false;

async function loadCache(): Promise<CacheShape> {
  if (cacheLoaded && cache) return cache;
  try {
    const text = await vfs.read(CACHE_PATH);
    const parsed = JSON.parse(text);
    if (parsed && parsed.v === 1 && typeof parsed.entries === "object") {
      cache = parsed as CacheShape;
      cacheLoaded = true;
      return cache;
    }
  } catch {
    /* no cache yet */
  }
  cache = { v: 1, entries: {} };
  cacheLoaded = true;
  return cache;
}

async function persistCache(): Promise<void> {
  if (!cache) return;
  try {
    await vfs.write(CACHE_PATH, JSON.stringify(cache));
  } catch {
    /* cache persistence is best-effort */
  }
}

// ── Quantity parsing ───────────────────────────────────────────────────

const UNIT_TO_GRAMS: Record<string, number> = {
  g: 1, gram: 1, grams: 1,
  kg: 1000, kilogram: 1000, kilograms: 1000, kilo: 1000, kilos: 1000,
  mg: 0.001, milligram: 0.001, milligrams: 0.001,
  oz: 28.35, ounce: 28.35, ounces: 28.35,
  lb: 453.6, pound: 453.6, pounds: 453.6,
  // Volume → grams (approximated as if mostly water; good enough for typical foods,
  // wildly off for oils which are ~0.92 g/ml — close enough for ±30% targets)
  ml: 1, milliliter: 1, milliliters: 1,
  l: 1000, liter: 1000, liters: 1000, litre: 1000, litres: 1000,
  tsp: 5, teaspoon: 5, teaspoons: 5,
  tbsp: 15, tbs: 15, tablespoon: 15, tablespoons: 15,
  cup: 240, cups: 240, c: 240,
  pint: 473, pints: 473, pt: 473,
  quart: 946, quarts: 946, qt: 946,
  fl: 30, // "fl oz" — handled below
};

const PER_PIECE_GRAMS: Record<string, number> = {
  egg: 50, eggs: 50,
  clove: 3, cloves: 3,
  onion: 150, onions: 150,
  potato: 213, potatoes: 213,
  tomato: 123, tomatoes: 123,
  apple: 182, apples: 182,
  banana: 118, bananas: 118,
  orange: 131, oranges: 131,
  carrot: 61, carrots: 61,
  pepper: 119, peppers: 119, "bell pepper": 119, "red bell pepper": 119, "green bell pepper": 119,
  lemon: 84, lemons: 84,
  lime: 67, limes: 67,
  avocado: 200, avocados: 200,
  cucumber: 301, cucumbers: 301,
  zucchini: 196, zucchinis: 196,
  // common pluralized canned/packaged units — fall back to a single "can"
  can: 400, cans: 400,
  jar: 350, jars: 350,
  package: 250, packages: 250,
  slice: 25, slices: 25,
  strip: 20, strips: 20,
};

const TRACE_INGREDIENTS = new Set([
  "salt", "pepper", "black pepper", "white pepper", "salt and pepper",
  "salt + pepper", "salt & pepper",
  "water", "ice", "ice water",
  "garnish", "to taste",
]);

interface ParsedIngredient {
  /** Lowercased food name, e.g. "olive oil". */
  name: string;
  /** Best-effort grams. 0 means we couldn't parse a quantity. */
  grams: number;
  /** Original line text, for debugging the cache file by eye. */
  raw: string;
}

/**
 * Quantity-token parser — ASCII-only. Earlier versions accepted Unicode
 * fraction characters (1/4, 1/2, 3/4, plus the U+2150..215E block) but
 * the literals corrupted in some ZIP-import pipelines (PowerShell
 * Compress-Archive's default code page, certain editors saving as UTF-16),
 * producing "Invalid regular expression: Range out of order in character
 * class" at iframe parse time. Removed wholesale rather than escaped:
 * the AI generates "1/2 cup" not "1/2 cup", so dropping these is zero
 * loss in practice and the source is now bulletproof against any
 * encoding mishap.
 */
function parseQuantityToken(token: string): number | null {
  // Plain number.
  if (/^\d+$/.test(token)) return Number(token);
  if (/^\d+\.\d+$/.test(token)) return Number(token);
  // ASCII fraction like "1/2" or "3/4".
  const m = token.match(/^(\d+)\/(\d+)$/);
  if (m) {
    const num = Number(m[1]);
    const den = Number(m[2]);
    if (den !== 0) return num / den;
  }
  return null;
}

export function parseIngredient(line: string): ParsedIngredient | null {
  const lower = line.trim().toLowerCase();
  if (!lower) return null;
  if (TRACE_INGREDIENTS.has(lower)) return null;

  // Strip leading list marker / parenthetical asides at the end. ASCII
  // markers only (- and *); Unicode bullet stripped from the class for
  // the same encoding-safety reason as the fraction parser above.
  const trimmed = lower.replace(/^[-*]\s*/, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) return null;

  // Pull leading quantity. Supports mixed numbers ("1 1/2 cups") via
  // repeated parseQuantityToken application.
  let i = 0;
  let quantity: number | null = null;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    const parsed = parseQuantityToken(tok);
    if (parsed === null) break;
    quantity = (quantity ?? 0) + parsed;
    i += 1;
  }

  // Find the unit (next token, possibly two for "fl oz")
  let grams = 0;
  let nameTokens = tokens.slice(i);

  if (quantity !== null && nameTokens.length > 0) {
    const t0 = nameTokens[0]!.replace(/\.$/, "");
    const t0Stripped = t0.replace(/s$/, ""); // crude singularize
    const fluidOunces = t0 === "fl" && nameTokens[1]?.replace(/\.$/, "").replace(/s$/, "") === "oz";
    if (fluidOunces) {
      grams = quantity * 30;
      nameTokens = nameTokens.slice(2);
    } else if (UNIT_TO_GRAMS[t0] !== undefined) {
      grams = quantity * UNIT_TO_GRAMS[t0]!;
      nameTokens = nameTokens.slice(1);
    } else if (UNIT_TO_GRAMS[t0Stripped] !== undefined) {
      grams = quantity * UNIT_TO_GRAMS[t0Stripped]!;
      nameTokens = nameTokens.slice(1);
    } else {
      // No unit. Try per-piece against the full remaining name.
      const fullName = nameTokens.join(" ");
      const perPiece = PER_PIECE_GRAMS[fullName] ?? PER_PIECE_GRAMS[t0] ?? PER_PIECE_GRAMS[t0Stripped];
      if (perPiece !== undefined) {
        grams = quantity * perPiece;
        // Keep the full name for the USDA search — "eggs" is a better query than "".
      } else {
        // Couldn't quantify. Assume average ~50g of whatever it is so the strip isn't
        // wildly skewed by a missing line; flag downstream that match was uncertain.
        grams = quantity * 50;
      }
    }
  } else if (quantity === null) {
    // No leading quantity. Treat as a small handful (~30g) so trace items don't dominate.
    grams = 30;
  }

  // Drop common modifiers from the front of the name ("fresh", "chopped", etc.) —
  // USDA matches better against the base food.
  const STOPWORDS = new Set([
    "fresh", "frozen", "dried", "chopped", "diced", "sliced", "minced",
    "grated", "shredded", "crushed", "ground", "raw", "cooked",
    "of", "small", "medium", "large", "extra", "whole", "halved",
  ]);
  while (nameTokens.length > 0 && STOPWORDS.has(nameTokens[0]!)) {
    nameTokens.shift();
  }
  // Trailing modifiers ("to taste", ", divided") — strip after the first comma.
  const joined = nameTokens.join(" ");
  const commaIdx = joined.indexOf(",");
  const name = (commaIdx === -1 ? joined : joined.slice(0, commaIdx)).trim();
  if (!name) return null;

  return { name, grams: Math.max(0, grams), raw: line };
}

// ── USDA API ──────────────────────────────────────────────────────────

/**
 * Outcome of a single USDA call. Distinguishes "ingredient genuinely not
 * in the database" (cache it as null forever) from "we got rate-limited"
 * (don't cache; the cap resets in an hour). The UI separates them too so
 * the user sees the right "why is this missing" message.
 */
type USDAFetchResult =
  | { kind: "hit"; food: FoodMacros }
  | { kind: "miss" } // 200 OK + empty foods[] — ingredient not in DB
  | { kind: "rate-limited" } // 429 — cap reached
  | { kind: "error" }; // network / 500 / unexpected — transient

async function searchUSDA(query: string, signal?: AbortSignal): Promise<USDAFetchResult> {
  if (rateLimitedUntil > Date.now()) return { kind: "rate-limited" };

  const url = new URL(`${USDA_BASE}/foods/search`);
  url.searchParams.set("api_key", API_KEY);
  url.searchParams.set("query", query);
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("dataType", "Foundation,SR Legacy");
  let resp: Response;
  // Stamp the timestamp BEFORE the await so the count reflects "fetch
  // attempted" rather than "fetch returned". A user firing many
  // requests in a tight loop sees the counter climb live, which is
  // closer to what they care about than "successful responses".
  recentFetchTimestamps.push(Date.now());
  try {
    resp = await fetch(url.toString(), { signal });
  } catch {
    return { kind: "error" };
  }
  if (resp.status === 429) {
    rateLimitedUntil = Date.now() + 60 * 60 * 1000;
    return { kind: "rate-limited" };
  }
  if (!resp.ok) return { kind: "error" };
  const json = (await resp.json()) as {
    foods?: Array<{
      fdcId: number;
      description: string;
      foodNutrients?: Array<{ nutrientName?: string; value?: number; unitName?: string }>;
    }>;
  };
  const food = json.foods?.[0];
  if (!food) return { kind: "miss" };
  let kcal = 0, protein = 0, fat = 0, carbs = 0;
  for (const n of food.foodNutrients ?? []) {
    const name = n.nutrientName ?? "";
    const value = typeof n.value === "number" ? n.value : 0;
    if (name === "Energy") kcal = value;
    else if (name === "Protein") protein = value;
    else if (name === "Total lipid (fat)") fat = value;
    else if (name === "Carbohydrate, by difference") carbs = value;
  }
  return {
    kind: "hit",
    food: { fdcId: food.fdcId, description: food.description, kcal, protein, fat, carbs },
  };
}

/**
 * Resolve a food name to its USDA macros. Cache-first; falls through to a
 * single live search. Caches successes + DB misses forever (the entry won't
 * appear by retrying); does NOT cache rate-limits or transient errors (those
 * are time-bound).
 */
async function resolveFood(
  name: string,
  signal?: AbortSignal,
): Promise<{ macros: FoodMacros | null; rateLimited: boolean }> {
  const key = name.toLowerCase().trim();
  if (!key) return { macros: null, rateLimited: false };
  const c = await loadCache();
  if (Object.prototype.hasOwnProperty.call(c.entries, key)) {
    return { macros: c.entries[key] ?? null, rateLimited: false };
  }
  const result = await searchUSDA(key, signal);
  switch (result.kind) {
    case "hit":
      c.entries[key] = result.food;
      await persistCache();
      return { macros: result.food, rateLimited: false };
    case "miss":
      c.entries[key] = null;
      await persistCache();
      return { macros: null, rateLimited: false };
    case "rate-limited":
      return { macros: null, rateLimited: true };
    case "error":
      return { macros: null, rateLimited: false };
  }
}

// ── Aggregation ────────────────────────────────────────────────────────

/**
 * Result of running the nutrition pipeline for one recipe.
 *
 * Two failure axes are deliberately separated:
 *   - `strip` null + rateLimited false → either zero ingredients parsed, or
 *     USDA genuinely had no match for any of them (permanent miss; will not
 *     improve on retry).
 *   - `strip` null + rateLimited true → cap on USDA lookups; the user's
 *     network has hit DEMO_KEY's 30/hr ceiling. Resolves on its own in <1h
 *     OR when the user bakes in their own VITE_USDA_API_KEY.
 *   - `strip` non-null + rateLimited true → some ingredients hit USDA before
 *     the 429, others didn't. The strip is partial; the UI flags it
 *     "rough" and shows the rate-limit context separately so the user
 *     understands why it's incomplete.
 */
export interface NutritionResult {
  strip: NutritionStrip | null;
  /** True if any USDA lookup in this recipe hit a 429. Implies further
   *  ingredients (and likely the rest of this batch of recipes) won't be
   *  looked up — the session-wide short-circuit is now active. */
  rateLimited: boolean;
  /** Count of ingredients we couldn't look up because of the rate limit
   *  (not because they're missing from USDA). For the user message. */
  missedDueToRateLimit: number;
}

/**
 * Run the lookup pipeline for a recipe.
 */
export async function computeNutrition(
  recipe: Recipe,
  signal?: AbortSignal,
): Promise<NutritionResult> {
  const parsed = recipe.ingredients
    .map(parseIngredient)
    .filter((p): p is ParsedIngredient => p !== null && p.grams > 0);
  if (parsed.length === 0) {
    return { strip: null, rateLimited: false, missedDueToRateLimit: 0 };
  }

  // Bounded concurrency — DEMO_KEY rate limit is tight, and recipes are small
  // enough that 3-in-flight is plenty.
  const results: Array<{ p: ParsedIngredient; macros: FoodMacros | null; rateLimited: boolean }> = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < parsed.length) {
      const idx = cursor++;
      const p = parsed[idx]!;
      const { macros, rateLimited } = await resolveFood(p.name, signal);
      results.push({ p, macros, rateLimited });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(SEARCH_CONCURRENCY, parsed.length) }, () => worker()),
  );

  let kcal = 0, protein = 0, fat = 0, carbs = 0;
  let matched = 0;
  let missedDueToRateLimit = 0;
  let anyRateLimited = false;
  for (const r of results) {
    if (r.macros) {
      const factor = r.p.grams / 100;
      kcal += r.macros.kcal * factor;
      protein += r.macros.protein * factor;
      fat += r.macros.fat * factor;
      carbs += r.macros.carbs * factor;
      matched += 1;
    } else if (r.rateLimited) {
      missedDueToRateLimit += 1;
      anyRateLimited = true;
    }
  }
  if (matched === 0) {
    return { strip: null, rateLimited: anyRateLimited, missedDueToRateLimit };
  }

  const servings = Math.max(1, recipe.servings);
  return {
    strip: {
      calories: Math.round(kcal / servings),
      protein: Math.round(protein / servings),
      fat: Math.round(fat / servings),
      carbs: Math.round(carbs / servings),
      matched,
      total: recipe.ingredients.length,
      est: true,
    },
    rateLimited: anyRateLimited,
    missedDueToRateLimit,
  };
}

/** When session-wide short-circuit will reset, or null if not active. */
export function rateLimitResetsAt(): Date | null {
  if (rateLimitedUntil <= Date.now()) return null;
  return new Date(rateLimitedUntil);
}

/**
 * Render a strip as a short string. Caller picks where to display it.
 * Format: "~520 cal · 32g P · 18g F · 48g C per serving · est."
 */
export function formatStrip(s: NutritionStrip): string {
  const coverageOK = s.matched / Math.max(1, s.total) >= 0.7;
  const flag = coverageOK ? "est." : "rough";
  return `~${s.calories} cal · ${s.protein}g P · ${s.fat}g F · ${s.carbs}g C · per serving · ${flag}`;
}
