/**
 * AI aisle inference. When the deterministic store layout (categories + user
 * exceptions + previously-learned placements) can't place an item, we hand the
 * MODEL that same layout as context and let it infer where the item goes at
 * THIS store — by analogy to what already lives in each aisle. The result is
 * remembered on the store (storeLayout.withLearned) so the next list is instant
 * and free. Robust to model/parse failure: returns {} and the items just stay
 * in the trailing "Unsorted" group.
 */
import { complete } from "../bridge/ai";
import type { StoreLayout } from "./storeLayout";

const SYSTEM = `You map grocery items to the aisles of ONE specific store.
You are given that store's aisle layout (each aisle's id, name, and the kinds of
things already shelved there) and a list of items that haven't been placed yet.
For each item, pick the aisle id where it most likely belongs AT THIS STORE,
reasoning by analogy to what each aisle already holds.
Output ONLY a JSON object mapping each item's EXACT given name to an aisle id,
e.g. {"all-purpose flour":"a1b2c3"}. Use only ids that appear in the layout.
Omit an item entirely if you genuinely cannot tell. No prose, no code fences.`;

/** Items per model call — see the chunking note in inferAislePlacements. */
const CHUNK = 25;

function parseObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Ask the model to place `items` into `store`'s aisles. Returns canonical → aisleId
 * for the ones it could place (only valid aisle ids; only requested items).
 */
export async function inferAislePlacements(
  items: { name: string; canonical: string }[],
  store: StoreLayout,
): Promise<Record<string, string>> {
  if (!items.length || !store.aisles.length) return {};
  // One reply has a token ceiling, and a truncated JSON object parses to
  // nothing — losing EVERY placement in the batch, not just the overflow. A
  // big shop can easily leave 40+ items unplaced, so split the ask.
  if (items.length > CHUNK) {
    const chunks: (typeof items)[] = [];
    for (let i = 0; i < items.length; i += CHUNK) chunks.push(items.slice(i, i + CHUNK));
    const results = await Promise.all(chunks.map((c) => inferAislePlacements(c, store)));
    return Object.assign({}, ...results) as Record<string, string>;
  }

  const learnedByAisle = new Map<string, string[]>();
  for (const [canon, aid] of Object.entries(store.learned ?? {})) {
    (learnedByAisle.get(aid) ?? learnedByAisle.set(aid, []).get(aid)!).push(canon);
  }
  const layout = store.aisles
    .map((a, i) => {
      const parts: string[] = [];
      if (a.categories.length) parts.push(a.categories.join(", "));
      const ex = store.itemOverrides.filter((o) => o.aisleId === a.id && o.keyword.trim()).map((o) => o.keyword.trim());
      const learned = learnedByAisle.get(a.id) ?? [];
      for (const e of [...ex, ...learned].slice(0, 12)) parts.push(e);
      const holds = parts.length ? ` — holds: ${parts.join(", ")}` : "";
      return `id="${a.id}" name="${a.name || `Aisle ${i + 1}`}"${holds}`;
    })
    .join("\n");

  const list = items.map((it) => `- ${it.name}`).join("\n");
  let raw: string;
  try {
    raw = await complete({
      tier: "cheap",
      system: SYSTEM,
      maxTokens: 600,
      messages: [{ role: "user", content: `Store aisles:\n${layout}\n\nUnplaced items:\n${list}` }],
    });
  } catch {
    return {};
  }

  const obj = parseObject(raw);
  if (!obj) return {};
  const validAisle = new Set(store.aisles.map((a) => a.id));
  const byName = new Map(items.map((it) => [it.name.toLowerCase(), it.canonical]));
  const out: Record<string, string> = {};
  for (const [name, aisleId] of Object.entries(obj)) {
    if (typeof aisleId !== "string" || !validAisle.has(aisleId)) continue;
    const canonical = byName.get(String(name).toLowerCase());
    if (canonical) out[canonical] = aisleId;
  }
  return out;
}
