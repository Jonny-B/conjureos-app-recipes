/**
 * Persistent pantry/fridge inventory.
 *
 * A single JSON document at /home/Documents/Recipes/.pantry.json (dot-prefixed
 * so listSavedRecipes() and the Files app, which only surface *.md, ignore it).
 * The pantry drives the "what can I make" match ranking and Plan My Week. Items
 * are added manually or merged from a fridge scan (vision pipeline).
 */

import { vfs } from "../bridge/vfs";
import { readJsonDoc, requireJsonDoc } from "./jsonDoc";
import { sanitizeName } from "./vision";
import type { Ingredient, PantryItem } from "../types";

const RECIPES_DIR = "/home/Documents/Recipes";
const PANTRY_PATH = `${RECIPES_DIR}/.pantry.json`;
const MAX_ITEMS = 200;
const MAX_FILE_BYTES = 256 * 1024;

interface PantryDoc {
  v: 1;
  items: PantryItem[];
  updatedAt: string;
}

/** Shape check shared by the display and mutator loaders. */
function parsePantry(raw: unknown): PantryItem[] | null {
  const doc = raw as Partial<PantryDoc> | null;
  if (!doc || !Array.isArray(doc.items)) return null;
  return doc.items.filter(isValidItem).slice(0, MAX_ITEMS);
}

const PANTRY_DOC = { maxBytes: MAX_FILE_BYTES, empty: [] as PantryItem[] };

/**
 * Read for DISPLAY. Still degrades to an empty list, because a screen that
 * can't read the pantry has nothing better to render.
 * Mutators must use `loadPantryForWrite` instead — see jsonDoc.ts.
 */
export async function loadPantry(): Promise<PantryItem[]> {
  const r = await readJsonDoc(PANTRY_PATH, parsePantry, PANTRY_DOC);
  return r.ok ? r.value : [];
}

/** Read for a read-modify-write. Throws rather than returning a false empty. */
async function loadPantryForWrite(): Promise<PantryItem[]> {
  return requireJsonDoc(PANTRY_PATH, parsePantry, { ...PANTRY_DOC, what: "pantry" });
}

export async function savePantry(items: PantryItem[]): Promise<void> {
  await ensureDir();
  const doc: PantryDoc = {
    v: 1,
    items: items.slice(0, MAX_ITEMS),
    updatedAt: new Date().toISOString(),
  };
  await vfs.write(PANTRY_PATH, JSON.stringify(doc, null, 2));
}

/** Add or update an item (dedupe by normalized name; later add wins on qty/notes). */
export async function addPantryItem(input: {
  name: string;
  quantity?: string;
  notes?: string;
}): Promise<PantryItem[]> {
  const name = sanitizeName(input.name);
  if (!name) throw new Error("Enter an ingredient name.");
  const items = await loadPantryForWrite();
  return mergeItem(items, {
    name,
    quantity: clean(input.quantity),
    notes: clean(input.notes),
    addedAt: new Date().toISOString(),
  });
}

/** Merge a batch of scanned/AI ingredients into the pantry. */
export async function addPantryItems(
  incoming: Array<{ name: string; quantity?: string; notes?: string }>,
): Promise<PantryItem[]> {
  let items = await loadPantryForWrite();
  const now = new Date().toISOString();
  for (const raw of incoming) {
    const name = sanitizeName(raw.name);
    if (!name) continue;
    items = mergeIntoList(items, {
      name,
      quantity: clean(raw.quantity),
      notes: clean(raw.notes),
      addedAt: now,
    });
  }
  await savePantry(items);
  return items;
}

export async function updatePantryItem(
  name: string,
  patch: Partial<Pick<PantryItem, "quantity" | "notes">>,
): Promise<PantryItem[]> {
  const items = await loadPantryForWrite();
  const key = dedupeKey(name);
  const next = items.map((i) =>
    dedupeKey(i.name) === key
      ? {
          ...i,
          quantity: "quantity" in patch ? clean(patch.quantity) : i.quantity,
          notes: "notes" in patch ? clean(patch.notes) : i.notes,
        }
      : i,
  );
  await savePantry(next);
  return next;
}

export async function removePantryItem(name: string): Promise<PantryItem[]> {
  const items = await loadPantryForWrite();
  const key = dedupeKey(name);
  const next = items.filter((i) => dedupeKey(i.name) !== key);
  await savePantry(next);
  return next;
}

/** Adapter: pantry items as the Ingredient shape the matcher/scaler consume. */
export function ingredientsFromPantry(items: PantryItem[]): Ingredient[] {
  return items.map((i) => ({
    name: i.name,
    confidence: 1,
    confirmed: true,
    ...(i.quantity ? { quantity: i.quantity } : {}),
    ...(i.notes ? { notes: i.notes } : {}),
  }));
}

// ── helpers ──────────────────────────────────────────────────────────────

async function mergeItem(items: PantryItem[], entry: PantryItem): Promise<PantryItem[]> {
  const next = mergeIntoList(items, entry);
  await savePantry(next);
  return next;
}

function mergeIntoList(items: PantryItem[], entry: PantryItem): PantryItem[] {
  const key = dedupeKey(entry.name);
  const idx = items.findIndex((i) => dedupeKey(i.name) === key);
  if (idx === -1) return [entry, ...items];
  const existing = items[idx]!;
  const merged: PantryItem = {
    name: existing.name,
    quantity: entry.quantity ?? existing.quantity,
    notes: entry.notes ?? existing.notes,
    addedAt: existing.addedAt,
  };
  const copy = items.slice();
  copy[idx] = merged;
  return copy;
}

function dedupeKey(name: string): string {
  return name.trim().toLowerCase();
}

function clean(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t ? t.slice(0, 60) : undefined;
}

function isValidItem(x: unknown): x is PantryItem {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as PantryItem).name === "string" &&
    (x as PantryItem).name.length > 0 &&
    (x as PantryItem).name.length <= 80
  );
}

async function ensureDir(): Promise<void> {
  try {
    await vfs.mkdir(RECIPES_DIR);
  } catch {
    /* already exists */
  }
}
