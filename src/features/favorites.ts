/**
 * Favorites index for CATALOG recipes.
 *
 * Saved recipes carry their favorite flag in their own markdown frontmatter
 * (see storage.setSavedFavorite). But catalog recipes aren't files, so we keep
 * a tiny index of favorited catalog ids at /home/Documents/Recipes/.favorites.json.
 * The Favorites screen unions both: saved recipes flagged favorite + catalog
 * recipes whose id is in this index.
 */

import { vfs } from "../bridge/vfs";
import { readJsonDoc, requireJsonDoc } from "./jsonDoc";

const RECIPES_DIR = "/home/Documents/Recipes";
const FAV_PATH = `${RECIPES_DIR}/.favorites.json`;
const MAX_IDS = 5000;
/** 5000 ids of ~40 bytes fits well inside this; over it, assume a real file we shouldn't clobber. */
const MAX_FILE_BYTES = 256 * 1024;

interface FavDoc {
  v: 1;
  catalogIds: string[];
  updatedAt: string;
}

function parseFavs(raw: unknown): Set<string> | null {
  const doc = raw as Partial<FavDoc> | null;
  if (!doc || !Array.isArray(doc.catalogIds)) return null;
  return new Set(doc.catalogIds.filter((x) => typeof x === "string").slice(0, MAX_IDS));
}

const FAV_DOC = { maxBytes: MAX_FILE_BYTES, empty: (): Set<string> => new Set() };

/** Read for DISPLAY — an unreadable index renders as "no favorites". */
export async function loadFavorites(): Promise<Set<string>> {
  const r = await readJsonDoc(FAV_PATH, parseFavs, FAV_DOC);
  return r.ok ? r.value : new Set();
}

/** Read for a read-modify-write. Throws rather than wiping the index. */
async function loadFavoritesForWrite(): Promise<Set<string>> {
  return requireJsonDoc(FAV_PATH, parseFavs, { ...FAV_DOC, what: "favorites" });
}

export async function toggleCatalogFavorite(id: string): Promise<Set<string>> {
  const favs = await loadFavoritesForWrite();
  if (favs.has(id)) favs.delete(id);
  else favs.add(id);
  await save(favs);
  return favs;
}

async function save(favs: Set<string>): Promise<void> {
  try {
    await vfs.mkdir(RECIPES_DIR);
  } catch {
    /* already exists */
  }
  const doc: FavDoc = {
    v: 1,
    catalogIds: [...favs].slice(0, MAX_IDS),
    updatedAt: new Date().toISOString(),
  };
  await vfs.write(FAV_PATH, JSON.stringify(doc));
}
