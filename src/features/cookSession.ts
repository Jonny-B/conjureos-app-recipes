/**
 * A cook in progress, remembered across leaving the screen.
 *
 * The guided cook held everything in `useState` — which steps you'd ticked,
 * which ingredients you'd gathered, and the servings you'd scaled to. Every
 * bottom-nav tap calls `setCookTarget(null)` (App.tsx), which unmounts the
 * whole screen, so the single most natural thing to do mid-cook — glance at
 * the shopping list, check something in Recipes — threw all of it away. So did
 * a refresh, and so did a phone locking and the tab being reclaimed. The
 * servings factor is the one that stings: that's work you did, and it silently
 * reverted to 1.
 *
 * Deliberately localStorage, not the VFS and not the DB:
 *
 *   - The VFS would sync, but every checkbox tap becomes a write plus a sync
 *     push, which is the write-amplification and lost-update problem
 *     `planSync.ts` exists to solve for the shopping list. A cook session
 *     lives about forty minutes; it does not deserve that machinery.
 *   - A DB row would buy "start on the tablet, finish on the phone", at the
 *     cost of a migration, an edge action and compare-and-swap handling. The
 *     failures actually being fixed here — a nav tap and a locked phone — are
 *     both single-device.
 *
 * ONE slot, because the app cooks one thing at a time (`cookTarget` is a
 * single value). Starting a different recipe replaces it, but only once you
 * actually tick something: opening a recipe and backing out must not wipe the
 * cook you left running.
 *
 * The whole recipe rides along so resuming is self-contained — Home can hand
 * it straight back to `startCook` without re-fetching a catalog row whose body
 * it may not have.
 */

import type { Recipe } from "../types";

const KEY = "recipes.cookSession.v1";
/**
 * How long a session is worth offering. A cook is an evening, not a project:
 * being asked on Friday whether you want to resume Tuesday's tagine is noise,
 * and worse, it's stale — the pantry has moved on.
 */
const TTL_MS = 12 * 60 * 60 * 1000;
/** Sanity bound on what we'll read back. A recipe is a few KB; this is slack. */
const MAX_BYTES = 256 * 1024;

export interface CookSession {
  v: 1;
  /** Identifies the recipe — see `cookKeyFor`. */
  key: string;
  /** The recipe as it was handed to the cook, UNSCALED; `factor` applies on top. */
  recipe: Recipe;
  /** `SavedRecipe.path` when this came from the library, so "made this" still works. */
  savedPath: string | null;
  /** Indices of ticked steps / gathered ingredients. */
  steps: number[];
  ingredients: number[];
  factor: number;
  updatedAt: number;
}

/**
 * A stable identity for "the same cook".
 *
 * Saved recipes have a path (`db:<id>`), catalog rows have an id, and a recipe
 * the user just described to the AI has neither — for that last case the title
 * is all there is. Two different ad-hoc recipes sharing a title would resume
 * into each other, which is why the stored session carries the recipe itself
 * and the resume card names it: you can see what you're resuming.
 */
export function cookKeyFor(recipe: Recipe, savedPath?: string | null): string {
  if (savedPath) return `p:${savedPath}`;
  const id = (recipe as Recipe & { id?: string }).id;
  if (id) return `c:${id}`;
  return `t:${recipe.title.trim().toLowerCase()}`;
}

function isValid(raw: unknown): raw is CookSession {
  if (!raw || typeof raw !== "object") return false;
  const s = raw as Partial<CookSession>;
  return (
    s.v === 1 &&
    typeof s.key === "string" &&
    !!s.recipe &&
    typeof s.recipe === "object" &&
    Array.isArray(s.recipe.ingredients) &&
    Array.isArray(s.recipe.instructions) &&
    Array.isArray(s.steps) &&
    Array.isArray(s.ingredients) &&
    typeof s.factor === "number" &&
    Number.isFinite(s.factor) &&
    s.factor > 0 &&
    typeof s.updatedAt === "number"
  );
}

/** The stored session, or null when there isn't a live one. Expired ones are dropped. */
export function loadCookSession(): CookSession | null {
  let text: string | null;
  try {
    text = localStorage.getItem(KEY);
  } catch {
    return null; // blocked storage — the cook just isn't resumable here
  }
  if (!text || text.length > MAX_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    clearCookSession();
    return null;
  }
  if (!isValid(raw)) {
    clearCookSession();
    return null;
  }
  if (Date.now() - raw.updatedAt > TTL_MS) {
    clearCookSession();
    return null;
  }
  return raw;
}

export function saveCookSession(s: Omit<CookSession, "v" | "updatedAt">): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...s, v: 1, updatedAt: Date.now() }));
  } catch {
    // Quota or private mode. Losing the ability to resume is not worth
    // interrupting someone mid-cook over, so this stays silent.
  }
}

/**
 * Drop the session. With a `key`, only if it's that one — so finishing recipe
 * A can't clear a session you've since started for recipe B.
 */
export function clearCookSession(key?: string): void {
  try {
    if (key) {
      // Compare the PARSED key, not a substring of the serialized blob: the
      // recipe travels inside that blob, so a title matching the key would
      // have satisfied a `String.includes` test and cleared the wrong session.
      const cur = localStorage.getItem(KEY);
      if (cur) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(cur);
        } catch {
          parsed = null; // unreadable — dropping it is the right move anyway
        }
        if (parsed && (parsed as CookSession).key !== key) return;
      }
    }
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Whether a session has anything worth resuming to. */
export function hasProgress(s: {
  steps: number[];
  ingredients: number[];
  factor: number;
}): boolean {
  return s.steps.length > 0 || s.ingredients.length > 0 || s.factor !== 1;
}
