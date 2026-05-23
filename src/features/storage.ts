/**
 * Recipe persistence — markdown with YAML frontmatter under
 * `/home/Documents/Recipes/`. Typed-home convention (ConjureOS 0.3.10)
 * so the user can browse + edit recipes in the Files app or any
 * markdown editor and they sync across devices.
 *
 * File shape:
 *
 *   ---
 *   title: Spinach & Feta Scramble
 *   difficulty: easy
 *   cookTime: 10
 *   savedAt: 2026-05-22T19:30:00.000Z
 *   madeCount: 0
 *   lastMadeAt: null
 *   source: conjureos-app-recipes
 *   ---
 *
 *   ## Ingredients
 *   - 3 eggs
 *   ...
 *
 *   ## Instructions
 *   1. ...
 */

import { vfs } from "../bridge/vfs";
import type { NutritionStrip, Recipe, SavedRecipe, Difficulty } from "../types";

const RECIPES_DIR = "/home/Documents/Recipes";

export async function saveRecipe(recipe: Recipe): Promise<SavedRecipe> {
  await ensureDir(RECIPES_DIR);
  const slug = await uniqueSlug(slugify(recipe.title));
  const savedAt = new Date().toISOString();
  const saved: SavedRecipe = {
    ...recipe,
    servings: recipe.servings || 2,
    nutrition: recipe.nutrition ?? null,
    path: `${RECIPES_DIR}/${slug}.md`,
    slug,
    savedAt,
    madeCount: 0,
    lastMadeAt: null,
  };
  await vfs.write(saved.path, toMarkdown(saved));
  return saved;
}

export async function listSavedRecipes(): Promise<SavedRecipe[]> {
  const exists = await vfs.exists(RECIPES_DIR).catch(() => false);
  if (!exists) return [];
  const entries = await vfs.ls(RECIPES_DIR).catch(() => []);
  const mdFiles = entries.filter((e) => e.endsWith(".md"));

  const results: SavedRecipe[] = [];
  for (const file of mdFiles) {
    const path = `${RECIPES_DIR}/${file}`;
    try {
      const text = await vfs.read(path);
      const parsed = parseMarkdown(text, path, file.replace(/\.md$/, ""));
      if (parsed) results.push(parsed);
    } catch {
      // Skip unreadable / malformed entries silently — the user
      // can delete them manually via the Files app if needed.
    }
  }
  // Newest first.
  results.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return results;
}

export async function markMade(recipe: SavedRecipe): Promise<SavedRecipe> {
  const updated: SavedRecipe = {
    ...recipe,
    madeCount: recipe.madeCount + 1,
    lastMadeAt: new Date().toISOString(),
  };
  await vfs.write(recipe.path, toMarkdown(updated));
  return updated;
}

export async function deleteRecipe(recipe: SavedRecipe): Promise<void> {
  await vfs.rm(recipe.path);
}

// ── helpers ────────────────────────────────────────────────────────

async function ensureDir(path: string): Promise<void> {
  try {
    await vfs.mkdir(path);
  } catch {
    /* already exists or host doesn't enforce */
  }
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "recipe"
  );
}

async function uniqueSlug(base: string): Promise<string> {
  let candidate = base;
  let n = 2;
  while (await vfs.exists(`${RECIPES_DIR}/${candidate}.md`)) {
    candidate = `${base}-${n}`;
    n += 1;
    if (n > 999) throw new Error("Too many recipes with similar titles.");
  }
  return candidate;
}

function toMarkdown(r: SavedRecipe): string {
  const nutritionLines = r.nutrition
    ? [
        `nutritionCalories: ${r.nutrition.calories}`,
        `nutritionProtein: ${r.nutrition.protein}`,
        `nutritionFat: ${r.nutrition.fat}`,
        `nutritionCarbs: ${r.nutrition.carbs}`,
        `nutritionMatched: ${r.nutrition.matched}`,
        `nutritionTotal: ${r.nutrition.total}`,
      ]
    : [];
  const fm = [
    "---",
    `title: ${yamlString(r.title)}`,
    `difficulty: ${r.difficulty}`,
    `cookTime: ${r.cookTime}`,
    `servings: ${r.servings}`,
    `savedAt: ${r.savedAt}`,
    `madeCount: ${r.madeCount}`,
    `lastMadeAt: ${r.lastMadeAt ?? "null"}`,
    ...nutritionLines,
    `source: conjureos-app-recipes`,
    "---",
    "",
  ].join("\n");
  const summary = r.summary ? `${r.summary}\n\n` : "";
  const ingredients = `## Ingredients\n\n${r.ingredients.map((i) => `- ${i}`).join("\n")}\n\n`;
  const instructions = `## Instructions\n\n${r.instructions.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`;
  return `${fm}# ${r.title}\n\n${summary}${ingredients}${instructions}`;
}

function yamlString(s: string): string {
  if (/[:#\n]/.test(s) || s.startsWith(" ") || s.endsWith(" ")) {
    return JSON.stringify(s);
  }
  return s;
}

function parseMarkdown(text: string, path: string, slug: string): SavedRecipe | null {
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const [, fm, body] = fmMatch;
  if (!fm || !body) return null;

  const front: Record<string, string> = {};
  for (const line of fm.split("\n")) {
    const eq = line.indexOf(":");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
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
        const m = ln.match(/^[-*]\s+(.+)$/);
        if (m) ingredients.push(m[1]!.trim());
      }
    } else if (sec.startsWith("Instructions\n")) {
      const lines = sec.split("\n").slice(1);
      for (const ln of lines) {
        const m = ln.match(/^\d+\.\s+(.+)$/);
        if (m) instructions.push(m[1]!.trim());
      }
    } else if (sec.startsWith("# ") || sec.startsWith("Summary\n")) {
      const text = sec.replace(/^#\s+[^\n]*\n+/, "").trim();
      if (text && !text.startsWith("##")) summary = text;
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
  };
}

function isDifficulty(s: string | undefined): s is Difficulty {
  return s === "easy" || s === "medium" || s === "hard";
}
