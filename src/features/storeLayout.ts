/**
 * Grocery store layouts. A "store" is the user's map of their grocery store:
 * an ORDERED list of aisles (by number or name) matching the path they walk,
 * with the app's ingredient categories slotted into those aisles plus per-item
 * exceptions (e.g. flour lives in the oil aisle at my store, not "Bakery").
 *
 * When a shopping list is shown, it's grouped + ordered by the selected store,
 * so the list matches the walk. Switching stores re-groups instantly (pure,
 * deterministic — no AI, no network). Reordering aisles reorders the list, so
 * a user who walks their store backwards just reverses the aisles.
 *
 * Stores are PERSONAL (owner decision 2026-07-26): stored in the app's VFS
 * (`/home/Documents/Recipes/stores.json`), never in the shared family DB. A
 * family shopping list re-groups to whoever is viewing it.
 */
import { vfs } from "../bridge/vfs";
import { readJsonDoc, type DocLoad } from "./jsonDoc";

/** The app's fixed ingredient categories (mirror of planWeek.ts AISLE_ORDER). */
export const STORE_CATEGORIES = [
  "Produce",
  "Meat & seafood",
  "Dairy & eggs",
  "Bakery",
  "Pantry",
  "Other",
] as const;
export type StoreCategory = (typeof STORE_CATEGORIES)[number];

export interface StoreAisle {
  id: string;
  /** Free text — a number ("7") or a name ("Produce", "Oils & Baking"). */
  name: string;
  /** Categories that live in this aisle (subset of STORE_CATEGORIES). */
  categories: string[];
}

export interface ItemException {
  /** Case-insensitive substring matched against the item name (e.g. "flour"). */
  keyword: string;
  aisleId: string;
}

export interface StoreLayout {
  id: string;
  name: string;
  /** Ordered = the order you walk the store. */
  aisles: StoreAisle[];
  itemOverrides: ItemException[];
  /**
   * AI-learned item placements: canonical ingredient name → aisle id. Filled in
   * when the model places an item the deterministic layout didn't cover, then
   * remembered so the same item is instant (and free) next time. User exceptions
   * always win over these; the user can clear them in the editor.
   */
  learned?: Record<string, string>;
}

export interface StoresState {
  stores: StoreLayout[];
  defaultId: string;
}

/** Over this, assume a real layouts file we must not clobber. */
const MAX_FILE_BYTES = 256 * 1024;
const STORES_PATH = "/home/Documents/Recipes/stores.json";
const LAST_STORE_KEY = "recipes.stores.lastStoreId";
/** Aisle id for items no rule placed — rendered as a trailing "Unsorted" group. */
export const UNSORTED = "__unsorted__";

let idSeq = 0;
export function newId(prefix = "a"): string {
  idSeq += 1;
  return `${prefix}${Date.now().toString(36)}${idSeq}`;
}

/** A fresh default store: each category is its own aisle, in the app's order. */
export function defaultStore(): StoreLayout {
  return {
    id: "default",
    name: "My store",
    aisles: STORE_CATEGORIES.map((c) => ({
      id: c.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name: c,
      categories: [c],
    })),
    itemOverrides: [],
  };
}

export function newStore(name: string): StoreLayout {
  return { ...defaultStore(), id: newId("s"), name: name.trim() || "New store" };
}

function parseStores(raw: unknown): StoresState | null {
  const parsed = raw as Partial<StoresState> | null;
  if (!parsed?.stores?.length) return null;
  return { stores: parsed.stores, defaultId: parsed.defaultId ?? parsed.stores[0]!.id };
}

/** A file we couldn't read is NOT a first run — see loadStoresState. */
const storesDoc = () => {
  const d = defaultStore();
  return { maxBytes: MAX_FILE_BYTES, empty: { stores: [d], defaultId: d.id } as StoresState };
};

/**
 * Load the user's store layouts, distinguishing a genuine first run from an
 * unreadable file. This one mattered most of the four: the old version answered
 * BOTH cases with a synthetic default store, and StoreEditor's debounced commit
 * then wrote that default straight over the user's real aisle layouts — every
 * custom aisle order and per-item exception gone, from one bad read.
 */
