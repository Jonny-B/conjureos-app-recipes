/**
 * Waste risk: how long something has probably got left.
 *
 * The whole promise of this app is "use up what you already have", and that
 * only means anything if it knows what is closest to being thrown out. There
 * are two ways to know:
 *
 *   1. A REAL date — read off the packaging by the scan, or typed by the user.
 *      A fact. It wins outright.
 *   2. An ESTIMATE — this table, applied to `addedAt`. A guess, and the UI
 *      always says so ("about 3 days left", never "expires Tuesday").
 *
 * The two are deliberately not blended. A printed date nudged by a table is
 * less trustworthy than either on its own, and the moment the app is confidently
 * wrong about a date the feature is dead.
 *
 * The numbers are ordinary home-storage rules of thumb, deliberately on the
 * generous side: telling someone their rice is about to go off is worse than
 * saying nothing, because it teaches them to ignore the block. They assume the
 * item's DEFAULT location; an item explicitly in the freezer gets the freezer
 * figure instead, whatever the food is.
 */
import type { PantryItem, PantryLocation } from "../types";

export type Risk = "expired" | "urgent" | "soon" | "fine";

/** Days at which each band starts. Tuned so "soon" is roughly "this week". */
const URGENT_DAYS = 2;
const SOON_DAYS = 5;

/** Anything frozen keeps for about this long, whatever it is. */
const FREEZER_DAYS = 180;

/** Nothing matched: a fortnight, and the UI shows it as the weakest signal. */
const DEFAULT_DAYS = 14;
const DEFAULT_WHERE: PantryLocation = "pantry";

/**
 * Keyword → [days, where]. Two rules make this table behave:
 *
 *   1. LONGEST MATCHING KEYWORD WINS, which sorts the collisions out with no
 *      special-casing: "ground beef" (2 days) beats "beef" (4), "sweet potato"
 *      beats "potato", "coconut milk" (365, pantry) beats "milk" (7, fridge),
 *      "black pepper" (a spice) beats "pepper" (a vegetable).
 *   2. A keyword must start at a WORD BOUNDARY. Without that, "boiled eggs"
 *      matches "oil" — b-**oil**-ed — and a three-letter keyword quietly
 *      poisons anything containing its letters. The boundary still allows the
 *      suffix matches the table depends on ("spinach" in "organic baby
 *      spinach", "strawberr" in "strawberries", "egg" in "eggs").
 *
 * Add new entries anywhere; order does not matter.
 */
