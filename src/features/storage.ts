/**
 * Saved-recipe persistence, now backed by the `recipes-db` Supabase table
 * (the all-in-DB store) rather than VFS markdown. Each saved recipe is a row
 * owned by the signed-in user; we reach it through recipesApi, which invokes
 * the "recipesDb" remote action so the kernel attaches a minted identity token
 * and the backend derives the owner. A saved recipe's `path` is `db:<id>`
 * (recipesApi.recipeIdFromPath recovers the id); there is no longer a real
 * file path.
 *
 * The public surface (saveRecipe / listSavedRecipes / markMade / deleteRecipe
 * / setSavedFavorite) is unchanged so the screens and the cross-app action
 * registry keep working. The old markdown reader survives only as the source
 * of a one-time migration that lifts any pre-existing VFS recipes into the DB.
 */

import { vfs } from "../bridge/vfs";
import * as api from "../bridge/recipesApi";
import { isBackendAvailable, recipeIdFromPath } from "../bridge/recipesApi";
import type { NutritionStrip, Recipe, SavedRecipe, Difficulty } from "../types";

const RECIPES_DIR = "/home/Documents/Recipes";
/** Marker so the one-time VFS to DB import runs at most once per device. */
const MIGRATED_FLAG = `${RECIPES_DIR}/.migrated-to-db`;

export async function saveRecipe(recipe: Recipe): Promise<SavedRecipe> {
  return api.addRecipe({ ...recipe, visibility: "private" });
}

/**
 * Outcome of listing the user's library. `ok: false` means the backend was
 * reachable-in-principle but the call failed — which is NOT the same as an
 * empty library, and must not be rendered as "you haven't saved anything".
 *
 * No backend at all (standalone conj-pack dev, where there is no actions
 * bridge) IS a genuine empty: there is no library to fail to read.
 */
export type SavedListing = { ok: true; recipes: SavedRecipe[] } | { ok: false };

export async function listSavedRecipesResult(): Promise<SavedListing> {
  if (!isBackendAvailable()) return { ok: true, recipes: [] };
  try {
    await migrateLegacyRecipes();
    return { ok: true, recipes: await api.listMine() };
  } catch {
    return { ok: false };
  }
}

/**
 * Lenient variant for surfaces that BLEND saved recipes into a wider feed
 * (Home, Plan-my-week). There an empty result asserts nothing to the user, so
 * degrading is fine. A screen that says "you haven't saved any recipes yet"
 * must use listSavedRecipesResult instead — that sentence is a claim.
 */
export async function listSavedRecipes(): Promise<SavedRecipe[]> {
  const r = await listSavedRecipesResult();
  return r.ok ? r.recipes : [];
}

/**
 * Rewrite an already-saved recipe's body. The one caller today is the nutrition
 * backfill: the USDA estimate for a card can land AFTER the user hit Save, and
 * nothing else ever recomputes nutrition for a saved recipe — so without this
 * the row keeps `nutrition: null` forever (see RecipesScreen.onSave).
 */
export async function updateSavedRecipe(
  saved: SavedRecipe,
  recipe: Recipe,
): Promise<SavedRecipe> {
  return api.updateRecipe(recipeIdFromPath(saved.path), recipe);
}

export async function markMade(recipe: SavedRecipe): Promise<SavedRecipe> {
  return api.markCooked(recipeIdFromPath(recipe.path));
}

export async function deleteRecipe(recipe: SavedRecipe): Promise<void> {
  await api.deleteRecipe(recipeIdFromPath(recipe.path));
}

/** Set/clear the favorite flag on a saved recipe (a column on its DB row). */
export async function setSavedFavorite(
  recipe: SavedRecipe,
  fav: boolean,
): Promise<SavedRecipe> {
  return api.setFavorite(recipeIdFromPath(recipe.path), fav);
}

// One-time legacy import (VFS markdown to DB).

/**
 * Lifts recipes saved by older versions of the app (markdown under
 * /home/Documents/Recipes) into the DB the first time we run against the
 * backend, then drops a flag file so it never repeats. The old .md files are
 * left in place as a backup; the user can delete them from the Files app.
 * Best-effort throughout: any failure just leaves the flag unset so a later
 * launch can retry, and it never blocks listing.
 */
async function migrateLegacyRecipes(): Promise<void> {
  try {
    if (await vfs.exists(MIGRATED_FLAG)) return;
  } catch {
    return;
  }
  try {
    if (!(await vfs.exists(RECIPES_DIR).catch(() => false))) {
      await markMigrated();
      return;
    }
    const entries = await vfs.ls(RECIPES_DIR).catch(() => [] as string[]);
    const mdFiles = entries.filter((e) => e.endsWith(".md"));
    // A file we can't read or parse is skipped FOREVER — retrying won't fix it.
    // A file the BACKEND refused is a different thing: that's transient, and it
    // must hold the flag open so a later launch retries. Lumping both into one
    // catch and marking migrated regardless is how a backend outage silently
    // consumed the one-shot migration and orphaned everyone's legacy recipes.
    let backendFailures = 0;
    for (const file of mdFiles) {
      const path = `${RECIPES_DIR}/${file}`;
      let parsed: ReturnType<typeof parseMarkdown> = null;
      try {
        const text = await vfs.read(path);
        parsed = parseMarkdown(text, path, file.replace(/\.md$/, ""));
      } catch {
        continue; // unreadable file — nothing a retry would change
      }
      if (!parsed) continue; // unparseable — same
      try {
        const added = await api.addRecipe({ ...toPlainRecipe(parsed), visibility: "private" });
        if (parsed.favorite) {
          await api.setFavorite(recipeIdFromPath(added.path), true).catch(() => {});
        }
      } catch {
        backendFailures++;
      }
    }
    if (backendFailures === 0) await markMigrated();
  } catch {
    /* leave the flag unset; a later launch retries */
  }
}

