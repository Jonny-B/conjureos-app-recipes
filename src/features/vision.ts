/**
 * Vision pass — image → ingredient list with confidence scores.
 *
 * Calls the ConjureOS in-app AI bridge at `capable` tier. BYK users hit
 * Sonnet (sharper at distinguishing similar produce); hosted-tier users
 * get Haiku regardless, which is good enough for the common cases and
 * relies on the user's edit pass to clean up missed/hallucinated items.
 *
 * Output contract: strict JSON object with an `ingredients` array.
 * Prompt asks the model to emit ONLY JSON, no preamble — we strip a
 * fenced ```json block defensively but otherwise expect raw JSON.
 */

import { complete, type ChatImage } from "../bridge/ai";
import type { Ingredient } from "../types";

const SYSTEM = `You identify ingredients visible in a photo of a fridge or pantry. Output ONLY a JSON object — no preamble, no markdown fences, no trailing prose.

Schema:
{ "ingredients": [
  { "name": string, "confidence": number, "notes": string? }
] }

Rules:
- name: lowercase, common (e.g. "eggs", "red bell pepper", "milk"). Avoid brand names.
- confidence: 0.0–1.0. Use ≥0.85 only when fully visible and unambiguous. Use 0.4–0.7 for partial views or look-alikes. Below 0.4 = a guess; include it but mark it.
- notes: optional, ONLY if useful (quantity, condition). Keep terse (under 30 chars).
- Skip ambiguous packaged items unless the label is clearly readable.
- Don't invent ingredients you can't see. It's better to miss than to hallucinate.
- Maximum 20 items. Prefer breadth (variety) over redundant variants of the same thing.`;

const USER_TEXT = "List the ingredients you can see in this fridge/pantry photo. JSON only.";

export async function identifyIngredients(photoDataUrl: string): Promise<Ingredient[]> {
  const image = imageFromDataUrl(photoDataUrl);
  const raw = await complete({
    tier: "capable",
    system: SYSTEM,
    maxTokens: 1500,
    messages: [
      {
        role: "user",
        content: USER_TEXT,
        images: [image],
      },
    ],
  });

  const parsed = parseIngredientsResponse(raw);
  if (!parsed.length) {
    throw new Error(
      "I couldn't identify any ingredients in that photo. Try a clearer shot with the fridge door open and the light on.",
    );
  }
  return parsed;
}

function imageFromDataUrl(dataUrl: string): ChatImage {
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
  if (!match) throw new Error("Photo isn't in a supported format. Try JPEG or PNG.");
  return {
    mediaType: match[1] as ChatImage["mediaType"],
    data: match[2]!,
  };
}

function parseIngredientsResponse(raw: string): Ingredient[] {
  const cleaned = stripCodeFence(raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("The AI returned something that wasn't valid JSON. Try retaking the photo.");
    }
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      throw new Error("The AI returned something that wasn't valid JSON. Try retaking the photo.");
    }
  }

  if (!parsed || typeof parsed !== "object" || !("ingredients" in parsed)) {
    throw new Error("AI response missing the `ingredients` field.");
  }
  const items = (parsed as { ingredients?: unknown }).ingredients;
  if (!Array.isArray(items)) {
    throw new Error("AI response's `ingredients` field wasn't an array.");
  }

  const out: Ingredient[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const obj = it as { name?: unknown; confidence?: unknown; notes?: unknown };
    if (typeof obj.name !== "string" || !obj.name.trim()) continue;
    const conf =
      typeof obj.confidence === "number" && obj.confidence >= 0 && obj.confidence <= 1
        ? obj.confidence
        : 0.5;
    out.push({
      name: obj.name.trim().toLowerCase(),
      confidence: conf,
      notes: typeof obj.notes === "string" && obj.notes.trim() ? obj.notes.trim() : undefined,
      confirmed: conf >= 0.7,
    });
  }
  return out;
}

function stripCodeFence(s: string): string {
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  return fenced ? fenced[1]! : s;
}