const TABLE: ReadonlyArray<readonly [string, number, PantryLocation]> = [
  // Fast — days, not weeks.
  ["fresh fish", 2, "fridge"],
  ["salmon", 2, "fridge"],
  ["cod", 2, "fridge"],
  ["haddock", 2, "fridge"],
  ["prawn", 2, "fridge"],
  ["shrimp", 2, "fridge"],
  ["mussel", 2, "fridge"],
  ["scallop", 2, "fridge"],
  ["mince", 2, "fridge"],
  ["ground beef", 2, "fridge"],
  ["ground pork", 2, "fridge"],
  ["ground turkey", 2, "fridge"],
  ["ground chicken", 2, "fridge"],
  ["sausage", 3, "fridge"],
  ["chicken", 2, "fridge"],
  ["turkey", 2, "fridge"],
  ["liver", 2, "fridge"],
  ["basil", 4, "fridge"],
  ["coriander", 4, "fridge"],
  ["cilantro", 4, "fridge"],
  ["parsley", 5, "fridge"],
  ["mint", 5, "fridge"],
  ["dill", 4, "fridge"],
  ["bagged salad", 4, "fridge"],
  ["salad leaves", 4, "fridge"],
  ["rocket", 4, "fridge"],
  ["arugula", 4, "fridge"],
  ["spinach", 5, "fridge"],
  ["lettuce", 6, "fridge"],
  ["strawberr", 4, "fridge"],
  ["raspberr", 3, "fridge"],
  ["blackberr", 4, "fridge"],
  ["blueberr", 8, "fridge"],
  ["avocado", 4, "pantry"],
  ["banana", 5, "pantry"],
  ["peach", 5, "pantry"],
  ["nectarine", 5, "pantry"],
  ["apricot", 5, "pantry"],
  ["fig", 4, "fridge"],
  ["mushroom", 6, "fridge"],
  ["leftover", 4, "fridge"],
  ["beef", 4, "fridge"],
  ["steak", 4, "fridge"],
  ["pork", 4, "fridge"],
  ["lamb", 4, "fridge"],

  // A week or so.
  ["milk", 7, "fridge"],
  ["cream", 7, "fridge"],
  ["sour cream", 10, "fridge"],
  ["creme fraiche", 10, "fridge"],
  ["yoghurt", 10, "fridge"],
  ["yogurt", 10, "fridge"],
  ["cottage cheese", 7, "fridge"],
  ["tofu", 7, "fridge"],
  ["ham", 7, "fridge"],
  ["bacon", 7, "fridge"],
  ["salami", 14, "fridge"],
  ["prosciutto", 10, "fridge"],
  ["chorizo", 14, "fridge"],
  ["bread", 5, "pantry"],
  ["sourdough", 5, "pantry"],
  ["juice", 8, "fridge"],
  ["kale", 7, "fridge"],
  ["chard", 6, "fridge"],
  ["asparagus", 5, "fridge"],
  ["green bean", 7, "fridge"],
  ["broccoli", 8, "fridge"],
  ["cauliflower", 9, "fridge"],
  ["courgette", 7, "fridge"],
  ["zucchini", 7, "fridge"],
  ["cucumber", 7, "fridge"],
  ["aubergine", 7, "fridge"],
  ["eggplant", 7, "fridge"],
  ["tomato", 8, "fridge"],
  ["pepper", 10, "fridge"],
  ["celery", 12, "fridge"],
  ["grape", 10, "fridge"],
  ["mango", 6, "pantry"],
  ["pineapple", 6, "fridge"],
  ["melon", 6, "fridge"],

  // Weeks.
  ["egg", 28, "fridge"],
  ["butter", 30, "fridge"],
  ["brie", 12, "fridge"],
  ["mozzarella", 10, "fridge"],
  ["ricotta", 7, "fridge"],
  ["feta", 14, "fridge"],
  ["halloumi", 21, "fridge"],
  ["cheddar", 28, "fridge"],
  ["parmesan", 45, "fridge"],
  ["gouda", 28, "fridge"],
  ["cheese", 21, "fridge"],
  ["lemon", 21, "fridge"],
  ["lime", 21, "fridge"],
  ["orange", 21, "fridge"],
  ["grapefruit", 21, "fridge"],
  ["apple", 21, "fridge"],
  ["pear", 12, "fridge"],
  ["carrot", 21, "fridge"],
  ["beetroot", 21, "fridge"],
  ["parsnip", 21, "fridge"],
  ["turnip", 21, "fridge"],
  ["radish", 12, "fridge"],
  ["cabbage", 30, "fridge"],
  ["tortilla", 14, "pantry"],
  ["wrap", 14, "pantry"],
  ["pitta", 10, "pantry"],
  ["ketchup", 60, "fridge"],
  ["mayonnaise", 30, "fridge"],
  ["mayo", 30, "fridge"],
  ["mustard", 90, "fridge"],
  ["jam", 30, "fridge"],
  ["salsa", 14, "fridge"],
  ["black pepper", 730, "pantry"],
  ["peppercorn", 730, "pantry"],
  ["cayenne", 730, "pantry"],
  ["chilli flake", 730, "pantry"],
  ["chili flake", 730, "pantry"],
  ["hummus", 7, "fridge"],
  ["pesto", 10, "fridge"],
  ["stock", 7, "fridge"],
  ["broth", 7, "fridge"],
  ["chicken stock", 7, "fridge"],
  ["beef stock", 7, "fridge"],

  // Months, and the cupboard.
  ["potato", 30, "pantry"],
  ["sweet potato", 21, "pantry"],
  ["onion", 45, "pantry"],
  ["shallot", 45, "pantry"],
  ["garlic", 60, "pantry"],
  ["squash", 45, "pantry"],
  ["pumpkin", 45, "pantry"],
  ["nut", 120, "pantry"],
  ["seed", 120, "pantry"],
  ["coconut milk", 365, "pantry"],
  ["almond milk", 60, "pantry"],
  ["oat milk", 60, "pantry"],
  ["rice", 365, "pantry"],
  ["pasta", 365, "pantry"],
  ["noodle", 365, "pantry"],
  ["couscous", 365, "pantry"],
  ["quinoa", 365, "pantry"],
  ["lentil", 365, "pantry"],
  ["chickpea", 365, "pantry"],
  ["oat", 365, "pantry"],
  ["flour", 270, "pantry"],
  ["sugar", 730, "pantry"],
  ["oil", 365, "pantry"],
  ["vinegar", 730, "pantry"],
  ["honey", 730, "pantry"],
  ["syrup", 540, "pantry"],
  ["salt", 730, "pantry"],
  ["cumin", 730, "pantry"],
  ["paprika", 730, "pantry"],
  ["cinnamon", 730, "pantry"],
  ["oregano", 730, "pantry"],
  ["thyme", 730, "pantry"],
  ["tinned", 540, "pantry"],
  ["canned", 540, "pantry"],
  ["frozen", FREEZER_DAYS, "freezer"],
];

