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

const RECIPES_DIR = "/home/Documents/Recipes";
const FAV_PATH = `${RECIPES_DIR}/.favorites.json`;
const MAX_IDS = 5000;

interface FavDoc {
  v: 1;
  catalogIds: string[];
  updatedAt: string;
}

export async function loadFavorites(): Promise<Set<string>> {
  try {
    const text = await vfs.read(FAV_PATH);
    const doc = JSON.parse(text) as Partial<FavDoc>;
    if (doc && Array.isArray(doc.catalogIds)) {
      return new Set(
        doc.catalogIds.filter((x) => typeof x === "string").slice(0, MAX_IDS),
      );
    }
  } catch {
    /* no favorites yet */
  }
  return new Set();
}

export async function toggleCatalogFavorite(id: string): Promise<Set<string>> {
  const favs = await loadFavorites();
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
