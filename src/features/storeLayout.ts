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
}

export interface StoresState {
  stores: StoreLayout[];
  defaultId: string;
}

const STORES_PATH = "/home/Documents/Recipes/stores.json";
const LAST_STORE_KEY = "recipes.stores.lastStoreId";
const UNSORTED = "__unsorted__";

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

export async function loadStores(): Promise<StoresState> {
  try {
    if (await vfs.exists(STORES_PATH)) {
      const parsed = JSON.parse(await vfs.read(STORES_PATH)) as Partial<StoresState>;
      if (parsed?.stores?.length) {
        return {
          stores: parsed.stores,
          defaultId: parsed.defaultId ?? parsed.stores[0]!.id,
        };
      }
    }
  } catch {
    /* unreadable / malformed → fall back to a fresh default */
  }
  const d = defaultStore();
  return { stores: [d], defaultId: d.id };
}

export async function saveStores(state: StoresState): Promise<void> {
  await vfs.write(STORES_PATH, JSON.stringify(state, null, 2));
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

  const aisleForItem = (it: T): string => {
    const hay = `${it.name} ${it.canonical}`.toLowerCase();
    for (const o of overrides) if (hay.includes(o.kw)) return o.aisleId;
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
