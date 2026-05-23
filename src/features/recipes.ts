/**
 * Recipe generation — confirmed ingredients → three recipes.
 *
 * Second AI call (text-only) at `capable` tier. Three recipes with
 * varied difficulty so the user has range; constrained to "mostly your
 * ingredients" with permission to add 1-2 common pantry items so the
 * model isn't forced to invent culinary impossibilities for sparse
 * fridges.
 */

import { complete } from "../bridge/ai";
import type { Ingredient, Recipe, Difficulty } from "../types";

const SYSTEM = `You are a friendly home-cook recipe generator. Output ONLY a JSON object — no preamble, no markdown fences, no trailing prose.

Schema:
{ "recipes": [
  { "title": string,
    "difficulty": "easy" | "medium" | "hard",
    "cookTime": number,
    "summary": string,
    "ingredients": string[],
    "instructions": string[]
  }
] }

Rules:
- Exactly 3 recipes. Vary difficulty: one easy (≤15 min, minimal technique), one medium (15-35 min, some skill), one ambitious (35-60 min, restaurant-quality).
- Use the user's ingredients as the core of each recipe. You may add up to 2 common pantry staples per recipe (salt, pepper, oil, common spices, flour, sugar, butter, garlic, onion if not already listed).
- DO NOT suggest recipes that require ingredients far outside the user's list. If the list is too sparse for an ambitious recipe, generate three easy variations instead.
- title: 2-6 words, evocative, no clickbait ("Best Ever…").
- cookTime: integer minutes, prep + cook combined.
- summary: 1-2 sentences. Pitch why this recipe is worth making.
- ingredients: full list with rough quantities (e.g. "2 eggs", "1 tbsp olive oil"). One per array element.
- instructions: numbered steps as separate array elements, no numbering in the strings themselves. 4-10 steps. Active voice, imperatives.`;

export async function generateRecipes(ingredients: Ingredient[]): Promise<Recipe[]> {
  const ingredientList = ingredients
    .filter((i) => i.confirmed)
    .map((i) => i.name)
    .join(", ");
  if (!ingredientList) {
    throw new Error("No confirmed ingredients to cook with.");
  }

  const raw = await complete({
    tier: "capable",
    system: SYSTEM,
    maxTokens: 2400,
    messages: [
      {
        role: "user",
        content: `My ingredients: ${ingredientList}.\n\nGenerate three recipes I can make tonight.`,
      },
    ],
  });

  const parsed = parseRecipesResponse(raw);
  if (parsed.length === 0) {
    throw new Error("The AI didn't return any recipes. Try with a slightly bigger ingredient list.");
  }
  return parsed;
}

function parseRecipesResponse(raw: string): Recipe[] {
  const cleaned = stripCodeFence(raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("The AI returned something that wasn't valid JSON.");
    }
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      throw new Error("The AI returned something that wasn't valid JSON.");
    }
  }

  if (!parsed || typeof parsed !== "object" || !("recipes" in parsed)) {
    throw new Error("AI response missing the `recipes` field.");
  }
  const list = (parsed as { recipes?: unknown }).recipes;
  if (!Array.isArray(list)) throw new Error("`recipes` wasn't an array.");

  const out: Recipe[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.title !== "string" || !o.title.trim()) continue;
    const difficulty = normalizeDifficulty(o.difficulty);
    const cookTime = typeof o.cookTime === "number" && o.cookTime > 0 ? Math.round(o.cookTime) : 30;
    const ingredients = Array.isArray(o.ingredients)
      ? o.ingredients.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [];
    const instructions = Array.isArray(o.instructions)
      ? o.instructions.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [];
    if (ingredients.length === 0 || instructions.length === 0) continue;
    out.push({
      title: o.title.trim(),
      difficulty,
      cookTime,
      ingredients,
      instructions,
      summary: typeof o.summary === "string" ? o.summary.trim() : undefined,
    });
  }
  return out;
}

function normalizeDifficulty(v: unknown): Difficulty {
  if (v === "easy" || v === "medium" || v === "hard") return v;
  return "medium";
}

function stripCodeFence(s: string): string {
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  return fenced ? fenced[1]! : s;
}
