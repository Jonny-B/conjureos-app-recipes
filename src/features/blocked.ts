/**
 * Blocked recipes — "don't suggest this again".
 *
 * Thumbs-down on a meal in the plan wizard adds its id here, and every plan
 * run passes the whole set as `excludeIds`, so a blocked recipe can never be
 * picked again. Deliberately a soft block: it only affects RECOMMENDATIONS.
 * A blocked recipe is still searchable, still openable, still cookable — the
 * user said "stop suggesting it", not "hide it from me".
 *
 * Stored the same way favorites are (see favorites.ts): a small id index at
 * `/home/Documents/Recipes/.blocked.json`. That path is under `/home/`, so it
 * syncs to the account and survives an uninstall — thumbs-down on the phone is
 * respected on the laptop, and reinstalling doesn't resurrect a rejected meal.
 */

import { vfs } from "../bridge/vfs";

const RECIPES_DIR = "/home/Documents/Recipes";
const BLOCKED_PATH = `${RECIPES_DIR}/.blocked.json`;
const MAX_IDS = 5000;

interface BlockedDoc {
  v: 1;
  ids: string[];
  updatedAt: string;
}

export async function loadBlocked(): Promise<Set<string>> {
  try {
    const doc = JSON.parse(await vfs.read(BLOCKED_PATH)) as Partial<BlockedDoc>;
    if (doc && Array.isArray(doc.ids)) {
      return new Set(doc.ids.filter((x) => typeof x === "string").slice(0, MAX_IDS));
    }
  } catch {
    /* nothing blocked yet */
  }
  return new Set();
}

async function save(ids: Set<string>): Promise<void> {
  const doc: BlockedDoc = {
    v: 1,
    ids: [...ids].slice(0, MAX_IDS),
    updatedAt: new Date().toISOString(),
  };
  await vfs.mkdir(RECIPES_DIR).catch(() => {});
  await vfs.write(BLOCKED_PATH, JSON.stringify(doc));
}

/** Block a recipe from future recommendations. Returns the new set. */
export async function blockRecipe(id: string): Promise<Set<string>> {
  const ids = await loadBlocked();
  ids.add(id);
  await save(ids);
  return ids;
}

/** Un-block, so it can be suggested again. Returns the new set. */
export async function unblockRecipe(id: string): Promise<Set<string>> {
  const ids = await loadBlocked();
  ids.delete(id);
  await save(ids);
  return ids;
}
