/**
 * dedupe-catalog.mjs: remove catalog recipes that are exact copies of another.
 *
 * WHY: MyPlate publishes some recipes more than once, at different addresses
 * (homemade-bagels and yummy-bagels, tuna-salad-grapes and tuna-salad-ii), and
 * the import kept every address. The browse feed then shows the same recipe two
 * or four times. On prod (2026-10-26) that was 11 groups, 13 surplus rows.
 *
 * WHAT COUNTS AS A COPY: same provenance AND identical ingredients AND
 * identical instructions, compared exactly. The title is NOT part of the key:
 * "Fig Bars" and "Fabulous Fig Bars" are one recipe under two names. Rows that
 * only share a title ("Ratatouille" ×2) are different recipes and are left
 * alone. Only `source = 'catalog'` rows are ever read; a user's own recipe is
 * never touched.
 *
 * WHICH COPY IS KEPT, per group, first rule that separates them:
 *   1. the one someone has favorited (catalog favorites are ids in each
 *      user's /home/Documents/Recipes/.favorites.json, so deleting a
 *      favorited row would silently drop it from their Favorites);
 *   2. the one with a photo;
 *   3. the one whose address best matches its own title: the larger share
 *      of the address's words found in the title, then more words matched
 *      (so "tuna-salad-grapes" beats "tuna-salad-ii", and "fried-rice-
 *      chicken-vegetables" beats "fried-rice"); a malformed address
 *      ("%20" in it) scores nothing;
 *   4. the oldest, then the lowest id, so the choice is stable across runs.
 * If two DIFFERENT rows in one group are favorited, every favorited row is
 * kept and the group is reported, never resolved by guessing.
 *
 * A deleted row's photo object in `recipe-images` is removed too when no
 * remaining row points at it, so nothing is orphaned. (Re-running
 * import-usda-photos.mjs afterwards re-uploads that object and reports "??"
 * for the deleted row; harmless.)
 *
 * Idempotent: a second run finds no groups and does nothing.
 *
 * Needs the project's SERVICE ROLE key (Supabase dashboard → Project Settings
 * → API). Pass it in the environment; never commit it or paste it anywhere.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/dedupe-catalog.mjs --dry-run     # list what it would delete
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/dedupe-catalog.mjs               # delete it
 *
 * Undo: none from this script. The dry run prints every row it would delete
 * (id, title, source_url); re-importing a deleted recipe means re-running the
 * catalog import for that source_url.
 */

const DRY = process.argv.includes("--dry-run");
const URL_BASE = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!URL_BASE || !KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see the header of this file).");
  process.exit(1);
}

const auth = { Authorization: `Bearer ${KEY}`, apikey: KEY };
const FILES_BUCKET = "user-files";
const IMAGE_BUCKET = "recipe-images";
const PAGE = 1000;

