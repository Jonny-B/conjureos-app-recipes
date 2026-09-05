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
import { readJsonDoc, requireJsonDoc } from "./jsonDoc";

const RECIPES_DIR = "/home/Documents/Recipes";
const BLOCKED_PATH = `${RECIPES_DIR}/.blocked.json`;
const MAX_IDS = 5000;
/** 5000 ids of ~40 bytes fits well inside this; over it, assume a real file we shouldn't clobber. */
const MAX_FILE_BYTES = 256 * 1024;

interface BlockedDoc {
  v: 1;
  ids: string[];
  updatedAt: string;
}

function parseBlocked(raw: unknown): Set<string> | null {
  const doc = raw as Partial<BlockedDoc> | null;
  if (!doc || !Array.isArray(doc.ids)) return null;
  return new Set(doc.ids.filter((x) => typeof x === "string").slice(0, MAX_IDS));
}

const BLOCKED_DOC = { maxBytes: MAX_FILE_BYTES, empty: new Set<string>() };

/** Read for DISPLAY / filtering — unreadable behaves as "nothing blocked". */
export async function loadBlocked(): Promise<Set<string>> {
  const r = await readJsonDoc(BLOCKED_PATH, parseBlocked, BLOCKED_DOC);
  return r.ok ? r.value : new Set();
}

/** Read for a read-modify-write. Throws rather than clearing the block list. */
async function loadBlockedForWrite(): Promise<Set<string>> {
  return requireJsonDoc(BLOCKED_PATH, parseBlocked, { ...BLOCKED_DOC, what: "blocked list" });
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
  const ids = await loadBlockedForWrite();
  ids.add(id);
  await save(ids);
  return ids;
}

/** Un-block, so it can be suggested again. Returns the new set. */
export async function unblockRecipe(id: string): Promise<Set<string>> {
  const ids = await loadBlockedForWrite();
  ids.delete(id);
  await save(ids);
  return ids;
}