export async function loadStoresState(): Promise<DocLoad<StoresState>> {
  return readJsonDoc(STORES_PATH, parseStores, storesDoc());
}

/**
 * Display-only convenience. Callers that can WRITE the result back must use
 * loadStoresState and refuse to save when it answers `ok: false`.
 */
export async function loadStores(): Promise<StoresState> {
  const r = await loadStoresState();
  return r.ok ? r.value : storesDoc().empty;
}

export async function saveStores(state: StoresState): Promise<void> {
  await vfs.write(STORES_PATH, JSON.stringify(state, null, 2));
}

const AI_SORT_KEY = "recipes.stores.aiSort";
/** Whether the model may place items the layout doesn't cover. Default on. */
export function aiSortEnabled(): boolean {
  try {
    return localStorage.getItem(AI_SORT_KEY) !== "off";
  } catch {
    return true;
  }
}
export function setAiSortEnabled(on: boolean): void {
  try {
    localStorage.setItem(AI_SORT_KEY, on ? "on" : "off");
  } catch {
    /* private mode — non-fatal */
  }
}

/** Merge AI-learned placements (canonical → aisleId) into a store, immutably. */
export function withLearned(store: StoreLayout, placements: Record<string, string>): StoreLayout {
  return { ...store, learned: { ...(store.learned ?? {}), ...placements } };
}

export function readLastStoreId(): string | null {
  try {
    return localStorage.getItem(LAST_STORE_KEY);
  } catch {
    return null;
  }
}
export function writeLastStoreId(id: string): void {
  try {
    localStorage.setItem(LAST_STORE_KEY, id);
  } catch {
    /* private mode — non-fatal */
  }
}

/** Which categories aren't slotted into any aisle (they fall to "Unsorted"). */
export function unassignedCategories(store: StoreLayout): string[] {
  const assigned = new Set(store.aisles.flatMap((a) => a.categories));
  return STORE_CATEGORIES.filter((c) => !assigned.has(c));
}

/**
 * Group a shopping list by a store's aisle order. Item exceptions win over the
 * category mapping; anything with no home lands in a trailing "Unsorted" group.
 */
export function groupByStore<T extends { name: string; canonical: string; aisle: string }>(
  items: T[],
  store: StoreLayout,
): Array<{ aisleId: string; aisleName: string; items: T[] }> {
  const catToAisle = new Map<string, string>();
  for (const a of store.aisles) for (const c of a.categories) catToAisle.set(c, a.id);
  const overrides = store.itemOverrides
    .map((o) => ({ kw: o.keyword.trim().toLowerCase(), aisleId: o.aisleId }))
    .filter((o) => o.kw && store.aisles.some((a) => a.id === o.aisleId));

  const learned = store.learned ?? {};
  const validAisle = new Set(store.aisles.map((a) => a.id));
  const aisleForItem = (it: T): string => {
    const hay = `${it.name} ${it.canonical}`.toLowerCase();
    for (const o of overrides) if (hay.includes(o.kw)) return o.aisleId; // explicit user exceptions win
    const l = learned[it.canonical]; // then an AI-learned placement (exact canonical)
    if (l && validAisle.has(l)) return l;
    return catToAisle.get(it.aisle) ?? UNSORTED;
  };

  const buckets = new Map<string, T[]>();
  for (const it of items) {
    const aid = aisleForItem(it);
    (buckets.get(aid) ?? buckets.set(aid, []).get(aid)!).push(it);
  }

  const out: Array<{ aisleId: string; aisleName: string; items: T[] }> = [];
  for (const a of store.aisles) {
    const its = buckets.get(a.id);
    if (its?.length) out.push({ aisleId: a.id, aisleName: a.name || "Aisle", items: its });
  }
  const un = buckets.get(UNSORTED);
  if (un?.length) out.push({ aisleId: UNSORTED, aisleName: "Unsorted", items: un });
  return out;
}