async function rest(path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: { ...auth, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path.split("?")[0]} ${res.status}: ${await res.text()}`);
  return res;
}

/** Every catalog row, paged: PostgREST caps a response at 1000 rows. */
async function loadCatalog() {
  const cols = "id,title,provenance,source_url,image_url,ingredients,instructions,created_at";
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const res = await rest(`recipes?source=eq.catalog&select=${cols}&order=id`, {
      headers: { Range: `${from}-${from + PAGE - 1}`, "Range-Unit": "items" },
    });
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

/** Catalog ids favorited by anyone, with how many users favorited each. */
async function loadFavorites() {
  const res = await rest(
    `files?path=like.*Recipes/.favorites.json&deleted_at=is.null&select=account_id,storage_key`,
  );
  const favs = new Map();
  for (const f of await res.json()) {
    const obj = await fetch(`${URL_BASE}/storage/v1/object/${FILES_BUCKET}/${f.storage_key}`, { headers: auth });
    if (!obj.ok) throw new Error(`favorites for ${f.account_id}: ${obj.status} (refusing to guess)`);
    let ids = [];
    try {
      ids = JSON.parse(await obj.text()).catalogIds ?? [];
    } catch {
      throw new Error(`favorites for ${f.account_id} did not parse (refusing to guess)`);
    }
    for (const id of ids) if (typeof id === "string") favs.set(id, (favs.get(id) ?? 0) + 1);
  }
  return favs;
}

/** How well a row's address names it: [share of its words in the title, words matched]. */
function addressFit(r) {
  const slug = (r.source_url ?? "").split("/").pop() ?? "";
  if (!/^[a-z0-9-]+$/.test(slug)) return [0, 0];
  const title = new Set(r.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const words = slug.split("-").filter(Boolean);
  const hit = words.filter((w) => title.has(w)).length;
  return [words.length ? hit / words.length : 0, hit];
}

function keeperOrder(favs) {
  return (a, b) =>
    (favs.has(b.id) ? 1 : 0) - (favs.has(a.id) ? 1 : 0) ||
    (b.image_url ? 1 : 0) - (a.image_url ? 1 : 0) ||
    addressFit(b)[0] - addressFit(a)[0] ||
    addressFit(b)[1] - addressFit(a)[1] ||
    String(a.created_at).localeCompare(String(b.created_at)) ||
    a.id.localeCompare(b.id);
}

/** `recipe-images` object path from a public URL, or null if it lives elsewhere. */
function imageObject(url) {
  const marker = `/storage/v1/object/public/${IMAGE_BUCKET}/`;
  const i = url ? url.indexOf(marker) : -1;
  return i === -1 ? null : decodeURIComponent(url.slice(i + marker.length));
}

const rows = await loadCatalog();
const favs = await loadFavorites();
console.log(`${rows.length} catalog rows, ${favs.size} favorited catalog ids, ${URL_BASE}${DRY ? " (dry run)" : ""}`);

const groups = new Map();
for (const r of rows) {
  const key = JSON.stringify([r.provenance, r.ingredients, r.instructions]);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const doomed = [];
const held = [];
for (const g of groups.values()) {
  if (g.length < 2) continue;
  g.sort(keeperOrder(favs));
  const [keep, ...rest] = g;
  console.log(`\nkeep   ${keep.id}  ${keep.title}  ${keep.source_url}${favs.has(keep.id) ? "  [favorited]" : ""}`);
  for (const r of rest) {
    if (favs.has(r.id)) {
      held.push(r);
      console.log(`HOLD   ${r.id}  ${r.title}  ${r.source_url}  [also favorited: kept, resolve by hand]`);
      continue;
    }
    doomed.push(r);
    console.log(`delete ${r.id}  ${r.title}  ${r.source_url}`);
  }
}

console.log(`\n${doomed.length} row(s) to delete, ${held.length} held.`);
if (DRY || doomed.length === 0) process.exit(0);

const ids = doomed.map((r) => r.id);
const del = await rest(`recipes?source=eq.catalog&id=in.(${ids.join(",")})`, {
  method: "DELETE",
  headers: { Prefer: "return=representation" },
});
const gone = await del.json();
console.log(`deleted ${gone.length}/${ids.length} rows`);

// Photos: only objects in our bucket that no surviving row still points at.
const survivors = new Set(rows.filter((r) => !ids.includes(r.id)).map((r) => r.image_url).filter(Boolean));
const objects = [...new Set(doomed.map((r) => r.image_url).filter((u) => u && !survivors.has(u)).map(imageObject).filter(Boolean))];
if (objects.length) {
  const res = await fetch(`${URL_BASE}/storage/v1/object/${IMAGE_BUCKET}`, {
    method: "DELETE",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: objects }),
  });
  console.log(res.ok ? `removed ${objects.length} orphaned photo(s): ${objects.join(", ")}` : `photo cleanup ${res.status}: ${await res.text()}`);
}
if (gone.length !== ids.length) process.exit(1);