/**
 * Precomputed longest-first, each keyword anchored to a word boundary, so the
 * first hit is always the best hit. Built once at module load: `shelfGuess` is
 * called per row on every Pantry render.
 */
const SORTED: ReadonlyArray<{ re: RegExp; days: number; where: PantryLocation }> = [...TABLE]
  .sort((a, b) => b[0].length - a[0].length)
  .map(([key, days, where]) => ({
    // Escaped even though every current keyword is plain letters and spaces —
    // the next one added will not necessarily be.
    re: new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    days,
    where,
  }));

export interface ShelfGuess {
  /** Estimated days from `addedAt` before it is likely past its best. */
  days: number;
  where: PantryLocation;
  /** False when nothing in the table matched and the default was used. */
  matched: boolean;
}

/** What the table thinks about a name. Never throws; always answers. */
export function shelfGuess(name: string): ShelfGuess {
  const n = name.trim().toLowerCase();
  for (const { re, days, where } of SORTED) {
    if (re.test(n)) return { days, where, matched: true };
  }
  return { days: DEFAULT_DAYS, where: DEFAULT_WHERE, matched: false };
}

/** Where an item lives: its own setting, else the table's guess. */
export function locationOf(item: PantryItem): PantryLocation {
  return item.location ?? shelfGuess(item.name).where;
}

export interface Remaining {
  /** Whole days left. Negative means it is already past. */
  days: number;
  /** `expiry` = a real date someone read or typed. `estimate` = this table. */
  basis: "expiry" | "estimate";
  /** True when the estimate came from the fallback, not a table hit. */
  weak: boolean;
}

const DAY_MS = 86_400_000;

/**
 * How long this item has left, and how much that answer is worth.
 *
 * Returns null only when `addedAt` is unparseable and there is no date — i.e.
 * when there is genuinely nothing to reason from. Callers must treat null as
 * "no opinion", not as "fine".
 */
export function remainingFor(item: PantryItem, now: number = Date.now()): Remaining | null {
  if (item.expiresAt) {
    // END of the stated day, not the start of it. A use-by date of the 30th
    // means "good through the 30th", so at midday on the 18th it has twelve
    // days left, not eleven — and something stamped for today reads as
    // "today" rather than as already gone.
    const due = Date.parse(`${item.expiresAt}T23:59:59Z`);
    if (!Number.isNaN(due)) {
      return { days: Math.floor((due - now) / DAY_MS), basis: "expiry", weak: false };
    }
  }
  const added = Date.parse(item.addedAt);
  if (Number.isNaN(added)) return null;
  const guess = shelfGuess(item.name);
  // The freezer stops the clock for practical purposes, so an explicit
  // freezer location overrides whatever the fresh-food row said.
  const days = item.location === "freezer" ? FREEZER_DAYS : guess.days;
  const elapsed = Math.floor((now - added) / DAY_MS);
  return { days: days - elapsed, basis: "estimate", weak: !guess.matched };
}

export function riskOf(item: PantryItem, now: number = Date.now()): Risk {
  const r = remainingFor(item, now);
  if (!r) return "fine";
  if (r.days < 0) return "expired";
  if (r.days <= URGENT_DAYS) return "urgent";
  if (r.days <= SOON_DAYS) return "soon";
  return "fine";
}

/** True for the three bands the "use these up" block cares about. */
export function atRisk(item: PantryItem, now: number = Date.now()): boolean {
  return riskOf(item, now) !== "fine";
}

/**
 * The waste-reduction ordering: soonest-gone first.
 *
 * When nothing is at risk it degrades to LONGEST HELD, because "what have I had
 * the longest" is the honest fallback and is exactly what `addedAt` already
 * knows. Stable: equal keys keep their input order.
 */
export function byWasteRisk(items: PantryItem[], now: number = Date.now()): PantryItem[] {
  return items
    .map((item, i) => {
      const r = remainingFor(item, now);
      return {
        item,
        i,
        // No opinion sorts last, not first — an item we know nothing about is
        // not evidence that it needs using up.
        key: r ? r.days : Number.POSITIVE_INFINITY,
        // A real date outranks an estimate at the same day count.
        tier: r?.basis === "expiry" ? 0 : 1,
      };
    })
    .sort((a, b) => a.key - b.key || a.tier - b.tier || a.i - b.i)
    .map((x) => x.item);
}

/** "2 days left" / "today" / "3 days past". Plain, and never falsely precise. */
export function remainingLabel(r: Remaining): string {
  if (r.days < 0) {
    const n = -r.days;
    return `${n} day${n === 1 ? "" : "s"} past`;
  }
  if (r.days === 0) return "today";
  if (r.days === 1) return "1 day left";
  return `${r.days} days left`;
}

/** Today as `YYYY-MM-DD`, for the expiry date input's min attribute. */
export function todayISO(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}