async function markMigrated(): Promise<void> {
  try {
    await vfs.mkdir(RECIPES_DIR);
  } catch {
    /* already exists */
  }
  try {
    await vfs.write(MIGRATED_FLAG, new Date().toISOString());
  } catch {
    /* non-fatal: worst case the import retries next launch */
  }
}

function toPlainRecipe(s: SavedRecipe): Recipe {
  return {
    title: s.title,
    difficulty: s.difficulty,
    cookTime: s.cookTime,
    servings: s.servings,
    ingredients: s.ingredients,
    instructions: s.instructions,
    summary: s.summary,
    nutrition: s.nutrition ?? null,
  };
}

// Legacy markdown reader (migration input only).

// Defensive caps when parsing saved markdown. Users (or other apps via the
// VFS) could have edited these files freely, so a malformed file should fail
// gracefully rather than blow memory or break the import.
const MAX_FILE_BYTES = 64 * 1024;
const MAX_FRONTMATTER_LINES = 40;
const MAX_FIELD_VALUE_LENGTH = 1000;
const MAX_BODY_INGREDIENTS = 60;
const MAX_BODY_INSTRUCTIONS = 60;
const MAX_LINE_LENGTH = 400;

function parseMarkdown(text: string, path: string, slug: string): SavedRecipe | null {
  if (text.length > MAX_FILE_BYTES) return null;
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const [, fm, body] = fmMatch;
  if (!fm || !body) return null;

  const fmLines = fm.split("\n");
  if (fmLines.length > MAX_FRONTMATTER_LINES) return null;

  const front: Record<string, string> = {};
  for (const line of fmLines) {
    const eq = line.indexOf(":");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key.length > 50) continue;
    let val = line.slice(eq + 1).trim();
    if (val.length > MAX_FIELD_VALUE_LENGTH) continue;
    if (val.startsWith('"') && val.endsWith('"')) {
      try {
        val = JSON.parse(val);
      } catch {
        /* keep literal */
      }
    }
    front[key] = val;
  }

  const title = front.title;
  const difficulty = isDifficulty(front.difficulty) ? front.difficulty : "medium";
  const cookTime = Number(front.cookTime);
  const servings = Number(front.servings ?? "2");
  const savedAt = front.savedAt ?? new Date().toISOString();
  const madeCount = Number(front.madeCount ?? "0");
  const lastMadeAt =
    front.lastMadeAt && front.lastMadeAt !== "null" ? front.lastMadeAt : null;

  let nutrition: NutritionStrip | null = null;
  if (front.nutritionCalories) {
    const calories = Number(front.nutritionCalories);
    const protein = Number(front.nutritionProtein ?? "0");
    const fat = Number(front.nutritionFat ?? "0");
    const carbs = Number(front.nutritionCarbs ?? "0");
    const matched = Number(front.nutritionMatched ?? "0");
    const total = Number(front.nutritionTotal ?? "0");
    if (Number.isFinite(calories)) {
      nutrition = {
        calories: Math.round(calories),
        protein: Math.round(protein),
        fat: Math.round(fat),
        carbs: Math.round(carbs),
        matched: Math.round(matched),
        total: Math.round(total),
        est: true,
      };
    }
  }

  if (!title || !Number.isFinite(cookTime)) return null;

  const ingredients: string[] = [];
  const instructions: string[] = [];
  let summary: string | undefined;

  const sections = body.split(/\n## /);
  for (const sec of sections) {
    if (sec.startsWith("Ingredients\n")) {
      const lines = sec.split("\n").slice(1);
      for (const ln of lines) {
        if (ingredients.length >= MAX_BODY_INGREDIENTS) break;
        if (ln.length > MAX_LINE_LENGTH) continue;
        const m = ln.match(/^[-*]\s+(.+)$/);
        if (m) ingredients.push(m[1]!.trim());
      }
    } else if (sec.startsWith("Instructions\n")) {
      const lines = sec.split("\n").slice(1);
      for (const ln of lines) {
        if (instructions.length >= MAX_BODY_INSTRUCTIONS) break;
        if (ln.length > MAX_LINE_LENGTH) continue;
        const m = ln.match(/^\d+\.\s+(.+)$/);
        if (m) instructions.push(m[1]!.trim());
      }
    } else if (sec.startsWith("# ") || sec.startsWith("Summary\n")) {
      const t = sec.replace(/^#\s+[^\n]*\n+/, "").trim();
      if (t && !t.startsWith("##") && t.length <= MAX_FIELD_VALUE_LENGTH) {
        summary = t;
      }
    }
  }

  if (!ingredients.length || !instructions.length) return null;

  return {
    title,
    difficulty,
    cookTime: Math.round(cookTime),
    servings: Number.isFinite(servings) && servings > 0 ? Math.round(servings) : 2,
    summary,
    ingredients,
    instructions,
    nutrition,
    path,
    slug,
    savedAt,
    madeCount: Number.isFinite(madeCount) ? madeCount : 0,
    lastMadeAt,
    favorite: front.favorite === "true",
  };
}

function isDifficulty(s: string | undefined): s is Difficulty {
  return s === "easy" || s === "medium" || s === "hard";
}
